import { describe, expect, test } from 'bun:test'
import { shouldLockCalibrationInteraction } from './calibration-lock'

describe('calibration interaction lock', () => {
  test('locks an active job', () => {
    expect(shouldLockCalibrationInteraction('refining', 'idle', false)).toBe(true)
  })

  test('locks while capture or local measurement is active', () => {
    expect(shouldLockCalibrationInteraction('complete', 'recording', false)).toBe(true)
    expect(shouldLockCalibrationInteraction('complete', 'idle', true)).toBe(true)
  })

  test('unlocks after a terminal job with no active capture', () => {
    expect(shouldLockCalibrationInteraction('complete', 'idle', false)).toBe(false)
    expect(shouldLockCalibrationInteraction(undefined, 'idle', false)).toBe(false)
  })
})
