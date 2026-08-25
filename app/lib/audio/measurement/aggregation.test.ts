import { describe, expect, test } from 'bun:test'
import type { MeasurementAnalysis } from './response'
import {
  aggregateResponse,
  allRepeatabilityPassed,
  calculateRepeatability,
  decideAdaptiveTake,
  decideInvalidTake,
  type MeasurementRecord,
} from './aggregation'
import { combineChannelAggregates } from '../correction/optimizer'
import { createMeasurementPlan, createMeasurementPlanForGroups, createProbeMeasurementPlan } from './plan'

function record(
  takeIndex: number,
  values: number[],
  options: Partial<Pick<MeasurementRecord['context'], 'channel' | 'positionId' | 'positionIndex' | 'positionCount' | 'phase' | 'takeCount' | 'attemptIndex' | 'attemptCount'>> = {},
  status: MeasurementAnalysis['status'] = 'ok',
  signalRms = 0.1,
): MeasurementRecord {
  const analysis = {
    status,
    rawPoints: values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb })),
    correctedPoints: values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb })),
    displayPoints: values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb })),
    room: null,
    impulse: null,
    micProfile: { id: 'test', name: 'test', author: 'test', sourceUrl: '', sourceDate: '', referenceType: 'unknown', capturePath: '', capturePathStatus: 'validated', dataMethod: 'published-data' },
    diagnostics: { detected: true, detectionOffsetMs: 0, envelopeOnlyOffsetMs: null, detectionConfidence: 1, endingMarkerConfidence: 1, clockDriftPpm: null, signalRms, signalPeak: 0.2, snrEstimateDb: 30, clipped: false, clippedSamples: 0, sampleCount: 10, frequencyPoints: values.length, failureReason: status === 'ok' ? null : status },
  } as MeasurementAnalysis
  return {
    context: {
      positionId: options.positionId ?? 'center',
      positionIndex: options.positionIndex ?? 0,
      positionCount: options.positionCount ?? 5,
      channel: options.channel ?? 'left',
      takeIndex,
      takeCount: options.takeCount ?? 3,
      attemptIndex: options.attemptIndex ?? 0,
      attemptCount: options.attemptCount ?? 2,
      phase: options.phase ?? 'measurement',
    },
    analysis,
  }
}

function validationRecord(
  takeIndex: number,
  values: number[],
  status: MeasurementAnalysis['status'] = 'ok',
): MeasurementRecord {
  return record(takeIndex, values, {
    positionCount: 1,
    takeCount: takeIndex < 2 ? 2 : 3,
    phase: 'validation',
  }, status)
}

