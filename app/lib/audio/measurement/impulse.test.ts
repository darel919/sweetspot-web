import { describe, expect, test } from 'bun:test'
import { generateSweepSignal, sweepSampleParts } from '../sweep-reference'
import {
  decayTime,
  deconvolveSweep,
  resampleCaptureForTest,
  summarizeImpulse,
  windowedImpulseResponse,
} from './impulse'

const sweep = {
  algorithm: 'exponential-sine-v1' as const,
  captureKind: 'position-composite' as const,
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

function activeCapture(): Float32Array {
  const parts = sweepSampleParts(sweep)
  const capture = new Float32Array(parts.sweepSamples + parts.postRollSamples)
  capture.set(generateSweepSignal(sweep))
  return capture
}

const toneSampleRate = 48_000
const toneSampleCount = 12_288
const toneFrequenciesHz = [100, 1_000, 5_000, 10_000, 15_000, 18_000]
const clockDriftPpm = [-500, -250, -100, -50, -25, 25, 50, 100, 250, 500]
const maxResamplerPassbandErrorDb = 0.1

function toneMagnitude(samples: Float32Array, frequencyHz: number, start: number, end: number, sampleRate = toneSampleRate): number {
  let sineProjection = 0
  let cosineProjection = 0
  for (let index = start; index < end; index++) {
    const phase = 2 * Math.PI * frequencyHz * index / sampleRate
    sineProjection += samples[index] * Math.sin(phase)
    cosineProjection += samples[index] * Math.cos(phase)
  }
  return 2 * Math.hypot(sineProjection, cosineProjection) / (end - start)
}

function assertResampledTone(frequencyHz: number, clockRatio: number, sampleRate = toneSampleRate): void {
  const input = new Float32Array(toneSampleCount + 128)
  for (let index = 0; index < input.length; index++) {
    input[index] = 0.5 * Math.sin(2 * Math.PI * frequencyHz * index / (sampleRate * clockRatio))
  }

  const output = resampleCaptureForTest(input, clockRatio, sampleRate)
  const measured = toneMagnitude(output, frequencyHz, 512, output.length - 512, sampleRate)
  const errorDb = 20 * Math.log10(measured / 0.5)
  expect(Math.abs(errorDb)).toBeLessThanOrEqual(maxResamplerPassbandErrorDb)
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

function applyTransferFunction(samples: Float32Array, transfer: Float32Array): Float32Array {
  const output = new Float32Array(samples.length + transfer.length - 1)
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    for (let transferIndex = 0; transferIndex < transfer.length; transferIndex++) {
      output[sampleIndex + transferIndex] += samples[sampleIndex] * transfer[transferIndex]
    }
  }
  return output
}

describe('browser-local impulse analysis', () => {
  test('keeps identity resampling sample-exact', () => {
    const input = Float32Array.from({ length: 128 }, (_, index) => Math.sin(index * 0.37))

    expect(Array.from(resampleCaptureForTest(input, 1, toneSampleRate))).toEqual(Array.from(input))
  })

  test('preserves passband tones at identity clock ratio', () => {
    for (const frequencyHz of toneFrequenciesHz) assertResampledTone(frequencyHz, 1)
  })

  test('corrects small clock drift without passband amplitude error', () => {
    for (const ppm of clockDriftPpm) {
      const clockRatio = 1 + ppm / 1_000_000
      for (const frequencyHz of toneFrequenciesHz) assertResampledTone(frequencyHz, clockRatio)
    }
  })

  test('designs the resampler for the actual recorder sample rate', () => {
    for (const ppm of [-500, 500]) {
      const clockRatio = 1 + ppm / 1_000_000
      for (const frequencyHz of [100, 1_000, 3_000]) assertResampledTone(frequencyHz, clockRatio, 8_000)
    }
  })

  test('preserves the 20 kHz passband at 44.1 kHz recorder rate', () => {
    for (const frequencyHz of [18_000, 19_000, 19_500, 20_000]) {
      assertResampledTone(frequencyHz, 1.0005, 44_100)
    }
  })

  test('recovers a synthetic transfer function after clock-drift correction', () => {
    const transfer = new Float32Array(48)
    transfer[0] = 1
    transfer[11] = 0.3
    transfer[31] = -0.18
    const parts = sweepSampleParts(sweep)
    const nominalCapture = new Float32Array(parts.sweepSamples + parts.postRollSamples)
    nominalCapture.set(applyTransferFunction(generateSweepSignal(sweep), transfer))
    const clockRatio = 1.0005
    const capture = stretchCapture(nominalCapture, clockRatio)

    const result = deconvolveSweep(capture, sweep.sampleRate, sweep, 0, clockRatio)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a synthetic transfer function.')
    expect(result.samples[0]).toBeGreaterThan(0.5)
    expect(result.samples[11] / result.samples[0]).toBeCloseTo(0.3, 1)
    expect(result.samples[31] / result.samples[0]).toBeCloseTo(-0.18, 1)
  })

  test('reports EDT, T20, and T30 as RT60 extrapolations', () => {
    const sampleRate = 8_000
    const rt60Seconds = 0.75
    const edc = new Float64Array(sampleRate * 2)
    for (let index = 0; index < edc.length; index++) edc[index] = -60 * (index / sampleRate) / rt60Seconds

    expect(decayTime(edc, sampleRate, 0, -10)).toBeCloseTo(rt60Seconds * 1_000, 0)
    expect(decayTime(edc, sampleRate, -5, -25)).toBeCloseTo(rt60Seconds * 1_000, 0)
    expect(decayTime(edc, sampleRate, -5, -35)).toBeCloseTo(rt60Seconds * 1_000, 0)
  })

  test('publishes decay estimates only when the noise-compensated range is supported', () => {
    const sampleRate = 8_000
    for (const rt60Seconds of [0.2, 0.4, 0.8, 1.5]) {
      const edc = new Float64Array(Math.ceil(sampleRate * Math.max(2 * rt60Seconds, 1)))
      for (let index = 0; index < edc.length; index++) {
        edc[index] = -60 * (index / sampleRate) / rt60Seconds
      }
      for (const noiseFloorDb of [-45, -35]) {
        expect(decayTime(edc, sampleRate, -5, -25, noiseFloorDb)).toBeCloseTo(rt60Seconds * 1_000, 0)
      }
      expect(decayTime(edc, sampleRate, -5, -25, -25)).toBeNull()
    }
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

  test('rejects a capture that has no intended post-roll for causal recovery', () => {
    const parts = sweepSampleParts(sweep)
    const capture = generateSweepSignal(sweep).slice(0, parts.sweepSamples)
    const result = deconvolveSweep(capture, sweep.sampleRate, sweep, 0)

    expect(result.kind).toBe('capture_too_short')
    if (result.kind !== 'capture_too_short') throw new Error('Expected the missing post-roll to be rejected.')
    expect(result.requiredSamples).toBe(parts.sweepSamples + parts.postRollSamples)
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

  test('keeps the HF gate configurable for reflection-window evaluation', () => {
    const sampleRate = 48_000
    const clean = new Float32Array(sampleRate)
    clean[0] = 1
    const reflected = clean.slice()
    reflected[Math.round(sampleRate * 0.06)] = 0.7
    const cleanResponse = windowedImpulseResponse(clean, sampleRate, 20, 20_000, 24)
    const lateWindowDifference = [10, 20, 30, 50, 80].map((hfWindowMs) => {
      const response = windowedImpulseResponse(reflected, sampleRate, 20, 20_000, 24, null, { hfWindowMs })
      const highIndex = response.findIndex((point) => point.frequencyHz >= 8_000)
      return Math.abs((response[highIndex]?.magnitudeDb ?? 0) - (cleanResponse[highIndex]?.magnitudeDb ?? 0))
    })

    expect(lateWindowDifference).toHaveLength(5)
    expect(lateWindowDifference.every((difference) => Number.isFinite(difference))).toBe(true)
    expect(lateWindowDifference[0]).toBeLessThan(lateWindowDifference[4] ?? 0)
    })
  })

  test('keeps decay estimates conservative across the requested RT60 and SNR matrix', () => {
    const sampleRate = 8_000
    for (const rt60Seconds of [0.2, 0.4, 0.8, 1.5]) {
      const edc = new Float64Array(Math.ceil(sampleRate * Math.max(2 * rt60Seconds, 1)))
      for (let index = 0; index < edc.length; index++) {
        edc[index] = -60 * (index / sampleRate) / rt60Seconds
      }
      for (const snrDb of [40, 30, 20, 15, 10]) {
        const t20 = decayTime(edc, sampleRate, -5, -25, -snrDb, 3)
        if (snrDb >= 30) {
          expect(t20).not.toBeNull()
          expect(t20 ?? 0).toBeCloseTo(rt60Seconds * 1_000, 0)
        } else {
          expect(t20).toBeNull()
        }
        expect(decayTime(edc, sampleRate, -5, -35, -snrDb)).toBeNull()
      }
    }
  })
