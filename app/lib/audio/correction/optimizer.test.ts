import { describe, expect, test } from 'bun:test'
import { parseMicCalibrationProfile } from '../mics/profile'
import { aggregateResponse, type AggregateResponse } from '../measurement/aggregation'
import type { ResponsePoint } from '../measurement/response'
import { calculateCorrection, limitAdjacentSlope, targetErrorRms } from './optimizer'
import { mapCorrectionToBands, mapCorrectionToBandsConservative } from './bandMapper'
import { detectLfCapability, detectLfExtensionHz, targetPointsFor } from './target'

const profile = parseMicCalibrationProfile({
  id: 'test', name: 'test', author: 'test', manufacturer: 'test', model: 'test', sourceUrl: 'https://example.test', sourceDate: '2026-01-01',
  referenceType: 'unknown', sourceSmoothing: 'none', capturePath: 'test', capturePathStatus: 'validated', dataMethod: 'published-data', normalizeAtHz: 1_000,
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
    broadbandLevelDb: null,
    relativeChannelLevelDb: null,
  }
}

function aggregatePoints(points: ResponsePoint[], spread = 1): AggregateResponse {
  return {
    channel: 'left',
    points,
    positionResponses: [],
    spreadDb: points.map((point) => ({ ...point, magnitudeDb: spread })),
    records: [],
    repeatability: [],
    failedGroups: [],
    broadbandLevelDb: null,
    relativeChannelLevelDb: null,
  }
}

function responseWithLowFrequencyRolloff(enteringHz: number): ResponsePoint[] {
  return Array.from({ length: 397 }, (_, index) => {
    const frequencyHz = 20 + index * 5
    const rolloffDb = frequencyHz < enteringHz
      ? -6 * Math.log2(enteringHz / frequencyHz)
      : 0
    const roomGainDb = frequencyHz >= 280 && frequencyHz <= 420 ? 2.5 : 0
    const roomPeakDb = Math.abs(frequencyHz - 500) <= 15 ? 6 : 0
    const roomNullDb = Math.abs(frequencyHz - 650) <= 15 ? -7 : 0
    const noiseDb = (((index * 37) % 13) - 6) * 0.05
    return {
      frequencyHz,
      magnitudeDb: Math.max(-18, rolloffDb) + roomGainDb + roomPeakDb + roomNullDb + noiseDb,
    }
  })
}

function interpolateLog(points: readonly ResponsePoint[], frequencyHz: number): number {
  if (frequencyHz <= points[0].frequencyHz) return points[0].magnitudeDb
  if (frequencyHz >= points[points.length - 1].frequencyHz) return points[points.length - 1].magnitudeDb
  for (let index = 1; index < points.length; index++) {
    const lower = points[index - 1]
    const upper = points[index]
    if (frequencyHz > upper.frequencyHz) continue
    const fraction = Math.log(frequencyHz / lower.frequencyHz) / Math.log(upper.frequencyHz / lower.frequencyHz)
    return lower.magnitudeDb + (upper.magnitudeDb - lower.magnitudeDb) * fraction
  }
  return points[points.length - 1].magnitudeDb
}

