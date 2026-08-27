import { CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB } from '../../../../shared/types/protocol'
import type { CalibrationPositionId } from '../../../../shared/types/protocol'
import type { AggregateResponse } from '../measurement/aggregation'
import { targetErrorRms } from './optimizer'
import { targetPointsFor } from './target'

export interface CalibrationValidationInput {
  beforeDb: number | null
  afterDb: number | null
  baselineQualityValid: boolean
  validationQualityValid: boolean
  requestedStatus?: 'passed' | 'worse' | 'inconclusive' | 'failed'
  reason?: string
}

export type CalibrationValidationOutcome =
  | { status: 'improved'; beforeDb: number; afterDb: number }
  | { status: 'worse'; beforeDb: number; afterDb: number }
  | { status: 'inconclusive'; reason: string; beforeDb?: number; afterDb?: number }
  | { status: 'failed'; reason: string; beforeDb?: number; afterDb?: number }

export interface SpatialValidationMetrics {
  before: number
  after: number
  objective: 'spatial'
  positionIds: CalibrationPositionId[]
}

const POSITIVE_GAIN_TOLERANCE_DB = 0.0001

export function candidateRequiresPositiveHeadroom(candidate: {
  bandsDb: readonly number[]
  leftBandsDb?: readonly number[]
  rightBandsDb?: readonly number[]
}): boolean {
  const curves = candidate.leftBandsDb !== undefined && candidate.rightBandsDb !== undefined
    ? [candidate.leftBandsDb, candidate.rightBandsDb]
    : [candidate.bandsDb]
  return curves
    .flatMap((curve) => curve ?? [])
    .some((gainDb) => gainDb > POSITIVE_GAIN_TOLERANCE_DB)
}

function comparablePositionIds(
  baseline: AggregateResponse,
  candidate: AggregateResponse,
): CalibrationPositionId[] | null {
  const baselineById = new Map(baseline.positionResponses.map((response) => [response.positionId, response]))
  const candidateById = new Map(candidate.positionResponses.map((response) => [response.positionId, response]))
  if (baselineById.size === 0 || baselineById.size !== candidateById.size) return null
  const positionIds = [...baselineById.keys()]
  for (const positionId of positionIds) {
    const baselineResponse = baselineById.get(positionId)
    const candidateResponse = candidateById.get(positionId)
    if (!baselineResponse || !candidateResponse
      || baselineResponse.points.length !== candidateResponse.points.length
      || baselineResponse.points.some((point, index) => point.frequencyHz !== candidateResponse.points[index]?.frequencyHz)) {
      return null
    }
  }
  return positionIds.sort((left, right) => left.localeCompare(right))
}

function aggregateForPositions(
  aggregate: AggregateResponse,
  positionIds: readonly CalibrationPositionId[],
): AggregateResponse | null {
  const selected = positionIds.flatMap((positionId) => aggregate.positionResponses.filter((response) => response.positionId === positionId))
  if (selected.length !== positionIds.length || selected.length === 0) return null
  const first = selected[0]
  if (!first || selected.some((response) => response.points.length !== first.points.length)) return null
  const points = first.points.map((point, index) => ({
    frequencyHz: point.frequencyHz,
    magnitudeDb: selected.reduce((sum, response) => sum + (response.points[index]?.magnitudeDb ?? 0), 0) / selected.length,
  }))
  return { ...aggregate, points, positionResponses: selected }
}

/**
 * Scores the same robust spatial objective used to generate a correction.
 * The baseline supplies the target and both aggregates must cover the same
 * physical positions and frequency grid.
 */
