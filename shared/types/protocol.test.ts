import { describe, expect, test } from 'bun:test'
import { isMeasurementSweep, validatePayload } from './protocol'

const sweep = {
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

describe('measurement protocol boundary', () => {
  test('accepts the deterministic sweep descriptor', () => {
    expect(isMeasurementSweep(sweep)).toBe(true)
    expect(validatePayload('measurement.ready', { sessionId: 'cal_test', sweep })).toBeNull()
  })

  test('rejects missing session and malformed sweep payloads', () => {
    expect(validatePayload('measurement.playSweep', {})).not.toBeNull()
    expect(validatePayload('measurement.ready', { sessionId: 'cal_test', sweep: { ...sweep, endHz: 1 } })).not.toBeNull()
  })
})
