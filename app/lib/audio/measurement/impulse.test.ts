import { describe, expect, test } from 'bun:test'
import { generateSweepReference } from '../sweep-reference'
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
    expect(result.summary.room.directArrivalMs).toBeCloseTo(0, 1)
    expect(result.summary.room.earlyReflections[0].delayMs).toBeCloseTo(5, 1)
    expect(result.summary.room.earlyReflections[0].levelDbRelativeToDirect).toBeLessThan(-5)
  })
})
