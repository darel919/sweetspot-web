import type { AggregateResponse, PositionResponse } from '../measurement/aggregation'
import type { ResponsePoint } from '../measurement/response'

export const SHARED_LF_COMMON_THROUGH_HZ = 120
export const SHARED_LF_INDEPENDENT_FROM_HZ = 250

export interface SharedLfPolicy {
  commonThroughHz: number
  independentFromHz: number
}

export interface SharedLfAssessment {
  confidence: number
  estimatedUpperHz: number | null
  shapeMismatchDb: number | null
  spatialFingerprintMismatchDb: number | null
  classification: 'likely-shared' | 'uncertain' | 'likely-independent'
}

export interface SharedLfBlendResult {
  left: ResponsePoint[]
  right: ResponsePoint[]
}

export const DEFAULT_SHARED_LF_POLICY: SharedLfPolicy = {
  commonThroughHz: SHARED_LF_COMMON_THROUGH_HZ,
  independentFromHz: SHARED_LF_INDEPENDENT_FROM_HZ,
}

const SHARED_LF_ANALYSIS_MIN_HZ = 30
const SHARED_LF_ANALYSIS_MAX_HZ = 300
const SHARED_LF_ANALYSIS_POINT_COUNT = 25
const SHARED_LF_SHAPE_MATCH_THRESHOLD_DB = 1.5
const SHARED_LF_INDEPENDENT_MISMATCH_THRESHOLD_DB = 3
const SHARED_LF_MIN_CONTIGUOUS_SPAN_HZ = 90
const SHARED_LF_MIN_PAIRED_POSITIONS = 3
const SHARED_LF_MIN_PAIR_COVERAGE = 0.8

const SHARED_LF_ANALYSIS_FREQUENCIES = Array.from(
  { length: SHARED_LF_ANALYSIS_POINT_COUNT },
  (_, index) => SHARED_LF_ANALYSIS_MIN_HZ
    * (SHARED_LF_ANALYSIS_MAX_HZ / SHARED_LF_ANALYSIS_MIN_HZ) ** (index / (SHARED_LF_ANALYSIS_POINT_COUNT - 1)),
)

function median(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (finite.length === 0) return null
  const middle = Math.floor(finite.length / 2)
  const current = finite[middle]
  if (current === undefined) return null
  if (finite.length % 2 !== 0) return current
  const previous = finite[middle - 1]
  return previous === undefined ? current : (previous + current) / 2
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function interpolateLog(points: readonly ResponsePoint[], frequencyHz: number): number | null {
  if (points.length === 0) return null
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return null
  if (frequencyHz <= first.frequencyHz) return Number.isFinite(first.magnitudeDb) ? first.magnitudeDb : null
  if (frequencyHz >= last.frequencyHz) return Number.isFinite(last.magnitudeDb) ? last.magnitudeDb : null

  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    const point = points[middle]
    if (!point || point.frequencyHz <= frequencyHz) low = middle
    else high = middle
  }
  const lower = points[low]
  const upper = points[high]
  if (!lower || !upper || !(upper.frequencyHz > lower.frequencyHz)) return null
  const fraction = Math.log(frequencyHz / lower.frequencyHz) / Math.log(upper.frequencyHz / lower.frequencyHz)
  const value = lower.magnitudeDb + (upper.magnitudeDb - lower.magnitudeDb) * fraction
  return Number.isFinite(value) ? value : null
}

function correctionValue(points: readonly ResponsePoint[], frequencyHz: number): number {
  return interpolateLog(points, frequencyHz) ?? 0
}

function validatePolicy(policy: SharedLfPolicy): void {
  if (!Number.isFinite(policy.commonThroughHz)
    || !Number.isFinite(policy.independentFromHz)
    || policy.commonThroughHz <= 0
    || policy.independentFromHz <= policy.commonThroughHz) {
    throw new RangeError('Shared LF policy requires positive, increasing frequency boundaries.')
  }
}

function transitionWeight(frequencyHz: number, policy: SharedLfPolicy): number {
  if (frequencyHz <= policy.commonThroughHz) return 0
  if (frequencyHz >= policy.independentFromHz) return 1
  const position = Math.log(frequencyHz / policy.commonThroughHz)
    / Math.log(policy.independentFromHz / policy.commonThroughHz)
  const bounded = clamp(position)
  return bounded * bounded * (3 - 2 * bounded)
}

function blendPoint(
  commonValue: number,
  independentValue: number,
  weight: number,
): number {
  if (weight === 0) return commonValue
  if (weight === 1) return independentValue
  return commonValue * (1 - weight) + independentValue * weight
}

