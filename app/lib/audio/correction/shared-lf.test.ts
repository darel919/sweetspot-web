import { describe, expect, test } from 'bun:test'
import type { AggregateResponse, PositionResponse } from '../measurement/aggregation'
import type { ResponsePoint } from '../measurement/response'
import { parseMicCalibrationProfile } from '../mics/profile'
import { calculateCorrection, targetErrorRms } from './optimizer'
import { mapCorrectionToBandsConservative } from './bandMapper'
import {
  DEFAULT_SHARED_LF_POLICY,
  assessSharedLfReproduction,
  blendSharedLfCorrections,
} from './shared-lf'

const profile = parseMicCalibrationProfile({
  id: 'shared-lf-test', name: 'shared-lf-test', author: 'test', manufacturer: 'test', model: 'test', sourceUrl: 'https://example.test', sourceDate: '2026-01-01',
  referenceType: 'unknown', sourceSmoothing: 'none', capturePath: 'test', capturePathStatus: 'validated', dataMethod: 'published-data', normalizeAtHz: 1_000,
  referenceMicrophone: 'test', referenceMicSpacingMm: 1, referenceMicSpacingApproximate: false, measurementEnvironment: 'test',
  excitation: 'test', orientationsAveraged: 1, referenceCalibration: 'test', publishedTraces: ['test'], directivityMeasuredSeparately: false,
  points: [{ frequencyHz: 20, responseDb: 0 }, { frequencyHz: 20_000, responseDb: 0 }],
  trust: { minHz: 30, fullTrustMaxHz: 8_000, taperToHz: 12_000 },
})

const correctionGrid = [20, 60, 120, 150, 180, 220, 250, 500, 1_000]

function curve(values: readonly number[], frequencies = correctionGrid): ResponsePoint[] {
  return frequencies.map((frequencyHz, index) => ({
    frequencyHz,
    magnitudeDb: values[index] ?? 0,
  }))
}

function aggregateFromPoints(
  points: readonly ResponsePoint[],
  spreadDb = 0,
  positionResponses: PositionResponse[] = [],
): AggregateResponse {
  return {
    channel: 'left',
    points: points.map((point) => ({ ...point })),
    spreadDb: points.map((point) => ({ ...point, magnitudeDb: spreadDb })),
    positionResponses,
    records: [],
    repeatability: [],
    failedGroups: [],
    broadbandLevelDb: null,
    relativeChannelLevelDb: null,
  }
}

function position(
  positionId: PositionResponse['positionId'],
  positionIndex: number,
  values: readonly number[],
  frequencies: readonly number[] = detectorGrid,
): PositionResponse {
  return {
    positionId,
    positionIndex,
    positionCount: 5,
    channel: 'left',
    points: curve(values, frequencies),
    broadbandLevelDb: null,
  }
}

function detectorAggregate(
  channel: 'left' | 'right',
  positions: PositionResponse[],
): AggregateResponse {
  const points = positions[0]?.points ?? []
  return {
    channel,
    points,
    spreadDb: points.map((point) => ({ ...point, magnitudeDb: 0 })),
    positionResponses: positions,
    records: [],
    repeatability: [],
    failedGroups: [],
    broadbandLevelDb: null,
    relativeChannelLevelDb: null,
  }
}

const detectorGrid = Array.from({ length: 49 }, (_, index) => 20 * (20_000 / 20) ** (index / 48))

function lfValue(frequencyHz: number, positionIndex: number, offsetDb = 0): number {
  const spatialDb = [-2, 1, 3, -1, 2][positionIndex] ?? 0
  const shapeDb = frequencyHz < 120 ? (frequencyHz - 120) / 30 : 0
  return spatialDb + shapeDb + offsetDb
}

function sharedDetectorAggregates(positionCount = 5): { left: AggregateResponse; right: AggregateResponse } {
  const ids: PositionResponse['positionId'][] = ['center', 'left', 'right', 'forward', 'backward']
  const leftPositions = ids.slice(0, positionCount).map((id, index) =>
    position(id, index, detectorGrid.map((frequencyHz) => lfValue(frequencyHz, index))))
  const rightPositions = ids.slice(0, positionCount).map((id, index) =>
    position(id, index, detectorGrid.map((frequencyHz) => lfValue(frequencyHz, index, 4))))
  return {
    left: detectorAggregate('left', leftPositions),
    right: detectorAggregate('right', rightPositions),
  }
}

