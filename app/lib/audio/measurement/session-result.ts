import type {
  MeasurementCaptureMetadata,
  MeasurementContext,
  MeasurementDiagnosticsValues,
} from '../../../../shared/types/protocol'
import {
  reconcileFailedTakeDiagnostics,
  type FailedTakeDiagnostic,
} from './failure-diagnostics'
import type { MeasurementRecord } from './aggregation'
import { hasNewAcceptedEvidence } from './response-graph'
import {
  appendCompositeCapture,
  completeAcceptedPositionCount,
  projectAcceptedRecords,
  type PositionLedger,
} from './position-ledger'
import type { CompositeMeasurementAnalysis, MeasurementAnalysis } from './response'
import { validationRepairChannel } from './validation-retry'

const ANALYSIS_CHANNELS = ['left', 'right'] as const
type AnalysisChannel = (typeof ANALYSIS_CHANNELS)[number]

export type CalibrationSessionMode = 'measurement' | 'validation' | 'probe'

interface SharedMeasurementSessionResultInput {
  context: MeasurementContext
  result: CompositeMeasurementAnalysis
  diagnostics: Readonly<Record<AnalysisChannel, MeasurementDiagnosticsValues>>
  failedTakeDiagnostics: readonly FailedTakeDiagnostic[]
}

type MeasurementInput = SharedMeasurementSessionResultInput & {
  mode: 'measurement'
  ledger: PositionLedger
  captureMetadata: MeasurementCaptureMetadata | null
  acceptedAt: number
}

type ValidationInput = SharedMeasurementSessionResultInput & {
  mode: 'validation'
  validationRecords: readonly MeasurementRecord[]
}

type ProbeInput = SharedMeasurementSessionResultInput & {
  mode: 'probe'
  records: readonly MeasurementRecord[]
}

export type MeasurementSessionResultInput = MeasurementInput | ValidationInput | ProbeInput

interface MeasurementSessionResultBase {
  failedTakeDiagnostics: FailedTakeDiagnostic[]
}

type ValidationNext =
  | { kind: 'advance' }
  | { kind: 'retry'; context: MeasurementContext }
  | { kind: 'blocked' }
  | { kind: 'failed'; channel: AnalysisChannel }

type ProbeNext =
  | { kind: 'advance' }
  | { kind: 'retry'; context: MeasurementContext }

export type MeasurementSessionResult =
  | (MeasurementSessionResultBase & {
      mode: 'measurement'
      ledger: PositionLedger
      records: MeasurementRecord[]
      analysis: MeasurementAnalysis
      acceptedEvidenceChanged: boolean
      acceptedPositionCount: number
      failedMeasurementAttemptCount: number
    })
  | (MeasurementSessionResultBase & {
      mode: 'validation'
      validationRecords: MeasurementRecord[]
      analysis: MeasurementAnalysis
      failedChannels: AnalysisChannel[]
      next: ValidationNext
    })
  | (MeasurementSessionResultBase & {
      mode: 'probe'
      records: MeasurementRecord[]
      next: ProbeNext
    })

function requiredChannels(context: MeasurementContext): readonly [AnalysisChannel, ...AnalysisChannel[]] {
  if (context.repairChannel === 'left' || context.repairChannel === 'right') return [context.repairChannel]
  return ANALYSIS_CHANNELS
}

function acceptedRecords(
  context: MeasurementContext,
  result: CompositeMeasurementAnalysis,
): MeasurementRecord[] {
  if (context.captureKind !== 'position-composite') return []
  return ANALYSIS_CHANNELS.flatMap((channel) => {
    const analysis = result[channel]
    return analysis.status === 'ok' && analysis.correctedPoints.length > 1
      ? [{ context, channel, analysis }]
      : []
  })
}

function updatedFailedTakeDiagnostics(
  input: SharedMeasurementSessionResultInput,
  channels: readonly AnalysisChannel[],
): FailedTakeDiagnostic[] {
  return reconcileFailedTakeDiagnostics(
    input.failedTakeDiagnostics,
    input.context,
    channels.map((channel) => ({
      channel,
      failed: input.result[channel].status !== 'ok',
      diagnostics: input.diagnostics[channel],
    })),
  )
}

