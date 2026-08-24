import { describe, expect, test } from 'bun:test'
import { parseMicCalibrationProfile } from '../mics/profile'
import { aggregateResponse, type AggregateResponse } from '../measurement/aggregation'
import type { ResponsePoint } from '../measurement/response'
import { calculateCorrection, limitAdjacentSlope } from './optimizer'
import { mapCorrectionToBands } from './bandMapper'
import { detectLfExtensionHz } from './target'

const profile = parseMicCalibrationProfile({
  id: 'test', name: 'test', author: 'test', manufacturer: 'test', model: 'test', sourceUrl: 'https://example.test', sourceDate: '2026-01-01',
  referenceType: 'unknown', sourceSmoothing: 'none', capturePath: 'test', dataMethod: 'published-data', normalizeAtHz: 1_000,
  referenceMicrophone: 'test', referenceMicSpacingMm: 1, referenceMicSpacingApproximate: false, measurementEnvironment: 'test',
  excitation: 'test', orientationsAveraged: 1, referenceCalibration: 'test', publishedTraces: ['test'], directivityMeasuredSeparately: false,
  points: [{ frequencyHz: 20, responseDb: 0 }, { frequencyHz: 20_000, responseDb: 0 }],
  trust: { minHz: 30, fullTrustMaxHz: 8_000, taperToHz: 12_000 },
})

function aggregate(values: number[], spread = 1): AggregateResponse {
  const points: ResponsePoint[] = values.map((magnitudeDb, index) => ({ frequencyHz: 20 * (20_000 / 20) ** (index / (values.length - 1)), magnitudeDb }))
  return {
    channel: 'left',
    points,
    positionResponses: [],
    spreadDb: points.map((point) => ({ ...point, magnitudeDb: spread })),
    records: [],
    repeatability: [],
    failedGroups: [],
  }
}

describe('constrained room correction', () => {
  test('cuts a broad low-frequency peak', () => {
    const result = calculateCorrection(aggregate(new Array(48).fill(0).map((_, index) => index < 15 ? 8 : 0)), profile, { headroomVerified: false })
    expect(Math.min(...result.correction.map((point) => point.magnitudeDb))).toBeLessThan(-1)
  })

  test('does not boost an isolated null', () => {
    const values = new Array(48).fill(0)
    values[12] = -12
    const result = calculateCorrection(aggregate(values), profile, { headroomVerified: true })
    expect(result.correction[12].magnitudeDb).toBeLessThanOrEqual(0)
  })

  test('does not let slope limiting leak a boost into an unsafe spatial region', () => {
    const values = new Array(48).fill(0)
    const measured = aggregate(values)
    measured.spreadDb[8].magnitudeDb = 10

    const result = calculateCorrection(measured, profile, { headroomVerified: true })

    expect(result.correction[8]?.magnitudeDb).toBeLessThanOrEqual(0)
  })

  test('turns spatial confidence off for arbitrarily high spread, including cuts', () => {
    const values = new Array(48).fill(0).map((_, index) => index < 15 ? 8 : 0)
    const result = calculateCorrection(aggregate(values, 10), profile, { headroomVerified: false })

    expect(result.correction.every((point) => point.magnitudeDb >= 0)).toBe(true)
  })

  test('does not leak a neighboring cut into a zero-confidence position', () => {
    const values = new Array(48).fill(0).map((_, index) => index < 15 ? 8 : 0)
    const measured = aggregate(values)
    measured.spreadDb[5].magnitudeDb = 10

    const result = calculateCorrection(measured, profile, { headroomVerified: false })

    expect(result.correction[5]?.magnitudeDb).toBeGreaterThanOrEqual(0)
  })

  test('limits adjacent slopes independently of traversal direction', () => {
    const curve = [
      { frequencyHz: 20, magnitudeDb: -6 },
      { frequencyHz: 40, magnitudeDb: 6 },
      { frequencyHz: 80, magnitudeDb: -5 },
      { frequencyHz: 160, magnitudeDb: 7 },
      { frequencyHz: 320, magnitudeDb: 0 },
    ]
    const forward = limitAdjacentSlope(curve)
    const backward = limitAdjacentSlope([...curve].reverse()).reverse()

    backward.forEach((point, index) => {
      expect(point.magnitudeDb).toBeCloseTo(forward[index]?.magnitudeDb ?? Number.NaN, 8)
    })
  })

  test('maps a continuous correction across actual band intervals', () => {
    const correction = [
      { frequencyHz: 20, magnitudeDb: -6 },
      { frequencyHz: 20_000, magnitudeDb: 0 },
    ]
    const mapped = mapCorrectionToBands(correction, [40, 80, 160, 320])
    expect(mapped).toHaveLength(4)
    expect(mapped[0]).toBeLessThan(mapped[3])
  })

  test('finds the upper recovery boundary for a broad low-frequency rolloff', () => {
    const points = new Array(29).fill(0).map((_, index) => {
      const frequencyHz = 20 + index * 10
      return { frequencyHz, magnitudeDb: frequencyHz < 60 ? -8 : 0 }
    })

    expect(detectLfExtensionHz(points)).toBeGreaterThanOrEqual(50)
    expect(detectLfExtensionHz(points)).toBeLessThanOrEqual(80)
  })

  test('ignores a narrow low-frequency null when finding extension', () => {
    const points = new Array(29).fill(0).map((_, index) => ({
      frequencyHz: 20 + index * 10,
      magnitudeDb: index === 3 ? -12 : 0,
    }))

    expect(detectLfExtensionHz(points)).toBe(20)
  })

  test('does not treat a broad low-frequency feature as a lower extension', () => {
    const points = new Array(29).fill(0).map((_, index) => {
      const frequencyHz = 20 + index * 10
      return { frequencyHz, magnitudeDb: frequencyHz < 100 ? -8 : 0 }
    })

    expect(detectLfExtensionHz(points)).toBeGreaterThanOrEqual(90)
    expect(detectLfExtensionHz(points)).toBeLessThanOrEqual(120)
  })
})
