import type { CalibrationPositionId } from '#shared/types/protocol'
import type { AggregateResponse } from './aggregation'
import { projectPhysicalPositionLedger, type PositionLedger } from './position-ledger'
import type { PhysicalPositionLedger } from './physical-position'

type AggregateQualityFailure =
  | 'aggregate-missing'
  | 'insufficient-positions'
  | 'position-missing'
  | 'position-quality-failed'
  | 'response-unusable'

export interface AggregateQualityEvaluation {
  passed: boolean
  acceptedPositionIds: CalibrationPositionId[]
  reason: AggregateQualityFailure | null
}

export interface CalibrationBaselineEligibility {
  passed: boolean
  acceptedPositionIds: CalibrationPositionId[]
  reason: AggregateQualityFailure | 'center-incomplete' | 'channel-position-mismatch' | 'spatial-response-unusable' | null
}

function selectedPositionIds(
  aggregate: AggregateResponse,
  acceptedPositionIds: readonly CalibrationPositionId[],
): CalibrationPositionId[] {
  const accepted = new Set(acceptedPositionIds)
  return aggregate.positionResponses
    .filter((response) => accepted.has(response.positionId))
    .map((response) => response.positionId)
}

export function evaluateAggregateQuality(input: {
  aggregate: AggregateResponse | null
  acceptedPositionIds: readonly CalibrationPositionId[]
  minimumAcceptedPositions: number
}): AggregateQualityEvaluation {
  const acceptedPositionIds = [...input.acceptedPositionIds]
  if (!input.aggregate) return { passed: false, acceptedPositionIds, reason: 'aggregate-missing' }
  if (acceptedPositionIds.length < input.minimumAcceptedPositions) {
    return { passed: false, acceptedPositionIds, reason: 'insufficient-positions' }
  }
  if (input.aggregate.points.length < 2) {
    return { passed: false, acceptedPositionIds, reason: 'response-unusable' }
  }
  const selected = selectedPositionIds(input.aggregate, acceptedPositionIds)
  if (selected.length !== acceptedPositionIds.length) {
    return { passed: false, acceptedPositionIds, reason: 'position-missing' }
  }
  const selectedSet = new Set(acceptedPositionIds)
  const summaries = input.aggregate.spatialConsistency.filter((summary) => selectedSet.has(summary.positionId))
  if (summaries.length !== acceptedPositionIds.length) {
    return { passed: false, acceptedPositionIds, reason: 'position-missing' }
  }
  if (summaries.some((summary) => !summary.passed)) {
    return { passed: false, acceptedPositionIds, reason: 'position-quality-failed' }
  }
  return { passed: true, acceptedPositionIds, reason: null }
}

function physicalLedger(ledger: PositionLedger | PhysicalPositionLedger): PhysicalPositionLedger {
  return 'captures' in ledger ? projectPhysicalPositionLedger(ledger) : ledger
}

export function evaluateCalibrationBaselineEligibility(input: {
  ledger: PositionLedger | PhysicalPositionLedger
  aggregateLeft: AggregateResponse | null
  aggregateRight: AggregateResponse | null
  minimumAcceptedPositions?: number
}): CalibrationBaselineEligibility {
  const minimumAcceptedPositions = input.minimumAcceptedPositions ?? 3
  const positions = physicalLedger(input.ledger).positions
  const acceptedPositionIds = positions
    .filter((position) => position.left.kind === 'accepted' && position.right.kind === 'accepted')
    .map((position) => position.positionId)
  const center = positions.find((position) => position.positionId === 'center')
  if (!center || center.left.kind !== 'accepted' || center.right.kind !== 'accepted') {
    return { passed: false, acceptedPositionIds, reason: 'center-incomplete' }
  }
  if (acceptedPositionIds.length < minimumAcceptedPositions) {
    return { passed: false, acceptedPositionIds, reason: 'insufficient-positions' }
  }
  const left = evaluateAggregateQuality({
    aggregate: input.aggregateLeft,
    acceptedPositionIds,
    minimumAcceptedPositions,
  })
  const right = evaluateAggregateQuality({
    aggregate: input.aggregateRight,
    acceptedPositionIds,
    minimumAcceptedPositions,
  })
  if (!left.passed || !right.passed) {
    const reason = left.reason === 'position-quality-failed' || right.reason === 'position-quality-failed'
      ? 'position-quality-failed'
      : left.reason === 'position-missing' || right.reason === 'position-missing'
        ? 'channel-position-mismatch'
        : left.reason ?? right.reason ?? 'aggregate-missing'
    return { passed: false, acceptedPositionIds, reason }
  }
  return { passed: true, acceptedPositionIds, reason: null }
}