describe('robust spatial aggregation', () => {
  test('uses the median and reports repeatability spread', () => {
    const records = [record(0, [8, 8, 8]), record(1, [8.5, 8.2, 8.1]), record(2, [7.8, 7.9, 8.2])]
    const aggregate = aggregateResponse(records, 'left')
    expect(aggregate?.points[0].magnitudeDb).toBeCloseTo(8, 5)
    expect(calculateRepeatability(records)?.passed).toBe(true)
  })

  test('preserves relative broadband channel level without changing tonal curves', () => {
    for (const offsetDb of [0, 1, 3, 6]) {
      const leftRecords = [
        record(0, [2, -1, 3], { channel: 'left' }, 'ok', 0.1),
        record(1, [2, -1, 3], { channel: 'left' }, 'ok', 0.1),
      ]
      const rightRms = 0.1 * 10 ** (-offsetDb / 20)
      const rightRecords = [
        record(0, [2, -1, 3], { channel: 'right' }, 'ok', rightRms),
        record(1, [2, -1, 3], { channel: 'right' }, 'ok', rightRms),
      ]
      const left = aggregateResponse(leftRecords, 'left')
      const right = aggregateResponse(rightRecords, 'right')
      expect(left).not.toBeNull()
      expect(right).not.toBeNull()
      if (!left || !right) throw new Error('Expected channel aggregates.')
      const combined = combineChannelAggregates(left, right)
      expect(combined.relativeChannelLevelDb).toBeCloseTo(offsetDb, 4)
      expect(combined.points.map((point) => point.magnitudeDb)).toEqual([2, -1, 3])
    }
  })

  test('rejects an obvious third-take outlier from a strongly agreeing pair', () => {
    const records = [record(0, [8, 8, 8]), record(1, [15, 15, 15]), record(2, [7, 7, 7])]
    expect(calculateRepeatability(records)).toMatchObject({
      passed: true,
      rejectedTakeIndex: 1,
    })
  })

  test('keeps validation at two center takes per channel when the pair agrees', () => {
    const plan = createMeasurementPlanForGroups([
      { positionId: 'center', positionIndex: 0, positionCount: 1, channel: 'left' },
      { positionId: 'center', positionIndex: 0, positionCount: 1, channel: 'right' },
    ], 'validation')

    expect(plan).toHaveLength(4)
    expect(plan.every((context) => context.positionId === 'center' && context.phase === 'validation')).toBe(true)
    expect(plan.every((context) => context.takeCount === 2)).toBe(true)
    expect(plan.filter((context) => context.channel === 'left').map((context) => context.takeIndex)).toEqual([0, 1])
    expect(plan.filter((context) => context.channel === 'right').map((context) => context.takeIndex)).toEqual([0, 1])

    const first = validationRecord(0, [8, 8, 8])
    const second = validationRecord(1, [8.2, 8.1, 8])
    expect(decideAdaptiveTake([first, second], second.context)).toMatchObject({
      kind: 'no-third',
      summary: { passed: true },
    })
  })

  test('schedules one validation third take only after the first pair fails', () => {
    const first = validationRecord(0, [0, 0, 0])
    const second = validationRecord(1, [4, 4, 4])
    expect(decideAdaptiveTake([first, second], second.context)).toMatchObject({
      kind: 'schedule-third',
      summary: { passed: false },
    })

    const third = validationRecord(2, [4, 4, 4])
    expect(decideAdaptiveTake([first, second, third], third.context)).toEqual({ kind: 'not-eligible' })
  })

  test('does not schedule an adaptive take when one logical take is invalid', () => {
    const first = validationRecord(0, [8, 8, 8])
    const second = validationRecord(1, [], 'capture_too_short')

    expect(decideAdaptiveTake([first, second], second.context)).toEqual({ kind: 'not-eligible' })
  })

  test('adjudicates a validation third take when it resolves the first outlier', () => {
    const summary = calculateRepeatability([
      validationRecord(0, [15, 15, 15]),
      validationRecord(1, [8, 8, 8]),
      validationRecord(2, [7, 7, 7]),
    ])

    expect(summary).toMatchObject({
      passed: true,
      rejectedTakeIndex: 0,
    })
  })

  test('adjudicates a validation third take when it resolves the second outlier', () => {
    const summary = calculateRepeatability([
      validationRecord(0, [8, 8, 8]),
      validationRecord(1, [15, 15, 15]),
      validationRecord(2, [7, 7, 7]),
    ])

    expect(summary).toMatchObject({
      passed: true,
      rejectedTakeIndex: 1,
    })
  })

  test('does not rescue three broadly disagreeing takes', () => {
    const records = [record(0, [0, 0, 0, 0, 0]), record(1, [3, 3, 3, 3, 3]), record(2, [6, 6, 6, 6, 6])]
    expect(calculateRepeatability(records)).toMatchObject({
      passed: false,
      rejectedTakeIndex: null,
    })
  })

  test('leaves three disagreeing validation takes inconclusive', () => {
    const summary = calculateRepeatability([
      validationRecord(0, [0, 0, 0, 0, 0]),
      validationRecord(1, [3, 3, 3, 3, 3]),
      validationRecord(2, [6, 6, 6, 6, 6]),
    ])

    expect(summary).toMatchObject({
      passed: false,
      rejectedTakeIndex: null,
      failureReason: 'spread',
    })
  })

  test('does not fail a group for one narrow-bin disagreement', () => {
    const records = [
      record(0, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      record(1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      record(2, [0, 0, 0, 0, 0, 0, 0, 0, 0, 5]),
    ]
    expect(calculateRepeatability(records)).toMatchObject({
      passed: true,
      rejectedTakeIndex: null,
    })
  })

  test('reduces repeats before giving every physical position equal spatial weight', () => {
    const records = [
      record(0, [0, 0, 0], { positionId: 'center', positionIndex: 0, positionCount: 2, takeCount: 2 }),
      record(1, [0, 0, 0], { positionId: 'center', positionIndex: 0, positionCount: 2, takeCount: 2 }),
      record(0, [10, 10, 10], { positionId: 'left', positionIndex: 1, positionCount: 2, takeCount: 3 }),
      record(1, [10, 10, 10], { positionId: 'left', positionIndex: 1, positionCount: 2, takeCount: 3 }),
      record(2, [10, 10, 10], { positionId: 'left', positionIndex: 1, positionCount: 2, takeCount: 3 }),
    ]

    const aggregate = aggregateResponse(records, 'left')

    expect(aggregate?.records).toHaveLength(5)
    expect(aggregate?.positionResponses).toHaveLength(2)
    expect(aggregate?.points[0].magnitudeDb).toBeCloseTo(5, 5)
    expect(aggregate?.spreadDb[0].magnitudeDb).toBeCloseTo(10, 5)
  })

  test('combines left and right per position before spatial aggregation', () => {
    const records = [
      record(0, [0, 0, 0], { positionId: 'center', positionIndex: 0, positionCount: 2, channel: 'left', takeCount: 2 }),
      record(1, [0, 0, 0], { positionId: 'center', positionIndex: 0, positionCount: 2, channel: 'left', takeCount: 2 }),
      record(0, [10, 10, 10], { positionId: 'center', positionIndex: 0, positionCount: 2, channel: 'right', takeCount: 2 }),
      record(1, [10, 10, 10], { positionId: 'center', positionIndex: 0, positionCount: 2, channel: 'right', takeCount: 2 }),
      record(0, [0, 0, 0], { positionId: 'left', positionIndex: 1, positionCount: 2, channel: 'left', takeCount: 2 }),
      record(1, [0, 0, 0], { positionId: 'left', positionIndex: 1, positionCount: 2, channel: 'left', takeCount: 2 }),
      record(0, [10, 10, 10], { positionId: 'left', positionIndex: 1, positionCount: 2, channel: 'right', takeCount: 2 }),
      record(1, [10, 10, 10], { positionId: 'left', positionIndex: 1, positionCount: 2, channel: 'right', takeCount: 2 }),
    ]

    const aggregate = aggregateResponse(records, 'both')

    expect(aggregate?.positionResponses).toHaveLength(2)
    expect(aggregate?.positionResponses.every((response) => response.channel === 'both')).toBe(true)
    expect(aggregate?.points[0].magnitudeDb).toBeCloseTo(5, 5)
    expect(aggregate?.spreadDb[0].magnitudeDb).toBeCloseTo(0, 5)
  })

  test('plans exactly two takes for every measurement position and channel', () => {
    const plan = createMeasurementPlan()
    expect(plan).toHaveLength(5 * 2 * 2)
    expect(new Set(plan.map((context) => `${context.positionId}:${context.channel}`)).size).toBe(10)
    expect(plan.every((context) => context.takeCount === 2)).toBe(true)
    expect(plan.filter((context) => context.positionId === 'center' && context.channel === 'left').map((context) => context.takeIndex)).toEqual([0, 1])
  })

  test('plans and aggregates a one-microphone both-channel routing probe', () => {
    const plan = createProbeMeasurementPlan('routing')
    expect(plan).toHaveLength(4)
    expect(plan.every((context) => context.channel === 'both' && context.takeCount === 2)).toBe(true)
    const aggregate = aggregateResponse([
      record(0, [0, 0, 0], { positionId: 'left', positionIndex: 0, positionCount: 2, channel: 'both', takeCount: 2 }),
      record(1, [0, 0, 0], { positionId: 'left', positionIndex: 0, positionCount: 2, channel: 'both', takeCount: 2 }),
      record(0, [1, 1, 1], { positionId: 'right', positionIndex: 1, positionCount: 2, channel: 'both', takeCount: 2 }),
      record(1, [1, 1, 1], { positionId: 'right', positionIndex: 1, positionCount: 2, channel: 'both', takeCount: 2 }),
    ], 'both')
    expect(aggregate?.positionResponses.map((response) => response.positionId)).toEqual(['left', 'right'])
    expect(allRepeatabilityPassed(aggregate)).toBe(true)
  })

  test('creates a targeted retry with the same position and channel', () => {
    const retry = createMeasurementPlanForGroups([{
      positionId: 'center',
      positionIndex: 0,
      positionCount: 5,
      channel: 'left',
    }])

    expect(retry.map((item) => item.takeIndex)).toEqual([0, 1])
    expect(retry.every((item) => item.positionId === 'center' && item.channel === 'left' && item.takeCount === 2)).toBe(true)
  })

  test('exposes the failed position and channel when one planned take is unusable', () => {
    const records = [
      record(0, [8, 8, 8], { takeCount: 2 }),
      record(1, [], { takeCount: 2 }, 'capture_too_short'),
    ]

    const aggregate = aggregateResponse(records, 'left')

    expect(aggregate?.repeatability).toHaveLength(1)
    expect(aggregate?.repeatability[0]).toMatchObject({
      positionId: 'center',
      channel: 'left',
      takeCount: 1,
      expectedTakeCount: 2,
      passed: false,
      failedTakeIndices: [1],
    })
    expect(aggregate?.failedGroups).toHaveLength(1)
  })

  test('bounds invalid take retries and never turns an invalid take into a pass', () => {
    expect(decideInvalidTake(0)).toEqual({ kind: 'retry', nextAttempts: 1 })
    expect(decideInvalidTake(1)).toEqual({ kind: 'terminal' })
    expect(decideInvalidTake(2)).toEqual({ kind: 'terminal' })

    const aggregate = aggregateResponse([
      validationRecord(0, [8, 8, 8]),
      validationRecord(1, [], 'capture_too_short'),
    ], 'left')

    expect(aggregate?.repeatability[0]).toMatchObject({
      takeCount: 1,
      expectedTakeCount: 2,
      passed: false,
      failedTakeIndices: [1],
    })
    expect(allRepeatabilityPassed(aggregate)).toBe(false)
  })

  test('does not pass correction when a required position is missing', () => {
    const records = [record(0, [8, 8, 8], { takeCount: 2 }), record(1, [8, 8, 8], { takeCount: 2 })]
    expect(allRepeatabilityPassed(aggregateResponse(records, 'left'))).toBe(false)
  })
})