function nextValidationStep(
  context: MeasurementContext,
  failedChannels: AnalysisChannel[],
): ValidationNext {
  if (failedChannels.length === 0) return { kind: 'advance' }
  if (context.attemptIndex + 1 >= context.attemptCount) {
    const failedChannel = failedChannels[0]
    return failedChannel ? { kind: 'failed', channel: failedChannel } : { kind: 'blocked' }
  }
  const failedChannel = validationRepairChannel(failedChannels)
  return failedChannel
    ? {
        kind: 'retry',
        context: {
          ...context,
          repairChannel: failedChannel,
          attemptIndex: context.attemptIndex + 1,
        },
      }
    : { kind: 'blocked' }
}

function applyValidationResult(
  input: ValidationInput,
  channels: readonly [AnalysisChannel, ...AnalysisChannel[]],
  failedTakeDiagnostics: FailedTakeDiagnostic[],
): Extract<MeasurementSessionResult, { mode: 'validation' }> {
  const nextRecords = acceptedRecords(input.context, input.result)
    .filter((record) => channels.includes(record.channel))
  const channelsToReplace = new Set(channels)
  const validationRecords = [
    ...input.validationRecords.filter((record) =>
      record.context.positionId !== input.context.positionId || !channelsToReplace.has(record.channel)),
    ...nextRecords,
  ]
  const analysisChannel = channels.find((channel) => input.result[channel].status === 'ok') ?? channels[0]
  const failedChannels = channels.filter((channel) => input.result[channel].status !== 'ok')
  return {
    mode: 'validation',
    validationRecords,
    analysis: input.result[analysisChannel],
    failedChannels,
    next: nextValidationStep(input.context, failedChannels),
    failedTakeDiagnostics,
  }
}

function applyProbeResult(
  input: ProbeInput,
  failedTakeDiagnostics: FailedTakeDiagnostic[],
): Extract<MeasurementSessionResult, { mode: 'probe' }> {
  const next: ProbeNext = input.result.status !== 'ok' && input.context.attemptIndex + 1 < input.context.attemptCount
    ? {
        kind: 'retry',
        context: { ...input.context, attemptIndex: input.context.attemptIndex + 1 },
      }
    : { kind: 'advance' }
  return {
    mode: 'probe',
    records: [...input.records, ...acceptedRecords(input.context, input.result)],
    next,
    failedTakeDiagnostics,
  }
}

function acceptedEvidenceKey(ledger: PositionLedger): string {
  return ledger.captures
    .flatMap((capture) => [capture.left, capture.right])
    .filter((submeasurement) => submeasurement.kind === 'accepted')
    .map((submeasurement) => `${submeasurement.captureKey}:${submeasurement.channel}`)
    .sort()
    .join('|')
}

function applyMeasurementResult(
  input: MeasurementInput,
  failedTakeDiagnostics: FailedTakeDiagnostic[],
): Extract<MeasurementSessionResult, { mode: 'measurement' }> {
  const acceptedEvidenceBefore = acceptedEvidenceKey(input.ledger)
  const ledger = appendCompositeCapture(input.ledger, {
    context: input.context,
    analysis: input.result,
    captureMetadata: input.captureMetadata,
    acceptedAt: input.acceptedAt,
  })
  const acceptedEvidenceAfter = acceptedEvidenceKey(ledger)
  return {
    mode: 'measurement',
    ledger,
    records: projectAcceptedRecords(ledger),
    analysis: input.result.left.status === 'ok' ? input.result.left : input.result.right,
    acceptedEvidenceChanged: hasNewAcceptedEvidence(acceptedEvidenceBefore, acceptedEvidenceAfter),
    acceptedPositionCount: completeAcceptedPositionCount(ledger),
    failedMeasurementAttemptCount: countFailedMeasurementAttempts(ledger),
    failedTakeDiagnostics,
  }
}

export function countFailedMeasurementAttempts(ledger: PositionLedger | null): number {
  return ledger?.captures.filter((capture) => {
    if (capture.context.phase !== 'measurement') return false
    return requiredChannels(capture.context).some((channel) => capture[channel].kind === 'rejected')
  }).length ?? 0
}

export function applyMeasurementSessionResult(input: MeasurementSessionResultInput): MeasurementSessionResult {
  const channels = requiredChannels(input.context)
  const failedTakeDiagnostics = updatedFailedTakeDiagnostics(input, channels)
  switch (input.mode) {
    case 'measurement':
      return applyMeasurementResult(input, failedTakeDiagnostics)
    case 'validation':
      return applyValidationResult(input, channels, failedTakeDiagnostics)
    case 'probe':
      return applyProbeResult(input, failedTakeDiagnostics)
  }
}
