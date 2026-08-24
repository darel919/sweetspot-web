import { micTrustWeightAtHz } from '../mics/profile'
import type { MicCalibrationProfile } from '../mics/types'
import type { AggregateResponse, PositionResponse } from '../measurement/aggregation'
import type { ResponsePoint } from '../measurement/response'
import { smoothResponsePoints } from '../measurement/response'
import { detectLfCapability, targetPointsFor, type LfCapability } from './target'

export type CorrectionStrength = 'off' | 'gentle' | 'normal' | 'strong'

export interface CorrectionOptions {
  strength?: CorrectionStrength
  maxCutDb?: number
  maxBoostDb?: number
  headroomVerified?: boolean
}

export interface CorrectionResult {
  correction: ResponsePoint[]
  target: ResponsePoint[]
  lfCapability: LfCapability
  lfExtensionHz: number
  lfExtension3DbHz: number
  lfExtension6DbHz: number
  lfExtensionConfidence: number
  maxCutDb: number
  maxBoostDb: number
  headroomDb: number
}

const STRENGTH: Record<CorrectionStrength, number> = {
  off: 0,
  gentle: 0.5,
  normal: 0.75,
  strong: 1,
}

function spatialConfidence(spreadDb: number): number {
  if (!Number.isFinite(spreadDb)) return 0
  if (spreadDb <= 2) return 1
  if (spreadDb >= 6) return 0
  if (spreadDb <= 4) return 1 - (spreadDb - 2) * 0.375
  return 0.25 * (6 - spreadDb) / 2
}

function aggressionAtHz(frequencyHz: number): number {
  if (frequencyHz <= 200) return 1
  if (frequencyHz <= 1_000) return 0.75
  if (frequencyHz <= 8_000) return 0.45
  if (frequencyHz <= 12_000) return 0.2
  return 0.08
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function smoothError(points: readonly ResponsePoint[]): ResponsePoint[] {
  return smoothResponsePoints(points.map((point) => ({ ...point })), 2)
}

export function limitAdjacentSlope(
  points: readonly ResponsePoint[],
  maxStepDb = 2,
): ResponsePoint[] {
  let limited = points.map((point) => ({ ...point }))
  const iterations = Math.max(1, points.length * 32)
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = limited.map((point) => ({ ...point }))
    let changed = false
    for (let index = 0; index < limited.length - 1; index++) {
      const left = limited[index]
      const right = limited[index + 1]
      if (!left || !right) continue
      const delta = right.magnitudeDb - left.magnitudeDb
      if (Math.abs(delta) <= maxStepDb) continue
      const direction = Math.sign(delta)
      const adjustment = (Math.abs(delta) - maxStepDb) / 2
      const nextLeft = next[index]
      const nextRight = next[index + 1]
      if (!nextLeft || !nextRight) continue
      nextLeft.magnitudeDb += direction * adjustment
      nextRight.magnitudeDb -= direction * adjustment
      changed = true
    }
    limited = next
    if (!changed) break
  }
  return limited
}

function sameCorrection(left: readonly ResponsePoint[], right: readonly ResponsePoint[]): boolean {
  return left.length === right.length && left.every((point, index) => {
    const other = right[index]
    return other !== undefined && Math.abs(point.magnitudeDb - other.magnitudeDb) < 1e-9
  })
}

function buildHardBoostSafetyMask(
  aggregate: AggregateResponse,
  rawError: readonly ResponsePoint[],
  micProfile: MicCalibrationProfile,
  options: CorrectionOptions,
  lfCapability: LfCapability,
): boolean[] {
  return aggregate.points.map((measuredPoint, index) => {
    const frequencyHz = measuredPoint.frequencyHz
    const spread = aggregate.spreadDb[index]?.magnitudeDb ?? 4
    if (options.headroomVerified !== true || spread > 2 || spatialConfidence(spread) <= 0) return false
    if (frequencyHz <= lfCapability.minus6Db.frequencyHz || micTrustWeightAtHz(micProfile, frequencyHz) <= 0) return false
    const start = Math.max(0, index - 2)
    const end = Math.min(aggregate.points.length, index + 3)
    const neighborhood = rawError.slice(start, Math.min(rawError.length, end))
    const broadPositiveSamples = neighborhood.filter((candidate) => candidate.magnitudeDb > 0.5).length
    if (broadPositiveSamples < Math.min(3, neighborhood.length)) return false
    const measuredNeighbors = aggregate.points
      .slice(start, end)
      .filter((_, neighborIndex) => start + neighborIndex !== index)
      .map((candidate) => candidate.magnitudeDb)
      .sort((left, right) => left - right)
    if (measuredNeighbors.length > 0) {
      const neighborMedian = measuredNeighbors[Math.floor(measuredNeighbors.length / 2)]
      if (neighborMedian !== undefined && measuredPoint.magnitudeDb < neighborMedian - 6) return false
    }
    return true
  })
}

