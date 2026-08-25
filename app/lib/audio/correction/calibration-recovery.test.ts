import { describe, expect, test } from 'bun:test'
import {
  canIssueStandaloneCandidateRollback,
  createCalibrationAbortCommand,
  evaluateCalibrationAbortRecovery,
  formatCalibrationAbortCompletion,
  formatCalibrationAbortRecoveryFailure,
  hasVerifiedAbortRecoveryReadback,
  mergeValidationAbortDetails,
  shouldContinueCalibrationAbortRecoveryPoll,
  shouldKeepCalibrationLockedDuringAbort,
  shouldReportValidationFailure,
  type CalibrationAbortDetails,
  type CalibrationAbortRecovery,
  type CalibrationAbortRecoverySnapshot,
} from './calibration-recovery'

function details(code: CalibrationAbortDetails['code'] = 'signal_too_low'): CalibrationAbortDetails {
  return {
    sessionId: 'session-1',
    mode: 'validation',
    candidateId: 'candidate-1',
    code,
    message: code === 'calibration_aborted' ? 'Calibration cancelled.' : 'The validation sweep was too quiet.',
  }
}

function recovery(
  state: 'pending' | 'awaiting-readback',
  code: CalibrationAbortDetails['code'] = 'signal_too_low',
): Extract<CalibrationAbortRecovery, { state: 'pending' | 'awaiting-readback' }> {
  return { state, details: details(code) }
}

function candidateTransaction(candidateId: string) {
  return {
    state: 'candidate_pending' as const,
    candidateId,
    validationStatus: 'rolling_back' as const,
    previousActive: true,
    beforeDb: null,
    afterDb: null,
    reason: null,
  }
}

function snapshot(overrides: Partial<CalibrationAbortRecoverySnapshot> = {}): CalibrationAbortRecoverySnapshot {
  return {
    authoritative: true,
    transaction: { state: 'none' },
    liveDspStatus: 'verified',
    applicationError: null,
    ...overrides,
  }
}

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
    })).toBe(true)
    expect(shouldKeepCalibrationLockedDuringAbort({
      abortState: 'awaiting-readback',
      transactionState: 'none',
      liveDspStatus: 'degraded',
    })).toBe(true)
  })

  test('recognizes a verified readback before the transient ended event arrives', () => {
    expect(hasVerifiedAbortRecoveryReadback({
      abortState: 'pending',
      transactionState: 'none',
      liveDspStatus: 'verified',
    })).toBe(true)
    expect(hasVerifiedAbortRecoveryReadback({
      abortState: 'awaiting-readback',
      transactionState: 'none',
      liveDspStatus: 'verified',
    })).toBe(true)
    expect(hasVerifiedAbortRecoveryReadback({
      abortState: 'failed',
      transactionState: 'none',
      liveDspStatus: 'verified',
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

  test('completes pending recovery from a fresh verified snapshot when ended was lost', () => {
    const current = recovery('pending')
    expect(evaluateCalibrationAbortRecovery(current, snapshot())).toEqual({
      kind: 'completed',
      details: current.details,
    })
  })

  test('completes normal ended recovery after verified readback', () => {
    const current = recovery('awaiting-readback')
    expect(evaluateCalibrationAbortRecovery(current, snapshot())).toEqual({
      kind: 'completed',
      details: current.details,
    })
  })

  test('does not resolve a recovery from a non-authoritative cached snapshot', () => {
    const current = recovery('pending')
    expect(evaluateCalibrationAbortRecovery(current, snapshot({ authoritative: false }))).toEqual({ kind: 'waiting' })
  })

  test('reports validation failure after rollback succeeds without calling it a recovery failure', () => {
    expect(formatCalibrationAbortCompletion(details('signal_too_low'), true)).toEqual({
      kind: 'validation-failure',
      message: 'Validation failed [signal_too_low]. The validation sweep was too quiet. The previously active calibration was restored.',
    })
  })

  test('reports ordinary cancellation separately after rollback succeeds', () => {
    expect(formatCalibrationAbortCompletion(details('calibration_aborted'), false)).toEqual({
      kind: 'cancelled',
      message: 'Calibration cancelled. The candidate was removed, and calibration remains off. Your pre-calibration audio settings are unchanged.',
    })
  })

  test('reports degraded DSP as a recovery failure', () => {
    const result = evaluateCalibrationAbortRecovery(recovery('pending'), snapshot({ liveDspStatus: 'degraded' }))
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.failure.kind).toBe('unverified-readback')
    expect(formatCalibrationAbortRecoveryFailure(result.failure)).toBe('The candidate could not be finalized safely. SweetSpot could not verify the restored DSP state.')
  })

  test('reports a pending candidate mismatch without resolving or rolling it back', () => {
    const result = evaluateCalibrationAbortRecovery(recovery('pending'), snapshot({
      transaction: candidateTransaction('candidate-2'),
    }))
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.failure).toEqual({ kind: 'candidate-mismatch', actualCandidateId: 'candidate-2' })
    expect(formatCalibrationAbortRecoveryFailure(result.failure)).toContain('recovery conflict')
  })

  test('keeps an unresolved same-candidate transaction pending', () => {
    expect(evaluateCalibrationAbortRecovery(recovery('pending'), snapshot({
      transaction: candidateTransaction('candidate-1'),
    }))).toEqual({ kind: 'waiting' })
  })

  test('ignores duplicate snapshots after the recovery has been settled', () => {
    expect(evaluateCalibrationAbortRecovery({ state: 'idle' }, snapshot())).toEqual({ kind: 'ignored' })
  })

  test('formats bounded recovery timeout as an explicit restoration failure', () => {
    expect(formatCalibrationAbortRecoveryFailure({ kind: 'timeout' })).toBe(
      'The candidate could not be finalized safely. SweetSpot could not verify the restored DSP state.',
    )
  })

  test('stops state polling at the recovery retry bound', () => {
    expect(shouldContinueCalibrationAbortRecoveryPoll(29)).toBe(true)
    expect(shouldContinueCalibrationAbortRecoveryPoll(30)).toBe(false)
  })
})
