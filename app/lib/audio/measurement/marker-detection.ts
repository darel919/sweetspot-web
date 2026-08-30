import type {
  MeasurementMarkerCandidate,
  MeasurementMarkerPairCandidate,
  MeasurementSweep,
  MeasurementSyncMarkerFailureReason,
} from '#shared/types/protocol'
import { generateSyncMarker, sweepSampleParts } from '../sweep-reference'
import { fftInPlace, nextPowerOfTwo } from './fft'

export function isMarkerDiagnosticCaptureKind(value: MeasurementSweep['captureKind']): boolean {
  return value === 'marker-only' || value === 'marker-production-spacing'
}

/** Expected recorder/TV clock mismatch is normally within 250 ppm. */
const CLOCK_DRIFT_WARNING_PPM = 250
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
const MAX_EXPORTED_MARKER_CANDIDATES = 16
const MAX_MARKER_SEARCH_CANDIDATES = 64
const MARKER_CANDIDATE_DEDUP_DISTANCE_FRACTION = 1 / 32
const MARKER_AMBIGUITY_MIN_CORRELATION = MARKER_MIN_CORRELATION
const MARKER_PAIR_AMBIGUITY_MARGIN = 0.05
const MARKER_PAIR_AMBIGUITY_RATIO = 1.1
type SyncMarkerFailureReason = MeasurementSyncMarkerFailureReason
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
    leadingMarkerCandidates: [],
    trailingMarkerCandidates: [],
    markerPairCandidates: [],
    leadingBestCorrelation: null,
    leadingSecondCorrelation: null,
    leadingCorrelationMargin: null,
    trailingBestCorrelation: null,
    trailingSecondCorrelation: null,
    trailingCorrelationMargin: null,
    markerPairScore: null,
    secondMarkerPairScore: null,
    markerPairScoreMargin: null,
    markerPairScoreRatio: null,
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
  maxCandidates = MAX_MARKER_SEARCH_CANDIDATES,
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
    if (selected.length >= maxCandidates) break
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
  if (leadingConfidence < MARKER_MIN_CORRELATION && trailingConfidence < MARKER_MIN_CORRELATION) return 'marker_pair_low_confidence'
  if (leadingConfidence < MARKER_MIN_CORRELATION) return 'leading_marker_weak'
  if (trailingConfidence < MARKER_MIN_CORRELATION) return 'trailing_marker_weak'
  return 'marker_pair_low_confidence'
}

function detectionFailureForTimingPair(pair: MarkerPair): SyncMarkerFailureReason {
  return Math.min(pair.leadingConfidence, pair.trailingConfidence) < CLOCK_DRIFT_ESTIMATE_MIN_CORRELATION
    ? 'marker_pair_low_confidence'
    : 'clock_drift_unreliable'
}

function blockRms(samples: Float32Array, start: number, length: number): number {
  let sumSquares = 0
  const end = Math.min(samples.length, start + length)
  for (let index = start; index < end; index++) sumSquares += samples[index] * samples[index]
  const count = end - start
  return count > 0 ? Math.sqrt(sumSquares / count) : 0
}

function markerCandidateStats(candidates: readonly number[], correlation: Float64Array): {
  values: MeasurementMarkerCandidate[]
  best: number | null
  second: number | null
  margin: number | null
} {
  const values = candidates.map((sample) => ({ sample, correlation: correlation[sample] ?? 0 }))
  const best = values[0]?.correlation ?? null
  const second = values[1]?.correlation ?? null
  return {
    values,
    best,
    second,
    margin: best === null || second === null ? null : best - second,
  }
}

function markerPairRejectionReason(pair: MarkerPair): SyncMarkerFailureReason | null {
  if (Math.abs(pair.driftPpm) > MARKER_PAIR_SEARCH_MAX_DRIFT_PPM) return 'marker_pair_bad_timing'
  if (Math.abs(pair.driftPpm) > CLOCK_DRIFT_HARD_REJECT_PPM) return detectionFailureForTimingPair(pair)
  if (Math.min(pair.leadingConfidence, pair.trailingConfidence) < MARKER_MIN_CORRELATION) {
    return detectionFailureForPeaks(pair.leadingConfidence, pair.trailingConfidence)
  }
  return pair.score >= MARKER_PAIR_SCORE_THRESHOLD ? null : 'marker_pair_low_confidence'
}

