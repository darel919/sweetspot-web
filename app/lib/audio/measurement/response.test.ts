import { describe, expect, test } from 'bun:test'
import type { MeasurementSweep } from '#shared/types/protocol'
import { analyzeMeasurement, detectSweepStart, normalizeResponsePoints } from './response'
import { windowedImpulseResponse } from './impulse'
import { generateSweepReference, sweepSampleParts } from '../sweep-reference'
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
  syncMarkerStartHz: 1_500,
  syncMarkerEndHz: 3_000,
  syncMarkerDurationMs: 20,
  syncMarkerGapMs: 10,
  levelDbfs: -12,
  fadeInMs: 10,
  fadeOutMs: 10,
}

function generateMeasurementReference(measurementSweep: MeasurementSweep): Float32Array {
  return generateSweepReference(measurementSweep)
}

function stretchCapture(samples: Float32Array, ratio: number): Float32Array {
  const stretched = new Float32Array(Math.ceil(samples.length * ratio))
  for (let index = 0; index < stretched.length; index++) {
    const sourcePosition = index / ratio
    const lower = Math.floor(sourcePosition)
    const upper = Math.min(samples.length - 1, lower + 1)
    const fraction = sourcePosition - lower
    stretched[index] = (samples[lower] ?? 0) + ((samples[upper] ?? 0) - (samples[lower] ?? 0)) * fraction
  }
  return stretched
}

