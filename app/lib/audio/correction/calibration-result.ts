import type { CalibrationValidationStatus } from '#shared/types/protocol'

type CalibrationValidationOutcome =
  | { status: 'improved'; beforeDb: number; afterDb: number }
  | { status: 'worse'; beforeDb: number; afterDb: number }
  | { status: 'inconclusive'; reason: string; beforeDb?: number; afterDb?: number }
  | { status: 'failed'; reason: string; beforeDb?: number; afterDb?: number }

export type CalibrationFinalizationDecision = CalibrationValidationOutcome | { status: 'error'; reason: string }
type CalibrationFinalResult = 'improved' | 'inconclusive' | 'worse' | 'cancelled' | 'error'

/** Uses the active transaction status only while a candidate is still pending. */
export function calibrationValidationStatusLabel(input: {
  candidatePending: boolean
  candidateValidationStatus: CalibrationValidationStatus | null
  calibrationResult: CalibrationFinalResult | null
}): string | null {
  if (input.candidatePending) return (input.candidateValidationStatus ?? 'pending').toUpperCase()
  if (input.calibrationResult === null) return null
  return (input.calibrationResult === 'improved' ? 'passed' : input.calibrationResult).toUpperCase()
}

export function verifiedRollbackStateMessage(previousActive: boolean): string {
  return previousActive
    ? 'The previously active calibration was restored.'
    : 'The candidate was removed, and calibration remains off. Your pre-calibration audio settings are unchanged.'
}

export function formatCalibrationFinalizationMessage(input: {
  outcome: CalibrationFinalizationDecision
  rollbackTargetActive: boolean
  readbackVerified: boolean
}): string {
  if (!input.readbackVerified) {
    return 'The candidate could not be finalized safely. SweetSpot could not verify the restored DSP state.'
  }
  if (input.outcome.status === 'improved') {
    return `Target spatial error improved from ${input.outcome.beforeDb.toFixed(2)} to ${input.outcome.afterDb.toFixed(2)} dB RMS. The candidate was accepted.`
  }
  if (input.outcome.status === 'worse') {
    return input.rollbackTargetActive
      ? 'The new candidate did not improve the measured result. The previously active calibration was restored.'
      : 'The candidate did not improve the measured result. It was removed, and calibration remains off. Your pre-calibration audio settings are unchanged.'
  }
  if (input.outcome.status === 'inconclusive') {
    return input.rollbackTargetActive
      ? 'The new candidate could not be proven better. The previously active calibration was restored.'
      : 'The candidate could not be proven better. It was removed, and calibration remains off. Your pre-calibration audio settings are unchanged.'
  }
  return `Validation failed. ${verifiedRollbackStateMessage(input.rollbackTargetActive)} ${input.outcome.reason}`
}
