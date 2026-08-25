import { describe, expect, test } from 'bun:test'
import type { MeasurementSweep } from '#shared/types/protocol'
import { analyzeCompositeMeasurement, analyzeMeasurement, detectSweepStart, normalizeResponsePoints, CLOCK_DRIFT_HARD_REJECT_PPM } from './response'
import { windowedImpulseResponse } from './impulse'
import { generateCompositeSweepReference, generateSweepReference, sweepSampleParts } from '../sweep-reference'
import { parseMicCalibrationProfile } from '../mics/profile'
import type { MicCalibrationProfile } from '../mics/types'
import { calculateCorrection, targetErrorRms, type AggregateResponse } from '../correction/optimizer'
import { mapCorrectionToBandsConservative } from '../correction/bandMapper'
import type { ResponsePoint } from './response'

const sweep: MeasurementSweep = {
  algorithm: 'exponential-sine-v1',
  captureKind: 'position-composite',
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
  endMarkerStartHz: 3_400,
  endMarkerEndHz: 1_200,
  endMarkerDurationMs: 20,
  interSweepGapMs: 20,
  levelDbfs: -12,
  fadeInMs: 10,
  fadeOutMs: 10,
}

function generateMeasurementReference(measurementSweep: MeasurementSweep): Float32Array {
  return generateSweepReference(measurementSweep)
}

function convolve(samples: Float32Array, impulse: Float32Array): Float32Array {
  const result = new Float32Array(samples.length + impulse.length - 1)
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    for (let impulseIndex = 0; impulseIndex < impulse.length; impulseIndex++) {
      result[sampleIndex + impulseIndex] += (samples[sampleIndex] ?? 0) * (impulse[impulseIndex] ?? 0)
    }
  }
  return result
}

function lowShelfImpulse(sampleRate: number): Float32Array {
  const impulse = new Float32Array(Math.round(sampleRate * 0.02))
  const decay = 0.96
  const lowFrequencyGain = 1.2
  const tailGain = lowFrequencyGain * (1 - decay)
  impulse[0] = 1 + tailGain
  for (let index = 1; index < impulse.length; index++) impulse[index] = tailGain * decay ** index
  return impulse
}

