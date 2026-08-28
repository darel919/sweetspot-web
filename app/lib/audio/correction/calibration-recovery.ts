import type {
  CalibrationErrorCode,
  CalibrationTransaction,
  CalibrationSessionAbortPayload,
} from '../../../../shared/types/protocol'
import { verifiedRollbackStateMessage } from './calibration-result'

export interface CalibrationAbortDetails {
  sessionId: string
  mode: 'measurement' | 'validation' | 'probe'
  candidateId: string | null
  code: CalibrationErrorCode
  message: string
}

export function mergeValidationAbortDetails(
  current: CalibrationAbortDetails,
  nextCode: CalibrationErrorCode,
  nextMessage: string,
): CalibrationAbortDetails {
  const preserveKnownFailure = current.code !== 'calibration_aborted'
    && current.code !== 'calibration_ui_closed'
    && nextCode === 'calibration_aborted'
  return preserveKnownFailure
    ? current
    : { ...current, code: nextCode, message: nextMessage }
}

export function createCalibrationAbortCommand(
  sessionId: string,
  code: CalibrationErrorCode,
  message?: string,
): { type: 'calibrationSession.abort'; payload: CalibrationSessionAbortPayload } {
  return {
    type: 'calibrationSession.abort',
    payload: {
      sessionId,
      code,
      ...(message === undefined ? {} : { message }),
    },
  }
}

export function canIssueStandaloneCandidateRollback(input: {
  validationActive: boolean
  candidatePending: boolean
}): boolean {
  return !input.validationActive && input.candidatePending
}

export type CalibrationAbortRecovery =
  | { state: 'idle' }
  | { state: 'pending'; details: CalibrationAbortDetails }
  | { state: 'awaiting-readback'; details: CalibrationAbortDetails }
  | {
      state: 'failed'
      details: CalibrationAbortDetails
      failure: CalibrationAbortRecoveryFailure
    }

export type CalibrationAbortState = CalibrationAbortRecovery['state']

const CALIBRATION_ABORT_RECOVERY_POLL_LIMIT = 30

export function shouldContinueCalibrationAbortRecoveryPoll(attempts: number): boolean {
  return attempts < CALIBRATION_ABORT_RECOVERY_POLL_LIMIT
}

export type CalibrationAbortRecoveryFailure =
  | { kind: 'candidate-mismatch'; actualCandidateId: string | null }
  | {
      kind: 'unverified-readback'
      liveDspStatus: 'degraded' | null
      applicationError: string | null
    }
  | { kind: 'timeout' }

export interface CalibrationAbortRecoverySnapshot {
  authoritative: boolean
  transaction: CalibrationTransaction
  liveDspStatus: 'verified' | 'degraded' | null
  applicationError: string | null
}

export type CalibrationAbortRecoveryObservation =
  | { kind: 'ignored' }
  | { kind: 'waiting' }
  | { kind: 'completed'; details: CalibrationAbortDetails }
  | {
      kind: 'failed'
      details: CalibrationAbortDetails
      failure: CalibrationAbortRecoveryFailure
    }

export type CalibrationAbortCompletion =
  | { kind: 'validation-failure'; message: string }
  | { kind: 'cancelled'; message: string }

export function isAbortRecoveryActive(state: CalibrationAbortState): boolean {
  return state === 'pending' || state === 'awaiting-readback'
}

export function evaluateCalibrationAbortRecovery(
  recovery: CalibrationAbortRecovery,
  snapshot: CalibrationAbortRecoverySnapshot,
): CalibrationAbortRecoveryObservation {
  if (recovery.state === 'idle' || recovery.state === 'failed') return { kind: 'ignored' }
  if (!snapshot.authoritative) return { kind: 'waiting' }

  const expectedCandidateId = recovery.details.candidateId
  if (snapshot.transaction.state === 'candidate_pending') {
    if (expectedCandidateId === null || snapshot.transaction.candidateId !== expectedCandidateId) {
      return {
        kind: 'failed',
        details: recovery.details,
        failure: {
          kind: 'candidate-mismatch',
          actualCandidateId: snapshot.transaction.candidateId,
        },
      }
    }
    return { kind: 'waiting' }
  }

  if (expectedCandidateId === null) {
    return {
      kind: 'failed',
      details: recovery.details,
      failure: { kind: 'candidate-mismatch', actualCandidateId: null },
    }
  }
  if (snapshot.liveDspStatus === 'degraded' || snapshot.applicationError !== null) {
    return {
      kind: 'failed',
      details: recovery.details,
      failure: {
        kind: 'unverified-readback',
        liveDspStatus: snapshot.liveDspStatus === 'degraded' ? 'degraded' : null,
        applicationError: snapshot.applicationError,
      },
    }
  }
  if (snapshot.liveDspStatus === 'verified') {
    return { kind: 'completed', details: recovery.details }
  }
  return { kind: 'waiting' }
}

export function formatCalibrationAbortCompletion(details: CalibrationAbortDetails, calibrationActive: boolean): CalibrationAbortCompletion {
  if (details.code === 'calibration_aborted') {
    return {
      kind: 'cancelled',
      message: `Calibration cancelled. ${calibrationActive ? 'The previously active calibration was restored.' : 'The candidate was removed, and calibration remains off. Your pre-calibration audio settings are unchanged.'}`,
    }
  }
  return {
    kind: 'validation-failure',
    message: `Validation failed [${details.code}]. ${details.message} ${verifiedRollbackStateMessage(calibrationActive)}`,
  }
}

export function formatCalibrationAbortRecoveryFailure(failure: CalibrationAbortRecoveryFailure): string {
  switch (failure.kind) {
    case 'candidate-mismatch':
      return `Calibration recovery conflict. The TV reports pending candidate ${failure.actualCandidateId ?? 'unknown'}, so the browser did not roll it back. Recovery controls remain available.`
    case 'unverified-readback':
      return 'The candidate could not be finalized safely. SweetSpot could not verify the restored DSP state.'
    case 'timeout':
      return 'The candidate could not be finalized safely. SweetSpot could not verify the restored DSP state.'
    default: {
      const _exhaustive: never = failure
      return _exhaustive
    }
  }
}

export interface ValidationFailureReportInput {
  validationFailed: boolean
  candidateMatches: boolean
  abortState: CalibrationAbortState
}

export interface CalibrationAbortReadbackInput {
  abortState: CalibrationAbortState
  transactionState: 'none' | 'candidate_pending' | null
  liveDspStatus: 'verified' | 'degraded' | null
}

export function shouldReportValidationFailure(input: ValidationFailureReportInput): boolean {
  return input.validationFailed
    && input.candidateMatches
    && input.abortState === 'idle'
}

export function shouldKeepCalibrationLockedDuringAbort(input: CalibrationAbortReadbackInput): boolean {
  return isAbortRecoveryActive(input.abortState)
}

export function hasVerifiedAbortRecoveryReadback(input: CalibrationAbortReadbackInput): boolean {
  return isAbortRecoveryActive(input.abortState)
    && input.transactionState === 'none'
    && input.liveDspStatus === 'verified'
}
