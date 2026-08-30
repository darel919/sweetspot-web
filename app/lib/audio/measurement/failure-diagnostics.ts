import { isMarkerDiagnosticCaptureKind } from '../../../../shared/types/protocol'
import type { CalibrationPositionId, MeasurementContext, MeasurementDiagnosticsValues } from '#shared/types/protocol'

export interface FailedTakeDiagnostic {
  context: MeasurementContext
  diagnostics: MeasurementDiagnosticsValues
}

export interface TakeDiagnosticUpdate {
  channel: 'left' | 'right'
  failed: boolean
  diagnostics: MeasurementDiagnosticsValues
}

export interface PhysicalTakeDiagnostics {
  context: Pick<MeasurementContext, 'positionId' | 'captureKind' | 'repairChannel'>
  left: Pick<MeasurementDiagnosticsValues, 'analysisStatus'>
  right: Pick<MeasurementDiagnosticsValues, 'analysisStatus'>
}

export interface MarkerProbeSummary {
  requestedPositionCount: number
  completedPositionCount: number
  failedPositionIds: CalibrationPositionId[]
  historicalAttemptCount: number
  historicalFailureCount: number
  passed: boolean
}

function diagnosticKey(context: MeasurementContext, channel: 'left' | 'right'): string {
  return `${context.positionId}:${channel}`
}

function physicalDiagnosticKey(context: MeasurementContext): string {
  return `${context.positionId}:physical`
}

function isFailedStatus(status: MeasurementDiagnosticsValues['analysisStatus']): boolean {
  return status !== 'ok' && status !== 'not_measured'
}

function requiredChannels(context: PhysicalTakeDiagnostics['context']): readonly ('left' | 'right')[] {
  if (isMarkerDiagnosticCaptureKind(context.captureKind)) return ['left', 'right']
  if (context.repairChannel === 'left' || context.repairChannel === 'right') return [context.repairChannel]
  return ['left', 'right']
}

export function countFailedPhysicalTakes(takes: readonly PhysicalTakeDiagnostics[]): number {
  return takes.reduce((count, take) => {
    const failed = requiredChannels(take.context).some((channel) => isFailedStatus(take[channel].analysisStatus))
    return count + (failed ? 1 : 0)
  }, 0)
}

export function summarizeMarkerProbe(
  takes: readonly PhysicalTakeDiagnostics[],
  unresolved: readonly FailedTakeDiagnostic[],
  requestedPositionCount: number,
): MarkerProbeSummary {
  const markerTakes = takes.filter((take) => isMarkerDiagnosticCaptureKind(take.context.captureKind))
  const failedPositionIds = [...new Set(unresolved
    .filter((failure) => isMarkerDiagnosticCaptureKind(failure.context.captureKind))
    .map((failure) => failure.context.positionId))]
  const completedPositions = new Set(markerTakes.map((take) => take.context.positionId))
  for (const positionId of failedPositionIds) completedPositions.delete(positionId)
  const completedPositionCount = completedPositions.size
  return {
    requestedPositionCount,
    completedPositionCount,
    failedPositionIds,
    historicalAttemptCount: markerTakes.length,
    historicalFailureCount: countFailedPhysicalTakes(markerTakes),
    passed: markerTakes.length > 0
      && completedPositionCount === requestedPositionCount
      && failedPositionIds.length === 0,
  }
}

/** Keeps one current unresolved diagnostic for each physical position/channel. */
export function reconcileFailedTakeDiagnostics(
  current: readonly FailedTakeDiagnostic[],
  context: MeasurementContext,
  updates: readonly TakeDiagnosticUpdate[],
): FailedTakeDiagnostic[] {
  const unresolved = new Map<string, FailedTakeDiagnostic>()
  for (const failure of current) {
    const channel = failure.diagnostics.channel
    if (isMarkerDiagnosticCaptureKind(failure.context.captureKind)) {
      unresolved.set(physicalDiagnosticKey(failure.context), failure)
    } else if (channel === 'left' || channel === 'right') {
      unresolved.set(diagnosticKey(failure.context, channel), failure)
    }
  }
  if (isMarkerDiagnosticCaptureKind(context.captureKind)) {
    const failedUpdate = updates.find((update) => update.failed)
    if (failedUpdate) unresolved.set(physicalDiagnosticKey(context), { context, diagnostics: failedUpdate.diagnostics })
    else unresolved.delete(physicalDiagnosticKey(context))
    return [...unresolved.values()]
  }
  for (const update of updates) {
    const key = diagnosticKey(context, update.channel)
    if (update.failed) unresolved.set(key, { context, diagnostics: update.diagnostics })
    else unresolved.delete(key)
  }
  return [...unresolved.values()]
}