function makeProfile(points: MicCalibrationProfile['points'] = [
  { frequencyHz: 20, responseDb: 0 },
  { frequencyHz: 1_000, responseDb: 0 },
  { frequencyHz: 20_000, responseDb: 0 },
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

  test('matches both synchronization markers despite pre-sweep noise and weak bass', () => {
    const reference = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    const delay = 173
    const capture = new Float32Array(reference.length + delay)
    capture.set(reference, delay)
    for (let index = 0; index < parts.sweepSamples / 4; index++) {
      const sampleIndex = delay + parts.sweepStartSamples + index
      capture[sampleIndex] *= 0.01
    }
    for (let index = 0; index < delay; index++) capture[index] = Math.sin(index * 0.37) * 0.03
    capture[delay - 3] = 0.9

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(true)
    expect(detection.startSample).toBe(delay + parts.sweepStartSamples)
    expect(detection.trailingMarkerSample).toBe(delay + parts.trailingMarkerStartSamples)
    expect(detection.confidence).toBeGreaterThan(0.8)
    expect(detection.driftPpm).toBeCloseTo(0, 3)
  })

  test('estimates capture clock stretch from the marker pair', () => {
    for (const ratio of [0.99975, 1.00025]) {
      const capture = stretchCapture(generateMeasurementReference(sweep), ratio)
      const detection = detectSweepStart(capture, sweep, sweep.sampleRate)
      expect(detection.found).toBe(true)
      expect(detection.clockRatio).toBeCloseTo(ratio, 4)
      expect(Math.abs((detection.driftPpm ?? 0) - (ratio - 1) * 1_000_000)).toBeLessThan(25)
      expect(detection.startSample).toBeCloseTo(sweepSampleParts(sweep).sweepStartSamples * ratio, 0)
    }
  })

  test('finds a delayed local sweep and separates analysis and display curves', () => {
    const reference = generateMeasurementReference(sweep)
    const delay = 160
    const capture = new Float32Array(reference.length + delay)
    capture.set(reference, delay)
    const result = analyzeMeasurement(capture, sweep.sampleRate, sweep, profile)
    expect(result.status).toBe('ok')
    expect(result.rawPoints.length).toBe(48)
    expect(result.correctedPoints.length).toBe(48)
    expect(result.displayPoints.length).toBe(48)
    expect(result.displayPoints).not.toBe(result.correctedPoints)
    expect(result.micProfile.id).toBe('test-microphone')
    expect(result.diagnostics.detected).toBe(true)
    expect(result.diagnostics.detectionOffsetMs).toBeGreaterThanOrEqual(0)
    expect(result.diagnostics.failureReason).toBeNull()
  })

  test('rejects silence before trying to estimate a response', () => {
    const result = analyzeMeasurement(new Float32Array(8_000), sweep.sampleRate, sweep, profile)
    expect(result.status).toBe('signal_too_low')
    expect(result.correctedPoints).toHaveLength(0)
    expect(result.displayPoints).toHaveLength(0)
  })

  test('normalizes a response against a broadband reference instead of one bin', () => {
    const points = [
      { frequencyHz: 400, magnitudeDb: 2 },
      { frequencyHz: 500, magnitudeDb: 2 },
      { frequencyHz: 700, magnitudeDb: 2 },
      { frequencyHz: 1_000, magnitudeDb: -18 },
      { frequencyHz: 1_400, magnitudeDb: 2 },
      { frequencyHz: 2_000, magnitudeDb: 2 },
      { frequencyHz: 3_000, magnitudeDb: 2 },
    ]

    const normalized = normalizeResponsePoints(points)

    expect(normalized[0]?.magnitudeDb).toBeCloseTo(0, 6)
    expect(normalized[3]?.magnitudeDb).toBeCloseTo(-20, 6)
    expect(normalized[6]?.magnitudeDb).toBeCloseTo(0, 6)
  })

  test('keeps raw points and applies inverse profile compensation to the corrected curve', () => {
    const reference = generateMeasurementReference(sweep)
    const delay = 160
    const capture = new Float32Array(reference.length + delay)
    capture.set(reference, delay)
    const constantThreeDbMic = makeProfile([
      { frequencyHz: 20, responseDb: 3 },
      { frequencyHz: 20_000, responseDb: 3 },
    ])
    const result = analyzeMeasurement(capture, sweep.sampleRate, sweep, constantThreeDbMic)
    expect(result.status).toBe('ok')
    const pointIndex = Math.floor(result.correctedPoints.length / 2)
    expect(result.rawPoints[pointIndex].magnitudeDb - result.correctedPoints[pointIndex].magnitudeDb).toBeCloseTo(0, 1)
    expect(result.displayPoints).not.toBe(result.correctedPoints)
  })

  test('rejects a capture that ends before the active sweep ends', () => {
    const reference = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    const shortCapture = reference.slice(0, parts.preRollSamples + parts.sweepSamples - 1)

    const result = analyzeMeasurement(shortCapture, sweep.sampleRate, sweep, profile)

    expect(result.status).toBe('sync_marker_not_found')
    expect(result.diagnostics.failureReason).toBe('sync_marker_not_found')
    expect(result.correctedPoints).toHaveLength(0)
    expect(result.displayPoints).toHaveLength(0)
  })

  test('rejects an active-looking capture when the ending marker is missing', () => {
    const reference = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    const missingEndingMarker = reference.slice(0, parts.trailingMarkerStartSamples)

    const result = analyzeMeasurement(missingEndingMarker, sweep.sampleRate, sweep, profile)

    expect(result.status).toBe('sync_marker_not_found')
    expect(result.diagnostics.detected).toBe(false)
    expect(result.diagnostics.endingMarkerConfidence).toBe(0)
    expect(result.correctedPoints).toHaveLength(0)
  })

  test('does not accept broadband noise and a transient as a sweep', () => {
    const capture = new Float32Array(generateMeasurementReference(sweep).length)
    for (let index = 0; index < capture.length; index++) capture[index] = Math.sin(index * 0.71) * 0.03
    capture[120] = 0.95

    const result = analyzeMeasurement(capture, sweep.sampleRate, sweep, profile)

    expect(result.status).toBe('sync_marker_not_found')
    expect(result.diagnostics.detected).toBe(false)
    expect(result.correctedPoints).toHaveLength(0)
  })

  test('scopes clipping validity to the synchronized measurement window', () => {
    const reference = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    const delay = 173
    const leadingClip = new Float32Array(reference.length + delay)
    leadingClip.set(reference, delay)
    leadingClip[delay - 3] = 1.2
    const leadingResult = analyzeMeasurement(leadingClip, sweep.sampleRate, sweep, profile)

    expect(leadingResult.status).toBe('ok')
    expect(leadingResult.diagnostics.clipped).toBe(false)

    const activeClip = leadingClip.slice()
    activeClip[delay + parts.sweepStartSamples + 10] = 1.2
    const activeResult = analyzeMeasurement(activeClip, sweep.sampleRate, sweep, profile)
    expect(activeResult.status).toBe('capture_clipped')
    expect(activeResult.diagnostics.clipped).toBe(true)
  })

  test('gates late response artifacts using the bounded direct path', () => {
    const clean = new Float32Array(4_096)
    clean[0] = 1
    const withLateArtifact = clean.slice()
    withLateArtifact[2_500] = 100

    const cleanPoints = windowedImpulseResponse(clean, sweep.sampleRate, 20, 3_500, 12)
    const gatedPoints = windowedImpulseResponse(withLateArtifact, sweep.sampleRate, 20, 3_500, 12)

    expect(gatedPoints).toHaveLength(cleanPoints.length)
    for (let index = 0; index < cleanPoints.length; index++) {
      expect(gatedPoints[index].magnitudeDb).toBeCloseTo(cleanPoints[index].magnitudeDb, 5)
    }
  })
})
