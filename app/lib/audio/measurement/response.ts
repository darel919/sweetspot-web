import type { MeasurementSweep, MeasurementSyncMarkerFailureReason } from '#shared/types/protocol'
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

/** Expected recorder/TV clock mismatch is normally within 250 ppm. */
export const CLOCK_DRIFT_WARNING_PPM = 250
/** Larger mismatch is retained for diagnosis, but not accepted for analysis. */
export const CLOCK_DRIFT_HARD_REJECT_PPM = 1_000

/** Candidate discovery only. Final acceptance also requires both-marker and timing evidence. */
const MARKER_DISCOVERY_FLOOR = 0.22
/** Per-marker floor used with the combined pair score, not as a standalone acceptance rule. */
const MARKER_MIN_CORRELATION = 0.25
/** Below this pair confidence, separation error is not enough evidence of oscillator drift. */
const CLOCK_DRIFT_ESTIMATE_MIN_CORRELATION = 0.55
/** Exact timing contributes half of the pair score, so timing can promote acoustic peaks. */
const MARKER_PAIR_SCORE_THRESHOLD = 0.63
const MARKER_PAIR_SEARCH_MAX_DRIFT_PPM = 5_000
const MAX_MARKER_CANDIDATES = 64
const MARKER_CANDIDATE_DEDUP_DISTANCE_FRACTION = 1 / 32

export type SyncMarkerFailureReason = MeasurementSyncMarkerFailureReason

export interface ResponsePoint {
  frequencyHz: number
  magnitudeDb: number
}

export interface SweepDetection {
  found: boolean
  startSample: number | null
  rightStartSample: number | null
  leadingMarkerSample: number | null
  trailingMarkerSample: number | null
  /** Recorder-timeline estimate used only to diagnose a missing marker pair. */
  envelopeOnlyOffsetMs: number | null
  /** Recorder-timeline offset from an accepted marker pair. */
  offsetMs: number | null
  /** Combined marker evidence and timing score used for acceptance. */
  confidence: number
  /** Raw trailing-marker correlation retained for diagnostics and quality summaries. */
  endingMarkerConfidence: number
  rawLeadingMarkerConfidence: number
  rawTrailingMarkerConfidence: number
  bestLeadingMarkerSample: number | null
  bestTrailingMarkerSample: number | null
  markerPairScore: number | null
  markerSeparationError: number | null
  markerTimingAgreement: number | null
  /** Raw marker separation expressed in ppm; it may be acoustic localization bias. */
  markerSeparationPpm: number | null
  /** Recorded samples per nominal TV sample, estimated from marker separation. */
  clockRatio: number | null
  /** Robust clock-ratio estimate; null when marker separation evidence is ambiguous. */
  driftPpm: number | null
  expectedMarkerSeparationSamples: number | null
  observedMarkerSeparationSamples: number | null
  failureReason: SyncMarkerFailureReason | null
}

export type MeasurementAnalysisStatus = 'ok' | 'signal_too_low' | 'sweep_not_found' | 'direct_arrival_low_confidence' | 'impulse_not_found' | 'response_not_generated' | 'sync_marker_not_found' | 'clock_drift_unreliable' | 'capture_too_short' | 'capture_clipped'
export type MeasurementAnalysisFailure = Exclude<MeasurementAnalysisStatus, 'ok'>

