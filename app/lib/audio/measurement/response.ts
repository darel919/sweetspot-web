import type { MeasurementSweep } from '#shared/types/protocol'
import { generateSyncMarker, sweepSampleParts } from '../sweep-reference'
import {
  micCompensationDbAtHz,
  summarizeMicCalibrationProfile,
} from '../mics/profile'
import type { MicCalibrationProfile, MicCalibrationSummary } from '../mics/types'
import {
  deconvolveSweep,
  type ImpulseSummary,
  type RoomMetrics,
  windowedImpulseResponse,
} from './impulse'
import { fftInPlace, nextPowerOfTwo } from './fft'

export interface ResponsePoint {
  frequencyHz: number
  magnitudeDb: number
}

export interface SweepDetection {
  found: boolean
  startSample: number | null
  leadingMarkerSample: number | null
  trailingMarkerSample: number | null
  offsetMs: number | null
  confidence: number
  endingMarkerConfidence: number
  clockRatio: number | null
  driftPpm: number | null
  failureReason: 'sync_marker_not_found' | 'clock_drift_unreliable' | null
}

export type MeasurementAnalysisStatus = 'ok' | 'signal_too_low' | 'sweep_not_found' | 'sync_marker_not_found' | 'clock_drift_unreliable' | 'capture_too_short' | 'capture_clipped'
export type MeasurementAnalysisFailure = Exclude<MeasurementAnalysisStatus, 'ok'>

export interface MeasurementAnalysisDiagnostics {
  detected: boolean
  /** Where the recorded sweep envelope was found inside the browser capture. */
  detectionOffsetMs: number | null
  detectionConfidence: number
  endingMarkerConfidence: number
  clockDriftPpm: number | null
  signalRms: number
  signalPeak: number
  snrEstimateDb: number | null
  clipped: boolean
  clippedSamples: number
  sampleCount: number
  frequencyPoints: number
  failureReason: MeasurementAnalysisFailure | null
}

export interface MeasurementAnalysis {
  status: MeasurementAnalysisStatus
  rawPoints: ResponsePoint[]
  correctedPoints: ResponsePoint[]
  displayPoints: ResponsePoint[]
  room: RoomMetrics | null
  impulse: ImpulseSummary | null
  micProfile: MicCalibrationSummary
  diagnostics: MeasurementAnalysisDiagnostics
}

function calculateSignalStats(samples: Float32Array, start = 0, end = samples.length): {
  rms: number
  peak: number
  clippedSamples: number
} {
  let sumSquares = 0
  let peak = 0
  let clippedSamples = 0
  const boundedStart = Math.max(0, start)
  const boundedEnd = Math.min(samples.length, end)
  for (let index = boundedStart; index < boundedEnd; index++) {
    const sample = samples[index]
    const absolute = Math.abs(sample)
    sumSquares += sample * sample
    peak = Math.max(peak, absolute)
    if (absolute >= 0.999) clippedSamples++
  }
  const count = boundedEnd - boundedStart
  return {
    rms: count > 0 ? Math.sqrt(sumSquares / count) : 0,
    peak,
    clippedSamples,
  }
}

function removeDc(samples: Float32Array): Float32Array {
  if (samples.length === 0) return new Float32Array(0)
  let sum = 0
  for (const sample of samples) sum += sample
  const mean = sum / samples.length
  if (Math.abs(mean) < 1e-8) return samples
  const centered = new Float32Array(samples.length)
  for (let index = 0; index < samples.length; index++) centered[index] = samples[index] - mean
  return centered
}

function blockRms(samples: Float32Array, start: number, length: number): number {
  let sumSquares = 0
  const end = Math.min(samples.length, start + length)
  for (let index = start; index < end; index++) sumSquares += samples[index] * samples[index]
  const count = end - start
  return count > 0 ? Math.sqrt(sumSquares / count) : 0
}