function applyCorrectionSafety(
  correction: ResponsePoint[],
  boostMask: readonly boolean[],
  cutLimits: readonly number[],
): void {
  correction.forEach((point, index) => {
    if (boostMask[index] !== true && point.magnitudeDb > 0) point.magnitudeDb = 0
    const cutLimit = cutLimits[index] ?? 0
    if (point.magnitudeDb < -cutLimit) point.magnitudeDb = -cutLimit
  })
}

export function calculateCorrection(
  aggregate: AggregateResponse,
  micProfile: MicCalibrationProfile,
  options: CorrectionOptions = {},
): CorrectionResult {
  const strength = STRENGTH[options.strength ?? 'normal']
  const maxCut = Math.abs(options.maxCutDb ?? 9)
  const maxBoost = options.headroomVerified ? Math.abs(options.maxBoostDb ?? 3) : 0
  const lfCapability = detectLfCapability(aggregate.points)
  const lfExtensionHz = lfCapability.minus3Db.frequencyHz
  const target = targetPointsFor(aggregate.points, lfCapability)
  const rawError = aggregate.points.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    magnitudeDb: target[index].magnitudeDb - point.magnitudeDb,
  }))
  const broadError = smoothError(rawError)
  const hardBoostSafetyMask = buildHardBoostSafetyMask(aggregate, rawError, micProfile, options, lfCapability)
  const spatialCutLimits = aggregate.points.map((_, index) => maxCut * spatialConfidence(aggregate.spreadDb[index]?.magnitudeDb ?? 4))
  let correction = broadError.map((point, index) => {
    const frequencyHz = point.frequencyHz
    const spread = aggregate.spreadDb[index]?.magnitudeDb ?? 4
    const confidence = spatialConfidence(spread)
    const trust = micTrustWeightAtHz(micProfile, frequencyHz)
    const aggression = aggressionAtHz(frequencyHz)
    let value = point.magnitudeDb * strength * confidence * aggression * trust
    if (value > 0 && !hardBoostSafetyMask[index]) value = 0
    return { frequencyHz, magnitudeDb: clamp(value, -maxCut, maxBoost) }
  })
  applyCorrectionSafety(correction, hardBoostSafetyMask, spatialCutLimits)

  for (let iteration = 0; iteration < Math.max(1, correction.length * 2); iteration++) {
    const limited = limitAdjacentSlope(correction)
    applyCorrectionSafety(limited, hardBoostSafetyMask, spatialCutLimits)
    if (sameCorrection(correction, limited)) {
      correction = limited
      break
    }
    correction = limited
  }
  const gains = correction.map((point) => point.magnitudeDb)
  const maxCutDb = Math.min(...gains)
  const maxBoostDb = Math.max(...gains)
  const headroomDb = maxBoostDb > 0 ? -(maxBoostDb + 0.5) : 0
  return {
    correction,
    target,
    lfCapability,
    lfExtensionHz,
    lfExtension3DbHz: lfCapability.minus3Db.frequencyHz,
    lfExtension6DbHz: lfCapability.minus6Db.frequencyHz,
    lfExtensionConfidence: Math.min(lfCapability.minus3Db.confidence, lfCapability.minus6Db.confidence),
    maxCutDb,
    maxBoostDb,
    headroomDb,
  }
}

