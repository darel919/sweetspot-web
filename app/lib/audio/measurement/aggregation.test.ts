import { describe, expect, test } from 'bun:test'
import type { MeasurementAnalysis } from './response'
import { aggregateResponse, allRepeatabilityPassed, calculateRepeatability, type MeasurementRecord } from './aggregation'
import { createMeasurementPlan, createMeasurementPlanForGroups } from './plan'

function record(
  takeIndex: number,
  values: number[],
  options: Partial<Pick<MeasurementRecord['context'], 'channel' | 'positionId' | 'positionIndex' | 'positionCount' | 'phase' | 'takeCount'>> = {},
  status: MeasurementAnalysis['status'] = 'ok',
): MeasurementRecord {
  const analysis = {
    status,
    rawPoints: values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb })),
    correctedPoints: values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb })),
    displayPoints: values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb })),
    room: null,
    impulse: null,
    micProfile: { id: 'test', name: 'test', author: 'test', sourceUrl: '', sourceDate: '', referenceType: 'unknown', capturePath: '', dataMethod: 'published-data' },
    diagnostics: { detected: true, detectionOffsetMs: 0, detectionConfidence: 1, endingMarkerConfidence: 1, clockDriftPpm: null, signalRms: 0.1, signalPeak: 0.2, snrEstimateDb: 30, clipped: false, clippedSamples: 0, sampleCount: 10, frequencyPoints: values.length, failureReason: status === 'ok' ? null : status },
  } as MeasurementAnalysis
  return {
    context: { positionId: options.positionId ?? 'center', positionIndex: options.positionIndex ?? 0, positionCount: options.positionCount ?? 5, channel: options.channel ?? 'left', takeIndex, takeCount: options.takeCount ?? 3, phase: options.phase ?? 'measurement' },
    analysis,
  }
}

describe('robust spatial aggregation', () => {
  test('uses the median and reports repeatability spread', () => {
    const records = [record(0, [8, 8, 8]), record(1, [8.5, 8.2, 8.1]), record(2, [7.8, 7.9, 8.2])]
    const aggregate = aggregateResponse(records, 'left')
    expect(aggregate?.points[0].magnitudeDb).toBeCloseTo(8, 5)
    expect(calculateRepeatability(records)?.passed).toBe(true)
  })

  test('rejects an obvious third-take outlier from a strongly agreeing pair', () => {
    const records = [record(0, [8, 8, 8]), record(1, [15, 15, 15]), record(2, [7, 7, 7])]
    expect(calculateRepeatability(records)).toMatchObject({
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

  test('does not pass correction when a required position is missing', () => {
    const records = [record(0, [8, 8, 8], { takeCount: 2 }), record(1, [8, 8, 8], { takeCount: 2 })]
    expect(allRepeatabilityPassed(aggregateResponse(records, 'left'))).toBe(false)
  })
})