function blockNoiseRms(samples: Float32Array, start: number, length: number): number {
  const end = Math.min(samples.length, start + length)
  let sum = 0
  let sumSquares = 0
  const count = Math.max(0, end - start)
  for (let index = start; index < end; index++) {
    const sample = samples[index]
    sum += sample
    sumSquares += sample * sample
  }
  if (count === 0) return 0
  return Math.sqrt(Math.max(0, sumSquares / count - (sum / count) ** 2))
}

function dbRatio(numerator: number, denominator: number): number | null {
  if (!(numerator > 0) || !(denominator > 0)) return null
  return 10 * Math.log10(numerator / denominator)
}

function estimateCaptureNoiseRms(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  startSample: number,
): number | null {
  const parts = sweepSampleParts(sweep, sampleRate)
  const signalStart = Math.min(samples.length, startSample)
  const noiseEnd = Math.max(0, signalStart - parts.syncMarkerGapSamples - parts.syncMarkerSamples)
  const noiseStart = Math.max(0, noiseEnd - Math.min(parts.preRollSamples, Math.round(sampleRate * 0.25)))
  if (noiseEnd <= noiseStart) return null
  const blockLength = Math.max(1, Math.floor((noiseEnd - noiseStart) / 8))
  const blockLevels: number[] = []
  for (let blockStart = noiseStart; blockStart < noiseEnd; blockStart += blockLength) {
    blockLevels.push(blockNoiseRms(samples, blockStart, Math.min(noiseEnd, blockStart + blockLength) - blockStart))
  }
  return median(blockLevels)
}

function estimateSnr(samples: Float32Array, sampleRate: number, sweep: MeasurementSweep, startSample: number): number | null {
  const parts = sweepSampleParts(sweep, sampleRate)
  const signalStart = Math.min(samples.length, startSample)
  const signalEnd = Math.min(samples.length, signalStart + parts.sweepSamples)
  const noise = estimateCaptureNoiseRms(samples, sampleRate, sweep, startSample)
  const signal = blockRms(samples, signalStart, Math.max(1, signalEnd - signalStart))
  if (!(signal > 0)) return null
  if (noise === null || !(noise > 0)) return Number.POSITIVE_INFINITY
  return dbRatio(signal * signal, noise * noise)
}

function emptySweepDetection(failureReason: SweepDetection['failureReason'] = 'sync_marker_not_found'): SweepDetection {
  return {
    found: false,
    startSample: null,
    leadingMarkerSample: null,
    trailingMarkerSample: null,
    offsetMs: null,
    confidence: 0,
    endingMarkerConfidence: 0,
    clockRatio: null,
    driftPpm: null,
    failureReason,
  }
}

function normalizedMarkerCorrelation(samples: Float32Array, marker: Float32Array): Float64Array {
  if (samples.length < marker.length || marker.length === 0) return new Float64Array(0)
  let markerMean = 0
  for (const value of marker) markerMean += value
  markerMean /= marker.length
  const centeredMarker = new Float32Array(marker.length)
  let markerEnergy = 0
  for (let index = 0; index < marker.length; index++) {
    const value = marker[index] - markerMean
    centeredMarker[index] = value
    markerEnergy += value * value
  }
  if (!(markerEnergy > 0)) return new Float64Array(0)

  const fftLength = nextPowerOfTwo(samples.length + marker.length - 1)
  const sampleReal = new Float32Array(fftLength)
  const sampleImaginary = new Float32Array(fftLength)
  const markerReal = new Float32Array(fftLength)
  const markerImaginary = new Float32Array(fftLength)
  sampleReal.set(samples)
  for (let index = 0; index < marker.length; index++) markerReal[marker.length - 1 - index] = centeredMarker[index]
  fftInPlace(sampleReal, sampleImaginary)
  fftInPlace(markerReal, markerImaginary)
  for (let index = 0; index < fftLength; index++) {
    const real = sampleReal[index] * markerReal[index] - sampleImaginary[index] * markerImaginary[index]
    const imaginary = sampleReal[index] * markerImaginary[index] + sampleImaginary[index] * markerReal[index]
    sampleReal[index] = real
    sampleImaginary[index] = imaginary
  }
  fftInPlace(sampleReal, sampleImaginary, true)

  const prefixEnergy = new Float64Array(samples.length + 1)
  for (let index = 0; index < samples.length; index++) {
    prefixEnergy[index + 1] = prefixEnergy[index] + samples[index] * samples[index]
  }
  const correlation = new Float64Array(samples.length - marker.length + 1)
  for (let start = 0; start < correlation.length; start++) {
    const energy = prefixEnergy[start + marker.length] - prefixEnergy[start]
    const dot = sampleReal[start + marker.length - 1]
    correlation[start] = energy > 1e-12 ? Math.abs(dot) / Math.sqrt(markerEnergy * energy) : 0
  }
  return correlation
}

