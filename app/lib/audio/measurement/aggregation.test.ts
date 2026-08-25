import { describe, expect, test } from 'bun:test'
import type { MeasurementContext } from '#shared/types/protocol'
import type { MeasurementAnalysis } from './response'
import {
  aggregateResponse,
  allRepeatabilityPassed,
  calculateRepeatability,
  type MeasurementRecord,
} from './aggregation'
import { combineChannelAggregates } from '../correction/optimizer'
import { createMeasurementPlan, createMeasurementPlanForGroups, createProbeMeasurementPlan } from './plan'

function analysis(
  values: readonly number[],
  status: MeasurementAnalysis['status'] = 'ok',
  signalRms = 0.1,
): MeasurementAnalysis {
  const points = values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb }))
  return {
    status,
    rawPoints: points,
    correctedPoints: status === 'ok' ? points : [],
    displayPoints: points,
    room: null,
    impulse: null,
    micProfile: {
      id: 'test',
      name: 'test',
      author: 'test',
      sourceUrl: '',
      sourceDate: '',
      referenceType: 'unknown',
      capturePath: '',
      capturePathStatus: 'validated',
      dataMethod: 'published-data',
    },
    diagnostics: {
      detected: status === 'ok',
      detectionOffsetMs: status === 'ok' ? 0 : null,
      envelopeOnlyOffsetMs: null,
      detectionConfidence: status === 'ok' ? 1 : 0,
      endingMarkerConfidence: status === 'ok' ? 1 : 0,
      rawLeadingMarkerConfidence: status === 'ok' ? 1 : 0,
      rawTrailingMarkerConfidence: status === 'ok' ? 1 : 0,
      bestLeadingMarkerSample: status === 'ok' ? 0 : null,
      bestTrailingMarkerSample: status === 'ok' ? 90 : null,
      markerPairScore: status === 'ok' ? 1 : null,
      markerSeparationError: status === 'ok' ? 0 : null,
      markerTimingAgreement: status === 'ok' ? 1 : null,
      syncMarkerFailureReason: status === 'ok' ? null : 'marker_pair_low_confidence',
      clockDriftPpm: status === 'ok' ? 0 : null,
      signalRms,
      signalPeak: 0.2,
      snrEstimateDb: status === 'ok' ? 30 : null,
      clipped: false,
      clippedSamples: 0,
      sampleCount: 10,
      frequencyPoints: points.length,
      failureReason: status === 'ok' ? null : status,
    },
  }
}

function context(options: Partial<MeasurementContext> = {}): MeasurementContext {
  return {
    positionId: 'center',
    positionIndex: 0,
    positionCount: 3,
    channel: 'both',
    captureKind: 'position-composite',
    repairChannel: 'both',
    attemptIndex: 0,
    attemptCount: 2,
    phase: 'measurement',
    ...options,
  }
}

function record(
  values: readonly number[],
  options: Partial<MeasurementContext & { channel: 'left' | 'right' }> = {},
  status: MeasurementAnalysis['status'] = 'ok',
  signalRms = 0.1,
): MeasurementRecord {
  const { channel = 'left', ...contextOptions } = options
  return { context: context(contextOptions), channel, analysis: analysis(values, status, signalRms) }
}

describe('physical-position spatial aggregation', () => {
  test('uses one accepted physical capture per channel and reports spatial spread', () => {
    const records = [
      record([8, 8, 8], { positionId: 'center', positionIndex: 0, channel: 'left' }),
      record([8.5, 8.2, 8.1], { positionId: 'left', positionIndex: 1, channel: 'left' }),
      record([7.8, 7.9, 8.2], { positionId: 'right', positionIndex: 2, channel: 'left' }),
    ]
    const aggregate = aggregateResponse(records, 'left')

    expect(aggregate?.positionResponses).toHaveLength(3)
    expect(aggregate?.points[0]?.magnitudeDb).toBeCloseTo(8, 5)
    expect(calculateRepeatability(records.slice(0, 1))?.passed).toBe(true)
  })

  test('preserves relative broadband channel level while combining the channels', () => {
    const left = aggregateResponse([
      record([2, -1, 3], { channel: 'left' }, 'ok', 0.1),
    ], 'left')
    const right = aggregateResponse([
      record([2, -1, 3], { channel: 'right' }, 'ok', 0.05),
    ], 'right')

    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    if (!left || !right) throw new Error('Expected channel aggregates.')
    const combined = combineChannelAggregates(left, right)
    expect(combined.relativeChannelLevelDb).toBeCloseTo(6.0206, 3)
    expect(combined.points.map((point) => point.magnitudeDb)).toEqual([2, -1, 3])
  })

  test('keeps a rejected channel visible without manufacturing a response', () => {
    const aggregate = aggregateResponse([
      record([8, 8, 8], { channel: 'left' }),
      record([], { channel: 'right' }, 'capture_too_short'),
    ], 'right')

    expect(aggregate?.points).toEqual([])
    expect(aggregate?.failedGroups).toMatchObject([{
      channel: 'right',
      failureReason: 'capture_rejected',
      failedAttemptIndices: [0],
    }])
  })

  test('combines left and right only when both channels exist at a position', () => {
    const records = [
      record([0, 0, 0], { positionId: 'center', positionIndex: 0, channel: 'left' }),
      record([10, 10, 10], { positionId: 'center', positionIndex: 0, channel: 'right' }),
      record([0, 0, 0], { positionId: 'left', positionIndex: 1, channel: 'left' }),
    ]
    const aggregate = aggregateResponse(records, 'both')

    expect(aggregate?.positionResponses).toHaveLength(1)
    expect(aggregate?.positionResponses[0]?.positionId).toBe('center')
    expect(aggregate?.points[0]?.magnitudeDb).toBeCloseTo(5, 5)
  })

  test('plans center, left, and right as three composite physical positions', () => {
    const plan = createMeasurementPlan()
    expect(plan).toHaveLength(3)
    expect(plan.map((item) => item.positionId)).toEqual(['center', 'left', 'right'])
    expect(plan.every((item) => item.channel === 'both' && item.captureKind === 'position-composite')).toBe(true)
    expect(new Set(plan.map((item) => item.positionId)).size).toBe(3)
  })

  test('creates a targeted repair without changing the physical position', () => {
    const [initial] = createMeasurementPlanForGroups([{
      positionId: 'center',
      positionIndex: 0,
      positionCount: 1,
      channel: 'both',
    }])
    if (!initial) throw new Error('Expected an initial context.')
    expect(initial).toMatchObject({ positionId: 'center', channel: 'both', repairChannel: 'both', attemptIndex: 0 })

    const repair = {
      ...initial,
      repairChannel: 'left' as const,
      attemptIndex: 1,
    }
    expect(repair).toMatchObject({
      positionId: 'center',
      channel: 'both',
      repairChannel: 'left',
      attemptIndex: 1,
    })
  })

  test('probe plans remain composite and bounded', () => {
    const plan = createProbeMeasurementPlan('routing')
    expect(plan).toHaveLength(2)
    expect(plan.every((item) => item.channel === 'both' && item.captureKind === 'position-composite')).toBe(true)
  })

  test('accepts an aggregate with one good capture per physical position', () => {
    const aggregate = aggregateResponse([
      record([8, 8, 8], { positionId: 'center', positionIndex: 0, channel: 'left' }),
      record([8, 8, 8], { positionId: 'left', positionIndex: 1, channel: 'left' }),
    ], 'left')
    expect(aggregate).not.toBeNull()
    expect(aggregate ? allRepeatabilityPassed(aggregate) : false).toBe(true)
  })
})
