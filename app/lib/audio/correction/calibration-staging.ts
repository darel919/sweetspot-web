const CALIBRATION_BAND_COUNT = 64

export interface AutomaticCorrection {
  readonly bandsDb: readonly number[]
  readonly leftBandsDb?: readonly number[]
  readonly rightBandsDb?: readonly number[]
}

export interface AutomaticCorrectionStageInput {
  measurementComplete: boolean
  convergenceSufficient: boolean
  measurementId: string | null
  correction: AutomaticCorrection | null
  supportsCalibratedCorrection: boolean
  capturePathEligible: boolean
  deviceOnline: boolean
  candidatePending: boolean
  applyInProgress: boolean
  attemptedMeasurementId: string | null
  failedMeasurementId: string | null
  unresolvedFailureCount: number
  acceptedPositionCount: number
}

function isCorrectionCurve(curve: readonly number[]): boolean {
  return curve.length === CALIBRATION_BAND_COUNT && curve.every(Number.isFinite)
}

export function isValidCorrection(correction: AutomaticCorrection | null): boolean {
  if (!correction) return false
  const curves = [correction.bandsDb]
  if (correction.leftBandsDb !== undefined) curves.push(correction.leftBandsDb)
  if (correction.rightBandsDb !== undefined) curves.push(correction.rightBandsDb)
  return curves.every(isCorrectionCurve)
}

export function shouldStageAutomaticCorrection(input: AutomaticCorrectionStageInput): boolean {
  const measurementId = input.measurementId
  return input.measurementComplete
    && input.convergenceSufficient
    && measurementId !== null
    && measurementId.length > 0
    && isValidCorrection(input.correction)
    && input.supportsCalibratedCorrection
    && input.capturePathEligible
    && input.acceptedPositionCount >= 3
    && input.deviceOnline
    && !input.candidatePending
    && !input.applyInProgress
    && input.attemptedMeasurementId !== measurementId
    && input.failedMeasurementId !== measurementId
}
