import type {
  MeasurementContext,
  MeasurementCaptureMetadata,
} from '#shared/types/protocol'
import type { CompositeMeasurementAnalysis, MeasurementAnalysis } from './response'
import {
  channelMeasurement,
  createPendingPosition,
  DEFAULT_POSITION_SPECS,
  type CaptureChannel,
  type CaptureFailureClass,
  type CaptureQuality,
  type ChannelMeasurement,
  type PhysicalPositionLedger,
  type PositionMeasurement,
} from './physical-position'
import type { MeasurementRecord } from './aggregation'

export type LedgerSubmeasurement =
  | {
      kind: 'accepted'
      captureKey: string
      channel: CaptureChannel
      analysis: MeasurementAnalysis
      quality: CaptureQuality
    }
  | {
      kind: 'rejected'
      captureKey: string
      channel: CaptureChannel
      analysis: MeasurementAnalysis
      quality: CaptureQuality
    }
  | {
      kind: 'ignored'
      captureKey: string
      channel: CaptureChannel
      reason: 'sibling-already-accepted'
      quality: CaptureQuality
    }

export interface LedgerCapture {
  captureKey: string
  context: MeasurementContext
  left: LedgerSubmeasurement
  right: LedgerSubmeasurement
  captureMetadata: MeasurementCaptureMetadata | null
  acceptedAt: number | null
}

export interface PositionLedger {
  schemaVersion: 2
  sessionId: string
  captures: LedgerCapture[]
  systemicCenterFailures: number
}

export interface CompositeCaptureCommit {
  context: MeasurementContext
  analysis: CompositeMeasurementAnalysis
  captureMetadata: MeasurementCaptureMetadata | null
  acceptedAt: number
}

export function createPositionLedger(sessionId: string): PositionLedger {
  return { schemaVersion: 2, sessionId, captures: [], systemicCenterFailures: 0 }
}

export function captureKey(context: MeasurementContext): string {
  return [
    context.phase,
    context.positionId,
    context.positionIndex,
    context.positionCount,
    context.repairChannel,
    context.attemptIndex,
  ].join(':')
}

function failureClass(status: MeasurementAnalysis['status']): CaptureFailureClass | null {
  if (status === 'sync_marker_not_found' || status === 'clock_drift_unreliable' || status === 'capture_too_short') {
    return 'systemic'
  }
  if (status === 'signal_too_low' || status === 'capture_clipped' || status === 'direct_arrival_low_confidence' || status === 'impulse_not_found' || status === 'response_not_generated') return 'local'
  return null
}

function qualityFor(analysis: MeasurementAnalysis): CaptureQuality {
  return {
    failureReason: analysis.diagnostics.failureReason,
    failureClass: failureClass(analysis.status),
    snrDb: analysis.diagnostics.snrEstimateDb,
    markerConfidence: analysis.diagnostics.detectionConfidence,
    endingMarkerConfidence: analysis.diagnostics.endingMarkerConfidence,
    clipped: analysis.diagnostics.clipped,
    clockDriftPpm: analysis.diagnostics.clockDriftPpm,
  }
}

function accepted(analysis: MeasurementAnalysis): boolean {
  return analysis.status === 'ok' && analysis.correctedPoints.length > 1
}

function commitChannel(
  captureKeyValue: string,
  channel: CaptureChannel,
  analysis: MeasurementAnalysis,
  alreadyAccepted: boolean,
): LedgerSubmeasurement {
  const quality = qualityFor(analysis)
  if (alreadyAccepted) return { kind: 'ignored', captureKey: captureKeyValue, channel, reason: 'sibling-already-accepted', quality }
  return accepted(analysis)
    ? { kind: 'accepted', captureKey: captureKeyValue, channel, analysis, quality }
    : { kind: 'rejected', captureKey: captureKeyValue, channel, analysis, quality }
}

function priorAcceptedChannel(
  ledger: PositionLedger,
  positionId: MeasurementContext['positionId'],
  channel: CaptureChannel,
): boolean {
  return ledger.captures.some((capture) =>
    capture.context.positionId === positionId
    && capture[channel].kind === 'accepted',
  )
}

/** Append one composite result. Existing accepted channels are never replaced. */
export function appendCompositeCapture(
  ledger: PositionLedger,
  commit: CompositeCaptureCommit,
): PositionLedger {
  const key = captureKey(commit.context)
  if (ledger.captures.some((capture) => capture.captureKey === key)) return ledger
  const leftAlreadyAccepted = priorAcceptedChannel(ledger, commit.context.positionId, 'left')
  const rightAlreadyAccepted = priorAcceptedChannel(ledger, commit.context.positionId, 'right')
  const capture: LedgerCapture = {
    captureKey: key,
    context: commit.context,
    left: commitChannel(key, 'left', commit.analysis.left, leftAlreadyAccepted),
    right: commitChannel(key, 'right', commit.analysis.right, rightAlreadyAccepted),
    captureMetadata: commit.captureMetadata,
    acceptedAt: commit.acceptedAt,
  }
  const systemicCenterFailure = commit.context.phase === 'measurement'
    && commit.context.positionId === 'center'
    && (failureClass(commit.analysis.left.status) === 'systemic'
      || failureClass(commit.analysis.right.status) === 'systemic'
      || commit.analysis.left.status === 'direct_arrival_low_confidence'
      || commit.analysis.right.status === 'direct_arrival_low_confidence'
      || commit.analysis.left.status === 'impulse_not_found'
      || commit.analysis.right.status === 'impulse_not_found'
      || commit.analysis.left.status === 'response_not_generated'
      || commit.analysis.right.status === 'response_not_generated')
  return {
    ...ledger,
    captures: [...ledger.captures, capture],
    systemicCenterFailures: ledger.systemicCenterFailures + (systemicCenterFailure ? 1 : 0),
  }
}

