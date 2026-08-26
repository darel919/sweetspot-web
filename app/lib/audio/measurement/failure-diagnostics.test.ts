import { describe, expect, test } from 'bun:test'
import type { MeasurementContext, MeasurementDiagnosticsValues } from '#shared/types/protocol'
import { countFailedPhysicalTakes, reconcileFailedTakeDiagnostics, summarizeMarkerProbe } from './failure-diagnostics'

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
  test('counts a marker-only failure once per physical position', () => {
    const markerContext = { ...context, captureKind: 'marker-only' as const }
    const failed = diagnostics('left')
    const takes = [{ context: markerContext, left: failed, right: { ...failed, channel: 'right' as const } }]

    expect(countFailedPhysicalTakes(takes)).toBe(1)
  })

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

  test('summarizes resolved marker positions separately from historical attempts', () => {
    const markerContext = { ...context, captureKind: 'marker-only' as const }
    const failedLeft = diagnostics('left')
    const failedRight = diagnostics('right')
    const successfulLeft = { ...failedLeft, analysisStatus: 'ok' as const }
    const successfulRight = { ...failedRight, analysisStatus: 'ok' as const }
    const centerTake = {
      context: { ...markerContext, positionId: 'center' as const },
      left: successfulLeft,
      right: successfulRight,
    }
    const leftFailure = {
      context: { ...markerContext, positionId: 'left' as const, attemptIndex: 0 },
      left: failedLeft,
      right: successfulRight,
    }
    const leftRetry = {
      context: { ...markerContext, positionId: 'left' as const, attemptIndex: 1 },
      left: successfulLeft,
      right: successfulRight,
    }
    const rightFailure = {
      context: { ...markerContext, positionId: 'right' as const, attemptIndex: 0 },
      left: failedRight,
      right: successfulRight,
    }
    const unresolved = reconcileFailedTakeDiagnostics(
      reconcileFailedTakeDiagnostics([], leftFailure.context, [
        { channel: 'left', failed: true, diagnostics: failedLeft },
        { channel: 'right', failed: false, diagnostics: successfulRight },
      ]),
      leftRetry.context,
      [
        { channel: 'left', failed: false, diagnostics: successfulLeft },
        { channel: 'right', failed: false, diagnostics: successfulRight },
      ],
    )
    const finalUnresolved = reconcileFailedTakeDiagnostics(
      unresolved,
      rightFailure.context,
      [
        { channel: 'left', failed: true, diagnostics: failedRight },
        { channel: 'right', failed: false, diagnostics: successfulRight },
      ],
    )

    expect(summarizeMarkerProbe(
      [centerTake, leftFailure, leftRetry, rightFailure],
      finalUnresolved,
      3,
    )).toEqual({
      requestedPositionCount: 3,
      completedPositionCount: 2,
      failedPositionIds: ['right'],
      historicalAttemptCount: 4,
      historicalFailureCount: 2,
      passed: false,
    })
  })

  test('uses the same resolved retry semantics for production-spacing markers', () => {
    const markerContext = { ...context, captureKind: 'marker-production-spacing' as const, positionId: 'left' as const }
    const failed = diagnostics('left')
    const successful = { ...failed, analysisStatus: 'ok' as const }
    const failureTake = { context: markerContext, left: failed, right: successful }
    const retryContext = { ...markerContext, attemptIndex: 1 }
    const retryTake = { context: retryContext, left: successful, right: successful }
    const unresolved = reconcileFailedTakeDiagnostics([], markerContext, [
      { channel: 'left', failed: true, diagnostics: failed },
      { channel: 'right', failed: false, diagnostics: successful },
    ])
    const resolved = reconcileFailedTakeDiagnostics(unresolved, retryContext, [
      { channel: 'left', failed: false, diagnostics: successful },
      { channel: 'right', failed: false, diagnostics: successful },
    ])

    expect(summarizeMarkerProbe([failureTake, retryTake], resolved, 1)).toEqual({
      requestedPositionCount: 1,
      completedPositionCount: 1,
      failedPositionIds: [],
      historicalAttemptCount: 2,
      historicalFailureCount: 1,
      passed: true,
    })
  })
})