export interface MeasurementAnalysisDiagnostics {
  detected: boolean
  /** Where the recorded sweep envelope was found inside the browser capture. */
  detectionOffsetMs: number | null
  /** Diagnostic-only envelope estimate. It can never authorize deconvolution. */
  envelopeOnlyOffsetMs: number | null
  detectionConfidence: number
  endingMarkerConfidence: number
  rawLeadingMarkerConfidence: number
  rawTrailingMarkerConfidence: number
  bestLeadingMarkerSample: number | null
  bestTrailingMarkerSample: number | null
  markerPairScore: number | null
  markerSeparationError: number | null
  markerTimingAgreement: number | null
  markerSeparationPpm: number | null
  syncMarkerFailureReason: SyncMarkerFailureReason | null
  clockDriftPpm: number | null
  signalRms: number
  signalPeak: number
  snrEstimateDb: number | null
  clipped: boolean
  clippedSamples: number
  sampleCount: number
  frequencyPoints: number
  directPeak?: number | null
  deconvolvedNoiseFloorRms?: number | null
  directPeakToNoiseDb?: number | null
  directArrivalAcceptanceThreshold?: number | null
  directArrivalCandidateSample?: number | null
  directArrivalAcceptedSample?: number | null
  directArrivalRejectionReason?: string | null
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
  noiseAnchorSample = startSample,
): number | null {
  const parts = sweepSampleParts(sweep, sampleRate)
  const signalStart = Math.min(samples.length, noiseAnchorSample)
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

function estimateSnr(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  startSample: number,
  noiseAnchorSample = startSample,
): number | null {
  const parts = sweepSampleParts(sweep, sampleRate)
  const signalStart = Math.min(samples.length, startSample)
  const signalEnd = Math.min(samples.length, signalStart + parts.sweepSamples)
  const noise = estimateCaptureNoiseRms(samples, sampleRate, sweep, startSample, noiseAnchorSample)
  const signal = blockRms(samples, signalStart, Math.max(1, signalEnd - signalStart))
  if (!(signal > 0)) return null
  if (noise === null || !(noise > 0)) return Number.POSITIVE_INFINITY
  return dbRatio(signal * signal, noise * noise)
}

function emptySweepDetection(failureReason: SweepDetection['failureReason'] = 'marker_absent'): SweepDetection {
  return {
    found: false,
    startSample: null,
    rightStartSample: null,
    leadingMarkerSample: null,
    trailingMarkerSample: null,
    envelopeOnlyOffsetMs: null,
    offsetMs: null,
    confidence: 0,
    endingMarkerConfidence: 0,
    rawLeadingMarkerConfidence: 0,
    rawTrailingMarkerConfidence: 0,
    bestLeadingMarkerSample: null,
    bestTrailingMarkerSample: null,
    markerPairScore: null,
    markerSeparationError: null,
    markerTimingAgreement: null,
    markerSeparationPpm: null,
    clockRatio: null,
    driftPpm: null,
    expectedMarkerSeparationSamples: null,
    observedMarkerSeparationSamples: null,
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
    correlation[start] = energy > 1e-12
      ? Math.min(1, Math.abs(dot) / Math.sqrt(markerEnergy * energy))
      : 0
  }
  return correlation
}

function markerCandidates(
  correlation: Float64Array,
  threshold = MARKER_DISCOVERY_FLOOR,
  minimumDistance = 1,
): number[] {
  const candidates: number[] = []
  for (let index = 0; index < correlation.length; index++) {
    const value = correlation[index]
    if (value < threshold) continue
    if (index > 0 && value < correlation[index - 1]) continue
    if (index + 1 < correlation.length && value < correlation[index + 1]) continue
    candidates.push(index)
  }
  candidates.sort((left, right) => correlation[right] - correlation[left])
  const selected: number[] = []
  for (const candidate of candidates) {
    if (selected.some((existing) => Math.abs(existing - candidate) < minimumDistance)) continue
    selected.push(candidate)
    if (selected.length >= MAX_MARKER_CANDIDATES) break
  }
  return selected
}

function strongestCorrelation(correlation: Float64Array): { sample: number | null; confidence: number } {
  let sample: number | null = null
  let confidence = 0
  for (let index = 0; index < correlation.length; index++) {
    const value = correlation[index]
    if (value > confidence) {
      sample = index
      confidence = value
    }
  }
  return { sample, confidence }
}

interface MarkerPair {
  leading: number
  trailing: number
  leadingConfidence: number
  trailingConfidence: number
  observedSeparationSamples: number
  clockRatio: number
  driftPpm: number
  separationError: number
  timingAgreement: number
  score: number
}

function timingAgreement(separationError: number): number {
  // The normalized separation error is the absolute clock-ratio error.
  const absoluteDrift = Math.abs(separationError) * 1_000_000
  if (!Number.isFinite(absoluteDrift)) return 0
  if (absoluteDrift <= CLOCK_DRIFT_WARNING_PPM) return 1
  return Math.max(0, Math.min(
    1,
    (CLOCK_DRIFT_HARD_REJECT_PPM - absoluteDrift)
      / (CLOCK_DRIFT_HARD_REJECT_PPM - CLOCK_DRIFT_WARNING_PPM),
  ))
}

function markerPairScore(
  leadingConfidence: number,
  trailingConfidence: number,
  separationError: number,
): number {
  const minimumCorrelation = Math.min(leadingConfidence, trailingConfidence)
  const geometricCorrelation = Math.sqrt(Math.max(0, leadingConfidence * trailingConfidence))
  const balancedCorrelation = minimumCorrelation * 0.7 + geometricCorrelation * 0.3
  const timingScore = timingAgreement(separationError)
  return balancedCorrelation * 0.5 + timingScore * 0.5
}

function createMarkerPair(
  leading: number,
  trailing: number,
  leadingConfidence: number,
  trailingConfidence: number,
  expectedSeparation: number,
): MarkerPair | null {
  if (trailing <= leading || !(expectedSeparation > 0)) return null
  const separation = trailing - leading
  const clockRatio = separation / expectedSeparation
  const driftPpm = (clockRatio - 1) * 1_000_000
  if (!Number.isFinite(clockRatio) || !Number.isFinite(driftPpm)) return null
  const separationError = Math.abs(separation - expectedSeparation) / expectedSeparation
  const timingScore = timingAgreement(separationError)
  return {
    leading,
    trailing,
    leadingConfidence,
    trailingConfidence,
    observedSeparationSamples: separation,
    clockRatio,
    driftPpm,
    separationError,
    timingAgreement: timingScore,
    score: markerPairScore(leadingConfidence, trailingConfidence, separationError),
  }
}

function betterMarkerPair(candidate: MarkerPair, current: MarkerPair | null): MarkerPair {
  if (!current) return candidate
  if (candidate.score !== current.score) return candidate.score > current.score ? candidate : current
  if (candidate.separationError !== current.separationError) {
    return candidate.separationError < current.separationError ? candidate : current
  }
  if (candidate.leading !== current.leading) return candidate.leading < current.leading ? candidate : current
  return candidate.trailing < current.trailing ? candidate : current
}

function detectionWithPair(
  base: SweepDetection,
  pair: MarkerPair,
  sweep: MeasurementSweep,
  sampleRate: number,
  tvParts: ReturnType<typeof sweepSampleParts>,
  accepted: boolean,
  failureReason: SyncMarkerFailureReason | null,
): SweepDetection {
  const nominalCapturePerTvFrame = sampleRate / sweep.sampleRate
  const activeSweepOffsetInTvFrames = tvParts.sweepStartSamples - tvParts.leadingMarkerStartSamples
  const rightSweepOffsetInTvFrames = tvParts.rightSweepStartSamples - tvParts.leadingMarkerStartSamples
  const startSample = pair.leading + Math.round(activeSweepOffsetInTvFrames * nominalCapturePerTvFrame * pair.clockRatio)
  const rightStartSample = pair.leading + Math.round(rightSweepOffsetInTvFrames * nominalCapturePerTvFrame * pair.clockRatio)
  const clockEstimateTrusted = accepted || (
    Math.min(pair.leadingConfidence, pair.trailingConfidence)
      >= CLOCK_DRIFT_ESTIMATE_MIN_CORRELATION
      && failureReason === 'clock_drift_unreliable'
  )
  return {
    ...base,
    found: accepted,
    startSample: accepted ? startSample : null,
    rightStartSample: accepted ? rightStartSample : null,
    leadingMarkerSample: pair.leading,
    trailingMarkerSample: pair.trailing,
    offsetMs: accepted ? startSample * 1000 / sampleRate : null,
    confidence: pair.score,
    endingMarkerConfidence: pair.trailingConfidence,
    markerPairScore: pair.score,
    markerSeparationError: pair.separationError,
    markerTimingAgreement: pair.timingAgreement,
    markerSeparationPpm: pair.driftPpm,
    clockRatio: pair.clockRatio,
    driftPpm: clockEstimateTrusted ? pair.driftPpm : null,
    observedMarkerSeparationSamples: pair.observedSeparationSamples,
    failureReason,
  }
}

function detectionFailureForPeaks(
  leadingConfidence: number,
  trailingConfidence: number,
): SyncMarkerFailureReason {
  if (leadingConfidence < MARKER_DISCOVERY_FLOOR && trailingConfidence < MARKER_DISCOVERY_FLOOR) return 'marker_absent'
  if (leadingConfidence >= MARKER_MIN_CORRELATION && trailingConfidence < MARKER_MIN_CORRELATION) return 'end_marker_missing'
  return 'marker_pair_low_confidence'
}

function detectionFailureForTimingPair(pair: MarkerPair): SyncMarkerFailureReason {
  return Math.min(pair.leadingConfidence, pair.trailingConfidence) < CLOCK_DRIFT_ESTIMATE_MIN_CORRELATION
    ? 'marker_pair_low_confidence'
    : 'clock_drift_unreliable'
}

function detectSyncMarkers(samples: Float32Array, sweep: MeasurementSweep, sampleRate: number): SweepDetection {
  const tvParts = sweepSampleParts(sweep, sweep.sampleRate)
  const expectedTvSeparation = tvParts.trailingMarkerStartSamples - tvParts.leadingMarkerStartSamples
  const nominalCapturePerTvFrame = sampleRate / sweep.sampleRate
  const expectedSeparation = expectedTvSeparation * nominalCapturePerTvFrame
  const startMarker = generateSyncMarker(sweep, sampleRate, 'start')
  const endMarker = generateSyncMarker(sweep, sampleRate, 'end')
  const startCorrelation = normalizedMarkerCorrelation(samples, startMarker)
  const endCorrelation = normalizedMarkerCorrelation(samples, endMarker)
  const leadingPeak = strongestCorrelation(startCorrelation)
  const trailingPeak = strongestCorrelation(endCorrelation)
  const rawPair = leadingPeak.sample === null || trailingPeak.sample === null
    ? null
    : createMarkerPair(
      leadingPeak.sample,
      trailingPeak.sample,
      leadingPeak.confidence,
      trailingPeak.confidence,
      expectedSeparation,
    )
  const base = {
    ...emptySweepDetection(detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence)),
    expectedMarkerSeparationSamples: expectedSeparation,
    leadingMarkerSample: leadingPeak.sample,
    trailingMarkerSample: trailingPeak.sample,
    rawLeadingMarkerConfidence: leadingPeak.confidence,
    rawTrailingMarkerConfidence: trailingPeak.confidence,
    bestLeadingMarkerSample: leadingPeak.sample,
    bestTrailingMarkerSample: trailingPeak.sample,
    confidence: rawPair?.score ?? Math.min(leadingPeak.confidence, trailingPeak.confidence),
    endingMarkerConfidence: trailingPeak.confidence,
    markerPairScore: rawPair?.score ?? null,
    markerSeparationError: rawPair?.separationError ?? null,
    markerTimingAgreement: rawPair?.timingAgreement ?? null,
    markerSeparationPpm: rawPair?.driftPpm ?? null,
    clockRatio: rawPair?.clockRatio ?? null,
    driftPpm: null,
    observedMarkerSeparationSamples: rawPair?.observedSeparationSamples ?? null,
  }
  if (startCorrelation.length === 0 || endCorrelation.length === 0) return base

  const startCandidates = markerCandidates(
    startCorrelation,
    MARKER_DISCOVERY_FLOOR,
    Math.max(1, Math.floor(startMarker.length * MARKER_CANDIDATE_DEDUP_DISTANCE_FRACTION)),
  )
  const endCandidates = markerCandidates(
    endCorrelation,
    MARKER_DISCOVERY_FLOOR,
    Math.max(1, Math.floor(endMarker.length * MARKER_CANDIDATE_DEDUP_DISTANCE_FRACTION)),
  )
  let bestOrdered: MarkerPair | null = null
  let bestWithinSearchWindow: MarkerPair | null = null
  let bestWithinHardLimit: MarkerPair | null = null
  for (const leading of startCandidates) {
    for (const trailing of endCandidates) {
      const pair = createMarkerPair(leading, trailing, startCorrelation[leading], endCorrelation[trailing], expectedSeparation)
      if (!pair) continue
      bestOrdered = betterMarkerPair(pair, bestOrdered)
      if (Math.abs(pair.driftPpm) <= MARKER_PAIR_SEARCH_MAX_DRIFT_PPM) {
        bestWithinSearchWindow = betterMarkerPair(pair, bestWithinSearchWindow)
      }
      if (Math.abs(pair.driftPpm) <= CLOCK_DRIFT_HARD_REJECT_PPM) {
        bestWithinHardLimit = betterMarkerPair(pair, bestWithinHardLimit)
      }
    }
  }
  if (bestWithinHardLimit) {
    const minimumConfidence = Math.min(bestWithinHardLimit.leadingConfidence, bestWithinHardLimit.trailingConfidence)
    const accepted = minimumConfidence >= MARKER_MIN_CORRELATION
      && bestWithinHardLimit.score >= MARKER_PAIR_SCORE_THRESHOLD
    const peakFailure = detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence)
    return detectionWithPair(
      base,
      bestWithinHardLimit,
      sweep,
      sampleRate,
      tvParts,
      accepted,
      accepted ? null : peakFailure,
    )
  }
  if (bestWithinSearchWindow) {
    const peakFailure = detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence)
    if (peakFailure === 'marker_absent' || peakFailure === 'end_marker_missing') {
      return detectionWithPair(
        base,
        bestWithinSearchWindow,
        sweep,
        sampleRate,
        tvParts,
        false,
        peakFailure,
      )
    }
    return detectionWithPair(
      base,
      bestWithinSearchWindow,
      sweep,
      sampleRate,
      tvParts,
      false,
      detectionFailureForTimingPair(bestWithinSearchWindow),
    )
  }
  if (bestOrdered) {
    const peakFailure = detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence)
    if (peakFailure === 'marker_absent' || peakFailure === 'end_marker_missing') {
      return detectionWithPair(
        base,
        bestOrdered,
        sweep,
        sampleRate,
        tvParts,
        false,
        peakFailure,
      )
    }
    return detectionWithPair(
      base,
      bestOrdered,
      sweep,
      sampleRate,
      tvParts,
      false,
      'marker_pair_bad_timing',
    )
  }
  const peakFailure = detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence)
  if (peakFailure === 'marker_absent' || peakFailure === 'end_marker_missing') {
    return {
      ...base,
      failureReason: peakFailure,
    }
  }
  if (startCandidates.length > 0 && endCandidates.length > 0) {
    return {
      ...base,
      failureReason: 'marker_pair_bad_timing',
    }
  }
  return {
    ...base,
    failureReason: detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence),
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
    envelopeOnlyOffsetMs: fallbackStartSample === null ? null : fallbackStartSample * 1000 / sampleRate,
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