function detectSyncMarkers(samples: Float32Array, sweep: MeasurementSweep, sampleRate: number): SweepDetection {
  const tvParts = sweepSampleParts(sweep, sweep.sampleRate)
  const marker = generateSyncMarker(sweep, sampleRate)
  const correlation = normalizedMarkerCorrelation(samples, marker)
  if (correlation.length === 0) return emptySweepDetection()

  const candidateIndexes: number[] = []
  for (let index = 0; index < correlation.length; index++) {
    const value = correlation[index]
    if (value < 0.35) continue
    if (index > 0 && value < correlation[index - 1]) continue
    if (index + 1 < correlation.length && value < correlation[index + 1]) continue
    candidateIndexes.push(index)
  }
  candidateIndexes.sort((left, right) => correlation[right] - correlation[left])
  const candidates = candidateIndexes.slice(0, 64)
  const expectedTvSeparation = tvParts.trailingMarkerStartSamples - tvParts.leadingMarkerStartSamples
  const nominalCapturePerTvFrame = sampleRate / sweep.sampleRate
  const expectedSeparation = expectedTvSeparation * nominalCapturePerTvFrame
  const minimumSeparation = expectedSeparation * 0.995
  const maximumSeparation = expectedSeparation * 1.005
  let best: { leading: number; trailing: number; score: number } | null = null
  for (const leading of candidates) {
    for (const trailing of candidates) {
      if (trailing <= leading) continue
      const separation = trailing - leading
      if (separation < minimumSeparation || separation > maximumSeparation) continue
      const separationPenalty = Math.abs(separation - expectedSeparation) / expectedSeparation
      const score = Math.min(correlation[leading], correlation[trailing]) - separationPenalty
      if (!best || score > best.score) best = { leading, trailing, score }
    }
  }
  if (!best) return emptySweepDetection()
  const leadingConfidence = correlation[best.leading]
  const trailingConfidence = correlation[best.trailing]
  const confidence = Math.min(leadingConfidence, trailingConfidence)
  const clockRatio = (best.trailing - best.leading) / expectedSeparation
  const driftPpm = (clockRatio - 1) * 1_000_000
  if (confidence < 0.45) {
    return {
      ...emptySweepDetection('sync_marker_not_found'),
      leadingMarkerSample: best.leading,
      trailingMarkerSample: best.trailing,
      confidence: leadingConfidence,
      endingMarkerConfidence: trailingConfidence,
    }
  }
  if (!Number.isFinite(clockRatio) || Math.abs(driftPpm) > 5_000) {
    return {
      ...emptySweepDetection('clock_drift_unreliable'),
      leadingMarkerSample: best.leading,
      trailingMarkerSample: best.trailing,
      confidence: leadingConfidence,
      endingMarkerConfidence: trailingConfidence,
      driftPpm,
    }
  }
  const activeSweepOffsetInTvFrames = tvParts.sweepStartSamples - tvParts.leadingMarkerStartSamples
  const startSample = best.leading + Math.round(activeSweepOffsetInTvFrames * nominalCapturePerTvFrame * clockRatio)
  return {
    found: true,
    startSample,
    leadingMarkerSample: best.leading,
    trailingMarkerSample: best.trailing,
    offsetMs: startSample * 1000 / sampleRate,
    confidence,
    endingMarkerConfidence: trailingConfidence,
    clockRatio,
    driftPpm,
    failureReason: null,
  }
}