describe('shared low-frequency correction', () => {
  test('uses the common curve exactly through the common boundary', () => {
    const common = curve([1, 1, 1, 1, 1, 1, 1, 1, 1])
    const left = curve([2, 2, 2, 2, 2, 2, 2, 4, 4])
    const right = curve([3, 3, 3, 3, 3, 3, 3, 5, 5])

    const result = blendSharedLfCorrections(common, left, right)

    expect(result.left.filter((point) => point.frequencyHz <= 120).map((point) => point.magnitudeDb)).toEqual([1, 1, 1])
    expect(result.right.filter((point) => point.frequencyHz <= 120).map((point) => point.magnitudeDb)).toEqual([1, 1, 1])
  })

  test('restores independent curves at and above the independent boundary', () => {
    const common = curve([0, 0, 0, 0, 0, 0, 0, 0, 0])
    const left = curve([1, 1, 1, 2, 3, 4, 5, 6, 7])
    const right = curve([-1, -1, -1, -2, -3, -4, -5, -6, -7])

    const result = blendSharedLfCorrections(common, left, right)

    expect(result.left.find((point) => point.frequencyHz === 250)?.magnitudeDb).toBe(5)
    expect(result.right.find((point) => point.frequencyHz === 250)?.magnitudeDb).toBe(-5)
    expect(result.left.find((point) => point.frequencyHz === 500)?.magnitudeDb).toBe(6)
    expect(result.right.find((point) => point.frequencyHz === 500)?.magnitudeDb).toBe(-6)
  })

  test('uses a monotonic smoothstep crossfade in log-frequency space', () => {
    const frequencies = [120, 150, 180, 220, 250]
    const result = blendSharedLfCorrections(
      curve([0, 0, 0, 0, 0], frequencies),
      curve([10, 10, 10, 10, 10], frequencies),
      curve([-10, -10, -10, -10, -10], frequencies),
    )

    const left = result.left.map((point) => point.magnitudeDb)
    const right = result.right.map((point) => point.magnitudeDb)
    expect(left[0]).toBe(0)
    expect(left[left.length - 1]).toBe(10)
    expect(right[0]).toBe(0)
    expect(right[right.length - 1]).toBe(-10)
    expect(left.every((value, index) => index === 0 || value >= (left[index - 1] ?? value))).toBe(true)
    expect(right.every((value, index) => index === 0 || value <= (right[index - 1] ?? value))).toBe(true)
    const logPosition = Math.log(180 / 120) / Math.log(250 / 120)
    const expectedWeight = logPosition * logPosition * (3 - 2 * logPosition)
    expect(left[2]).toBeCloseTo(expectedWeight * 10, 10)
    expect(left[2]).toBeGreaterThan(left[1] ?? 0)
    expect(left[2]).toBeLessThan(left[3] ?? 10)
  })

  test('preserves continuity, the input grid, and convex bounds', () => {
    const common = curve([0, -1, -2, -3, -4, -5, -6, -7, -8])
    const left = curve([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const right = curve([-1, -2, -3, -4, -5, -6, -7, -8, -9])
    const result = blendSharedLfCorrections(common, left, right)

    expect(result.left.map((point) => point.frequencyHz)).toEqual(common.map((point) => point.frequencyHz))
    expect(result.right.map((point) => point.frequencyHz)).toEqual(common.map((point) => point.frequencyHz))
    result.left.forEach((point, index) => {
      const values = [common[index]?.magnitudeDb, left[index]?.magnitudeDb].filter((value): value is number => value !== undefined)
      expect(point.magnitudeDb).toBeGreaterThanOrEqual(Math.min(...values))
      expect(point.magnitudeDb).toBeLessThanOrEqual(Math.max(...values))
      expect(Number.isFinite(point.magnitudeDb)).toBe(true)
    })
    expect(result.left.find((point) => point.frequencyHz === 120)?.magnitudeDb).toBe(-2)
    expect(result.left.find((point) => point.frequencyHz === 250)?.magnitudeDb).toBe(7)
  })

  test('leaves identical curves unchanged and rejects an invalid policy', () => {
    const points = curve([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(DEFAULT_SHARED_LF_POLICY).toEqual({ commonThroughHz: 120, independentFromHz: 250 })
    expect(blendSharedLfCorrections(points, points, points)).toEqual({ left: points, right: points })
    expect(() => blendSharedLfCorrections(points, points, points, {
      commonThroughHz: 250,
      independentFromHz: 120,
    })).toThrow()
  })

  test('detects shared LF shape after removing a constant channel offset', () => {
    const { left, right } = sharedDetectorAggregates()
    const result = assessSharedLfReproduction(left, right)

    expect(result.classification).toBe('likely-shared')
    expect(result.confidence).toBeGreaterThan(0.75)
    expect(result.shapeMismatchDb).not.toBeNull()
    expect(result.shapeMismatchDb ?? Number.POSITIVE_INFINITY).toBeLessThan(0.1)
    expect(result.estimatedUpperHz).not.toBeNull()
  })

  test('uses LF evidence when HF curves differ', () => {
    const { left, right } = sharedDetectorAggregates()
    right.positionResponses.forEach((response) => {
      response.points = response.points.map((point) => ({
        ...point,
        magnitudeDb: point.frequencyHz > 500 ? point.magnitudeDb + 8 : point.magnitudeDb,
      }))
    })

    expect(assessSharedLfReproduction(left, right).classification).toBe('likely-shared')
  })

  test('reduces shared confidence when spatial LF fingerprints differ', () => {
    const { left, right } = sharedDetectorAggregates()
    const differingSpatial = [3, -2, 1, 4, -3]
    right.positionResponses.forEach((response, index) => {
      const delta = differingSpatial[index] - ([-2, 1, 3, -1, 2][index] ?? 0)
      response.points = response.points.map((point) => ({ ...point, magnitudeDb: point.magnitudeDb + delta }))
    })

    const result = assessSharedLfReproduction(left, right)

    expect(result.classification).toBe('likely-independent')
    expect(result.spatialFingerprintMismatchDb ?? 0).toBeGreaterThan(3)
  })

  test('does not give high shared confidence to one matching position', () => {
    const { left, right } = sharedDetectorAggregates(1)
    const result = assessSharedLfReproduction(left, right)

    expect(result.classification).toBe('uncertain')
    expect(result.confidence).toBeLessThan(0.6)
  })

  test('does not classify isolated matching frequencies as a shared span', () => {
    const { left, right } = sharedDetectorAggregates()
    right.positionResponses.forEach((response) => {
      response.points = response.points.map((point) => ({
        ...point,
        magnitudeDb: point.magnitudeDb + 8 * Math.log2(point.frequencyHz / 100),
      }))
    })

    const result = assessSharedLfReproduction(left, right)

    expect(result.classification).not.toBe('likely-shared')
    expect(result.estimatedUpperHz).toBeNull()
  })

  test('reduces confidence for missing position pairs', () => {
    const completeAggregates = sharedDetectorAggregates()
    const complete = assessSharedLfReproduction(completeAggregates.left, completeAggregates.right)
    const partial = assessSharedLfReproduction(
      sharedDetectorAggregates().left,
      sharedDetectorAggregates(3).right,
    )

    expect(partial.confidence).toBeLessThan(complete.confidence)
    expect(partial.classification).not.toBe('likely-shared')
  })

  test('blends safe correction curves before conservative band mapping', () => {
    const frequencies = Array.from({ length: 64 }, (_, index) => 20 * (20_000 / 20) ** (index / 63))
    const commonPoints = frequencies.map((frequencyHz) => ({ frequencyHz, magnitudeDb: frequencyHz < 250 ? 7 : 0 }))
    const leftPoints = frequencies.map((frequencyHz) => ({ frequencyHz, magnitudeDb: frequencyHz < 250 ? 7 : frequencyHz < 1_000 ? 2 : -4 }))
    const rightPoints = frequencies.map((frequencyHz) => ({ frequencyHz, magnitudeDb: frequencyHz < 250 ? 7 : frequencyHz < 1_000 ? -2 : 3 }))
    const common = calculateCorrection(aggregateFromPoints(commonPoints), profile, { headroomVerified: true })
    const left = calculateCorrection(aggregateFromPoints(leftPoints), profile, { headroomVerified: true })
    const right = calculateCorrection(aggregateFromPoints(rightPoints), profile, { headroomVerified: true })
    const blended = blendSharedLfCorrections(common.correction, left.correction, right.correction)
    const cutoffs = frequencies
    const leftBands = mapCorrectionToBandsConservative(blended.left, cutoffs)
    const rightBands = mapCorrectionToBandsConservative(blended.right, cutoffs)

    expect(leftBands.slice(0, 12)).toEqual(rightBands.slice(0, 12))
    expect(leftBands.slice(24).some((value, index) => value !== rightBands[24 + index])).toBe(true)
    expect(targetErrorRms(
      leftPoints.map((point, index) => ({ ...point, magnitudeDb: point.magnitudeDb + (leftBands[index] ?? 0) })),
      left.target,
    )).toBeLessThan(targetErrorRms(leftPoints, left.target))
  })

  test('keeps narrow LF nulls and unsupported LF rolloff from becoming boosts', () => {
    const frequencies = Array.from({ length: 64 }, (_, index) => 20 * (20_000 / 20) ** (index / 63))
    const narrowNull = frequencies.map((frequencyHz) => ({ frequencyHz, magnitudeDb: Math.abs(frequencyHz - 80) < 4 ? -12 : 0 }))
    const nullCorrection = calculateCorrection(aggregateFromPoints(narrowNull), profile, { headroomVerified: true })
    const nullBands = mapCorrectionToBandsConservative(nullCorrection.correction, frequencies)
    expect(nullCorrection.correction.find((point) => Math.abs(point.frequencyHz - 80) < 4)?.magnitudeDb ?? 0).toBeLessThanOrEqual(0)
    expect(nullBands.find((_, index) => frequencies[index] !== undefined && Math.abs(frequencies[index] - 80) < 20) ?? 0).toBeLessThanOrEqual(0)

    const rolloff = frequencies.map((frequencyHz) => ({
      frequencyHz,
      magnitudeDb: frequencyHz < 180 ? -6 * Math.log2(180 / frequencyHz) : 0,
    }))
    const rolloffCorrection = calculateCorrection(aggregateFromPoints(rolloff), profile, { headroomVerified: true })
    expect(rolloffCorrection.correction
      .filter((point) => point.frequencyHz <= rolloffCorrection.lfCapability.minus6Db.frequencyHz)
      .every((point) => point.magnitudeDb <= 0)).toBe(true)
  })
})
