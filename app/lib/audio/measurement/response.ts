import type {
  MeasurementMarkerCandidate,
  MeasurementMarkerPairCandidate,
  MeasurementSweep,
  MeasurementSyncMarkerFailureReason,
} from '#shared/types/protocol'
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
import {
  detectSweepStart,
  isMarkerDiagnosticCaptureKind,
} from './marker-detection'
import type { SweepDetection } from './marker-detection'

export { CLOCK_DRIFT_HARD_REJECT_PPM, detectSweepStart } from './marker-detection'
export type { SweepDetection } from './marker-detection'

type SyncMarkerFailureReason = MeasurementSyncMarkerFailureReason

export interface ResponsePoint {
  frequencyHz: number
  magnitudeDb: number
}
type MeasurementAnalysisFailure = Exclude<MeasurementAnalysisStatus, 'ok'>

interface MeasurementAnalysisDiagnostics {
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
  leadingMarkerCandidates: MeasurementMarkerCandidate[]
  trailingMarkerCandidates: MeasurementMarkerCandidate[]
  markerPairCandidates: MeasurementMarkerPairCandidate[]
  leadingBestCorrelation: number | null
  leadingSecondCorrelation: number | null
  leadingCorrelationMargin: number | null
  trailingBestCorrelation: number | null
  trailingSecondCorrelation: number | null
  trailingCorrelationMargin: number | null
  markerPairScore: number | null
  secondMarkerPairScore: number | null
  markerPairScoreMargin: number | null
  markerPairScoreRatio: number | null
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
  directSupportWindowRms?: number | null
  directSupportWindowThreshold?: number | null
  directSupportSampleCount?: number | null
  bestLaterReflectionSample?: number | null
  bestLaterReflectionPeak?: number | null
  candidateAbsoluteTimeMs?: number | null
  earlySearchWindowStartSample?: number | null
  earlySearchWindowEndSample?: number | null
  topEarlyImpulsePeaks?: Array<{ sample: number; amplitude: number; peakToNoiseDb: number | null }>
  strongestLaterReflectionDelayMs?: number | null
  localSupportWindowStartSample?: number | null
  localSupportWindowEndSample?: number | null
  localSupportWindowMax?: number | null
  localSupportSampleCount?: number | null
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
  markerOnly?: boolean
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
    leadingMarkerCandidates: detection.leadingMarkerCandidates,
    trailingMarkerCandidates: detection.trailingMarkerCandidates,
    markerPairCandidates: detection.markerPairCandidates,
    leadingBestCorrelation: detection.leadingBestCorrelation,
    leadingSecondCorrelation: detection.leadingSecondCorrelation,
    leadingCorrelationMargin: detection.leadingCorrelationMargin,
    trailingBestCorrelation: detection.trailingBestCorrelation,
    trailingSecondCorrelation: detection.trailingSecondCorrelation,
    trailingCorrelationMargin: detection.trailingCorrelationMargin,
    markerPairScore: detection.markerPairScore,
    secondMarkerPairScore: detection.secondMarkerPairScore,
    markerPairScoreMargin: detection.markerPairScoreMargin,
    markerPairScoreRatio: detection.markerPairScoreRatio,
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
  if (options.markerOnly) return emptyAnalysis(detection.found ? 'ok' : 'sync_marker_not_found', micProfile, baseDiagnostics)
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
    directSupportWindowRms: directArrival.supportWindowRms,
    directSupportWindowThreshold: directArrival.supportWindowThreshold,
    directSupportSampleCount: directArrival.supportSampleCount,
    bestLaterReflectionSample: directArrival.laterReflectionIndex,
    bestLaterReflectionPeak: directArrival.laterReflectionPeak,
    candidateAbsoluteTimeMs: directArrival.candidateAbsoluteTimeMs,
    earlySearchWindowStartSample: directArrival.earlySearchWindowStartSample,
    earlySearchWindowEndSample: directArrival.earlySearchWindowEndSample,
    topEarlyImpulsePeaks: directArrival.topEarlyImpulsePeaks,
    strongestLaterReflectionDelayMs: directArrival.strongestLaterReflectionDelayMs,
    localSupportWindowStartSample: directArrival.localSupportWindowStartSample,
    localSupportWindowEndSample: directArrival.localSupportWindowEndSample,
    localSupportWindowMax: directArrival.localSupportWindowMax,
    localSupportSampleCount: directArrival.localSupportSampleCount,
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
  if (isMarkerDiagnosticCaptureKind(sweep.captureKind)) {
    const markerAnalysis = analyzeMeasurementWindow(centeredSamples, sampleRate, sweep, micProfile, {
      detection,
      markerOnly: true,
    })
    return { status: markerAnalysis.status, detection, left: markerAnalysis, right: markerAnalysis }
  }
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