export function blendSharedLfCorrections(
  common: readonly ResponsePoint[],
  left: readonly ResponsePoint[],
  right: readonly ResponsePoint[],
  policy: SharedLfPolicy = DEFAULT_SHARED_LF_POLICY,
): SharedLfBlendResult {
  validatePolicy(policy)
  const blend = (independent: readonly ResponsePoint[]): ResponsePoint[] => common.map((point) => {
    const weight = transitionWeight(point.frequencyHz, policy)
    const commonValue = point.magnitudeDb
    const independentValue = correctionValue(independent, point.frequencyHz)
    return {
      frequencyHz: point.frequencyHz,
      magnitudeDb: blendPoint(commonValue, independentValue, weight),
    }
  })
  return {
    left: blend(left),
    right: blend(right),
  }
}

interface PairedPosition {
  left: PositionResponse
  right: PositionResponse
}

interface PairEvidence {
  leftValues: Array<number | null>
  rightValues: Array<number | null>
  residuals: Array<number | null>
}

interface FrequencyEvidence {
  frequencyHz: number
  shapeMismatchDb: number | null
  spatialFingerprintMismatchDb: number | null
  similar: boolean
  independent: boolean
}

function pairedPositions(left: AggregateResponse, right: AggregateResponse): PairedPosition[] {
  const rightByPosition = new Map(right.positionResponses.map((response) => [response.positionId, response]))
  return left.positionResponses.flatMap((leftResponse) => {
    const rightResponse = rightByPosition.get(leftResponse.positionId)
    return rightResponse ? [{ left: leftResponse, right: rightResponse }] : []
  })
}

function pairEvidenceForPosition(pair: PairedPosition): PairEvidence | null {
  const leftValues = SHARED_LF_ANALYSIS_FREQUENCIES.map((frequencyHz) => interpolateLog(pair.left.points, frequencyHz))
  const rightValues = SHARED_LF_ANALYSIS_FREQUENCIES.map((frequencyHz) => interpolateLog(pair.right.points, frequencyHz))
  const differences = leftValues.flatMap((value, index) => {
    const right = rightValues[index]
    return value !== null && right !== null ? [value - right] : []
  })
  const offset = median(differences)
  if (offset === null) return null
  return {
    leftValues,
    rightValues,
    residuals: leftValues.map((value, index) => {
      const right = rightValues[index]
      return value !== null && right !== null ? value - right - offset : null
    }),
  }
}

function spatialFingerprintMismatch(
  evidence: readonly PairEvidence[],
  index: number,
): number | null {
  const values = evidence.flatMap((pair) => {
    const left = pair.leftValues[index]
    const right = pair.rightValues[index]
    return left !== null && right !== null ? [{ left, right }] : []
  })
  if (values.length < 2) return null
  const leftMedian = median(values.map((value) => value.left))
  const rightMedian = median(values.map((value) => value.right))
  if (leftMedian === null || rightMedian === null) return null
  return median(values.map((value) => Math.abs((value.left - leftMedian) - (value.right - rightMedian))))
}

function frequencyEvidence(evidence: readonly PairEvidence[]): FrequencyEvidence[] {
  return SHARED_LF_ANALYSIS_FREQUENCIES.map((frequencyHz, index) => {
    const shapeMismatchDb = median(evidence.flatMap((pair) => {
      const residual = pair.residuals[index]
      return residual === null ? [] : [Math.abs(residual)]
    }))
    const spatialFingerprintMismatchDb = spatialFingerprintMismatch(evidence, index)
    const similar = shapeMismatchDb !== null
      && spatialFingerprintMismatchDb !== null
      && shapeMismatchDb <= SHARED_LF_SHAPE_MATCH_THRESHOLD_DB
      && spatialFingerprintMismatchDb <= SHARED_LF_SHAPE_MATCH_THRESHOLD_DB
    const independent = (shapeMismatchDb !== null && shapeMismatchDb >= SHARED_LF_INDEPENDENT_MISMATCH_THRESHOLD_DB)
      || (spatialFingerprintMismatchDb !== null && spatialFingerprintMismatchDb >= SHARED_LF_INDEPENDENT_MISMATCH_THRESHOLD_DB)
    return {
      frequencyHz,
      shapeMismatchDb,
      spatialFingerprintMismatchDb,
      similar,
      independent,
    }
  })
}