function applyMappedCorrection(points: readonly ResponsePoint[], bandsDb: readonly number[]): ResponsePoint[] {
  const cutoffs = Array.from({ length: bandsDb.length }, (_, index) =>
    20 * (20_000 / 20) ** ((index + 1) / bandsDb.length))
  return points.map((point) => {
    const bandIndex = cutoffs.findIndex((cutoff) => point.frequencyHz <= cutoff)
    const index = bandIndex < 0 ? bandsDb.length - 1 : bandIndex
    return { ...point, magnitudeDb: point.magnitudeDb + (bandsDb[index] ?? 0) }
  })
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

    expect(detectLfExtensionHz(points)).toBe(200)
  })

  test('does not treat a broad low-frequency feature as a lower extension', () => {
    const points = new Array(29).fill(0).map((_, index) => {
      const frequencyHz = 20 + index * 10
      return { frequencyHz, magnitudeDb: frequencyHz < 100 ? -8 : 0 }
    })

    expect(detectLfExtensionHz(points)).toBeGreaterThanOrEqual(90)
    expect(detectLfExtensionHz(points)).toBeLessThanOrEqual(120)
  })

  for (const enteringHz of [250, 200, 150, 120, 100, 80, 60, 40]) {
    test(`detects the -3 dB and -6 dB capability for a ${enteringHz} Hz rolloff`, () => {
      const capability = detectLfCapability(responseWithLowFrequencyRolloff(enteringHz))
      const expectedMinus3Hz = enteringHz / Math.sqrt(2)
      const expectedMinus6Hz = enteringHz / 2

      expect(capability.minus3Db.frequencyHz).toBeGreaterThan(expectedMinus3Hz * 0.75)
      expect(capability.minus3Db.frequencyHz).toBeLessThan(expectedMinus3Hz * 1.25)
      expect(capability.minus6Db.frequencyHz).toBeGreaterThanOrEqual(Math.max(20, expectedMinus6Hz * 0.65))
      expect(capability.minus6Db.frequencyHz).toBeLessThan(expectedMinus6Hz * 1.35)
      expect(capability.minus6Db.frequencyHz).toBeLessThanOrEqual(capability.minus3Db.frequencyHz)
      expect(capability.minus3Db.confidence).toBeGreaterThan(0.4)
      expect(capability.minus6Db.confidence).toBeGreaterThan(0.4)
    })
  }

  test('returns capability fields and never boosts below the hard LF limit', () => {
    const result = calculateCorrection(
      aggregatePoints(responseWithLowFrequencyRolloff(250)),
      profile,
      { headroomVerified: true },
    )
    const hardLimitHz = result.lfCapability.minus6Db.frequencyHz

    expect(result.lfExtensionHz).toBe(result.lfCapability.minus3Db.frequencyHz)
    expect(result.lfExtension3DbHz).toBe(result.lfCapability.minus3Db.frequencyHz)
    expect(result.lfExtension6DbHz).toBe(result.lfCapability.minus6Db.frequencyHz)
    expect(result.lfExtensionConfidence).toBeGreaterThan(0)
    expect(result.lfCapability.minus3Db.confidence).toBeGreaterThan(0)
    expect(result.lfCapability.minus6Db.confidence).toBeGreaterThan(0)
    expect(result.target
      .filter((point) => point.frequencyHz <= hardLimitHz)
      .every((point) => point.magnitudeDb <= 0)).toBe(true)
    expect(result.correction
      .filter((point) => point.frequencyHz <= hardLimitHz)
      .every((point) => point.magnitudeDb <= 0)).toBe(true)
  })

  test('does not authorize low-frequency target boost when capability is unknown on the production grid', () => {
    const points = Array.from({ length: 48 }, (_, index) => ({
      frequencyHz: 20 * (20_000 / 20) ** (index / 47),
      magnitudeDb: 0,
    }))
    const capability = detectLfCapability(points)
    const target = targetPointsFor(points, capability)

    expect(Math.min(capability.minus3Db.confidence, capability.minus6Db.confidence)).toBe(0)
    expect(target.filter((point) => point.frequencyHz < 200).every((point) => point.magnitudeDb <= 0)).toBe(true)
  })

  test('smoothly tapers positive target values between the capability estimates', () => {
    const capability = {
      minus3Db: { frequencyHz: 200, confidence: 1 },
      minus6Db: { frequencyHz: 100, confidence: 1 },
    }
    const target = targetPointsFor([
      { frequencyHz: 80, magnitudeDb: 0 },
      { frequencyHz: 100, magnitudeDb: 0 },
      { frequencyHz: 150, magnitudeDb: 0 },
      { frequencyHz: 200, magnitudeDb: 0 },
    ], capability)

    expect(target[0]?.magnitudeDb).toBe(0)
    expect(target[1]?.magnitudeDb).toBe(0)
    expect(target[2]?.magnitudeDb).toBeGreaterThan(0)
    expect(target[2]?.magnitudeDb).toBeLessThan(target[3]?.magnitudeDb ?? 0)
  })

  test('improves a known broad system after 64-band mapping without boosting a narrow null', () => {
    const points = Array.from({ length: 64 }, (_, index) => {
      const frequencyHz = 20 * (20_000 / 20) ** (index / 63)
      const logFrequency = Math.log(frequencyHz / 1_000)
      const broadPeak = 8 * Math.exp(-(logFrequency ** 2) / (2 * 0.28 ** 2))
      const narrowNull = index === 20 ? -8 : 0
      const lowRolloff = frequencyHz < 120 ? -6 * Math.log2(120 / frequencyHz) : 0
      return { frequencyHz, magnitudeDb: broadPeak + narrowNull + lowRolloff }
    })
    const result = calculateCorrection(aggregatePoints(points, 0), profile, { headroomVerified: true })
    const bandCorrection = mapCorrectionToBandsConservative(result.correction, Array.from({ length: 64 }, (_, index) =>
      20 * (20_000 / 20) ** ((index + 1) / 64)))
    const corrected = applyMappedCorrection(points, bandCorrection)

    expect(targetErrorRms(corrected, result.target)).toBeLessThan(targetErrorRms(points, result.target))
    const nullFrequency = points[20]?.frequencyHz ?? 60
    const nullBandIndex = bandCorrection.findIndex((_, index) =>
      20 * (20_000 / 20) ** ((index + 1) / 64) >= nullFrequency)
    expect(nullBandIndex).toBeGreaterThanOrEqual(0)
    expect(bandCorrection[nullBandIndex]).toBeLessThanOrEqual(0)
  })
})
