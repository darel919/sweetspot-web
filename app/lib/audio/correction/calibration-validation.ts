import { CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB } from '../../../../shared/types/protocol'

export interface CalibrationValidationInput {
  beforeDb: number | null
  afterDb: number | null
  baselineRepeatable: boolean
  validationRepeatable: boolean
}

export type CalibrationValidationOutcome =
  | { status: 'improved'; beforeDb: number; afterDb: number }
  | { status: 'worse'; beforeDb: number; afterDb: number }
  | { status: 'inconclusive'; reason: string; beforeDb?: number; afterDb?: number }

export function shouldRunValidationConfirmation(input: {
  outcome: CalibrationValidationOutcome | null
  candidateId: string | null
  confirmedCandidateId: string | null
}): boolean {
  return input.outcome?.status === 'inconclusive'
    && input.candidateId !== null
    && input.candidateId !== input.confirmedCandidateId
}

export interface AutomaticValidationStartInput {
  measurementComplete: boolean
  measurementId: string | null
  candidateId: string | null
  baselineRepeatable: boolean
  deviceValidationReady: boolean
  capturePathEligible: boolean
  deviceOnline: boolean
  validationActive: boolean
  startedCandidateId: string | null
  stagingFailedMeasurementId: string | null
}

export function shouldStartAutomaticValidation(input: AutomaticValidationStartInput): boolean {
  return input.measurementComplete
    && input.measurementId !== null
    && input.candidateId !== null
    && input.baselineRepeatable
    && input.deviceValidationReady
    && input.capturePathEligible
    && input.deviceOnline
    && !input.validationActive
    && input.startedCandidateId !== input.candidateId
    && input.stagingFailedMeasurementId !== input.measurementId
}

export function classifyCalibrationValidation(input: CalibrationValidationInput): CalibrationValidationOutcome {
  const { beforeDb, afterDb } = input
  if (!input.baselineRepeatable || !input.validationRepeatable) {
    return {
      status: 'inconclusive',
      reason: 'Validation measurements were not repeatable.',
    }
  }
  if (beforeDb === null || afterDb === null || !Number.isFinite(beforeDb) || !Number.isFinite(afterDb)) {
    return {
      status: 'inconclusive',
      reason: 'Validation target-error metrics were unavailable.',
    }
  }

  if (afterDb < beforeDb - CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB) {
    return { status: 'improved', beforeDb, afterDb }
  }
  if (afterDb > beforeDb + CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB) {
    return { status: 'worse', beforeDb, afterDb }
  }
  return {
    status: 'inconclusive',
    reason: 'The validation change was smaller than the accepted measurement tolerance.',
    beforeDb,
    afterDb,
  }
}
