import type { MeasurementContext, MeasurementDiagnosticsValues } from '#shared/types/protocol'

export interface FailedTakeDiagnostic {
  context: MeasurementContext
  diagnostics: MeasurementDiagnosticsValues
}

export interface TakeDiagnosticUpdate {
  channel: 'left' | 'right'
  failed: boolean
  diagnostics: MeasurementDiagnosticsValues
}

function diagnosticKey(context: MeasurementContext, channel: 'left' | 'right'): string {
  return `${context.positionId}:${channel}`
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
    if (channel === 'left' || channel === 'right') unresolved.set(diagnosticKey(failure.context, channel), failure)
  }
  for (const update of updates) {
    const key = diagnosticKey(context, update.channel)
    if (update.failed) unresolved.set(key, { context, diagnostics: update.diagnostics })
    else unresolved.delete(key)
  }
  return [...unresolved.values()]
}
