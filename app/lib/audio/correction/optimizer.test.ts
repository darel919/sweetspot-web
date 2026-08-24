import { describe, expect, test } from 'bun:test'
import { parseMicCalibrationProfile } from '../mics/profile'
import { aggregateResponse, type AggregateResponse } from '../measurement/aggregation'
import type { ResponsePoint } from '../measurement/response'
import { calculateCorrection } from './optimizer'
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

function aggregate(values: number[]): AggregateResponse {
  const points: ResponsePoint[] = values.map((magnitudeDb, index) => ({ frequencyHz: 20 * (20_000 / 20) ** (index / (values.length - 1)), magnitudeDb }))
  return {
    channel: 'left',
    points,
    spreadDb: points.map((point) => ({ ...point, magnitudeDb: 1 })),
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

  test('maps a continuous correction across actual band intervals', () => {
    const correction = [
      { frequencyHz: 20, magnitudeDb: -6 },
      { frequencyHz: 20_000, magnitudeDb: 0 },
    ]
    const mapped = mapCorrectionToBands(correction, [40, 80, 160, 320])
    expect(mapped).toHaveLength(4)
    expect(mapped[0]).toBeLessThan(mapped[3])
  })

  test('detects the first broad low-frequency rolloff instead of a narrow notch', () => {
    const points = new Array(48).fill(0).map((_, index) => {
      const frequencyHz = 20 * (20_000 / 20) ** (index / 47)
      return {
        frequencyHz,
        magnitudeDb: frequencyHz < 60 ? -8 : frequencyHz === 90 ? -12 : 0,
      }
    })
    expect(detectLfExtensionHz(points)).toBeLessThan(100)
  })
})