interface MeasurementWindowOptions {
  detection?: SweepDetection
  postRollMs?: number
  noiseAnchorSample?: number
}

function analyzeMeasurementWindow(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
  options: MeasurementWindowOptions = {},
): MeasurementAnalysis {
  const centeredSamples = removeDc(samples)
  const wholeCaptureSignal = calculateSignalStats(centeredSamples)
  const detection = options.detection ?? detectSweepStart(centeredSamples, sweep, sampleRate)
  const analysisSweep = options.postRollMs === undefined
    ? sweep
    : { ...sweep, postRollMs: options.postRollMs }
  const parts = sweepSampleParts(analysisSweep, sampleRate)
  const activeEnd = detection.startSample === null
    ? centeredSamples.length
    : detection.startSample + Math.ceil(
      (parts.sweepSamples + parts.postRollSamples)
      * (detection.clockRatio ?? 1),
    )
  const signal = detection.startSample === null
    ? wholeCaptureSignal
    : calculateSignalStats(centeredSamples, detection.startSample, activeEnd)
  const baseDiagnostics: MeasurementAnalysisDiagnostics = {
    detected: detection.found,
    detectionOffsetMs: detection.offsetMs,
    envelopeOnlyOffsetMs: detection.envelopeOnlyOffsetMs,
    detectionConfidence: detection.confidence,
    endingMarkerConfidence: detection.endingMarkerConfidence,
    rawLeadingMarkerConfidence: detection.rawLeadingMarkerConfidence,
    rawTrailingMarkerConfidence: detection.rawTrailingMarkerConfidence,
    bestLeadingMarkerSample: detection.bestLeadingMarkerSample,
    bestTrailingMarkerSample: detection.bestTrailingMarkerSample,
    markerPairScore: detection.markerPairScore,
    markerSeparationError: detection.markerSeparationError,
    markerTimingAgreement: detection.markerTimingAgreement,
    markerSeparationPpm: detection.markerSeparationPpm,
    syncMarkerFailureReason: detection.failureReason,
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
    return emptyAnalysis(
      detection.failureReason === 'clock_drift_unreliable'
        ? 'clock_drift_unreliable'
        : 'sync_marker_not_found',
      micProfile,
      baseDiagnostics,
    )
  }

  const noiseAnchorSample = options.noiseAnchorSample ?? detection.leadingMarkerSample ?? detection.startSample
  const captureNoiseRms = estimateCaptureNoiseRms(centeredSamples, sampleRate, analysisSweep, detection.startSample, noiseAnchorSample)
  const snrEstimateDb = estimateSnr(centeredSamples, sampleRate, analysisSweep, detection.startSample, noiseAnchorSample)
  const diagnostics = { ...baseDiagnostics, snrEstimateDb }
  if (snrEstimateDb !== null && snrEstimateDb < 8) return emptyAnalysis('signal_too_low', micProfile, diagnostics)

  const deconvolution = deconvolveSweep(
    centeredSamples,
    sampleRate,
    analysisSweep,
    detection.startSample,
    detection.clockRatio ?? 1,
    captureNoiseRms,
  )
  if (deconvolution.kind === 'capture_too_short') {
    return emptyAnalysis('capture_too_short', micProfile, diagnostics)
  }
  const directArrival = deconvolution.summary.directArrival
  const diagnosticsWithDirectArrival: MeasurementAnalysisDiagnostics = {
    ...diagnostics,
    directPeak: directArrival.directPeak,
    deconvolvedNoiseFloorRms: directArrival.noiseFloorRms,
    directPeakToNoiseDb: directArrival.peakToNoiseDb,
    directArrivalAcceptanceThreshold: directArrival.acceptanceThreshold,
    directArrivalCandidateSample: directArrival.candidateArrivalIndex,
    directArrivalAcceptedSample: directArrival.acceptedArrivalIndex,
    directArrivalRejectionReason: directArrival.rejectionReason,
  }
  if (directArrival.acceptedArrivalIndex === null) {
    return emptyAnalysis(
      directArrival.candidateArrivalIndex === null ? 'impulse_not_found' : 'direct_arrival_low_confidence',
      micProfile,
      diagnosticsWithDirectArrival,
    )
  }
  const rawPoints = normalizeResponsePoints(windowedImpulseResponse(
    deconvolution.samples,
    sampleRate,
    analysisSweep.startHz,
    analysisSweep.endHz,
    48,
    deconvolution.summary.noiseFloorRms,
  ))
  if (rawPoints.length === 0) return emptyAnalysis('response_not_generated', micProfile, diagnosticsWithDirectArrival)
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
      ...diagnosticsWithDirectArrival,
      frequencyPoints: correctedPoints.length,
      failureReason: signal.clippedSamples > 0 ? 'capture_clipped' : null,
    },
  }
}