export function acceptedChannel(
  ledger: PositionLedger,
  positionId: MeasurementContext['positionId'],
  channel: CaptureChannel,
): LedgerSubmeasurement | null {
  for (const capture of ledger.captures) {
    if (capture.context.positionId !== positionId) continue
    const outcome = capture[channel]
    if (outcome.kind === 'accepted') return outcome
  }
  return null
}

function channelProjection(
  outcome: LedgerSubmeasurement | null,
): ChannelMeasurement {
  if (!outcome || outcome.kind === 'ignored') return { kind: 'pending' }
  if (outcome.kind === 'accepted') {
    return {
      kind: 'accepted',
      response: outcome.analysis.correctedPoints,
      analysis: outcome.analysis,
      quality: outcome.quality,
      acceptedAt: 0,
    }
  }
  return { kind: 'rejected', analysis: outcome.analysis, quality: outcome.quality }
}

function latestRejected(
  ledger: PositionLedger,
  positionId: MeasurementContext['positionId'],
  channel: CaptureChannel,
): LedgerSubmeasurement | null {
  for (let index = ledger.captures.length - 1; index >= 0; index--) {
    const capture = ledger.captures[index]
    if (capture?.context.positionId !== positionId) continue
    const outcome = capture[channel]
    if (outcome.kind === 'rejected') return outcome
  }
  return null
}

function latestMeasurementCapture(
  ledger: PositionLedger,
  positionId: MeasurementContext['positionId'],
): LedgerCapture | null {
  for (let index = ledger.captures.length - 1; index >= 0; index--) {
    const capture = ledger.captures[index]
    if (capture?.context.phase === 'measurement' && capture.context.positionId === positionId) return capture
  }
  return null
}

/** Project the append-only evidence into the bounded planner view. */
export function projectPhysicalPositionLedger(ledger: PositionLedger): PhysicalPositionLedger {
  const positionIds = [...new Set(ledger.captures
    .filter((capture) => capture.context.phase === 'measurement')
    .map((capture) => capture.context.positionId))]
  const positions: PositionMeasurement[] = positionIds.flatMap((positionId) => {
    const capture = latestMeasurementCapture(ledger, positionId)
    if (!capture) return []
    const spec = DEFAULT_POSITION_SPECS.find((candidate) => candidate.id === positionId) ?? DEFAULT_POSITION_SPECS[0]
    const left = acceptedChannel(ledger, positionId, 'left')
    const right = acceptedChannel(ledger, positionId, 'right')
    const attemptIndex = ledger.captures
      .filter((entry) => entry.context.phase === 'measurement' && entry.context.positionId === positionId)
      .reduce((maximum, entry) => Math.max(maximum, entry.context.attemptIndex), 0)
    const pending = createPendingPosition(
      spec,
      capture.context.positionIndex,
      capture.context.positionCount,
      capture.captureKey,
      attemptIndex,
    )
    const projected = {
      ...pending,
      left: channelProjection(left ?? latestRejected(ledger, positionId, 'left')),
      right: channelProjection(right ?? latestRejected(ledger, positionId, 'right')),
      captureMetadata: capture.captureMetadata,
      acceptedAt: left?.kind === 'accepted' && right?.kind === 'accepted' ? capture.acceptedAt : null,
    }
    return [projected]
  })
  return {
    schemaVersion: 1,
    sessionId: ledger.sessionId,
    positions,
    systemicCenterFailures: ledger.systemicCenterFailures,
  }
}

export function projectAcceptedRecords(
  ledger: PositionLedger,
  phase: MeasurementContext['phase'] = 'measurement',
): MeasurementRecord[] {
  return ledger.captures
    .filter((capture) => capture.context.phase === phase)
    .flatMap((capture) => (['left', 'right'] as const).flatMap((channel) => {
      const outcome = capture[channel]
      return outcome.kind === 'accepted'
        ? [{ context: capture.context, channel, analysis: outcome.analysis }]
        : []
    }))
}

export function completeAcceptedPositionCount(ledger: PositionLedger): number {
  return projectPhysicalPositionLedger(ledger).positions.filter((position) =>
    channelMeasurement(position, 'left').kind === 'accepted'
    && channelMeasurement(position, 'right').kind === 'accepted',
  ).length
}

export const acceptedPositionCount = completeAcceptedPositionCount