export function combineChannelAggregates(
  left: AggregateResponse,
  right: AggregateResponse,
): AggregateResponse {
  const byPosition = new Map<string, { left?: PositionResponse; right?: PositionResponse }>()
  for (const response of left.positionResponses) {
    byPosition.set(response.positionId, { left: response })
  }
  for (const response of right.positionResponses) {
    const existing = byPosition.get(response.positionId)
    if (existing) existing.right = response
    else byPosition.set(response.positionId, { right: response })
  }
  const positionResponses = [...byPosition.values()]
    .filter(({ left, right }) => left !== undefined && right !== undefined)
    .map(({ left: leftPosition, right: rightPosition }) => {
      const source = leftPosition ?? rightPosition
      if (!source) return null
      return {
        positionId: source.positionId,
        positionIndex: source.positionIndex,
        positionCount: source.positionCount,
        channel: 'both' as const,
        points: source.points.map((point, index) => ({
          frequencyHz: point.frequencyHz,
          magnitudeDb: leftPosition && rightPosition
            ? (point.magnitudeDb + (rightPosition.points[index]?.magnitudeDb ?? point.magnitudeDb)) / 2
          : point.magnitudeDb,
        })),
        broadbandLevelDb: leftPosition && rightPosition
          ? (leftPosition.broadbandLevelDb !== null && rightPosition.broadbandLevelDb !== null
            ? (leftPosition.broadbandLevelDb + rightPosition.broadbandLevelDb) / 2
            : null)
          : source.broadbandLevelDb,
      }
    })
    .filter((value): value is PositionResponse => value !== null)
    .sort((a, b) => a.positionIndex - b.positionIndex)
  const frequencies = positionResponses[0]?.points.map((point) => point.frequencyHz) ?? left.points.map((point) => point.frequencyHz)
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
      ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
      : (sorted[middle] ?? 0)
  }
  const points = frequencies.map((frequencyHz, index) => {
    const values = positionResponses.map((response) => response.points[index]?.magnitudeDb ?? 0)
    return { frequencyHz, magnitudeDb: median(values) }
  })
  const spreadDb = frequencies.map((frequencyHz, index) => {
    const values = positionResponses.map((response) => response.points[index]?.magnitudeDb ?? 0)
    return { frequencyHz, magnitudeDb: values.length > 0 ? Math.max(...values) - Math.min(...values) : 0 }
  })
  return {
    channel: 'both',
    points,
    spreadDb,
    positionResponses,
    records: [...left.records, ...right.records],
    repeatability: [...left.repeatability, ...right.repeatability],
    failedGroups: [...left.failedGroups, ...right.failedGroups],
    broadbandLevelDb: left.broadbandLevelDb !== null && right.broadbandLevelDb !== null
      ? (left.broadbandLevelDb + right.broadbandLevelDb) / 2
      : null,
    relativeChannelLevelDb: left.broadbandLevelDb !== null && right.broadbandLevelDb !== null
      ? left.broadbandLevelDb - right.broadbandLevelDb
      : null,
  }
}

export function targetErrorRms(points: readonly ResponsePoint[], target = targetPointsFor(points)): number {
  if (points.length === 0) return 0
  const targetAtFrequency = (frequencyHz: number, index: number): number => {
    const indexed = target[index]
    if (indexed?.frequencyHz === frequencyHz) return indexed.magnitudeDb
    if (frequencyHz <= (target[0]?.frequencyHz ?? frequencyHz)) return target[0]?.magnitudeDb ?? 0
    for (let cursor = 1; cursor < target.length; cursor++) {
      const lower = target[cursor - 1]
      const upper = target[cursor]
      if (!lower || !upper || frequencyHz > upper.frequencyHz) continue
      const fraction = Math.log(frequencyHz / lower.frequencyHz) / Math.log(upper.frequencyHz / lower.frequencyHz)
      return lower.magnitudeDb + (upper.magnitudeDb - lower.magnitudeDb) * fraction
    }
    return target[target.length - 1]?.magnitudeDb ?? 0
  }
  const weighted = points.reduce((sum, point, index) => {
    const weight = point.frequencyHz <= 8_000 ? 1 : 0.25
    return sum + weight * (targetAtFrequency(point.frequencyHz, index) - point.magnitudeDb) ** 2
  }, 0)
  const weights = points.reduce((sum, point) => sum + (point.frequencyHz <= 8_000 ? 1 : 0.25), 0)
  return Math.sqrt(weighted / Math.max(weights, 1))
}