export function matchedSpatialValidationMetrics(
  baseline: AggregateResponse | null,
  candidate: AggregateResponse | null,
  requestedPositionIds?: readonly CalibrationPositionId[],
): SpatialValidationMetrics | null {
  if (!baseline || !candidate || baseline.points.length < 2 || candidate.points.length < 2) return null
  const positionIds = requestedPositionIds === undefined
    ? comparablePositionIds(baseline, candidate)
    : [...new Set(requestedPositionIds)]
  if (!positionIds || positionIds.length === 0) return null
  const selectedBaseline = requestedPositionIds === undefined ? baseline : aggregateForPositions(baseline, positionIds)
  const selectedCandidate = requestedPositionIds === undefined ? candidate : aggregateForPositions(candidate, positionIds)
  if (!selectedBaseline || !selectedCandidate) return null
  if (requestedPositionIds !== undefined
    && selectedCandidate.positionResponses.length !== candidate.positionResponses.length) return null
  if (selectedBaseline.points.length !== selectedCandidate.points.length
    || selectedBaseline.points.some((point, index) => point.frequencyHz !== selectedCandidate.points[index]?.frequencyHz)) return null
  const target = targetPointsFor(selectedBaseline.points)
  return {
    before: targetErrorRms(selectedBaseline.points, target),
    after: targetErrorRms(selectedCandidate.points, target),
    objective: 'spatial',
    positionIds,
  }
}

export function shouldRunValidationConfirmation(input: {
  outcome: CalibrationValidationOutcome | null
  candidateId: string | null
  confirmedCandidateId: string | null
}): boolean {
  return input.outcome?.status === 'inconclusive'
    && input.candidateId !== null
    && input.candidateId !== input.confirmedCandidateId
}

export function selectValidationConfirmationPositions(
  positionIds: readonly CalibrationPositionId[],
): CalibrationPositionId[] {
  if (positionIds.includes('center')) return ['center']
  const first = positionIds[0]
  return first ? [first] : []
}

export interface AutomaticValidationStartInput {
  measurementComplete: boolean
  measurementId: string | null
  candidateId: string | null
  baselineQualityValid: boolean
  deviceValidationReady: boolean
  capturePathEligible: boolean
  deviceOnline: boolean
  validationActive: boolean
  startedCandidateId: string | null
  stagingFailedMeasurementId: string | null
}

export function shouldStartAutomaticValidation(input: AutomaticValidationStartInput): boolean {
  return input.measurementComplete
    && input.measurementId !== null
    && input.candidateId !== null
    && input.baselineQualityValid
    && input.deviceValidationReady
    && input.capturePathEligible
    && input.deviceOnline
    && !input.validationActive
    && input.startedCandidateId !== input.candidateId
    && input.stagingFailedMeasurementId !== input.measurementId
}

export function classifyCalibrationValidation(input: CalibrationValidationInput): CalibrationValidationOutcome {
  const { beforeDb, afterDb } = input
  const finiteBefore = typeof beforeDb === 'number' && Number.isFinite(beforeDb) ? beforeDb : undefined
  const finiteAfter = typeof afterDb === 'number' && Number.isFinite(afterDb) ? afterDb : undefined
  if (input.requestedStatus === 'failed') {
    return {
      status: 'failed',
      reason: input.reason ?? 'Validation failed.',
      ...(finiteBefore === undefined ? {} : { beforeDb: finiteBefore }),
      ...(finiteAfter === undefined ? {} : { afterDb: finiteAfter }),
    }
  }
  if (input.requestedStatus === 'inconclusive') {
    return {
      status: 'inconclusive',
      reason: input.reason ?? 'Validation was inconclusive.',
      ...(finiteBefore === undefined ? {} : { beforeDb: finiteBefore }),
      ...(finiteAfter === undefined ? {} : { afterDb: finiteAfter }),
    }
  }
  if (!input.baselineQualityValid || !input.validationQualityValid) {
    return {
      status: 'inconclusive',
      reason: 'Validation measurements did not provide complete, usable position evidence.',
    }
  }
  if (beforeDb === null || afterDb === null || !Number.isFinite(beforeDb) || !Number.isFinite(afterDb)) {
    return {
      status: 'inconclusive',
      reason: 'Validation target-error metrics were unavailable.',
    }
  }

  if (afterDb < beforeDb - CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB) {
    return { status: 'improved', beforeDb, afterDb }
  }
  if (afterDb > beforeDb + CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB) {
    return { status: 'worse', beforeDb, afterDb }
  }
  return {
    status: 'inconclusive',
    reason: 'The validation change was smaller than the accepted measurement tolerance.',
    beforeDb,
    afterDb,
  }
}