function aggregateForCorrection(points: readonly ResponsePoint[]): AggregateResponse {
  return {
    channel: 'left',
    points: points.map((point) => ({ ...point })),
    positionResponses: [],
    spreadDb: points.map((point) => ({ ...point, magnitudeDb: 0.5 })),
    records: [],
    repeatability: [],
    failedGroups: [],
    broadbandLevelDb: null,
    relativeChannelLevelDb: null,
  }
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
      expect(detection.clockRatio).toBeCloseTo(ratio, 3)
      expect(Math.abs((detection.driftPpm ?? 0) - (ratio - 1) * 1_000_000)).toBeLessThan(250)
      expect(detection.startSample).toBeCloseTo(sweepSampleParts(sweep).sweepStartSamples * ratio, 0)
    }
  })

  test('analyzes left and right sweeps from one composite capture', () => {
    const result = analyzeCompositeMeasurement(
      generateCompositeSweepReference(sweep),
      sweep.sampleRate,
      sweep,
      profile,
    )

    expect(result.status).toBe('ok')
    expect(result.detection.rightStartSample).toBe(sweepSampleParts(sweep).rightSweepStartSamples)
    expect(result.left.status).toBe('ok')
    expect(result.right.status).toBe('ok')
    expect(result.left.rawPoints).toHaveLength(48)
    expect(result.right.rawPoints).toHaveLength(48)
  })

  test('rejects an implausibly large marker-derived clock mismatch', () => {
    const detection = detectSweepStart(
      stretchCapture(generateMeasurementReference(sweep), 1.002),
      sweep,
      sweep.sampleRate,
    )

    expect(detection.found).toBe(false)
    expect(detection.failureReason).toBe('clock_drift_unreliable')
    expect(Math.abs(detection.driftPpm ?? 0)).toBeGreaterThan(CLOCK_DRIFT_HARD_REJECT_PPM)
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

  test('recovers a known synthetic transfer function through the full analyzer', () => {
    const reference = generateMeasurementReference(sweep)
    const transfer = new Float32Array(32)
    transfer[0] = 1
    transfer[11] = 0.3
    const capture = new Float32Array(reference.length + transfer.length - 1)
    for (let sampleIndex = 0; sampleIndex < reference.length; sampleIndex++) {
      for (let transferIndex = 0; transferIndex < transfer.length; transferIndex++) {
        capture[sampleIndex + transferIndex] += reference[sampleIndex] * transfer[transferIndex]
      }
    }

    const result = analyzeMeasurement(capture, sweep.sampleRate, sweep, profile)

    expect(result.status).toBe('ok')
    expect(result.diagnostics.detected).toBe(true)
    expect(result.rawPoints).toHaveLength(48)
    const expected = result.rawPoints.map((point) => {
      let real = 0
      let imaginary = 0
      for (let index = 0; index < transfer.length; index++) {
        const phase = -2 * Math.PI * point.frequencyHz * index / sweep.sampleRate
        real += (transfer[index] ?? 0) * Math.cos(phase)
        imaginary += (transfer[index] ?? 0) * Math.sin(phase)
      }
      return 20 * Math.log10(Math.hypot(real, imaginary))
    })
    const referenceValues = expected.filter((_, index) => {
      const frequencyHz = result.rawPoints[index]?.frequencyHz ?? 0
      return frequencyHz >= 500 && frequencyHz <= 2_000
    }).sort((left, right) => left - right)
    const normalization = referenceValues[Math.floor(referenceValues.length / 2)] ?? 0
    const maximumError = result.rawPoints.reduce((maximum, point, index) =>
      Math.max(maximum, Math.abs(point.magnitudeDb - ((expected[index] ?? 0) - normalization))), 0)

    expect(maximumError).toBeLessThan(0.75)
  })

  test('runs a synthetic system through analysis, drift correction, optimization, and band mapping', () => {
    const reference = generateMeasurementReference(sweep)
    const stretchedCapture = stretchCapture(
      convolve(reference, lowShelfImpulse(sweep.sampleRate)),
      1.0005,
    )
    const measured = analyzeMeasurement(stretchedCapture, sweep.sampleRate, sweep, profile)

    expect(measured.status).toBe('ok')
    expect(measured.diagnostics.clockDriftPpm).toBeGreaterThan(200)
    expect(measured.diagnostics.clockDriftPpm).toBeLessThan(600)

    const aggregate = aggregateForCorrection(measured.correctedPoints)
    const correction = calculateCorrection(aggregate, profile, { headroomVerified: true })
    const bandGains = mapCorrectionToBandsConservative(
      correction.correction,
      Array.from({ length: 64 }, (_, index) => 20 * (20_000 / 20) ** ((index + 1) / 64)),
    )
    const corrected = measured.correctedPoints.map((point) => {
      const bandIndex = bandGains.findIndex((_, index) => point.frequencyHz <= 20 * (20_000 / 20) ** ((index + 1) / 64))
      return {
        ...point,
        magnitudeDb: point.magnitudeDb + (bandGains[bandIndex < 0 ? bandGains.length - 1 : bandIndex] ?? 0),
      }
    })

    expect(targetErrorRms(corrected, correction.target)).toBeLessThan(
      targetErrorRms(measured.correctedPoints, correction.target),
    )
    expect(bandGains.every(Number.isFinite)).toBe(true)
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

  test('keeps an envelope estimate diagnostic when markers fail without accepting the sweep', () => {
    const reference = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    const markerless = reference.slice()
    markerless.fill(0, parts.leadingMarkerStartSamples, parts.sweepStartSamples)
    markerless.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.syncMarkerSamples)

    const detection = detectSweepStart(markerless, sweep, sweep.sampleRate)
    const result = analyzeMeasurement(markerless, sweep.sampleRate, sweep, profile)

    expect(detection.found).toBe(false)
    expect(detection.offsetMs).toBeNull()
    expect(detection.envelopeOnlyOffsetMs).not.toBeNull()
    expect(result.status).toBe('sync_marker_not_found')
    expect(result.diagnostics.envelopeOnlyOffsetMs).not.toBeNull()
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
