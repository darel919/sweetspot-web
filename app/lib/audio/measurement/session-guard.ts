import type { MeasurementContext } from '../../../../shared/types/protocol'

export function isSameMeasurementContext(left: MeasurementContext | null, right: MeasurementContext | null): boolean {
  if (!left || !right) return left === right
  return left.positionId === right.positionId
    && left.positionIndex === right.positionIndex
    && left.positionCount === right.positionCount
    && left.channel === right.channel
    && left.captureKind === right.captureKind
    && left.repairChannel === right.repairChannel
    && left.attemptIndex === right.attemptIndex
    && left.attemptCount === right.attemptCount
    && left.phase === right.phase
}

export function isCalibrationOperationCurrent(
  operationGeneration: number,
  currentGeneration: number,
  operationSessionId: string | null,
  currentSessionId: string | null,
): boolean {
  return operationGeneration === currentGeneration
    && operationSessionId !== null
    && currentSessionId === operationSessionId
}
