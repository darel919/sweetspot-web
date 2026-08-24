import { describe, expect, test } from 'bun:test'
import { generateSweepSignal, sweepSampleParts } from '../sweep-reference'
import { decayTime, deconvolveSweep, summarizeImpulse, windowedImpulseResponse } from './impulse'

const sweep = {
  algorithm: 'exponential-sine-v1' as const,
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

function activeCapture(): Float32Array {
  const parts = sweepSampleParts(sweep)
  const capture = new Float32Array(parts.sweepSamples + parts.postRollSamples)
  capture.set(generateSweepSignal(sweep))
  return capture
}

describe('browser-local impulse analysis', () => {
  test('reports EDT, T20, and T30 as RT60 extrapolations', () => {
    const sampleRate = 8_000
    const rt60Seconds = 0.75
    const edc = new Float64Array(sampleRate * 2)
    for (let index = 0; index < edc.length; index++) edc[index] = -60 * (index / sampleRate) / rt60Seconds

    expect(decayTime(edc, sampleRate, 0, -10)).toBeCloseTo(rt60Seconds * 1_000, 0)
    expect(decayTime(edc, sampleRate, -5, -25)).toBeCloseTo(rt60Seconds * 1_000, 0)
    expect(decayTime(edc, sampleRate, -5, -35)).toBeCloseTo(rt60Seconds * 1_000, 0)
  })

  test('recovers a known RT60 from a diffuse synthetic impulse when quiet noise is zero', () => {
    const sampleRate = 8_000
    const rt60Seconds = 0.75
    const impulse = new Float32Array(Math.round(sampleRate * 1.5))
    impulse[0] = 1
    let state = 123_456_789
    for (let index = 1; index < impulse.length; index++) {
      state = (1_664_525 * state + 1_013_904_223) >>> 0
      const noise = (state / 4_294_967_296) * 2 - 1
      impulse[index] = 0.2 * 10 ** (-60 * (index / sampleRate) / rt60Seconds / 20) * noise
    }

    const summary = summarizeImpulse(impulse, sampleRate, 0)

    expect(summary.room.edtMs).toBeGreaterThan(700)
    expect(summary.room.edtMs).toBeLessThan(800)
    expect(summary.room.t20Ms).toBeGreaterThan(700)
    expect(summary.room.t20Ms).toBeLessThan(800)
    expect(summary.room.t30Ms).toBeGreaterThan(700)
    expect(summary.room.t30Ms).toBeLessThan(800)
    expect(summary.room.decayConfidence).toBe('high')
  })

  test('rejects decay metrics when the curve reaches its noise floor before the fit range', () => {
    const sampleRate = 8_000
    const rt60Seconds = 0.75
    const edc = new Float64Array(sampleRate * 2)
    for (let index = 0; index < edc.length; index++) {
      const ideal = -60 * (index / sampleRate) / rt60Seconds
      edc[index] = ideal
    }

    expect(decayTime(edc, sampleRate, -5, -25, -20)).toBeNull()
    expect(decayTime(edc, sampleRate, -5, -35, -20)).toBeNull()
  })

  test('rejects a non-linear decay instead of fitting through a reflection', () => {
    const sampleRate = 8_000
    const rt60Seconds = 0.75
    const edc = new Float64Array(sampleRate * 2)
    for (let index = 0; index < edc.length; index++) {
      const time = index / sampleRate
      const reflection = time > 0.12 && time < 0.28
        ? 8 * Math.sin((time - 0.12) / 0.16 * Math.PI)
        : 0
      edc[index] = -60 * time / rt60Seconds + reflection
    }

    expect(decayTime(edc, sampleRate, -5, -25)).toBeNull()
    expect(decayTime(edc, sampleRate, -5, -35)).toBeNull()
  })

  test('does not publish decay metrics from a noise-limited impulse tail', () => {
    const sampleRate = 8_000
    const impulse = new Float32Array(sampleRate)
    impulse[0] = 1
    for (let index = 1; index < impulse.length; index++) {
      const decay = 10 ** (-30 * (index / sampleRate) / 0.75)
      impulse[index] = decay + 0.03 * Math.sin(index * 0.37) + 0.021 * Math.sin(index * 0.11)
    }

    const summary = summarizeImpulse(impulse, sampleRate)

    expect(summary.room.t20Ms).toBeNull()
    expect(summary.room.t30Ms).toBeNull()
    expect(summary.room.directToLateDb).toBeNull()
    expect(summary.room.c50Db).toBeNull()
    expect(summary.room.c80Db).toBeNull()
    expect(summary.room.decayConfidence).toBe('low')
  })

  test('detects a direct path at the first causal sample', () => {
    const reference = activeCapture()
    const result = deconvolveSweep(reference, sweep.sampleRate, sweep, 0)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(result.samples.length).toBe(sweepSampleParts(sweep).postRollSamples + 1)
    expect(result.summary.room.directArrivalMs).toBeCloseTo(0, 1)
  })

  test('finds a small delayed direct path inside the causal search window', () => {
    const parts = sweepSampleParts(sweep)
    const directDelay = 8
    const active = generateSweepSignal(sweep)
    const capture = new Float32Array(active.length + directDelay + parts.postRollSamples)
    capture.set(active, directDelay)

    const result = deconvolveSweep(capture, sweep.sampleRate, sweep, directDelay)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(result.summary.room.directArrivalMs).toBeCloseTo(0, 1)
  })

  test('finds an early reflection from a delayed swept-sine echo', () => {
    const reference = activeCapture()
    const directDelay = 160
    const reflectionDelay = 40
    const capture = new Float32Array(reference.length + directDelay + reflectionDelay)
    for (let index = 0; index < reference.length; index++) {
      capture[directDelay + index] += reference[index]
      if (directDelay + index + reflectionDelay < capture.length) {
        capture[directDelay + index + reflectionDelay] += reference[index] * 0.5
      }
    }
    const result = deconvolveSweep(capture, sweep.sampleRate, sweep, directDelay)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(result.summary.room.directArrivalMs).toBeCloseTo(0, 1)
    expect(result.summary.room.earlyReflections[0].delayMs).toBeCloseTo(5, 1)
    expect(result.summary.room.earlyReflections[0].levelDbRelativeToDirect).toBeLessThan(-5)
  })

  test('deconvolves the active sweep without retaining the silent pre-roll', () => {
    const reference = activeCapture()
    const directDelay = 160
    const capture = new Float32Array(reference.length + directDelay)
    capture.set(reference, directDelay)

    const result = deconvolveSweep(capture, sweep.sampleRate, sweep, directDelay)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(result.samples.length).toBe(sweepSampleParts(sweep).postRollSamples + 1)
    expect(result.summary.room.directArrivalMs).toBeCloseTo(0, 1)
  })

  test('carries the quiet capture noise estimate into the impulse summary', () => {
    const reference = activeCapture()
    const clean = deconvolveSweep(reference, sweep.sampleRate, sweep, 0)
    const withNoiseEstimate = deconvolveSweep(reference, sweep.sampleRate, sweep, 0, 1, 0.0001)

    expect(clean.kind).toBe('ok')
    expect(withNoiseEstimate.kind).toBe('ok')
    if (clean.kind !== 'ok' || withNoiseEstimate.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(withNoiseEstimate.summary.noiseFloorRms).toBeGreaterThan(clean.summary.noiseFloorRms)
  })

  test('ignores samples after the intentionally captured post-roll', () => {
    const reference = activeCapture()
    const capture = new Float32Array(reference.length + 2_000)
    capture.set(reference)
    capture.fill(100, reference.length)

    const result = deconvolveSweep(capture, sweep.sampleRate, sweep, 0)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(result.samples.length).toBe(sweepSampleParts(sweep).postRollSamples + 1)
    expect(result.summary.room.directArrivalMs).toBeCloseTo(0, 1)
    expect(result.summary.peak).toBeLessThan(2)
  })

  test('uses a shorter HF gate so a late reflection does not shape treble correction', () => {
    const sampleRate = 8_000
    const clean = new Float32Array(sampleRate * 2)
    clean[0] = 1
    const reflected = clean.slice()
    reflected[Math.round(sampleRate * 0.15)] = 0.8

    const cleanResponse = windowedImpulseResponse(clean, sampleRate, 20, 3_500)
    const reflectedResponse = windowedImpulseResponse(reflected, sampleRate, 20, 3_500)
    const highIndex = cleanResponse.findIndex((point) => point.frequencyHz >= 1_500)
    const lowIndex = cleanResponse.findIndex((point) => point.frequencyHz >= 80)

    expect(highIndex).toBeGreaterThanOrEqual(0)
    expect(lowIndex).toBeGreaterThanOrEqual(0)
    expect(Math.abs((reflectedResponse[highIndex]?.magnitudeDb ?? 0) - (cleanResponse[highIndex]?.magnitudeDb ?? 0))).toBeLessThan(0.5)
    expect(Math.abs((reflectedResponse[lowIndex]?.magnitudeDb ?? 0) - (cleanResponse[lowIndex]?.magnitudeDb ?? 0))).toBeGreaterThan(0.5)
  })
})