function detectEnvelopeStart(samples: Float32Array, sweep: MeasurementSweep, sampleRate: number): number | null {
  const blockSize = Math.max(128, Math.round(sampleRate * 0.01))
  const blocks = Math.ceil(samples.length / blockSize)
  const levels = new Float64Array(blocks)
  let maximum = 0
  for (let index = 0; index < blocks; index++) {
    levels[index] = blockRms(samples, index * blockSize, blockSize)
    maximum = Math.max(maximum, levels[index])
  }
  if (maximum < 0.0001) return null
  const baselineBlocks = Math.min(blocks, Math.max(1, Math.floor(sweepSampleParts(sweep, sampleRate).preRollSamples / blockSize)))
  let baseline = 0
  for (let index = 0; index < baselineBlocks; index++) baseline += levels[index]
  baseline /= Math.max(1, baselineBlocks)
  const threshold = Math.max(0.0001, baseline * 2.5, maximum * 0.08)
  const activeBlock = levels.findIndex((level, index) => level >= threshold && (levels[index + 1] ?? 0) >= threshold)
  return activeBlock < 0 ? null : Math.max(0, activeBlock * blockSize - sweepSampleParts(sweep, sampleRate).preRollSamples)
}

export function detectSweepStart(
  samples: Float32Array,
  sweep: MeasurementSweep,
  sampleRate: number,
): SweepDetection {
  if (samples.length === 0 || sampleRate <= 0) return emptySweepDetection()
  const markerDetection = detectSyncMarkers(samples, sweep, sampleRate)
  if (markerDetection.found) return markerDetection
  const fallbackStartSample = detectEnvelopeStart(samples, sweep, sampleRate)
  return {
    ...markerDetection,
    offsetMs: fallbackStartSample === null ? null : fallbackStartSample * 1000 / sampleRate,
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  const current = sorted[middle]
  if (current === undefined) return 0
  if (sorted.length % 2 !== 0) return current
  const previous = sorted[middle - 1]
  return previous === undefined ? current : (previous + current) / 2
}

export function normalizeResponsePoints(
  points: readonly ResponsePoint[],
  referenceMinHz = 500,
  referenceMaxHz = 2_000,
): ResponsePoint[] {
  if (points.length === 0) return []
  const referencePoints = points.filter((point) =>
    point.frequencyHz >= referenceMinHz && point.frequencyHz <= referenceMaxHz,
  )
  const reference = median((referencePoints.length > 0 ? referencePoints : points)
    .map((point) => point.magnitudeDb))
  return points.map((point) => ({ ...point, magnitudeDb: point.magnitudeDb - reference }))
}

/** Display smoothing only; optimizer smoothing is intentionally separate. */
export function smoothResponsePoints(points: ResponsePoint[], radius = 1): ResponsePoint[] {
  if (points.length < 3 || radius <= 0) return points.map((point) => ({ ...point }))
  return points.map((point, index) => {
    const start = Math.max(0, index - radius)
    const end = Math.min(points.length - 1, index + radius)
    let total = 0
    let count = 0
    for (let cursor = start; cursor <= end; cursor++) {
      total += points[cursor].magnitudeDb
      count++
    }
    return { ...point, magnitudeDb: total / count }
  })
}

function emptyAnalysis(
  status: MeasurementAnalysisStatus,
  micProfile: MicCalibrationProfile,
  diagnostics: MeasurementAnalysisDiagnostics,
): MeasurementAnalysis {
  return {
    status,
    rawPoints: [],
    correctedPoints: [],
    displayPoints: [],
    room: null,
    impulse: null,
    micProfile: summarizeMicCalibrationProfile(micProfile),
    diagnostics: { ...diagnostics, failureReason: status === 'ok' ? null : status },
  }
}

export function analyzeMeasurement(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
): MeasurementAnalysis {
  const centeredSamples = removeDc(samples)
  const wholeCaptureSignal = calculateSignalStats(centeredSamples)
  const detection = detectSweepStart(centeredSamples, sweep, sampleRate)
  const activeEnd = detection.startSample === null
    ? centeredSamples.length
    : detection.startSample + Math.ceil(
      (sweepSampleParts(sweep, sampleRate).sweepSamples + sweepSampleParts(sweep, sampleRate).postRollSamples)
      * (detection.clockRatio ?? 1),
    )
  const signal = detection.startSample === null
    ? wholeCaptureSignal
    : calculateSignalStats(centeredSamples, detection.startSample, activeEnd)
  const baseDiagnostics: MeasurementAnalysisDiagnostics = {
    detected: detection.found,
    detectionOffsetMs: detection.offsetMs,
    detectionConfidence: detection.confidence,
    endingMarkerConfidence: detection.endingMarkerConfidence,
    clockDriftPpm: detection.driftPpm,
    signalRms: signal.rms,
    signalPeak: signal.peak,
    snrEstimateDb: null,
    clipped: signal.clippedSamples > 0,
    clippedSamples: signal.clippedSamples,
    sampleCount: samples.length,
    frequencyPoints: 0,
    failureReason: null,
  }

  if (signal.rms < 0.0001) return emptyAnalysis('signal_too_low', micProfile, baseDiagnostics)
  if (!detection.found || detection.startSample === null) {
    return emptyAnalysis(detection.failureReason ?? 'sync_marker_not_found', micProfile, baseDiagnostics)
  }

  const captureNoiseRms = estimateCaptureNoiseRms(centeredSamples, sampleRate, sweep, detection.startSample)
  const snrEstimateDb = estimateSnr(centeredSamples, sampleRate, sweep, detection.startSample)
  const diagnostics = { ...baseDiagnostics, snrEstimateDb }
  if (snrEstimateDb !== null && snrEstimateDb < 8) return emptyAnalysis('signal_too_low', micProfile, diagnostics)

  const deconvolution = deconvolveSweep(
    centeredSamples,
    sampleRate,
    sweep,
    detection.startSample,
    detection.clockRatio ?? 1,
    captureNoiseRms,
  )
  if (deconvolution.kind === 'capture_too_short') {
    return emptyAnalysis('capture_too_short', micProfile, diagnostics)
  }
  const rawPoints = normalizeResponsePoints(windowedImpulseResponse(
    deconvolution.samples,
    sampleRate,
    sweep.startHz,
    sweep.endHz,
    48,
    deconvolution.summary.noiseFloorRms,
  ))
  if (rawPoints.length === 0) return emptyAnalysis('sweep_not_found', micProfile, diagnostics)
  const correctedPoints = rawPoints.map((point) => ({
    ...point,
    magnitudeDb: point.magnitudeDb + micCompensationDbAtHz(micProfile, point.frequencyHz),
  }))
  const displayPoints = smoothResponsePoints(correctedPoints)
  return {
    status: signal.clippedSamples > 0 ? 'capture_clipped' : 'ok',
    rawPoints,
    correctedPoints,
    displayPoints,
    room: deconvolution.summary.room,
    impulse: deconvolution.summary,
    micProfile: summarizeMicCalibrationProfile(micProfile),
    diagnostics: {
      ...diagnostics,
      frequencyPoints: correctedPoints.length,
      failureReason: signal.clippedSamples > 0 ? 'capture_clipped' : null,
    },
  }
}
