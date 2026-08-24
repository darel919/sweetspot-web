import { describe, expect, test } from 'bun:test'
import type { MeasurementAnalysis } from './response'
import { aggregateResponse, calculateRepeatability, type MeasurementRecord } from './aggregation'

function record(takeIndex: number, values: number[]): MeasurementRecord {
  const analysis = {
    status: 'ok',
    rawPoints: values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb })),
    points: values.map((magnitudeDb, index) => ({ frequencyHz: 100 * (index + 1), magnitudeDb })),
    room: null,
    impulse: null,
    micProfile: { id: 'test', name: 'test', author: 'test', sourceUrl: '', sourceDate: '', referenceType: 'unknown', capturePath: '', dataMethod: 'published-data' },
    diagnostics: { detected: true, detectionOffsetMs: 0, detectionConfidence: 1, signalRms: 0.1, signalPeak: 0.2, snrEstimateDb: 30, clipped: false, clippedSamples: 0, sampleCount: 10, frequencyPoints: values.length },
  } as MeasurementAnalysis
  return {
    context: { positionId: 'center', positionIndex: 0, positionCount: 5, channel: 'left', takeIndex, takeCount: 3, phase: 'measurement' },
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

  test('does not call a single unstable take repeatable', () => {
    const records = [record(0, [8, 8, 8]), record(1, [15, 15, 15]), record(2, [7, 7, 7])]
    expect(calculateRepeatability(records)?.passed).toBe(false)
  })
})
