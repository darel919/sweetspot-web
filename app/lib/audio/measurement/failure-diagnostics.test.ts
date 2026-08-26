import { describe, expect, test } from 'bun:test'
import type { MeasurementContext, MeasurementDiagnosticsValues } from '#shared/types/protocol'
import { reconcileFailedTakeDiagnostics } from './failure-diagnostics'

const context: MeasurementContext = {
  positionId: 'center',
  reference: 'center',
  xCm: 0,
  yCm: 0,
  zCm: 0,
  positionIndex: 0,
  positionCount: 3,
  channel: 'both',
  captureKind: 'position-composite',
  repairChannel: 'both',
  attemptIndex: 0,
  attemptCount: 2,
  phase: 'validation',
}

function diagnostics(channel: 'left' | 'right'): MeasurementDiagnosticsValues {
  return {
    channel,
    analysisStatus: 'sync_marker_not_found',
    failureReason: 'sync_marker_not_found',
    signalRms: 0,
    signalPeak: 0,
    snrEstimateDb: null,
    detectionOffsetMs: null,
    syncMarkerConfidence: 0,
    endingMarkerConfidence: 0,
    clockDriftPpm: null,
    clipped: false,
    clippedSamples: 0,
    directArrivalMs: null,
    directToLateDb: null,
    c50Db: null,
    c80Db: null,
    edtMs: null,
    t20Ms: null,
    t30Ms: null,
    earlyReflections: 0,
    decayConfidence: 'low',
  }
}

describe('failed take diagnostics', () => {
  test('a successful retry resolves the earlier position/channel failure', () => {
    const failure = { context, diagnostics: diagnostics('left') }
    expect(reconcileFailedTakeDiagnostics(
      [],
      context,
      [{ channel: 'left', failed: true, diagnostics: diagnostics('left') }],
    )).toEqual([failure])

    expect(reconcileFailedTakeDiagnostics(
      [failure],
      { ...context, attemptIndex: 1 },
      [{ channel: 'left', failed: false, diagnostics: { ...diagnostics('left'), analysisStatus: 'ok' } }],
    )).toEqual([])
  })

  test('keeps an unresolved channel while resolving its sibling', () => {
    const failures = reconcileFailedTakeDiagnostics(
      [],
      context,
      [
        { channel: 'left', failed: true, diagnostics: diagnostics('left') },
        { channel: 'right', failed: true, diagnostics: diagnostics('right') },
      ],
    )
    const resolved = reconcileFailedTakeDiagnostics(
      failures,
      { ...context, attemptIndex: 1 },
      [{ channel: 'left', failed: false, diagnostics: { ...diagnostics('left'), analysisStatus: 'ok' } }],
    )
    expect(resolved.map((entry) => entry.diagnostics.channel)).toEqual(['right'])
  })
})
