import { describe, expect, test } from 'bun:test'
import { calibrationValidationStatusLabel, formatCalibrationFinalizationMessage, verifiedRollbackStateMessage } from './calibration-result'

describe('calibration finalization copy', () => {
  test('describes an inactive rollback target without claiming a calibration restore', () => {
    expect(formatCalibrationFinalizationMessage({
      outcome: { status: 'worse', beforeDb: 7, afterDb: 8 },
      rollbackTargetActive: false,
      readbackVerified: true,
    })).toBe('The candidate did not improve the measured result. It was removed, and calibration remains off. Your pre-calibration audio settings are unchanged.')
  })

  test('describes a committed calibration restore only when it was active', () => {
    expect(formatCalibrationFinalizationMessage({
      outcome: { status: 'worse', beforeDb: 7, afterDb: 8 },
      rollbackTargetActive: true,
      readbackVerified: true,
    })).toBe('The new candidate did not improve the measured result. The previously active calibration was restored.')
    expect(verifiedRollbackStateMessage(false)).toContain('calibration remains off')
  })

  test('does not claim a rollback when final DSP readback is unverified', () => {
    expect(formatCalibrationFinalizationMessage({
      outcome: { status: 'worse', beforeDb: 7, afterDb: 8 },
      rollbackTargetActive: true,
      readbackVerified: false,
    })).toBe('The candidate could not be finalized safely. SweetSpot could not verify the restored DSP state.')
  })

  test('keeps a finalized worse result from falling back to pending', () => {
    expect(calibrationValidationStatusLabel({
      candidatePending: false,
      candidateValidationStatus: null,
      calibrationResult: 'worse',
    })).toBe('WORSE')
    expect(calibrationValidationStatusLabel({
      candidatePending: true,
      candidateValidationStatus: null,
      calibrationResult: 'worse',
    })).toBe('PENDING')
    expect(calibrationValidationStatusLabel({
      candidatePending: false,
      candidateValidationStatus: null,
      calibrationResult: 'improved',
    })).toBe('PASSED')
  })
})
