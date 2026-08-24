import { describe, expect, test } from 'bun:test'
import type { MeasurementSweep } from '#shared/types/protocol'
import { generateSweepReference, sweepSampleParts } from './sweep-reference'

const sweep: MeasurementSweep = {
  algorithm: 'exponential-sine-v1',
  sampleRate: 48_000,
  startHz: 20,
  endHz: 20_000,
  durationMs: 8_000,
  preRollMs: 1_000,
  postRollMs: 1_000,
  levelDbfs: -12,
  fadeInMs: 20,
  fadeOutMs: 20,
}

describe('sweep reference', () => {
  test('uses the reported timing and keeps the preroll silent', () => {
    const parts = sweepSampleParts(sweep)
    const reference = generateSweepReference(sweep)
    expect(reference.length).toBe(parts.preRollSamples + parts.sweepSamples + parts.postRollSamples)
    expect(reference.slice(0, parts.preRollSamples).every((sample) => sample === 0)).toBe(true)
    expect(reference.every(Number.isFinite)).toBe(true)
    expect(Math.max(...reference)).toBeLessThanOrEqual(10 ** (-12 / 20) + 0.001)
  })
})
