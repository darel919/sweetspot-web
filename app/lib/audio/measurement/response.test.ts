import { describe, expect, test } from 'bun:test'
import type { MeasurementSweep } from '#shared/types/protocol'
import { analyzeCompositeMeasurement, analyzeMeasurement, detectSweepStart, normalizeResponsePoints, CLOCK_DRIFT_HARD_REJECT_PPM } from './response'
import { windowedImpulseResponse } from './impulse'
import { generateCompositeSweepReference, generateSweepReference, generateSyncMarker, sweepSampleParts } from '../sweep-reference'
import { parseMicCalibrationProfile } from '../mics/profile'
import type { MicCalibrationProfile } from '../mics/types'
import { calculateCorrection, targetErrorRms, type AggregateResponse } from '../correction/optimizer'
import { mapCorrectionToBandsConservative } from '../correction/bandMapper'
import type { ResponsePoint } from './response'

const sweep: MeasurementSweep = {
  sweepRevision: 'android-sweep-v3',
  algorithm: 'exponential-sine-v1',
  captureKind: 'position-composite',
  markerChannel: 'left',
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
  sweepLevelDbfs: -12,
  markerLevelDbfs: -12,
  fadeInMs: 10,
  fadeOutMs: 10,
}

const androidCalibrationSweep: MeasurementSweep = {
  sweepRevision: 'android-sweep-v3',
  algorithm: 'exponential-sine-v1',
  captureKind: 'position-composite',
  markerChannel: 'left',
  sampleRate: 48_000,
  startHz: 20,
  endHz: 20_000,
  durationMs: 1_500,
  preRollMs: 500,
  postRollMs: 500,
  syncMarkerStartHz: 700,
  syncMarkerEndHz: 2_600,
  syncMarkerDurationMs: 150,
  syncMarkerGapMs: 50,
  endMarkerStartHz: 3_500,
  endMarkerEndHz: 1_500,
  endMarkerDurationMs: 150,
  interSweepGapMs: 50,
  sweepLevelDbfs: -12,
  markerLevelDbfs: -12,
  fadeInMs: 20,
  fadeOutMs: 20,
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
    spatialConsistency: [],
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

function setMarkerCorrelation(
  capture: Float32Array,
  measurementSweep: MeasurementSweep,
  kind: 'start' | 'end',
  targetCorrelation: number,
  markerStartOverride?: number,
): void {
  const marker = generateSyncMarker(measurementSweep, measurementSweep.sampleRate, kind)
  const parts = sweepSampleParts(measurementSweep)
  const start = markerStartOverride ?? (kind === 'start' ? parts.leadingMarkerStartSamples : parts.trailingMarkerStartSamples)
  const centeredMarker = new Float64Array(marker.length)
  const markerMean = marker.reduce((sum, value) => sum + value, 0) / marker.length
  let markerEnergy = 0
  for (let index = 0; index < marker.length; index++) {
    const value = marker[index] - markerMean
    centeredMarker[index] = value
    markerEnergy += value * value
  }
  const noise = new Float64Array(marker.length)
  let noiseMean = 0
  for (let index = 0; index < marker.length; index++) {
    noiseMean += Math.sin(index * 0.731 + (kind === 'start' ? 0.37 : 1.13))
  }
  noiseMean /= marker.length
  let markerNoiseProjection = 0
  let noiseEnergy = 0
  for (let index = 0; index < marker.length; index++) {
    noise[index] = Math.sin(index * 0.731 + (kind === 'start' ? 0.37 : 1.13)) - noiseMean
    markerNoiseProjection += noise[index] * centeredMarker[index]
    noiseEnergy += noise[index] * noise[index]
  }
  markerNoiseProjection /= markerEnergy
  noiseEnergy = 0
  for (let index = 0; index < marker.length; index++) {
    noise[index] -= markerNoiseProjection * centeredMarker[index]
    noiseEnergy += noise[index] * noise[index]
  }
  const noiseScale = Math.sqrt(markerEnergy * (1 - targetCorrelation ** 2) / (targetCorrelation ** 2 * noiseEnergy))
  for (let index = 0; index < marker.length; index++) {
    capture[start + index] = centeredMarker[index] + noise[index] * noiseScale
  }
}

function setExactMarker(
  capture: Float32Array,
  measurementSweep: MeasurementSweep,
  kind: 'start' | 'end',
  markerStart: number,
): void {
  capture.set(generateSyncMarker(measurementSweep, measurementSweep.sampleRate, kind), markerStart)
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
    expect(detection.leadingMarkerCandidates.length).toBeGreaterThan(0)
    expect(detection.leadingMarkerCandidates.length).toBeLessThanOrEqual(16)
    expect(detection.trailingMarkerCandidates.length).toBeGreaterThan(0)
    expect(detection.markerPairCandidates[0]?.accepted).toBe(true)
  })

  test('accepts moderate acoustic marker correlation when marker timing is exact', () => {
    const capture = generateMeasurementReference(sweep)
    setMarkerCorrelation(capture, sweep, 'start', 0.36)
    setMarkerCorrelation(capture, sweep, 'end', 0.40)

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(true)
    expect(detection.rawLeadingMarkerConfidence).toBeGreaterThan(0.3)
    expect(detection.rawLeadingMarkerConfidence).toBeLessThan(0.45)
    expect(detection.rawTrailingMarkerConfidence).toBeGreaterThan(0.35)
    expect(detection.rawTrailingMarkerConfidence).toBeLessThan(0.45)
    expect(detection.observedMarkerSeparationSamples).toBe(detection.expectedMarkerSeparationSamples)
    expect(detection.markerTimingAgreement).toBe(1)
    expect(detection.confidence).toBeGreaterThan(0)
  })

  test('accepts field-shaped moderate marker correlations on the Android calibration layout', () => {
    const parts = sweepSampleParts(androidCalibrationSweep)
    const capture = generateMeasurementReference(androidCalibrationSweep)
    setMarkerCorrelation(capture, androidCalibrationSweep, 'start', 0.36)
    setMarkerCorrelation(capture, androidCalibrationSweep, 'end', 0.40)

    const detection = detectSweepStart(capture, androidCalibrationSweep, androidCalibrationSweep.sampleRate)
    const analysis = analyzeMeasurement(capture, androidCalibrationSweep.sampleRate, androidCalibrationSweep, profile)

    expect(parts.trailingMarkerStartSamples - parts.leadingMarkerStartSamples).toBe(158_400)
    expect(detection.found).toBe(true)
    expect(analysis.status).toBe('ok')
    expect(detection.leadingMarkerSample).toBe(parts.leadingMarkerStartSamples)
    expect(detection.trailingMarkerSample).toBe(parts.trailingMarkerStartSamples)
    expect(detection.expectedMarkerSeparationSamples).toBe(158_400)
    expect(detection.observedMarkerSeparationSamples).toBe(158_400)
    expect(detection.rawLeadingMarkerConfidence).toBeGreaterThan(0.3)
    expect(detection.rawLeadingMarkerConfidence).toBeLessThan(0.45)
    expect(detection.rawTrailingMarkerConfidence).toBeGreaterThan(0.35)
    expect(detection.rawTrailingMarkerConfidence).toBeLessThan(0.45)
    expect(detection.markerSeparationError).toBe(0)
    expect(detection.markerTimingAgreement).toBe(1)
  })

  test('hard-rejects high-confidence marker pairs when the pair timing exceeds the hard drift limit', () => {
    const capture = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    capture.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples)
    setMarkerCorrelation(capture, sweep, 'start', 0.90)
    setMarkerCorrelation(capture, sweep, 'end', 0.90, parts.trailingMarkerStartSamples + 32)

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(false)
    expect(detection.failureReason).toBe('clock_drift_unreliable')
    expect(detection.rawLeadingMarkerConfidence).toBeGreaterThan(0.8)
    expect(detection.rawTrailingMarkerConfidence).toBeGreaterThan(0.8)
    expect(Math.abs(detection.driftPpm ?? 0)).toBeGreaterThan(CLOCK_DRIFT_HARD_REJECT_PPM)
  })

  test('keeps Android marker separation and clock drift distinct at -107 ppm', () => {
    const parts = sweepSampleParts(androidCalibrationSweep)
    const capture = generateMeasurementReference(androidCalibrationSweep)
    capture.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples)
    setMarkerCorrelation(capture, androidCalibrationSweep, 'start', 0.36)
    setMarkerCorrelation(
      capture,
      androidCalibrationSweep,
      'end',
      0.40,
      parts.trailingMarkerStartSamples - 17,
    )

    const detection = detectSweepStart(capture, androidCalibrationSweep, androidCalibrationSweep.sampleRate)

    expect(detection.found).toBe(true)
    expect(detection.expectedMarkerSeparationSamples).toBe(158_400)
    expect(detection.observedMarkerSeparationSamples).toBe(158_383)
    expect(detection.driftPpm).toBeCloseTo(-107.323, 3)
    expect(detection.markerSeparationError).toBeCloseTo(17 / 158_400, 9)
    expect(detection.markerTimingAgreement).toBe(1)
  })

  test('reports low-confidence Android markers near 1100 ppm as insufficient timing', () => {
    const parts = sweepSampleParts(androidCalibrationSweep)
    const capture = generateMeasurementReference(androidCalibrationSweep)
    capture.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples)
    setMarkerCorrelation(capture, androidCalibrationSweep, 'start', 0.24)
    setMarkerCorrelation(
      capture,
      androidCalibrationSweep,
      'end',
      0.26,
      parts.trailingMarkerStartSamples + 174,
    )

    const detection = detectSweepStart(capture, androidCalibrationSweep, androidCalibrationSweep.sampleRate)

    expect(detection.found).toBe(false)
    expect(detection.failureReason).toBe('leading_marker_weak')
    expect(detection.expectedMarkerSeparationSamples).toBe(158_400)
    expect(detection.observedMarkerSeparationSamples).toBe(158_574)
    expect(detection.driftPpm).toBeNull()
    expect(detection.markerSeparationPpm).toBeCloseTo(1_098.485, 3)
    expect(detection.rawLeadingMarkerConfidence).toBeGreaterThan(0.2)
    expect(detection.rawLeadingMarkerConfidence).toBeLessThan(0.25)
    expect(detection.rawTrailingMarkerConfidence).toBeGreaterThan(0.2)
    expect(detection.rawTrailingMarkerConfidence).toBeLessThan(0.27)
  })

  test('does not call a field-shaped 1100 ppm separation oscillator drift', () => {
    const parts = sweepSampleParts(androidCalibrationSweep)
    const capture = generateMeasurementReference(androidCalibrationSweep)
    capture.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples)
    setMarkerCorrelation(capture, androidCalibrationSweep, 'start', 0.48)
    setMarkerCorrelation(
      capture,
      androidCalibrationSweep,
      'end',
      0.31,
      parts.trailingMarkerStartSamples + 178,
    )

    const detection = detectSweepStart(capture, androidCalibrationSweep, androidCalibrationSweep.sampleRate)

    expect(detection.found).toBe(false)
    expect(detection.failureReason).toBe('marker_pair_low_confidence')
    expect(detection.observedMarkerSeparationSamples).toBeGreaterThanOrEqual(158_576)
    expect(detection.observedMarkerSeparationSamples).toBeLessThanOrEqual(158_580)
    expect(detection.markerSeparationPpm).toBeGreaterThan(1_000)
    expect(detection.markerSeparationPpm).toBeLessThan(1_200)
    expect(detection.rawLeadingMarkerConfidence).toBeGreaterThan(0.27)
    expect(detection.rawLeadingMarkerConfidence).toBeLessThan(0.56)
    expect(detection.rawTrailingMarkerConfidence).toBeGreaterThan(0.27)
    expect(detection.rawTrailingMarkerConfidence).toBeLessThan(0.56)
    expect(detection.driftPpm).toBeNull()
  })

  test('classifies an ordered marker pair outside the timing search window', () => {
    const capture = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    capture.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples)
    setMarkerCorrelation(capture, sweep, 'start', 0.65)
    setMarkerCorrelation(capture, sweep, 'end', 0.65, parts.trailingMarkerStartSamples + 100)

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(false)
    expect(detection.failureReason).toBe('marker_pair_bad_timing')
    expect(Math.abs(detection.markerSeparationPpm ?? 0)).toBeGreaterThan(5_000)
    expect(detection.driftPpm).toBeNull()
  })

  test('classifies a -887 sample marker separation error as bad timing', () => {
    const parts = sweepSampleParts(androidCalibrationSweep)
    const capture = generateMeasurementReference(androidCalibrationSweep)
    capture.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples)
    setMarkerCorrelation(capture, androidCalibrationSweep, 'start', 0.40, parts.leadingMarkerStartSamples)
    setMarkerCorrelation(
      capture,
      androidCalibrationSweep,
      'end',
      0.45,
      parts.trailingMarkerStartSamples - 887,
    )

    const detection = detectSweepStart(capture, androidCalibrationSweep, androidCalibrationSweep.sampleRate)

    expect(detection.found).toBe(false)
    expect(detection.failureReason).toBe('marker_pair_bad_timing')
    expect(detection.expectedMarkerSeparationSamples).toBe(158_400)
    expect(detection.observedMarkerSeparationSamples).toBe(157_513)
    expect(detection.markerSeparationPpm).toBeCloseTo(-5_599.75, 2)
    expect(detection.clockRatio).not.toBeNull()
    expect(detection.driftPpm).toBeNull()
  })

  test('selects the valid temporal pair instead of two stronger independent peaks', () => {
    const capture = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    capture.fill(0, parts.leadingMarkerStartSamples, parts.leadingMarkerStartSamples + parts.syncMarkerSamples)
    capture.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples)
    setMarkerCorrelation(capture, sweep, 'start', 0.65)
    setMarkerCorrelation(capture, sweep, 'end', 0.65)
    setExactMarker(capture, sweep, 'start', 0)
    setExactMarker(capture, sweep, 'end', parts.trailingMarkerStartSamples + parts.endMarkerSamples + 200)

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(true)
    expect(detection.leadingMarkerSample).toBe(parts.leadingMarkerStartSamples)
    expect(detection.trailingMarkerSample).toBe(parts.trailingMarkerStartSamples)
  })

  test('prefers exact timing over a stronger pair near the drift limit', () => {
    const capture = generateMeasurementReference(sweep)
    const parts = sweepSampleParts(sweep)
    capture.fill(0, parts.leadingMarkerStartSamples, parts.sweepStartSamples)
    capture.fill(0, parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples)
    setMarkerCorrelation(capture, sweep, 'start', 0.36)
    setMarkerCorrelation(capture, sweep, 'end', 0.40)
    setMarkerCorrelation(capture, sweep, 'start', 0.90, parts.leadingMarkerStartSamples + 500)
    setMarkerCorrelation(capture, sweep, 'end', 0.90, parts.trailingMarkerStartSamples + 512)

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(true)
    expect(detection.leadingMarkerSample).toBe(parts.leadingMarkerStartSamples)
    expect(detection.trailingMarkerSample).toBe(parts.trailingMarkerStartSamples)
  })

  test('rejects an ambiguous pair when two independent marker pairs score alike', () => {
    const parts = sweepSampleParts(sweep)
    const capture = new Float32Array(parts.totalSamples + 400)
    setMarkerCorrelation(capture, sweep, 'start', 0.75, parts.leadingMarkerStartSamples)
    setMarkerCorrelation(capture, sweep, 'end', 0.75, parts.trailingMarkerStartSamples)
    setMarkerCorrelation(capture, sweep, 'start', 0.75, parts.leadingMarkerStartSamples + 200)
    setMarkerCorrelation(capture, sweep, 'end', 0.75, parts.trailingMarkerStartSamples + 200)

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(false)
    expect(detection.failureReason).toBe('marker_pair_ambiguous')
    expect(detection.secondMarkerPairScore).not.toBeNull()
    expect(detection.markerPairScoreMargin).toBeLessThan(0.05)
  })

  test('rejects plausible moderate-confidence competing pairs as ambiguous', () => {
    const parts = sweepSampleParts(sweep)
    const capture = new Float32Array(parts.totalSamples + 400)
    setMarkerCorrelation(capture, sweep, 'start', 0.40, parts.leadingMarkerStartSamples)
    setMarkerCorrelation(capture, sweep, 'end', 0.45, parts.trailingMarkerStartSamples)
    setMarkerCorrelation(capture, sweep, 'start', 0.40, parts.leadingMarkerStartSamples + 200)
    setMarkerCorrelation(capture, sweep, 'end', 0.45, parts.trailingMarkerStartSamples + 200)

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(false)
    expect(detection.failureReason).toBe('marker_pair_ambiguous')
    expect(detection.driftPpm).toBeNull()
  })

  test('searches beyond the exported marker candidate limit for a valid pair', () => {
    const parts = sweepSampleParts(sweep)
    const capture = new Float32Array(parts.totalSamples + 10_000)
    const expectedLeading = parts.leadingMarkerStartSamples
    const expectedTrailing = parts.trailingMarkerStartSamples
    for (let index = 1; index <= 20; index++) {
      setMarkerCorrelation(capture, sweep, 'start', 0.90, expectedLeading + index * 400)
    }
    setMarkerCorrelation(capture, sweep, 'start', 0.36, expectedLeading)
    setMarkerCorrelation(capture, sweep, 'end', 0.40, expectedTrailing)

    const detection = detectSweepStart(capture, sweep, sweep.sampleRate)

    expect(detection.found).toBe(true)
    expect(detection.leadingMarkerSample).toBe(expectedLeading)
    expect(detection.trailingMarkerSample).toBe(expectedTrailing)
    expect(detection.leadingMarkerCandidates).toHaveLength(16)
    expect(detection.trailingMarkerCandidates).toHaveLength(1)
    expect(detection.leadingMarkerCandidates.some((candidate) => candidate.sample === expectedLeading)).toBe(false)
    expect(detection.markerPairCandidates.length).toBeLessThanOrEqual(16)
  })

  test('keeps detecting markers through low-level room coloration, reflections, noise, and clock mismatch', () => {
    const reference = generateMeasurementReference(sweep)
    const roomImpulse = new Float32Array(32)
    roomImpulse[0] = 1
    roomImpulse[5] = 0.25
    roomImpulse[31] = 0.1
    const stretched = stretchCapture(convolve(reference, roomImpulse), 1.0005)
    for (let index = 0; index < stretched.length; index++) {
      stretched[index] = stretched[index] * 0.35 + Math.sin(index * 0.173) * 0.002
    }

    const detection = detectSweepStart(stretched, sweep, sweep.sampleRate)

    expect(detection.found).toBe(true)
    expect(detection.driftPpm).toBeGreaterThan(200)
    expect(detection.driftPpm).toBeLessThan(800)
  })

  test('keeps the Android calibration layout detectable after acoustic degradation', () => {
    const roomImpulse = new Float32Array(174)
    roomImpulse[0] = 1
    roomImpulse[7] = 0.25
    roomImpulse[61] = 0.12
    roomImpulse[173] = 0.08
    const stretched = stretchCapture(
      convolve(generateMeasurementReference(androidCalibrationSweep), roomImpulse),
      1.0005,
    )
    for (let index = 0; index < stretched.length; index++) {
      stretched[index] = stretched[index] * 0.35 + Math.sin(index * 0.173) * 0.0015
    }

    const detection = detectSweepStart(
      stretched,
      androidCalibrationSweep,
      androidCalibrationSweep.sampleRate,
    )

    expect(detection.found).toBe(true)
    expect(detection.rawLeadingMarkerConfidence).toBeGreaterThan(0.25)
    expect(detection.rawTrailingMarkerConfidence).toBeGreaterThan(0.25)
    expect(detection.driftPpm).toBeGreaterThan(200)
    expect(detection.driftPpm).toBeLessThan(800)
  })

  test('analyzes marker-only captures without producing a response curve', () => {
    const markerOnlySweep: MeasurementSweep = { ...androidCalibrationSweep, captureKind: 'marker-only' }
    const result = analyzeCompositeMeasurement(
      generateSweepReference(markerOnlySweep),
      markerOnlySweep.sampleRate,
      markerOnlySweep,
      profile,
    )

    expect(result.status).toBe('ok')
    expect(result.left.status).toBe('ok')
    expect(result.right.status).toBe('ok')
    expect(result.left.correctedPoints).toHaveLength(0)
    expect(result.right.correctedPoints).toHaveLength(0)
  })

  test('scales marker timing for a 44.1 kHz recorder against the Android sweep', () => {
    const recorderRate = 44_100
    const recorderCapture = generateSweepReference(androidCalibrationSweep, recorderRate)
    const recorderParts = sweepSampleParts(androidCalibrationSweep, recorderRate)
    const detection = detectSweepStart(recorderCapture, androidCalibrationSweep, recorderRate)

    expect(detection.found).toBe(true)
    expect(detection.expectedMarkerSeparationSamples).toBe(
      recorderParts.trailingMarkerStartSamples - recorderParts.leadingMarkerStartSamples,
    )
    expect(detection.observedMarkerSeparationSamples).toBe(detection.expectedMarkerSeparationSamples)
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
    expect(result.diagnostics.rawLeadingMarkerConfidence).toBeGreaterThan(0.2)
    expect(result.diagnostics.rawTrailingMarkerConfidence).toBeGreaterThan(0)
    expect(result.diagnostics.endingMarkerConfidence).toBeGreaterThan(0)
    expect(result.diagnostics.syncMarkerFailureReason).toBe('trailing_marker_weak')
    expect(result.correctedPoints).toHaveLength(0)
  })

  test('retains raw marker peaks when the combined policy rejects them', () => {
    const capture = generateMeasurementReference(sweep)
    setMarkerCorrelation(capture, sweep, 'start', 0.24)
    setMarkerCorrelation(capture, sweep, 'end', 0.26)

    const result = analyzeMeasurement(capture, sweep.sampleRate, sweep, profile)

    expect(result.status).toBe('sync_marker_not_found')
    expect(result.diagnostics.rawLeadingMarkerConfidence).toBeGreaterThan(0.2)
    expect(result.diagnostics.rawTrailingMarkerConfidence).toBeGreaterThan(0.2)
    expect(result.diagnostics.markerPairScore).not.toBeNull()
    expect(result.diagnostics.markerPairScore).toBeLessThan(0.63)
    expect(result.diagnostics.syncMarkerFailureReason).toBe('marker_pair_low_confidence')
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

  test('analyzes marker-only captures without generating a response curve', () => {
    const markerSweep: MeasurementSweep = { ...sweep, captureKind: 'marker-only' }
    const result = analyzeCompositeMeasurement(
      generateSweepReference(markerSweep),
      markerSweep.sampleRate,
      markerSweep,
      profile,
    )

    expect(result.status).toBe('ok')
    expect(result.left.status).toBe('ok')
    expect(result.right.status).toBe('ok')
    expect(result.left.correctedPoints).toHaveLength(0)
    expect(result.left.diagnostics.bestLeadingMarkerSample).not.toBeNull()
    expect(result.left.diagnostics.bestTrailingMarkerSample).not.toBeNull()
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