export function analyzeMeasurement(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
): MeasurementAnalysis {
  return analyzeMeasurementWindow(samples, sampleRate, sweep, micProfile)
}

export interface CompositeMeasurementAnalysis {
  status: 'ok' | 'partial' | MeasurementAnalysisFailure
  detection: SweepDetection
  left: MeasurementAnalysis
  right: MeasurementAnalysis
}

/** Analyze both routed sweeps from one physical-position recording. */
export function analyzeCompositeMeasurement(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
): CompositeMeasurementAnalysis {
  const centeredSamples = removeDc(samples)
  const detection = detectSweepStart(centeredSamples, sweep, sampleRate)
  if (!detection.found || detection.startSample === null || detection.rightStartSample === null) {
    const failed = analyzeMeasurementWindow(centeredSamples, sampleRate, sweep, micProfile, { detection })
    return { status: failed.status, detection, left: failed, right: failed }
  }

  const noiseAnchorSample = detection.leadingMarkerSample ?? detection.startSample
  const left = analyzeMeasurementWindow(centeredSamples, sampleRate, sweep, micProfile, {
    detection,
    postRollMs: sweep.interSweepGapMs,
    noiseAnchorSample,
  })
  const rightDetection: SweepDetection = {
    ...detection,
    startSample: detection.rightStartSample,
    offsetMs: detection.rightStartSample * 1000 / sampleRate,
  }
  const right = analyzeMeasurementWindow(centeredSamples, sampleRate, sweep, micProfile, {
    detection: rightDetection,
    postRollMs: sweep.postRollMs,
    noiseAnchorSample,
  })
  const leftAccepted = left.status === 'ok'
  const rightAccepted = right.status === 'ok'
  return {
    status: leftAccepted && rightAccepted
      ? 'ok'
      : leftAccepted || rightAccepted
        ? 'partial'
        : left.status,
    detection,
    left,
    right,
  }
}
