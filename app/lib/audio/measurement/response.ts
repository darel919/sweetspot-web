import type { MeasurementSweep } from '#shared/types/protocol'
import { sweepSampleParts } from '../sweep-reference'
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

export interface ResponsePoint {
  frequencyHz: number
  magnitudeDb: number
}

export interface SweepDetection {
  found: boolean
  startSample: number | null
  offsetMs: number | null
  confidence: number
}

export type MeasurementAnalysisStatus = 'ok' | 'signal_too_low' | 'sweep_not_found' | 'capture_clipped'

export interface MeasurementAnalysisDiagnostics {
  detected: boolean
  detectionOffsetMs: number | null
  detectionConfidence: number
  signalRms: number
  signalPeak: number
  snrEstimateDb: number | null
  clipped: boolean
  clippedSamples: number
  sampleCount: number
  frequencyPoints: number
}

export interface MeasurementAnalysis {
  status: MeasurementAnalysisStatus
  rawPoints: ResponsePoint[]
  points: ResponsePoint[]
  room: RoomMetrics | null
  impulse: ImpulseSummary | null
  micProfile: MicCalibrationSummary
  diagnostics: MeasurementAnalysisDiagnostics
}

function calculateSignalStats(samples: Float32Array): {
  rms: number
  peak: number
  clippedSamples: number
} {
  let sumSquares = 0
  let peak = 0
  let clippedSamples = 0
  for (const sample of samples) {
    const absolute = Math.abs(sample)
    sumSquares += sample * sample
    peak = Math.max(peak, absolute)
    if (absolute >= 0.999) clippedSamples++
  }
  return {
    rms: samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0,
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

function dbRatio(numerator: number, denominator: number): number | null {
  if (!(numerator > 0) || !(denominator > 0)) return null
  return 10 * Math.log10(numerator / denominator)
}

function estimateSnr(samples: Float32Array, sampleRate: number, sweep: MeasurementSweep, startSample: number): number | null {
  const parts = sweepSampleParts(sweep, sampleRate)
  const noiseEnd = Math.min(samples.length, startSample + Math.max(1, Math.min(parts.preRollSamples, Math.round(sampleRate * 0.25))))
  const signalStart = Math.min(samples.length, startSample + parts.preRollSamples)
  const signalEnd = Math.min(samples.length, signalStart + parts.sweepSamples)
  const noise = blockRms(samples, startSample, Math.max(1, noiseEnd - startSample))
  const signal = blockRms(samples, signalStart, Math.max(1, signalEnd - signalStart))
  if (!(signal > 0)) return null
  if (!(noise > 0)) return Number.POSITIVE_INFINITY
  return dbRatio(signal * signal, noise * noise)
}

export function detectSweepStart(
  samples: Float32Array,
  sweep: MeasurementSweep,
  sampleRate: number,
): SweepDetection {
  if (samples.length === 0 || sampleRate <= 0) {
    return { found: false, startSample: null, offsetMs: null, confidence: 0 }
  }
  const blockSize = Math.max(128, Math.round(sampleRate * 0.01))
  const blocks = Math.ceil(samples.length / blockSize)
  const levels = new Float64Array(blocks)
  let maximum = 0
  for (let index = 0; index < blocks; index++) {
    levels[index] = blockRms(samples, index * blockSize, blockSize)
    maximum = Math.max(maximum, levels[index])
  }
  if (maximum < 0.0001) return { found: false, startSample: null, offsetMs: null, confidence: 0 }

  const baselineBlocks = Math.min(blocks, 12)
  let baseline = 0
  for (let index = 0; index < baselineBlocks; index++) baseline += levels[index]
  baseline = baselineBlocks > 0 ? baseline / baselineBlocks : 0
  const threshold = Math.max(0.0001, baseline * 2.5, maximum * 0.08)
  let activeBlock = -1
  for (let index = 0; index < blocks - 1; index++) {
    if (levels[index] >= threshold && levels[index + 1] >= threshold) {
      activeBlock = index
      break
    }
  }
  if (activeBlock < 0) activeBlock = levels.findIndex((level) => level >= threshold)
  if (activeBlock < 0) return { found: false, startSample: null, offsetMs: null, confidence: 0 }

  const preRollSamples = sweepSampleParts(sweep, sampleRate).preRollSamples
  const startSample = Math.max(0, activeBlock * blockSize - preRollSamples)
  const confidence = Math.min(1, Math.max(0, (levels[activeBlock] - baseline) / Math.max(maximum - baseline, 0.0001)))
  return {
    found: true,
    startSample,
    offsetMs: startSample * 1000 / sampleRate,
    confidence,
  }
}

function interpolatePointDb(points: readonly ResponsePoint[], frequencyHz: number): number {
  if (points.length === 0) return 0
  if (frequencyHz <= points[0].frequencyHz) return points[0].magnitudeDb
  if (frequencyHz >= points[points.length - 1].frequencyHz) return points[points.length - 1].magnitudeDb
  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle].frequencyHz <= frequencyHz) low = middle
    else high = middle
  }
  const lower = points[low]
  const upper = points[high]
  const position = Math.log(frequencyHz / lower.frequencyHz) /
    Math.log(upper.frequencyHz / lower.frequencyHz)
  return lower.magnitudeDb + (upper.magnitudeDb - lower.magnitudeDb) * position
}

