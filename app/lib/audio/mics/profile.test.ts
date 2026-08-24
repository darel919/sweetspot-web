import { describe, expect, test } from 'bun:test'
import {
  interpolateLogResponseDb,
  micCompensationDbAtHz,
  isMicCalibrationProfileEligibleForCorrection,
  parseMicCalibrationProfile,
  micTrustWeightAtHz,
} from './profile'
import type { MicCalibrationProfile } from './types'

function makeProfile(points = [
  { frequencyHz: 100, responseDb: 3 },
  { frequencyHz: 1_000, responseDb: 0 },
  { frequencyHz: 20_000, responseDb: -2 },
]): MicCalibrationProfile {
  return parseMicCalibrationProfile({
    id: 'test-microphone',
    name: 'Test microphone',
    author: 'Test author',
    manufacturer: 'Test',
    model: 'Test',
    sourceUrl: 'https://example.test/microphone',
    sourceDate: '2026-01-01',
    referenceType: 'unknown',
    sourceSmoothing: 'none',
    capturePath: 'test capture path',
    capturePathStatus: 'validated',
    dataMethod: 'published-data',
    normalizeAtHz: 1_000,
    referenceMicrophone: 'test reference',
    referenceMicSpacingMm: 1,
    referenceMicSpacingApproximate: false,
    measurementEnvironment: 'test',
    excitation: 'test',
    orientationsAveraged: 1,
    referenceCalibration: 'test',
    publishedTraces: ['test'],
    directivityMeasuredSeparately: false,
    points,
    trust: { minHz: 30, fullTrustMaxHz: 8_000, taperToHz: 12_000 },
  })
}

describe('microphone profile math', () => {
  const profile = makeProfile()

  test('interpolates source response in log frequency', () => {
    const lower = profile.points[0]
    const upper = profile.points[1]
    const frequencyHz = Math.sqrt(lower.frequencyHz * upper.frequencyHz)
    const expected = (lower.responseDb + upper.responseDb) / 2
    expect(interpolateLogResponseDb(profile, frequencyHz)).toBeCloseTo(expected, 6)
  })

  test('uses inverse sign for microphone compensation', () => {
    const syntheticProfile = makeProfile([
      { frequencyHz: 100, responseDb: 5 },
      { frequencyHz: 1_000, responseDb: 3 },
    ])
    expect(micCompensationDbAtHz(syntheticProfile, 100)).toBeCloseTo(-2, 6)
  })

  test('removes constant microphone sensitivity from spectral compensation', () => {
    const constantOffsetProfile = makeProfile([
      { frequencyHz: 100, responseDb: 3 },
      { frequencyHz: 1_000, responseDb: 3 },
      { frequencyHz: 20_000, responseDb: 3 },
    ])

    expect(micCompensationDbAtHz(constantOffsetProfile, 100)).toBeCloseTo(0, 6)
    expect(micCompensationDbAtHz(constantOffsetProfile, 500)).toBeCloseTo(0, 6)
    expect(micCompensationDbAtHz(constantOffsetProfile, 9_000)).toBeCloseTo(0, 6)
  })

  test('tapers trust before the extreme treble', () => {
    expect(micTrustWeightAtHz(profile, 20)).toBe(0)
    expect(micTrustWeightAtHz(profile, 1_000)).toBe(1)
    expect(micTrustWeightAtHz(profile, 9_000)).toBeLessThan(1)
    expect(micTrustWeightAtHz(profile, 13_000)).toBe(0)
  })

  test('caps mic-derived treble compensation', () => {
    const syntheticProfile = makeProfile([
      { frequencyHz: 100, responseDb: 3 },
      { frequencyHz: 20_000, responseDb: 20 },
    ])
    expect(Math.abs(micCompensationDbAtHz(syntheticProfile, 9_000))).toBeLessThanOrEqual(2)
    expect(Math.abs(micCompensationDbAtHz(syntheticProfile, 11_000))).toBeLessThanOrEqual(1)
    expect(micCompensationDbAtHz(syntheticProfile, 13_000)).toBeCloseTo(0, 6)
  })

  test('keeps unvalidated capture paths diagnostic-only', () => {
    expect(isMicCalibrationProfileEligibleForCorrection(profile)).toBe(true)
    const unvalidated = parseMicCalibrationProfile({
      ...profile,
      capturePathStatus: 'unvalidated',
    })
    expect(isMicCalibrationProfileEligibleForCorrection(unvalidated)).toBe(false)
  })
})