function markerPairCandidate(
  pair: MarkerPair,
  accepted: boolean,
  rejectionReason: MeasurementSyncMarkerFailureReason | null,
): MeasurementMarkerPairCandidate {
  return {
    leadingSample: pair.leading,
    trailingSample: pair.trailing,
    leadingCorrelation: pair.leadingConfidence,
    trailingCorrelation: pair.trailingConfidence,
    observedSeparationSamples: pair.observedSeparationSamples,
    separationPpm: pair.driftPpm,
    timingAgreement: pair.timingAgreement,
    pairScore: pair.score,
    accepted,
    rejectionReason,
  }
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
  const leadingStats = markerCandidateStats(startCandidates, startCorrelation)
  const trailingStats = markerCandidateStats(endCandidates, endCorrelation)
  const exportedLeadingStats = markerCandidateStats(startCandidates.slice(0, MAX_EXPORTED_MARKER_CANDIDATES), startCorrelation)
  const exportedTrailingStats = markerCandidateStats(endCandidates.slice(0, MAX_EXPORTED_MARKER_CANDIDATES), endCorrelation)
  const baseWithCandidates: SweepDetection = {
    ...base,
    leadingMarkerCandidates: exportedLeadingStats.values,
    trailingMarkerCandidates: exportedTrailingStats.values,
    leadingBestCorrelation: leadingStats.best,
    leadingSecondCorrelation: leadingStats.second,
    leadingCorrelationMargin: leadingStats.margin,
    trailingBestCorrelation: trailingStats.best,
    trailingSecondCorrelation: trailingStats.second,
    trailingCorrelationMargin: trailingStats.margin,
  }
  let bestOrdered: MarkerPair | null = null
  let bestWithinSearchWindow: MarkerPair | null = null
  let bestWithinHardLimit: MarkerPair | null = null
  const allPairs: MarkerPair[] = []
  for (const leading of startCandidates) {
    for (const trailing of endCandidates) {
      const pair = createMarkerPair(leading, trailing, startCorrelation[leading], endCorrelation[trailing], expectedSeparation)
      if (!pair) continue
      allPairs.push(pair)
      bestOrdered = betterMarkerPair(pair, bestOrdered)
      if (Math.abs(pair.driftPpm) <= MARKER_PAIR_SEARCH_MAX_DRIFT_PPM) {
        bestWithinSearchWindow = betterMarkerPair(pair, bestWithinSearchWindow)
      }
      if (Math.abs(pair.driftPpm) <= CLOCK_DRIFT_HARD_REJECT_PPM) {
        bestWithinHardLimit = betterMarkerPair(pair, bestWithinHardLimit)
      }
    }
  }
  allPairs.sort((left, right) => right.score - left.score || left.separationError - right.separationError)
  const selectedPair = bestWithinHardLimit ?? bestWithinSearchWindow ?? bestOrdered
  const plausiblePairs = allPairs.filter((pair) =>
    Math.abs(pair.driftPpm) <= MARKER_PAIR_SEARCH_MAX_DRIFT_PPM
      && Math.min(pair.leadingConfidence, pair.trailingConfidence) >= MARKER_AMBIGUITY_MIN_CORRELATION,
  )
  const secondPair = selectedPair
    ? plausiblePairs.find((pair) => {
      const leadingDistance = Math.abs(pair.leading - selectedPair.leading)
      const trailingDistance = Math.abs(pair.trailing - selectedPair.trailing)
      const markerLobeDistance = Math.max(4, Math.round(Math.min(startMarker.length, endMarker.length) * 0.25))
      return (leadingDistance >= markerLobeDistance || trailingDistance >= markerLobeDistance)
        && (pair.leading !== selectedPair.leading || pair.trailing !== selectedPair.trailing)
    }) ?? null
    : null
  const pairIsAmbiguous = selectedPair !== null
    && secondPair !== null
    && (selectedPair.score - secondPair.score < MARKER_PAIR_AMBIGUITY_MARGIN
      || (secondPair.score > 0 && selectedPair.score / secondPair.score < MARKER_PAIR_AMBIGUITY_RATIO))
  const baseWithPairCandidates: SweepDetection = {
    ...baseWithCandidates,
    markerPairCandidates: (selectedPair === null
      ? allPairs.slice(0, MAX_EXPORTED_MARKER_CANDIDATES)
      : [selectedPair, ...allPairs.filter((pair) => pair !== selectedPair).slice(0, MAX_EXPORTED_MARKER_CANDIDATES - 1)]).map((pair) => {
      const rejectionReason = pair === selectedPair && pairIsAmbiguous
        ? 'marker_pair_ambiguous'
        : markerPairRejectionReason(pair)
      return markerPairCandidate(pair, pair === selectedPair && rejectionReason === null, rejectionReason)
    }),
    secondMarkerPairScore: secondPair?.score ?? null,
    markerPairScoreMargin: selectedPair && secondPair ? selectedPair.score - secondPair.score : null,
    markerPairScoreRatio: selectedPair && secondPair && secondPair.score > 0 ? selectedPair.score / secondPair.score : null,
  }
  const peakFailure = detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence)
  const minimumPeakConfidence = Math.min(leadingPeak.confidence, trailingPeak.confidence)
  const weakPairEvidence = minimumPeakConfidence < CLOCK_DRIFT_ESTIMATE_MIN_CORRELATION
    && (minimumPeakConfidence < MARKER_MIN_CORRELATION || (bestOrdered?.score ?? 0) < MARKER_PAIR_SCORE_THRESHOLD)
  if (bestOrdered && pairIsAmbiguous) {
    return detectionWithPair(
      baseWithPairCandidates,
      bestOrdered,
      sweep,
      sampleRate,
      tvParts,
      false,
      'marker_pair_ambiguous',
    )
  }
  if (bestOrdered && weakPairEvidence) {
    return detectionWithPair(
      baseWithPairCandidates,
      bestOrdered,
      sweep,
      sampleRate,
      tvParts,
      false,
      Math.abs(bestOrdered.driftPpm) > MARKER_PAIR_SEARCH_MAX_DRIFT_PPM && peakFailure === 'marker_pair_low_confidence'
        ? 'marker_pair_bad_timing'
        : peakFailure,
    )
  }
  if (bestWithinHardLimit) {
    const selectedFailure = pairIsAmbiguous
      ? 'marker_pair_ambiguous'
      : markerPairRejectionReason(bestWithinHardLimit)
    const accepted = selectedFailure === null
    return detectionWithPair(
      baseWithPairCandidates,
      bestWithinHardLimit,
      sweep,
      sampleRate,
      tvParts,
      accepted,
      accepted ? null : (selectedFailure ?? peakFailure),
    )
  }
  if (bestWithinSearchWindow) {
    const peakFailure = detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence)
    if (peakFailure === 'marker_absent' || peakFailure === 'leading_marker_weak' || peakFailure === 'trailing_marker_weak') {
      return detectionWithPair(
        baseWithPairCandidates,
        bestWithinSearchWindow,
        sweep,
        sampleRate,
        tvParts,
        false,
        peakFailure,
      )
    }
    return detectionWithPair(
      baseWithPairCandidates,
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
    if (peakFailure === 'marker_absent' || peakFailure === 'leading_marker_weak' || peakFailure === 'trailing_marker_weak') {
      return detectionWithPair(
        baseWithPairCandidates,
        bestOrdered,
        sweep,
        sampleRate,
        tvParts,
        false,
        peakFailure,
      )
    }
    return detectionWithPair(
      baseWithPairCandidates,
      bestOrdered,
      sweep,
      sampleRate,
      tvParts,
      false,
      'marker_pair_bad_timing',
    )
  }
  const finalPeakFailure = detectionFailureForPeaks(leadingPeak.confidence, trailingPeak.confidence)
  if (finalPeakFailure === 'marker_absent' || finalPeakFailure === 'leading_marker_weak' || finalPeakFailure === 'trailing_marker_weak') {
    return {
      ...baseWithPairCandidates,
      failureReason: finalPeakFailure,
    }
  }
  if (startCandidates.length > 0 && endCandidates.length > 0) {
    return {
      ...baseWithPairCandidates,
      failureReason: 'marker_pair_bad_timing',
    }
  }
  return {
    ...baseWithPairCandidates,
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

