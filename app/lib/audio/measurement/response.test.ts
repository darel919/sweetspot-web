import { describe, expect, test } from 'bun:test'
import type { MeasurementSweep } from '#shared/types/protocol'
import { analyzeMeasurement } from './response'
import { generateSweepReference } from '../sweep-reference'
import { parseMicCalibrationProfile } from '../mics/profile'
import type { MicCalibrationProfile } from '../mics/types'

const sweep: MeasurementSweep = {
  algorithm: 'exponential-sine-v1',
  sampleRate: 8_000,
  startHz: 20,
  endHz: 3_500,
  durationMs: 800,
  preRollMs: 100,
  postRollMs: 100,
  levelDbfs: -12,
  fadeInMs: 10,
  fadeOutMs: 10,
}

function makeProfile(points: MicCalibrationProfile['points'] = [
  { frequencyHz: 20, responseDb: 0 },
  { frequencyHz: 1_000, responseDb: 0 },
  { frequencyHz: 20_000, responseDb: 0 },
]): MicCalibrationProfile {
  return parseMicCalibrationProfile({
    id: 'test-microphone',
    name: 'Test microphone',
    manufacturer: 'Test',
    model: 'Test',
    sourceUrl: 'https://example.test/microphone',
    sourceDate: '2026-01-01',
    referenceType: 'unknown',
    sourceSmoothing: 'none',
    capturePath: 'test capture path',
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

describe('measurement response analysis', () => {
  const profile = makeProfile()

  test('finds a delayed local sweep and returns a smoothed response', () => {
    const reference = generateSweepReference(sweep)
    const delay = 160
    const capture = new Float32Array(reference.length + delay)
    capture.set(reference, delay)
    const result = analyzeMeasurement(capture, sweep.sampleRate, sweep, profile)
    expect(result.status).toBe('ok')
    expect(result.points.length).toBe(48)
    expect(result.rawPoints.length).toBe(48)
    expect(result.micProfile.id).toBe('test-microphone')
    expect(result.diagnostics.detected).toBe(true)
    expect(result.diagnostics.detectionOffsetMs).toBeGreaterThanOrEqual(0)
  })

  test('rejects silence before trying to estimate a response', () => {
    const result = analyzeMeasurement(new Float32Array(8_000), sweep.sampleRate, sweep, profile)
    expect(result.status).toBe('signal_too_low')
    expect(result.points).toHaveLength(0)
  })

  test('keeps raw points and applies inverse profile compensation to the corrected curve', () => {
    const reference = generateSweepReference(sweep)
    const delay = 160
    const capture = new Float32Array(reference.length + delay)
    capture.set(reference, delay)
    const constantThreeDbMic = makeProfile([
      { frequencyHz: 20, responseDb: 3 },
      { frequencyHz: 20_000, responseDb: 3 },
    ])
    const result = analyzeMeasurement(capture, sweep.sampleRate, sweep, constantThreeDbMic)
    expect(result.status).toBe('ok')
    const pointIndex = Math.floor(result.points.length / 2)
    expect(result.rawPoints[pointIndex].magnitudeDb - result.points[pointIndex].magnitudeDb).toBeCloseTo(3, 1)
  })
})
