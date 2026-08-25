import type {
  CalibrationErrorCode,
  CalibrationSessionAbortPayload,
} from '../../../../shared/types/protocol'

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
  | { state: 'failed'; details: CalibrationAbortDetails }

export type CalibrationAbortState = CalibrationAbortRecovery['state']

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
  if (input.abortState === 'pending') return true
  if (input.abortState !== 'awaiting-readback') return false
  return input.transactionState !== 'none'
}

export function hasVerifiedAbortRecoveryReadback(input: CalibrationAbortReadbackInput): boolean {
  return input.abortState === 'awaiting-readback'
    && input.transactionState === 'none'
    && input.liveDspStatus === 'verified'
}