function contiguousLowFrequencySpan(
  evidence: readonly FrequencyEvidence[],
  predicate: (point: FrequencyEvidence) => boolean,
): { upperHz: number; spanHz: number } | null {
  let runStart = -1
  let best: { start: number; end: number } | null = null
  const closeRun = (end: number) => {
    if (runStart < 0) return
    if (!best || end - runStart > best.end - best.start) best = { start: runStart, end }
    runStart = -1
  }
  evidence.forEach((point, index) => {
    if (predicate(point)) {
      if (runStart < 0) runStart = index
      return
    }
    closeRun(index - 1)
  })
  closeRun(evidence.length - 1)
  if (!best || best.start > 0) return null
  const first = evidence[best.start]
  const last = evidence[best.end]
  if (!first || !last || last.frequencyHz - first.frequencyHz < SHARED_LF_MIN_CONTIGUOUS_SPAN_HZ) return null
  return { upperHz: last.frequencyHz, spanHz: last.frequencyHz - first.frequencyHz }
}

function expectedPositionCount(left: AggregateResponse, right: AggregateResponse): number {
  const leftCount = Math.max(0, ...left.positionResponses.map((response) => response.positionCount))
  const rightCount = Math.max(0, ...right.positionResponses.map((response) => response.positionCount))
  return Math.max(leftCount, rightCount)
}

function assessmentConfidence(
  evidenceFraction: number,
  span: { upperHz: number; spanHz: number } | null,
  pairCount: number,
  pairCoverage: number,
): number {
  const spanFraction = span === null
    ? 0
    : clamp(span.spanHz / (SHARED_LF_ANALYSIS_MAX_HZ - SHARED_LF_ANALYSIS_MIN_HZ))
  const pairFactor = pairCount >= SHARED_LF_MIN_PAIRED_POSITIONS
    ? 0.75 + 0.25 * pairCoverage
    : 0.5 * pairCount / SHARED_LF_MIN_PAIRED_POSITIONS
  return clamp((0.5 * evidenceFraction + 0.25 * pairCoverage + 0.25 * spanFraction) * pairFactor)
}

export function assessSharedLfReproduction(
  left: AggregateResponse,
  right: AggregateResponse,
): SharedLfAssessment {
  const pairs = pairedPositions(left, right)
  const evidence = pairs
    .map(pairEvidenceForPosition)
    .filter((value): value is PairEvidence => value !== null)
  if (evidence.length === 0) {
    return {
      confidence: 0,
      estimatedUpperHz: null,
      shapeMismatchDb: null,
      spatialFingerprintMismatchDb: null,
      classification: 'uncertain',
    }
  }

  const byFrequency = frequencyEvidence(evidence)
  const sharedCount = byFrequency.filter((point) => point.similar).length
  const independentCount = byFrequency.filter((point) => point.independent).length
  const sharedFraction = sharedCount / byFrequency.length
  const independentFraction = independentCount / byFrequency.length
  const sharedSpan = contiguousLowFrequencySpan(byFrequency, (point) => point.similar)
  const independentSpan = contiguousLowFrequencySpan(byFrequency, (point) => point.independent)
  const expected = expectedPositionCount(left, right)
  const pairCoverage = expected > 0 ? clamp(evidence.length / expected) : 0
  const shapeMismatchDb = median(byFrequency.flatMap((point) => point.shapeMismatchDb === null ? [] : [point.shapeMismatchDb]))
  const spatialFingerprintMismatchDb = median(byFrequency.flatMap((point) => point.spatialFingerprintMismatchDb === null ? [] : [point.spatialFingerprintMismatchDb]))
  const enoughPairs = evidence.length >= SHARED_LF_MIN_PAIRED_POSITIONS
  const enoughCoverage = pairCoverage >= SHARED_LF_MIN_PAIR_COVERAGE
  const likelyShared = enoughPairs && enoughCoverage && sharedSpan !== null && sharedFraction >= 0.75
  const likelyIndependent = enoughPairs && enoughCoverage && independentSpan !== null && independentFraction >= 0.75
  const classification = likelyShared
    ? 'likely-shared'
    : likelyIndependent
      ? 'likely-independent'
      : 'uncertain'
  const confidence = classification === 'likely-shared'
    ? assessmentConfidence(sharedFraction, sharedSpan, evidence.length, pairCoverage)
    : classification === 'likely-independent'
      ? assessmentConfidence(independentFraction, independentSpan, evidence.length, pairCoverage)
      : Math.max(
        assessmentConfidence(sharedFraction, sharedSpan, evidence.length, pairCoverage),
        assessmentConfidence(independentFraction, independentSpan, evidence.length, pairCoverage),
      )

  return {
    confidence,
    estimatedUpperHz: sharedSpan?.upperHz ?? null,
    shapeMismatchDb,
    spatialFingerprintMismatchDb,
    classification,
  }
}
