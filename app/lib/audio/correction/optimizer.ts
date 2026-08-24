import { micTrustWeightAtHz } from '../mics/profile'
import type { MicCalibrationProfile } from '../mics/types'
import type { AggregateResponse } from '../measurement/aggregation'
import type { ResponsePoint } from '../measurement/response'
import { smoothResponsePoints } from '../measurement/response'
import { detectLfExtensionHz, sweetSpotTargetDbAtHz, targetPointsFor } from './target'

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
  lfExtensionHz: number
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
  if (spreadDb <= 2) return 1
  if (spreadDb >= 4) return 0.25
  return 1 - (spreadDb - 2) * 0.375
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

export function calculateCorrection(
  aggregate: AggregateResponse,
  micProfile: MicCalibrationProfile,
  options: CorrectionOptions = {},
): CorrectionResult {
  const strength = STRENGTH[options.strength ?? 'normal']
  const maxCut = Math.abs(options.maxCutDb ?? 9)
  const maxBoost = options.headroomVerified ? Math.abs(options.maxBoostDb ?? 3) : 0
  const target = targetPointsFor(aggregate.points)
  const rawError = aggregate.points.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    magnitudeDb: target[index].magnitudeDb - point.magnitudeDb,
  }))
  const broadError = smoothError(rawError)
  const lfExtensionHz = detectLfExtensionHz(aggregate.points)
  const correction = broadError.map((point, index) => {
    const frequencyHz = point.frequencyHz
    const measuredPoint = aggregate.points[index]
    const spread = aggregate.spreadDb[index]?.magnitudeDb ?? 4
    const confidence = spatialConfidence(spread)
    const trust = micTrustWeightAtHz(micProfile, frequencyHz)
    const aggression = aggressionAtHz(frequencyHz)
    let value = point.magnitudeDb * strength * confidence * aggression * trust
    if (value > 0) {
      const neighborhood = rawError.slice(Math.max(0, index - 2), Math.min(rawError.length, index + 3))
      const broadPositiveSamples = neighborhood.filter((candidate) => candidate.magnitudeDb > 0.5).length
      if (broadPositiveSamples < Math.min(3, neighborhood.length)) value = 0
      const measuredNeighbors = aggregate.points
        .slice(Math.max(0, index - 2), Math.min(aggregate.points.length, index + 3))
        .filter((_, neighborIndex) => neighborIndex !== Math.min(2, index))
        .map((candidate) => candidate.magnitudeDb)
      const neighborMedian = measuredNeighbors.length > 0
        ? measuredNeighbors.sort((left, right) => left - right)[Math.floor(measuredNeighbors.length / 2)]
        : point.magnitudeDb
      if (measuredPoint.magnitudeDb < neighborMedian - 6) value = 0
    }
    if (value > 0 && frequencyHz < lfExtensionHz) {
      value *= clamp(frequencyHz / lfExtensionHz, 0, 1) ** 2
    }
    // A broad, repeatable error can be cut. A positive correction needs both
    // spatial agreement and verified TV headroom.
    if (value > 0 && (spread > 2 || !options.headroomVerified)) value = 0
    return { frequencyHz, magnitudeDb: clamp(value, -maxCut, maxBoost) }
  })

  // Avoid creating sharp adjacent filter transitions that the real bands
  // cannot represent cleanly.
  for (let index = 1; index < correction.length; index++) {
    const delta = correction[index].magnitudeDb - correction[index - 1].magnitudeDb
    if (Math.abs(delta) > 2) {
      correction[index].magnitudeDb = correction[index - 1].magnitudeDb + Math.sign(delta) * 2
    }
  }
  // Re-apply the null guard after slope limiting; otherwise a neighboring
  // positive band could leak a small boost into a spatially unstable notch.
  for (let index = 0; index < correction.length; index++) {
    if (correction[index].magnitudeDb <= 0) continue
    const start = Math.max(0, index - 2)
    const end = Math.min(aggregate.points.length, index + 3)
    const neighbors = aggregate.points.slice(start, end)
      .filter((_, neighborIndex) => neighborIndex !== Math.min(2, index))
      .map((candidate) => candidate.magnitudeDb)
      .sort((left, right) => left - right)
    const neighborMedian = neighbors.length > 0 ? neighbors[Math.floor(neighbors.length / 2)] : aggregate.points[index].magnitudeDb
    if (aggregate.points[index].magnitudeDb < neighborMedian - 6) correction[index].magnitudeDb = 0
  }
  const gains = correction.map((point) => point.magnitudeDb)
  const maxCutDb = Math.min(...gains)
  const maxBoostDb = Math.max(...gains)
  const headroomDb = maxBoostDb > 0 ? -(maxBoostDb + 0.5) : 0
  return { correction, target, lfExtensionHz, maxCutDb, maxBoostDb, headroomDb }
}

export function combineChannelAggregates(
  left: AggregateResponse,
  right: AggregateResponse,
): AggregateResponse {
  const points = left.points.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    magnitudeDb: (point.magnitudeDb + (right.points[index]?.magnitudeDb ?? point.magnitudeDb)) / 2,
  }))
  const spreadDb = left.spreadDb.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    magnitudeDb: Math.max(point.magnitudeDb, right.spreadDb[index]?.magnitudeDb ?? point.magnitudeDb),
  }))
  return {
    channel: 'both',
    points,
    spreadDb,
    records: [...left.records, ...right.records],
    repeatability: [...left.repeatability, ...right.repeatability],
    failedGroups: [...left.failedGroups, ...right.failedGroups],
  }
}

export function targetErrorRms(points: readonly ResponsePoint[], target = targetPointsFor(points)): number {
  if (points.length === 0) return 0
  const weighted = points.reduce((sum, point, index) => {
    const weight = point.frequencyHz <= 8_000 ? 1 : 0.25
    return sum + weight * (target[index].magnitudeDb - point.magnitudeDb) ** 2
  }, 0)
  const weights = points.reduce((sum, point) => sum + (point.frequencyHz <= 8_000 ? 1 : 0.25), 0)
  return Math.sqrt(weighted / Math.max(weights, 1))
}
