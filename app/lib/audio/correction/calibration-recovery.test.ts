import { describe, expect, test } from 'bun:test'
import {
  canIssueStandaloneCandidateRollback,
  createCalibrationAbortCommand,
  hasVerifiedAbortRecoveryReadback,
  mergeValidationAbortDetails,
  shouldKeepCalibrationLockedDuringAbort,
  shouldReportValidationFailure,
} from './calibration-recovery'

describe('validation abort recovery guards', () => {
  test('active validation cancellation has only the abort command', () => {
    expect(createCalibrationAbortCommand('session-1', 'calibration_aborted')).toEqual({
      type: 'calibrationSession.abort',
      payload: { sessionId: 'session-1', code: 'calibration_aborted' },
    })
  })

  test('standalone rollback is allowed only after the TV validation session is inactive', () => {
    expect(canIssueStandaloneCandidateRollback({ validationActive: true, candidatePending: true })).toBe(false)
    expect(canIssueStandaloneCandidateRollback({ validationActive: false, candidatePending: true })).toBe(true)
    expect(canIssueStandaloneCandidateRollback({ validationActive: false, candidatePending: false })).toBe(false)
  })

  test('does not report a second validation result after Android owns an abort', () => {
    expect(shouldReportValidationFailure({
      validationFailed: true,
      candidateMatches: true,
      abortState: 'idle',
    })).toBe(true)
    expect(shouldReportValidationFailure({
      validationFailed: true,
      candidateMatches: true,
      abortState: 'pending',
    })).toBe(false)
    expect(shouldReportValidationFailure({
      validationFailed: true,
      candidateMatches: true,
      abortState: 'awaiting-readback',
    })).toBe(false)
    expect(shouldReportValidationFailure({
      validationFailed: true,
      candidateMatches: true,
      abortState: 'failed',
    })).toBe(false)
  })

  test('keeps the dashboard locked until rollback and verified DSP readback finish', () => {
    expect(shouldKeepCalibrationLockedDuringAbort({
      abortState: 'pending',
      transactionState: 'none',
      liveDspStatus: 'verified',
    })).toBe(true)
    expect(shouldKeepCalibrationLockedDuringAbort({
      abortState: 'awaiting-readback',
      transactionState: 'candidate_pending',
      liveDspStatus: 'verified',
    })).toBe(true)
    expect(shouldKeepCalibrationLockedDuringAbort({
      abortState: 'awaiting-readback',
      transactionState: 'none',
      liveDspStatus: 'verified',
    })).toBe(false)
    expect(shouldKeepCalibrationLockedDuringAbort({
      abortState: 'awaiting-readback',
      transactionState: 'none',
      liveDspStatus: 'degraded',
    })).toBe(false)
  })

  test('recognizes the final verified readback', () => {
    expect(hasVerifiedAbortRecoveryReadback({
      abortState: 'awaiting-readback',
      transactionState: 'none',
      liveDspStatus: 'verified',
    })).toBe(true)
    expect(hasVerifiedAbortRecoveryReadback({
      abortState: 'awaiting-readback',
      transactionState: 'none',
      liveDspStatus: 'degraded',
    })).toBe(false)
  })

  test('keeps a real validation failure when a later event says generic cancellation', () => {
    const original = {
      sessionId: 'session-1',
      mode: 'validation' as const,
      candidateId: 'candidate-1',
      code: 'signal_too_low' as const,
      message: 'The validation sweep was too quiet.',
    }
    expect(mergeValidationAbortDetails(original, 'calibration_aborted', 'Calibration cancelled.'))
      .toEqual(original)
  })
})