function normalizePoints(points: ResponsePoint[], normalizeAtHz = 1_000): ResponsePoint[] {
  if (points.length === 0) return []
  const center = interpolatePointDb(points, normalizeAtHz)
  return points.map((point) => ({ ...point, magnitudeDb: point.magnitudeDb - center }))
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
    points: [],
    room: null,
    impulse: null,
    micProfile: summarizeMicCalibrationProfile(micProfile),
    diagnostics,
  }
}

export function analyzeMeasurement(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
): MeasurementAnalysis {
  const centeredSamples = removeDc(samples)
  const signal = calculateSignalStats(centeredSamples)
  const detection = detectSweepStart(centeredSamples, sweep, sampleRate)
  const baseDiagnostics: MeasurementAnalysisDiagnostics = {
    detected: detection.found,
    detectionOffsetMs: detection.offsetMs,
    detectionConfidence: detection.confidence,
    signalRms: signal.rms,
    signalPeak: signal.peak,
    snrEstimateDb: null,
    clipped: signal.clippedSamples > 0,
    clippedSamples: signal.clippedSamples,
    sampleCount: samples.length,
    frequencyPoints: 0,
  }

  if (signal.rms < 0.0001) return emptyAnalysis('signal_too_low', micProfile, baseDiagnostics)
  if (!detection.found || detection.startSample === null) return emptyAnalysis('sweep_not_found', micProfile, baseDiagnostics)

  const snrEstimateDb = estimateSnr(centeredSamples, sampleRate, sweep, detection.startSample)
  const diagnostics = { ...baseDiagnostics, snrEstimateDb }
  if (snrEstimateDb !== null && snrEstimateDb < 8) return emptyAnalysis('signal_too_low', micProfile, diagnostics)

  const impulse = deconvolveSweep(centeredSamples, sampleRate, sweep, detection.startSample)
  const rawPoints = normalizePoints(windowedImpulseResponse(
    impulse.samples,
    sampleRate,
    sweep.startHz,
    sweep.endHz,
  ))
  if (rawPoints.length === 0) return emptyAnalysis('sweep_not_found', micProfile, diagnostics)
  const points = smoothResponsePoints(rawPoints.map((point) => ({
    ...point,
    magnitudeDb: point.magnitudeDb + micCompensationDbAtHz(micProfile, point.frequencyHz),
  })))
  return {
    status: signal.clippedSamples > 0 ? 'capture_clipped' : 'ok',
    rawPoints,
    points,
    room: impulse.summary.room,
    impulse: impulse.summary,
    micProfile: summarizeMicCalibrationProfile(micProfile),
    diagnostics: { ...diagnostics, frequencyPoints: points.length },
  }
}
