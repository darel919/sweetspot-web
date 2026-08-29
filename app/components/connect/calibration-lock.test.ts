import { describe, expect, test } from 'bun:test'
import { shouldLockCalibrationInteraction } from './calibration-lock'

describe('calibration interaction lock', () => {
  test('locks an active job', () => {
    expect(shouldLockCalibrationInteraction('refining', 'idle', false, false)).toBe(true)
  })

  test('locks while capture or local measurement is active', () => {
    expect(shouldLockCalibrationInteraction('complete', 'recording', false, false)).toBe(true)
    expect(shouldLockCalibrationInteraction('complete', 'idle', true, false)).toBe(true)
  })

  test('unlocks after a terminal job with no active capture', () => {
    expect(shouldLockCalibrationInteraction('complete', 'idle', false, false)).toBe(false)
    expect(shouldLockCalibrationInteraction(undefined, 'idle', false, false)).toBe(false)
  })

  test('locks immediately while a start request is pending', () => {
    expect(shouldLockCalibrationInteraction(undefined, 'idle', false, true)).toBe(true)
  })
})
