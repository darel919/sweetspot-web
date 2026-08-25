import { describe, expect, test } from 'bun:test'
import type { MeasurementSweep } from '#shared/types/protocol'
import golden from '../../../test-vectors/measurement-sweep-golden.json'
import { generateCompositeSweepStereoReference, generateSweepReference, sweepSampleParts } from './sweep-reference'

const sweep: MeasurementSweep = {
  algorithm: 'exponential-sine-v1',
  captureKind: 'position-composite',
  sampleRate: 48_000,
  startHz: 20,
  endHz: 20_000,
  durationMs: 8_000,
  preRollMs: 1_000,
  postRollMs: 1_000,
  syncMarkerStartHz: 1_000,
  syncMarkerEndHz: 4_000,
  syncMarkerDurationMs: 40,
  syncMarkerGapMs: 10,
  endMarkerStartHz: 3_500,
  endMarkerEndHz: 1_500,
  endMarkerDurationMs: 40,
  interSweepGapMs: 50,
  levelDbfs: -12,
  fadeInMs: 20,
  fadeOutMs: 20,
}

describe('sweep reference', () => {
  test('uses the reported timing and keeps the preroll silent', () => {
    const parts = sweepSampleParts(sweep)
    const reference = generateSweepReference(sweep)
    expect(reference.length).toBe(parts.totalSamples)
    expect(reference.slice(0, parts.leadingMarkerStartSamples).every((sample) => sample === 0)).toBe(true)
    expect(reference.slice(parts.sweepStartSamples, parts.sweepStartSamples + parts.sweepSamples).some((sample) => sample !== 0)).toBe(true)
    expect(reference.slice(parts.trailingMarkerStartSamples, parts.trailingMarkerStartSamples + parts.endMarkerSamples).some((sample) => sample !== 0)).toBe(true)
    expect(reference.every(Number.isFinite)).toBe(true)
    const peak = reference.reduce((maximum, sample) => Math.max(maximum, sample), 0)
    expect(peak).toBeLessThanOrEqual(10 ** (-12 / 20) + 0.001)
  })

  test('matches the deterministic cross-language PCM golden vector', () => {
    const fixture = golden as { sweep: MeasurementSweep; pcm16: number[] }
    const reference = generateCompositeSweepStereoReference(fixture.sweep)

    expect(fixture.pcm16).toHaveLength(reference.length)
    for (let index = 0; index < reference.length; index++) {
      const expected = fixture.pcm16[index]
      const actual = Math.round((reference[index] ?? 0) * 32_767)
      expect(Math.abs(actual - (expected ?? 0))).toBeLessThanOrEqual(1)
    }
  })
})
