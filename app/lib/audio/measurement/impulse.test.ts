import { describe, expect, test } from 'bun:test'
import { generateSweepReference, sweepSampleParts } from '../sweep-reference'
import { deconvolveSweep } from './impulse'

const sweep = {
  algorithm: 'exponential-sine-v1' as const,
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

describe('browser-local impulse analysis', () => {
  test('detects a direct path at the first causal sample', () => {
    const reference = generateSweepReference(sweep)
    const result = deconvolveSweep(reference, sweep.sampleRate, sweep, 0)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(result.samples.length).toBe(sweepSampleParts(sweep).postRollSamples + 1)
    expect(result.summary.room.directArrivalMs).toBeCloseTo(0, 1)
  })

  test('finds a small delayed direct path inside the causal search window', () => {
    const parts = sweepSampleParts(sweep)
    const directDelay = 8
    const active = generateSweepReference(sweep).subarray(parts.preRollSamples)
    const capture = new Float32Array(parts.preRollSamples + active.length + directDelay)
    capture.set(active, parts.preRollSamples + directDelay)

    const result = deconvolveSweep(capture, sweep.sampleRate, sweep, 0)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(result.summary.room.directArrivalMs).toBeCloseTo(directDelay * 1000 / sweep.sampleRate, 1)
  })

  test('finds an early reflection from a delayed swept-sine echo', () => {
    const reference = generateSweepReference(sweep)
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
    const reference = generateSweepReference(sweep)
    const directDelay = 160
    const capture = new Float32Array(reference.length + directDelay)
    capture.set(reference, directDelay)

    const result = deconvolveSweep(capture, sweep.sampleRate, sweep, directDelay)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('Expected a causal impulse response.')
    expect(result.samples.length).toBe(sweepSampleParts(sweep).postRollSamples + 1)
    expect(result.summary.room.directArrivalMs).toBeCloseTo(0, 1)
  })

  test('ignores samples after the intentionally captured post-roll', () => {
    const reference = generateSweepReference(sweep)
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
})
