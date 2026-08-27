import { describe, expect, test } from 'bun:test'
import type { CalibrationPositionId } from '../../../../shared/types/protocol'
import type { AggregateResponse } from './aggregation'
import { evaluateCalibrationBaselineEligibility, evaluateAggregateQuality } from './quality'
import type { PhysicalPositionLedger } from './physical-position'

function aggregate(positionIds: readonly CalibrationPositionId[], failedPositionIds: readonly CalibrationPositionId[] = []): AggregateResponse {
  const points = [
    { frequencyHz: 100, magnitudeDb: 0 },
    { frequencyHz: 1_000, magnitudeDb: 0 },
  ]
  const summaries = [...positionIds, ...failedPositionIds].map((positionId, positionIndex) => ({
    positionId,
    positionIndex,
    positionCount: positionIds.length + failedPositionIds.length,
    channel: 'left' as const,
    captureCount: failedPositionIds.includes(positionId) ? 0 : 1,
    expectedCaptureCount: 1 as const,
    failedAttemptIndices: failedPositionIds.includes(positionId) ? [0] : [],
    medianSpreadDb: 0,
    maxSpreadDb: 0,
    withinTwoDbFraction: 1,
    passed: !failedPositionIds.includes(positionId),
    failureReason: failedPositionIds.includes(positionId) ? 'capture_rejected' as const : null,
  }))
  return {
    channel: 'left',
    points,
    spreadDb: points.map((point) => ({ ...point, magnitudeDb: 0 })),
    positionResponses: positionIds.map((positionId, positionIndex) => ({
      positionId,
      positionIndex,
      positionCount: positionIds.length + failedPositionIds.length,
      channel: 'left',
      points,
      broadbandLevelDb: null,
    })),
    records: [],
    spatialConsistency: summaries,
    failedGroups: summaries.filter((summary) => !summary.passed),
    broadbandLevelDb: null,
    relativeChannelLevelDb: null,
  }
}

function ledger(positionIds: readonly CalibrationPositionId[], incompleteCenter = false): PhysicalPositionLedger {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    systemicCenterFailures: 0,
    positions: positionIds.map((positionId, positionIndex) => ({
      id: `${positionId}-${positionIndex}`,
      positionId,
      positionIndex,
      requestedPositionCount: positionIds.length,
      spatialOffset: { xCm: 0, yCm: 0, zCm: 0 },
      left: { kind: 'accepted', response: [], analysis: {} as never, quality: {} as never, acceptedAt: 1 },
      right: incompleteCenter && positionId === 'center'
        ? { kind: 'rejected', analysis: null, quality: {} as never }
        : { kind: 'accepted', response: [], analysis: {} as never, quality: {} as never, acceptedAt: 1 },
      captureMetadata: null,
      attemptIndex: 0,
      acceptedAt: 1,
    })),
  }
}

describe('calibration evidence quality', () => {
  test('uses accepted physical positions instead of the historical planner target', () => {
    const acceptedPositionIds = ['center', 'left', 'right', 'forward'] as const
    const result = evaluateAggregateQuality({
      aggregate: aggregate(acceptedPositionIds, ['backward']),
      acceptedPositionIds,
      minimumAcceptedPositions: 3,
    })

    expect(result).toEqual({ passed: true, acceptedPositionIds: [...acceptedPositionIds], reason: null })
  })

  test('requires a complete center and the minimum complete positions for both channels', () => {
    const result = evaluateCalibrationBaselineEligibility({
      ledger: ledger(['center', 'left', 'right'], true),
      aggregateLeft: aggregate(['left', 'right']),
      aggregateRight: aggregate(['left', 'right']),
      minimumAcceptedPositions: 3,
    })

    expect(result.passed).toBe(false)
    expect(result.reason).toBe('center-incomplete')
  })
})
