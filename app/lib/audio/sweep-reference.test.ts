import { describe, expect, test } from 'bun:test'
import type { MeasurementSweep } from '#shared/types/protocol'
import golden from '../../../test-vectors/measurement-sweep-golden.json'
import { generateCompositeSweepStereoReference, generateSweepReference, generateSweepSignal, generateSyncMarker, sweepSampleParts } from './sweep-reference'

const sweep: MeasurementSweep = {
  sweepRevision: 'android-sweep-v2',
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
  sweepLevelDbfs: -12,
  markerLevelDbfs: -12,
  fadeInMs: 20,
  fadeOutMs: 20,
}

const androidDefaultSweep: MeasurementSweep = {
  sweepRevision: 'android-sweep-v2',
  algorithm: 'exponential-sine-v1',
  captureKind: 'position-composite',
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

describe('sweep reference', () => {
  test('evaluates candidate field levels without clipping the deterministic sweep', () => {
    for (const sweepLevelDbfs of [-18, -15, -12, -9, -6]) {
      const signal = generateSweepSignal({ ...sweep, sweepLevelDbfs })
      const peak = signal.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample)), 0)
      expect(peak).toBeLessThanOrEqual(1)
      expect(peak).toBeGreaterThan(0)
    }
  })

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

  test('keeps the Android calibration marker and sweep layout aligned', () => {
    const parts = sweepSampleParts(androidDefaultSweep)
    const reference = generateCompositeSweepStereoReference(androidDefaultSweep)

    expect(parts.syncMarkerSamples).toBe(7_200)
    expect(parts.endMarkerSamples).toBe(7_200)
    expect(parts.leadingMarkerStartSamples).toBe(14_400)
    expect(parts.sweepStartSamples).toBe(24_000)
    expect(parts.rightSweepStartSamples).toBe(98_400)
    expect(parts.trailingMarkerStartSamples).toBe(172_800)
    expect(parts.totalSamples).toBe(204_000)
    expect(reference.length).toBe(parts.totalSamples * 2)

    const start = generateSyncMarker(androidDefaultSweep, androidDefaultSweep.sampleRate, 'start')
    const end = generateSyncMarker(androidDefaultSweep, androidDefaultSweep.sampleRate, 'end')
    const startMidpoint = Math.floor(start.length / 2)
    const endMidpoint = Math.floor(end.length / 2)
    expect(reference[(parts.leadingMarkerStartSamples + startMidpoint) * 2]).toBe(start[startMidpoint])
    expect(reference[(parts.leadingMarkerStartSamples + startMidpoint) * 2 + 1]).toBe(start[startMidpoint])
    expect(reference[(parts.trailingMarkerStartSamples + endMidpoint) * 2]).toBe(end[endMidpoint])
    expect(reference[(parts.trailingMarkerStartSamples + endMidpoint) * 2 + 1]).toBe(end[endMidpoint])
    let leftOnlyFrame = false
    for (let frame = parts.sweepStartSamples; frame < parts.rightSweepStartSamples; frame++) {
      if (reference[frame * 2] !== 0 && reference[frame * 2 + 1] === 0) {
        leftOnlyFrame = true
        break
      }
    }
    let rightOnlyFrame = false
    for (let frame = parts.rightSweepStartSamples; frame < parts.trailingMarkerStartSamples; frame++) {
      if (reference[frame * 2] === 0 && reference[frame * 2 + 1] !== 0) {
        rightOnlyFrame = true
        break
      }
    }
    expect(leftOnlyFrame).toBe(true)
    expect(rightOnlyFrame).toBe(true)
  })

  test('keeps production marker spacing while removing sweep energy', () => {
    const markerOnly: MeasurementSweep = { ...androidDefaultSweep, captureKind: 'marker-production-spacing' }
    const parts = sweepSampleParts(markerOnly)
    const reference = generateCompositeSweepStereoReference(markerOnly)

    expect(parts.trailingMarkerStartSamples - parts.leadingMarkerStartSamples).toBe(158_400)
    expect(reference.length).toBe(parts.totalSamples * 2)
    expect(reference.slice(parts.sweepStartSamples * 2, parts.trailingMarkerStartSamples * 2).every((sample) => sample === 0)).toBe(true)
    expect(reference.slice(parts.leadingMarkerStartSamples * 2, parts.sweepStartSamples * 2).some((sample) => sample !== 0)).toBe(true)
    expect(reference.slice(parts.trailingMarkerStartSamples * 2, (parts.trailingMarkerStartSamples + parts.endMarkerSamples) * 2).some((sample) => sample !== 0)).toBe(true)
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
