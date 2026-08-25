import { computed, onScopeDispose, readonly, ref, shallowRef } from 'vue'
import type {
  CalibrationProgressStage,
  CalibrationErrorCode,
  Envelope,
  MeasurementContext,
  MeasurementDiagnosticsValues,
  MeasurementCaptureMetadata,
  MeasurementResponsePayload,
  MeasurementSweep,
} from '#shared/types/protocol'
import {
  CALIBRATION_ERROR_CODES,
  isCalibrationSessionPositionContinuedPayload,
  isMeasurementContext,
  isMeasurementReadyPayload,
} from '#shared/types/protocol'
import { openMicrophone, closeMicrophone, type MicrophoneCapture } from '../lib/audio/capture/microphone'
import { createPcmRecorder, type CaptureSignalDiagnostics, type PcmRecorder } from '../lib/audio/capture/pcm-recorder'
import { analyzeInWorker } from '../lib/audio/measurement/worker-client'
import {
  aggregateResponse,
  allRepeatabilityPassed,
  type AggregateResponse,
  type MeasurementRecord,
  type RepeatabilitySummary,
} from '../lib/audio/measurement/aggregation'
import type { MeasurementAnalysis, ResponsePoint } from '../lib/audio/measurement/response'
import {
  createMeasurementPlan,
  createMeasurementPlanForGroups,
  createProbeMeasurementPlan,
  positionForContext,
  requiresRemoteContinue,
  type ProbePlanKind,
} from '../lib/audio/measurement/plan'
import {
  appendCompositeCapture,
  acceptedPositionCount,
  createPositionLedger,
  projectAcceptedRecords,
  projectPhysicalPositionLedger,
  type PositionLedger,
} from '../lib/audio/measurement/position-ledger'
import { decideNextCapture, type ConvergenceAssessment } from '../lib/audio/measurement/adaptive-planner'
import {
  checkCalibrationCheckpointCompatibility,
  clearCalibrationCheckpoint,
  createCalibrationCheckpoint,
  loadCalibrationCheckpoint,
  saveCalibrationCheckpoint,
  type CalibrationCheckpoint,
  type CalibrationCheckpointIdentity,
} from '../lib/audio/measurement/checkpoint'
import { sweepSampleParts } from '../lib/audio/sweep-reference'
import { discoverMicCalibrationProfiles } from '../lib/audio/mics/registry'
import type { MicCalibrationProfile } from '../lib/audio/mics/types'
import {
  isCalibrationOperationCurrent,
  isSameMeasurementContext,
} from '../lib/audio/measurement/session-guard'
import { hasNewAcceptedEvidence } from '../lib/audio/measurement/response-graph'
import {
  createCalibrationAbortCommand,
  evaluateCalibrationAbortRecovery,
  formatCalibrationAbortRecoveryFailure,
  isAbortRecoveryActive,
  mergeValidationAbortDetails,
  shouldContinueCalibrationAbortRecoveryPoll,
  type CalibrationAbortDetails,
  type CalibrationAbortRecovery,
  type CalibrationAbortRecoveryFailure,
  type CalibrationAbortRecoveryObservation,
  type CalibrationAbortRecoverySnapshot,
} from '../lib/audio/correction/calibration-recovery'

type Connection = {
  send: (type: string, payload?: unknown) => string
  onMessage: (handler: (env: Envelope) => void) => () => void
  isDeviceOnline: () => boolean
}

interface CalibrationSessionOptions {
  getDeviceIdentity?: () => { id: string; appVersion: string } | null
}

const ABORT_RECOVERY_POLL_INTERVAL_MS = 400
const CAPTURE_TAIL_AFTER_PLAYBACK_MS = 450
const MAX_MEDIAN_CORRECTION_CHANGE_DB = 1.5
const MAX_P95_CORRECTION_CHANGE_DB = 3

export type CalibrationStage =
  | 'idle'
  | 'requesting-microphone'
  | 'preparing'
  | 'loudness'
  | 'position-pause'
  | 'recording'
  | 'analyzing'
  | 'ending'
  | 'complete'
  | 'error'

export const CALIBRATION_ACTIVE_STAGES: readonly CalibrationStage[] = [
  'requesting-microphone',
  'preparing',
  'loudness',
  'position-pause',
  'recording',
  'analyzing',
  'ending',
]

export function isCalibrationActiveStage(stage: CalibrationStage): boolean {
  return CALIBRATION_ACTIVE_STAGES.includes(stage)
}

function newSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return `cal_${random ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`}`
}

function analysisErrorCode(status: MeasurementAnalysis['status']): CalibrationErrorCode {
  if (status === 'capture_clipped') return 'capture_clipped'
  if (status === 'sweep_not_found') return 'sweep_not_found'
  if (status === 'sync_marker_not_found') return 'sync_marker_not_found'
  if (status === 'clock_drift_unreliable') return 'clock_drift_unreliable'
  if (status === 'capture_too_short') return 'capture_too_short'
  return 'signal_too_low'
}

function errorCode(value: unknown): CalibrationErrorCode {
  for (const code of CALIBRATION_ERROR_CODES) {
    if (value === code) return code
  }
  return 'invalid_session'
}

function isUserCancellationCode(code: CalibrationErrorCode): boolean {
  return code === 'calibration_aborted' || code === 'calibration_ui_closed'
}

export function useCalibrationSession(connection: Connection, options: CalibrationSessionOptions = {}) {
  const stage = ref<CalibrationStage>('idle')
  const message = ref('')
  const analysis = shallowRef<MeasurementAnalysis | null>(null)
  const validationAnalysis = shallowRef<MeasurementAnalysis | null>(null)
  const records = shallowRef<MeasurementRecord[]>([])
  const validationRecords = shallowRef<MeasurementRecord[]>([])
  const aggregateLeft = shallowRef<AggregateResponse | null>(null)
  const aggregateRight = shallowRef<AggregateResponse | null>(null)
  const aggregateBoth = shallowRef<AggregateResponse | null>(null)
  const validationAggregateLeft = shallowRef<AggregateResponse | null>(null)
  const validationAggregateRight = shallowRef<AggregateResponse | null>(null)
  const captureDiagnostics = shallowRef<CaptureSignalDiagnostics | null>(null)
  const failedTakeDiagnostics = shallowRef<Array<{ context: MeasurementContext; diagnostics: MeasurementDiagnosticsValues }>>([])
  const profiles = shallowRef<MicCalibrationProfile[]>([])
  const selectedProfileId = ref('')
  const profileError = ref('')
  const captureInfo = shallowRef<{
    settings: MicrophoneCapture['settings']
    capabilities: MicrophoneCapture['capabilities']
  } | null>(null)
  const captureMetadata = shallowRef<MeasurementCaptureMetadata | null>(null)
  const progress = ref({ current: 0, total: 0 })
  const estimatedRemainingSeconds = ref<number | null>(null)
  const validationActive = ref(false)
  const validationFailed = ref(false)
  const validationCandidateId = ref<string | null>(null)
  const completedMeasurementId = ref<string | null>(null)
  const abortRecovery = shallowRef<CalibrationAbortRecovery>({ state: 'idle' })
  const resumeAvailable = ref(false)
  const resumePositionCount = ref(0)
  const resumeMessage = ref('')

  let disposed = false
  let sessionId: string | null = null
  let sweep: MeasurementSweep | null = null
  let capture: MicrophoneCapture | null = null
  let recorder: PcmRecorder | null = null
  let profile: MicCalibrationProfile | null = null
  let profileLoadPromise: Promise<MicCalibrationProfile[]> | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  let positionKeepAlive: ReturnType<typeof setInterval> | null = null
  let sessionKeepAlive: ReturnType<typeof setInterval> | null = null
  let abortRecoveryPollTimer: ReturnType<typeof setTimeout> | null = null
  let abortRecoveryPollAttempts = 0
  let sessionGeneration = 0
  let plan: MeasurementContext[] = []
  let planIndex = 0
  let positionLedger: PositionLedger | null = null
  let sessionMode: 'measurement' | 'validation' | 'probe' = 'measurement'
  let probePlanKind: ProbePlanKind | null = null
  const activeContext = shallowRef<MeasurementContext | null>(null)
  let preparedContext: MeasurementContext | null = null
  let takeStartInFlightGeneration: number | null = null
  let loudnessRequested = false
  let loudnessComplete = false
  let validationConfirmationUsed = false
  let checkpointWriteChain: Promise<void> = Promise.resolve()
  let loadedResumeCheckpoint: CalibrationCheckpoint | null = null
  let previousConvergencePoints: readonly ResponsePoint[] | null = null

  const repeatabilityPassed = computed(() =>
    allRepeatabilityPassed(aggregateLeft.value) && allRepeatabilityPassed(aggregateRight.value))
  const repeatabilitySummaries = computed<RepeatabilitySummary[]>(() => [
    ...(aggregateLeft.value?.repeatability ?? []),
    ...(aggregateRight.value?.repeatability ?? []),
  ])
  const failedRepeatabilityGroups = computed(() =>
    repeatabilitySummaries.value.filter((summary) => !summary.passed))
  const probeRepeatabilitySummaries = computed<RepeatabilitySummary[]>(() =>
    aggregateBoth.value?.repeatability ?? [])
  const probeRepeatabilityPassed = computed(() => allRepeatabilityPassed(aggregateBoth.value))
  const probeFailedRepeatabilityGroups = computed(() =>
    probeRepeatabilitySummaries.value.filter((summary) => !summary.passed))
  const currentPosition = computed(() => activeContext.value ? positionForContext(activeContext.value) : null)
  const currentChannel = computed(() => {
    const channel = activeContext.value?.repairChannel ?? activeContext.value?.channel
    return channel === 'left' || channel === 'right' || channel === 'both' ? channel : null
  })
  const currentInstruction = computed(() => {
    const context = activeContext.value
    if (!context) return null
    if (sessionMode === 'probe' && context.channel === 'both') {
      if (context.positionId === 'left') return 'Place the single microphone at the fixed left-speaker position and keep its orientation unchanged.'
      if (context.positionId === 'right') return 'Move the same microphone to the fixed right-speaker position and keep its orientation unchanged.'
      return 'Place the single microphone at the fixed center listening position and keep its orientation unchanged.'
    }
    return positionForContext(context).instruction
  })

  async function loadProfiles(): Promise<MicCalibrationProfile[]> {
    if (profiles.value.length > 0) return profiles.value
    if (profileLoadPromise) return profileLoadPromise
    profileLoadPromise = discoverMicCalibrationProfiles()
      .then((loadedProfiles) => {
        profiles.value = loadedProfiles
        if (!loadedProfiles.some((candidate) => candidate.id === selectedProfileId.value)) {
          selectedProfileId.value = loadedProfiles[0]?.id ?? ''
        }
        profileError.value = ''
        return loadedProfiles
      })
      .catch((error: unknown) => {
        profileError.value = error instanceof Error ? error.message : 'Could not load microphone profiles.'
        throw error
      })
      .finally(() => {
        profileLoadPromise = null
      })
    return profileLoadPromise
  }

  function clearTimeoutTimer() {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer)
    timeoutTimer = null
  }

  function armTimeout() {
    clearTimeoutTimer()
    const operationGeneration = sessionGeneration
    const operationSessionId = sessionId
    timeoutTimer = setTimeout(() => {
      if (!isCurrentOperation(operationGeneration, operationSessionId)) return
      void fail('measurement_timeout', 'The TV did not finish this measurement in time.')
    }, 70_000)
  }

  function clearPositionKeepAlive() {
    if (positionKeepAlive !== null) clearInterval(positionKeepAlive)
    positionKeepAlive = null
  }

  function clearSessionKeepAlive() {
    if (sessionKeepAlive !== null) clearInterval(sessionKeepAlive)
    sessionKeepAlive = null
  }

  function clearAbortRecoveryPolling() {
    if (abortRecoveryPollTimer !== null) clearTimeout(abortRecoveryPollTimer)
    abortRecoveryPollTimer = null
    abortRecoveryPollAttempts = 0
  }

  function invalidateSessionGeneration(): number {
    sessionGeneration += 1
    return sessionGeneration
  }

  function isCurrentOperation(operationGeneration: number, operationSessionId: string | null): boolean {
    return !disposed && isCalibrationOperationCurrent(
      operationGeneration,
      sessionGeneration,
      operationSessionId,
      sessionId,
    )
  }

  function clearValidationSessionState() {
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    clearAbortRecoveryPolling()
    void closeCapture()
    sessionId = null
    sweep = null
    profile = null
    activeContext.value = null
    preparedContext = null
    validationActive.value = false
    estimatedRemainingSeconds.value = null
  }

  function markAbortRecoveryFailed(failure: CalibrationAbortRecoveryFailure): CalibrationAbortRecoveryObservation {
    const current = abortRecovery.value
    if (current.state === 'idle' || current.state === 'failed') return { kind: 'ignored' }
    const messageText = formatCalibrationAbortRecoveryFailure(failure)
    const failed = { state: 'failed' as const, details: current.details, failure }
    abortRecovery.value = failed
    clearValidationSessionState()
    stage.value = 'error'
    message.value = messageText
    return { kind: 'failed', details: failed.details, failure }
  }

  function scheduleAbortRecoveryPoll(resetAttempts = false) {
    if (resetAttempts) {
      clearAbortRecoveryPolling()
    }
    if (disposed || abortRecoveryPollTimer !== null || !isAbortRecoveryActive(abortRecovery.value.state)) return
    abortRecoveryPollTimer = setTimeout(() => {
      abortRecoveryPollTimer = null
      if (disposed || !isAbortRecoveryActive(abortRecovery.value.state)) return
      if (!shouldContinueCalibrationAbortRecoveryPoll(abortRecoveryPollAttempts)) {
        markAbortRecoveryFailed({ kind: 'timeout' })
        return
      }
      abortRecoveryPollAttempts += 1
      if (connection.isDeviceOnline()) connection.send('state.get')
      scheduleAbortRecoveryPoll()
    }, ABORT_RECOVERY_POLL_INTERVAL_MS)
  }

  function observeAbortRecoverySnapshot(snapshot: CalibrationAbortRecoverySnapshot): CalibrationAbortRecoveryObservation {
    const current = abortRecovery.value
    const observation = evaluateCalibrationAbortRecovery(current, snapshot)
    if (observation.kind === 'failed') return markAbortRecoveryFailed(observation.failure)
    if (observation.kind !== 'completed') return observation
    clearValidationSessionState()
    abortRecovery.value = { state: 'idle' }
    stage.value = 'error'
    message.value = observation.details.message
    return observation
  }

  async function closeCapture() {
    const currentRecorder = recorder
    const currentCapture = capture
    recorder = null
    capture = null
    if (currentRecorder) await currentRecorder.dispose()
    if (currentCapture) closeMicrophone(currentCapture)
  }

  function currentCheckpointIdentity(): CalibrationCheckpointIdentity | null {
    const device = options.getDeviceIdentity?.() ?? null
    const currentProfile = profile ?? profiles.value.find((candidate) => candidate.id === selectedProfileId.value) ?? null
    if (!device || !currentProfile) return null
    return {
      deviceId: device.id,
      appVersion: device.appVersion,
      profileId: currentProfile.id,
      profileSourceDate: currentProfile.sourceDate,
      capturePathStatus: currentProfile.capturePathStatus,
      sampleRate: captureMetadata.value?.sampleRate ?? null,
    }
  }

  async function refreshResumeCheckpoint(): Promise<void> {
    const identity = currentCheckpointIdentity()
    if (!identity) {
      resumeAvailable.value = false
      resumePositionCount.value = 0
      return
    }
    try {
      const checkpoint = await loadCalibrationCheckpoint(identity.deviceId)
      loadedResumeCheckpoint = checkpoint
      if (!checkpoint) {
        resumeAvailable.value = false
        resumePositionCount.value = 0
        resumeMessage.value = ''
        return
      }
      const compatibility = checkCalibrationCheckpointCompatibility(checkpoint, identity)
      if (!compatibility.compatible) {
        resumeAvailable.value = false
        resumePositionCount.value = 0
        resumeMessage.value = 'A saved calibration cannot be resumed because the TV or microphone setup has changed.'
        return
      }
      resumeAvailable.value = true
      resumePositionCount.value = acceptedPositionCount(checkpoint.ledger)
      resumeMessage.value = ''
    } catch {
      loadedResumeCheckpoint = null
      resumeAvailable.value = false
      resumePositionCount.value = 0
    }
  }

  function persistPositionCheckpoint(): void {
    const ledger = positionLedger
    const identity = currentCheckpointIdentity()
    if (!ledger || !identity || !sessionId || !profile) return
    const checkpoint = createCalibrationCheckpoint({
      sessionId,
      device: { id: identity.deviceId, appVersion: identity.appVersion },
      microphone: {
        profileId: profile.id,
        sourceDate: profile.sourceDate,
        capturePathStatus: profile.capturePathStatus,
        sampleRate: identity.sampleRate,
      },
      captureMetadata: captureMetadata.value,
      ledger,
      validationStarted: false,
    })
    checkpointWriteChain = checkpointWriteChain
      .then(() => saveCalibrationCheckpoint(checkpoint))
      .catch(() => undefined)
    loadedResumeCheckpoint = checkpoint
    resumeAvailable.value = true
    resumePositionCount.value = acceptedPositionCount(ledger)
  }

  function clearPersistedCheckpoint(): void {
    const device = options.getDeviceIdentity?.() ?? null
    if (!device) return
    checkpointWriteChain = checkpointWriteChain
      .then(() => clearCalibrationCheckpoint(device.id))
      .catch(() => undefined)
    loadedResumeCheckpoint = null
    resumeAvailable.value = false
    resumePositionCount.value = 0
    resumeMessage.value = ''
  }

  function rebuildAggregates() {
    const current = records.value
    aggregateLeft.value = aggregateResponse(current, 'left')
    aggregateRight.value = aggregateResponse(current, 'right')
    aggregateBoth.value = aggregateResponse(current, 'both')
  }

  function rebuildValidationAggregates() {
    validationAggregateLeft.value = aggregateResponse(validationRecords.value, 'left')
    validationAggregateRight.value = aggregateResponse(validationRecords.value, 'right')
  }

  function assessConvergence(): ConvergenceAssessment | null {
    if (!positionLedger || sessionMode !== 'measurement') return null
    const physical = projectPhysicalPositionLedger(positionLedger)
    if (physical.positions.filter((position) => position.left.kind === 'accepted' && position.right.kind === 'accepted').length < 3) {
      return null
    }
    const spread = aggregateBoth.value?.spreadDb ?? []
    const currentPoints = aggregateBoth.value?.points ?? []
    if (spread.length === 0) {
      return {
        sufficient: false,
        medianCorrectionChangeDb: null,
        p95CorrectionChangeDb: null,
        medianSpatialSpreadDb: null,
        lowFrequencySpreadDb: null,
        highConfidenceBandFraction: 0,
      }
    }
    const sorted = spread.map((point) => point.magnitudeDb).sort((left, right) => left - right)
    const percentile = (fraction: number): number | null => {
      const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
      return sorted[index] ?? null
    }
    const lowFrequency = spread.filter((point) => point.frequencyHz <= 200).map((point) => point.magnitudeDb)
    const lowSorted = lowFrequency.sort((left, right) => left - right)
    const lowMedian = lowSorted.length === 0 ? null : lowSorted[Math.floor(lowSorted.length / 2)] ?? null
    const medianSpread = percentile(0.5)
    const p95Spread = percentile(0.95)
    const correctionChanges = previousConvergencePoints === null
      ? []
      : currentPoints.flatMap((point) => {
        const previous = previousConvergencePoints?.find((candidate) => Math.abs(candidate.frequencyHz - point.frequencyHz) < 0.001)
        return previous ? [Math.abs(point.magnitudeDb - previous.magnitudeDb)] : []
      }).sort((left, right) => left - right)
    const correctionPercentile = (fraction: number): number | null => {
      if (correctionChanges.length === 0) return null
      const index = Math.min(correctionChanges.length - 1, Math.max(0, Math.round((correctionChanges.length - 1) * fraction)))
      return correctionChanges[index] ?? null
    }
    const medianCorrectionChangeDb = correctionPercentile(0.5)
    const p95CorrectionChangeDb = correctionPercentile(0.95)
    const highConfidenceBandFraction = spread.filter((point) => point.magnitudeDb <= 3).length / spread.length
    const correctionStable = medianCorrectionChangeDb === null || (
      medianCorrectionChangeDb <= MAX_MEDIAN_CORRECTION_CHANGE_DB
      && (p95CorrectionChangeDb ?? Number.POSITIVE_INFINITY) <= MAX_P95_CORRECTION_CHANGE_DB
    )
    return {
      sufficient: medianSpread !== null
        && p95Spread !== null
        && (lowMedian === null || lowMedian <= 4)
        && medianSpread <= 3
        && p95Spread <= 6
        && correctionStable
        && highConfidenceBandFraction >= 0.5,
      medianCorrectionChangeDb,
      p95CorrectionChangeDb,
      medianSpatialSpreadDb: medianSpread,
      lowFrequencySpreadDb: lowMedian,
      highConfidenceBandFraction,
    }
  }

  function contextForAdaptiveDecision(decision: Extract<ReturnType<typeof decideNextCapture>, { kind: 'capture' }>): MeasurementContext {
    return {
      positionId: decision.position.id,
      positionIndex: decision.positionIndex,
      positionCount: decision.requestedPositionCount,
      channel: 'both',
      captureKind: 'position-composite',
      repairChannel: decision.repairChannel,
      attemptIndex: decision.attemptIndex,
      attemptCount: 2,
      phase: 'measurement',
    }
  }

  function scheduleAdaptiveNext(): void {
    if (!positionLedger) return
    const decision = decideNextCapture(projectPhysicalPositionLedger(positionLedger), assessConvergence())
    if (decision.kind === 'finish') {
      if (decision.outcome === 'insufficient') {
        void fail(
          'measurement_unstable',
          'Calibration could not collect the minimum three high-quality listening positions. No correction was generated; you can retry the affected setup or resume the saved readings.',
        )
        return
      }
      void finishMeasurement()
      return
    }
    if (decision.kind === 'abort') {
      void fail('sync_marker_not_found', decision.message)
      return
    }
    const next = contextForAdaptiveDecision(decision)
    plan = [next]
    planIndex = 0
    progress.value = { current: progress.value.current, total: next.positionCount }
    activeContext.value = next
    if (requiresRemoteContinue(next)) waitForPosition(next)
    else sendPrepare(next)
  }

  function responseChannel(aggregate: AggregateResponse | null): MeasurementResponsePayload['left'] {
    if (!aggregate || aggregate.points.length < 2 || aggregate.points.length > 64) return null
    const frequenciesHz = aggregate.points.map((point) => point.frequencyHz)
    const magnitudesDb = aggregate.points.map((point) => point.magnitudeDb)
    if (frequenciesHz.some((frequency, index) => {
      const previousFrequency = index > 0 ? frequenciesHz[index - 1] : undefined
      return !Number.isFinite(frequency) || frequency <= 0 || (previousFrequency !== undefined && frequency <= previousFrequency)
    })) {
      return null
    }
    if (magnitudesDb.some((magnitude) => !Number.isFinite(magnitude))) return null
    return { frequenciesHz, magnitudesDb }
  }

  function sendResponseGraph(current: number, total: number) {
    if (!sessionId || sessionMode !== 'measurement') return
    const left = responseChannel(aggregateLeft.value)
    const right = responseChannel(aggregateRight.value)
    if (!left && !right) return
    connection.send('measurement.response', { sessionId, current, total, left, right })
  }

  function repeatabilityFailureMessage(groups: readonly RepeatabilitySummary[]): string {
    if (groups.length === 0) return ''
    return groups.map((group) => {
      if (group.failureReason === 'capture_rejected') return `${group.positionId} ${group.channel} channel was not usable`
      const medianSpread = group.medianSpreadDb === null ? 'unknown' : `${group.medianSpreadDb.toFixed(1)} dB`
      const maxSpread = group.maxSpreadDb === null ? 'unknown' : `${group.maxSpreadDb.toFixed(1)} dB`
      const withinTwoDb = group.withinTwoDbFraction === null ? 'unknown' : `${Math.round(group.withinTwoDbFraction * 100)}%`
      return `${group.positionId} ${group.channel} channel (median ${medianSpread}, max ${maxSpread}, ${withinTwoDb} within 2 dB)`
    }).join('; ')
  }

  function boundedAbortMessage(text: string): string {
    return text.slice(0, 1_024)
  }

  function beginValidationAbort(code: CalibrationErrorCode, text: string): void {
    const currentSessionId = sessionId
    if (!currentSessionId) return
    const current = abortRecovery.value
    const messageText = boundedAbortMessage(text)
    if (current.state === 'failed') return
    if (current.state !== 'idle') {
      abortRecovery.value = {
        state: current.state,
        details: mergeValidationAbortDetails(current.details, code, messageText),
      }
      return
    }
    const details: CalibrationAbortDetails = {
      sessionId: currentSessionId,
      mode: 'validation',
      candidateId: validationCandidateId.value,
      code,
      message: messageText,
    }
    abortRecovery.value = { state: 'pending', details }
    const abort = createCalibrationAbortCommand(details.sessionId, details.code, details.message)
    connection.send(abort.type, abort.payload)
    connection.send('state.get')
    scheduleAbortRecoveryPoll(true)
  }

  async function fail(code: CalibrationErrorCode, text: string) {
    const currentSessionId = sessionId
    const ownsValidationAbort = sessionMode === 'validation' && currentSessionId !== null
    if (!currentSessionId && stage.value === 'error') return
    if (sessionMode === 'validation') {
      validationFailed.value = code !== 'calibration_aborted'
      if (ownsValidationAbort) beginValidationAbort(code, text)
    }
    const operationGeneration = invalidateSessionGeneration()
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    if (currentSessionId && !ownsValidationAbort && code !== 'calibration_aborted') {
      connection.send('calibrationSession.abort', {
        sessionId: currentSessionId,
        code,
        message: boundedAbortMessage(text),
      })
    }
    if (code === 'calibration_aborted' && !ownsValidationAbort) connection.send('state.get')
    await closeCapture()
    if (disposed || operationGeneration !== sessionGeneration) return
    if (!ownsValidationAbort) sessionId = null
    sweep = null
    profile = null
    activeContext.value = null
    preparedContext = null
    validationActive.value = ownsValidationAbort
    estimatedRemainingSeconds.value = null
    stage.value = 'error'
    message.value = boundedAbortMessage(text)
  }

  function progressStage(value: CalibrationStage): CalibrationProgressStage {
    if (value === 'loudness') return 'loudness'
    if (value === 'recording') return 'recording'
    if (value === 'analyzing') return 'analyzing'
    if (value === 'position-pause') return 'position-pause'
    if (value === 'ending') return 'ending'
    if (sessionMode === 'validation') return 'validation'
    return 'preparing'
  }

  function estimateRemainingSeconds(stageName: CalibrationProgressStage): number | undefined {
    if (stageName === 'loudness' || !sweep) return undefined
    const remainingSweeps = Math.max(0, progress.value.total - progress.value.current)
    const sweepSeconds = sweepSampleParts(sweep).totalSamples / sweep.sampleRate + 2
    const contexts = plan.slice(planIndex)
    let positionPauses = 0
    let previousPosition = activeContext.value?.positionIndex ?? null
    for (const context of contexts) {
      if (previousPosition !== null && context.positionIndex !== previousPosition) positionPauses++
      previousPosition = context.positionIndex
    }
    return Math.ceil(remainingSweeps * sweepSeconds + positionPauses * 15)
  }

  function sendProgress(stageName = progressStage(stage.value), text = 'Follow the instructions on the TV.') {
    if (!sessionId) return
    const estimate = estimateRemainingSeconds(stageName)
    estimatedRemainingSeconds.value = estimate ?? null
    connection.send('calibrationSession.progress', {
      sessionId,
      stage: stageName,
      current: progress.value.current,
      total: progress.value.total,
      ...(estimate === undefined ? {} : { estimatedRemainingSeconds: estimate }),
      message: text,
    })
  }

  function armSessionKeepAlive() {
    clearSessionKeepAlive()
    sessionKeepAlive = setInterval(() => {
      if (sessionId) sendProgress()
    }, 15_000)
  }

  function setPreparingText(_context: MeasurementContext) {
    message.value = 'Follow the instructions on the TV.'
  }

  function sendPrepare(context: MeasurementContext) {
    const operationGeneration = sessionGeneration
    const operationSessionId = sessionId
    if (!isCurrentOperation(operationGeneration, operationSessionId)) return
    preparedContext = null
    stage.value = 'preparing'
    setPreparingText(context)
    armTimeout()
    sendProgress('preparing')
    connection.send('measurement.prepare', {
      sessionId: operationSessionId,
      channel: context.channel,
      context,
    })
  }

  function waitForPosition(context: MeasurementContext) {
    sendPrepare(context)
    stage.value = 'position-pause'
    message.value = 'Follow the instructions on the TV, then continue.'
    sendProgress('position-pause', positionForContext(context).instruction)
    activeContext.value = context
    clearPositionKeepAlive()
    const operationGeneration = sessionGeneration
    const operationSessionId = sessionId
    positionKeepAlive = setInterval(() => {
      if (isCurrentOperation(operationGeneration, operationSessionId) && preparedContext) {
        connection.send('measurement.prepare', {
          sessionId: operationSessionId,
          channel: preparedContext.channel,
          context: preparedContext,
        })
      }
    }, 25_000)
  }

  function advanceAfterCapture(currentContext: MeasurementContext, acceptedEvidenceChanged = false) {
    const operationGeneration = sessionGeneration
    const operationSessionId = sessionId
    if (!isCurrentOperation(operationGeneration, operationSessionId)) return
    planIndex++
    if (sessionMode === 'validation') rebuildValidationAggregates()
    else rebuildAggregates()
    if (sessionMode === 'measurement') {
      if (acceptedEvidenceChanged) sendResponseGraph(progress.value.current, progress.value.total)
      scheduleAdaptiveNext()
      return
    }
    const next = plan[planIndex]
    if (!next) {
      void finishMeasurement()
      return
    }
    if (next.positionIndex !== currentContext.positionIndex) {
      waitForPosition(next)
      return
    }
    sendPrepare(next)
    activeContext.value = next
    message.value = 'Follow the instructions on the TV.'
  }

  async function startTake(context: MeasurementContext, operationGeneration = sessionGeneration) {
    const operationSessionId = sessionId
    if (!isCurrentOperation(operationGeneration, operationSessionId) || !sweep || !recorder) return
    if (takeStartInFlightGeneration === operationGeneration) return
    takeStartInFlightGeneration = operationGeneration
    activeContext.value = context
    preparedContext = context
    try {
      await recorder.start()
      if (!isCurrentOperation(operationGeneration, operationSessionId)) return
      stage.value = 'recording'
      message.value = 'Follow the instructions on the TV.'
      armTimeout()
      sendProgress('recording')
      connection.send('measurement.playSweep', { sessionId: operationSessionId, context })
    } catch (error: unknown) {
      if (!isCurrentOperation(operationGeneration, operationSessionId)) return
      await fail('calibration_ui_failed', error instanceof Error ? error.message : 'Microphone recording failed.')
    } finally {
      if (takeStartInFlightGeneration === operationGeneration) takeStartInFlightGeneration = null
    }
  }

  function prepareNextContext() {
    const next = plan[planIndex]
    if (!next) {
      void finishMeasurement()
      return
    }
    const previous = activeContext.value
    if (requiresRemoteContinue(next)) {
      waitForPosition(next)
      return
    }
    activeContext.value = next
    sendPrepare(next)
    if (previous && previous.positionIndex !== next.positionIndex) {
      stage.value = 'preparing'
    }
  }

  async function finishMeasurement() {
    const currentSessionId = sessionId
    const operationGeneration = sessionGeneration
    if (!isCurrentOperation(operationGeneration, currentSessionId)) return
    await closeCapture()
    if (!isCurrentOperation(operationGeneration, currentSessionId)) return
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    if (sessionMode === 'validation') rebuildValidationAggregates()
    else rebuildAggregates()
    stage.value = 'ending'
    const failures = sessionMode === 'measurement'
      ? failedRepeatabilityGroups.value
      : sessionMode === 'probe'
        ? probeFailedRepeatabilityGroups.value
        : []
    message.value = sessionMode === 'validation'
      ? 'Follow the instructions on the TV.'
      : failures.length > 0
        ? `Some measurements need attention: ${repeatabilityFailureMessage(failures)}`
        : 'Follow the instructions on the TV.'
    sendProgress('ending', message.value)
    connection.send('calibrationSession.end', { sessionId: currentSessionId })
  }

  async function loadAndOpenCapture() {
    const loadedProfiles = await loadProfiles()
    const selectedProfile = loadedProfiles.find((candidate) => candidate.id === selectedProfileId.value) ?? loadedProfiles[0]
    if (!selectedProfile) throw new Error('No microphone calibration profiles are available.')
    profile = selectedProfile
    capture = await openMicrophone()
    captureInfo.value = { settings: capture.settings, capabilities: capture.capabilities }
    captureMetadata.value = {
      ...capture.settings,
      sampleRateRange: capture.capabilities.sampleRate,
      channelCountRange: capture.capabilities.channelCount,
      echoCancellationCapabilities: [...capture.capabilities.echoCancellation],
      noiseSuppressionCapabilities: [...capture.capabilities.noiseSuppression],
      autoGainControlCapabilities: [...capture.capabilities.autoGainControl],
      ...(typeof navigator !== 'undefined' ? { browserUserAgent: navigator.userAgent } : {}),
      ...(profile.id ? { micProfileId: profile.id } : {}),
      ...(profile.sourceDate ? { micProfileSourceDate: profile.sourceDate } : {}),
      micProfileCapturePathStatus: profile.capturePathStatus,
    }
    recorder = createPcmRecorder(capture, {
      onTrackEnded: () => {
        void fail('signal_too_low', 'The microphone ended during calibration.')
      },
    })
  }

  async function startMode(
    mode: 'measurement' | 'validation' | 'probe',
    _retryGroups: readonly unknown[] | null = null,
    candidateId: string | null = null,
    nextProbePlanKind: ProbePlanKind | null = null,
    resumeCheckpoint: CalibrationCheckpoint | null = null,
  ) {
    if (disposed || ['requesting-microphone', 'preparing', 'loudness', 'position-pause', 'recording', 'analyzing', 'ending'].includes(stage.value)) return
    if (abortRecovery.value.state === 'pending' || abortRecovery.value.state === 'awaiting-readback') return
    if (mode === 'validation' && !candidateId) {
      stage.value = 'error'
      message.value = 'Validation requires a pending calibration candidate.'
      return
    }
    sessionMode = mode
    const resumingMeasurement = mode === 'measurement' && resumeCheckpoint !== null
    abortRecovery.value = { state: 'idle' }
    if (mode === 'measurement') completedMeasurementId.value = null
    probePlanKind = mode === 'probe' ? nextProbePlanKind : null
    if (mode === 'probe' && !probePlanKind) {
      stage.value = 'error'
      message.value = 'A diagnostic probe plan is required.'
      return
    }
    const operationGeneration = invalidateSessionGeneration()
    validationActive.value = mode === 'validation'
    validationFailed.value = false
    validationCandidateId.value = mode === 'validation' ? candidateId : null
    if (mode === 'measurement' || mode === 'probe') {
      analysis.value = null
      records.value = []
      aggregateLeft.value = null
      aggregateRight.value = null
      aggregateBoth.value = null
      positionLedger = null
      previousConvergencePoints = null
      if (!resumingMeasurement) loadedResumeCheckpoint = null
    } else {
      validationAnalysis.value = null
      validationRecords.value = []
      validationAggregateLeft.value = null
      validationAggregateRight.value = null
    }
    captureDiagnostics.value = null
    failedTakeDiagnostics.value = []
    captureInfo.value = null
    captureMetadata.value = null
    plan = mode === 'validation'
      ? createMeasurementPlanForGroups([
          { positionId: 'center', positionIndex: 0, positionCount: 1, channel: 'both' },
        ], 'validation')
      : mode === 'probe'
        ? createProbeMeasurementPlan(probePlanKind as ProbePlanKind)
        : [createMeasurementPlan()[0]!]
    progress.value = { current: 0, total: mode === 'measurement' ? plan[0]?.positionCount ?? 3 : plan.length }
    estimatedRemainingSeconds.value = null
    planIndex = 0
    activeContext.value = null
    preparedContext = null
    loudnessRequested = false
    loudnessComplete = false
    validationConfirmationUsed = false
    stage.value = 'requesting-microphone'
    message.value = 'Loading microphone profiles…'
    try {
      await loadAndOpenCapture()
      if (disposed || operationGeneration !== sessionGeneration) {
        await closeCapture()
        return
      }
      if (resumingMeasurement && resumeCheckpoint) {
        const identity = currentCheckpointIdentity()
        const compatibility = identity
          ? checkCalibrationCheckpointCompatibility(resumeCheckpoint, identity)
          : { compatible: false as const, reason: 'device' as const }
        if (!compatibility.compatible) {
          resumeAvailable.value = false
          resumeMessage.value = 'The saved calibration cannot be resumed because the TV or microphone setup changed.'
          throw new Error(resumeMessage.value)
        }
      }
      sessionId = newSessionId()
      if (mode === 'measurement') {
        positionLedger = resumingMeasurement && resumeCheckpoint
          ? { ...resumeCheckpoint.ledger, sessionId }
          : createPositionLedger(sessionId)
        records.value = projectAcceptedRecords(positionLedger)
        rebuildAggregates()
        if (resumingMeasurement && positionLedger) {
          const decision = decideNextCapture(projectPhysicalPositionLedger(positionLedger), null)
          if (decision.kind === 'capture') {
            const next = contextForAdaptiveDecision(decision)
            plan = [next]
            progress.value = {
              current: acceptedPositionCount(positionLedger),
              total: next.positionCount,
            }
          }
        }
      }
      stage.value = 'preparing'
      message.value = 'Preparing the TV measurement. Follow the instructions on the TV.'
      armTimeout()
      connection.send('calibrationSession.begin', {
        sessionId,
        channel: 'both',
        phase: mode === 'validation' ? 'validation' : 'measurement',
        ...(mode === 'validation' && candidateId ? { candidateId } : {}),
      })
      armSessionKeepAlive()
    } catch (error: unknown) {
      await closeCapture()
      if (disposed || operationGeneration !== sessionGeneration) return
      sessionId = null
      profile = null
      validationActive.value = false
      if (mode === 'validation') validationFailed.value = true
      stage.value = 'error'
      message.value = error instanceof Error ? error.message : 'Microphone access failed.'
    }
  }

  function start() {
    void startMode('measurement')
  }

  async function resume() {
    if (disposed || isCalibrationActiveStage(stage.value)) return
    await refreshResumeCheckpoint()
    if (!loadedResumeCheckpoint || !resumeAvailable.value) {
      message.value = resumeMessage.value || 'There is no compatible saved calibration to resume.'
      return
    }
    void startMode('measurement', null, null, null, loadedResumeCheckpoint)
  }

  function startValidation(candidateId: string) {
    void startMode('validation', null, candidateId)
  }

  function startProbe(kind: ProbePlanKind) {
    void startMode('probe', null, null, kind)
  }

  function retryFailedGroups() {
    if (stage.value !== 'complete' || sessionMode !== 'measurement') return
    if (failedRepeatabilityGroups.value.length === 0) return
    void startMode('measurement')
  }

  async function onReady(payload: unknown) {
    const operationGeneration = sessionGeneration
    const operationSessionId = sessionId
    if (!isCurrentOperation(operationGeneration, operationSessionId) || !isMeasurementReadyPayload(payload) || payload.sessionId !== operationSessionId) return
    const context = payload.context
    if (!context || !isMeasurementContext(context)) {
      if (stage.value !== 'preparing') return
      sweep = payload.sweep
      if (sessionMode === 'measurement' && !loudnessRequested) {
        loudnessRequested = true
        stage.value = 'loudness'
        message.value = 'Follow the instructions on the TV.'
        sendProgress('loudness')
        connection.send('calibrationSession.loudness.start', { sessionId })
        return
      }
      if (loudnessComplete || sessionMode === 'validation' || sessionMode === 'probe') prepareNextContext()
      return
    }
    const wanted = plan[planIndex]
    if (!wanted || !isSameMeasurementContext(context, wanted)) return
    if (stage.value !== 'preparing' && stage.value !== 'position-pause') return
    sweep = payload.sweep
    preparedContext = context
    if (stage.value === 'position-pause') return
    await startTake(context, operationGeneration)
  }

  async function onFinished(payload: unknown) {
    const operationGeneration = sessionGeneration
    const operationSessionId = sessionId
    if (!isCurrentOperation(operationGeneration, operationSessionId) || stage.value !== 'recording' || !sweep || !activeContext.value) return
    if (typeof payload !== 'object' || payload === null || !('sessionId' in payload) || payload.sessionId !== operationSessionId) return
    const context = 'context' in payload && isMeasurementContext(payload.context) ? payload.context : null
    if (!context || !isSameMeasurementContext(context, activeContext.value)) return
    const wanted = plan[planIndex]
    if (!wanted || !isSameMeasurementContext(context, wanted)) return
    const currentSweep = sweep
    const currentRecorder = recorder
    const currentProfile = profile
    const currentContext = activeContext.value
    if (!currentContext) return
    stage.value = 'analyzing'
    message.value = 'Follow the instructions on the TV.'
    sendProgress('analyzing')
    try {
      if (!currentRecorder) throw new Error('Microphone recorder is unavailable.')
      await new Promise<void>((resolve) => setTimeout(resolve, CAPTURE_TAIL_AFTER_PLAYBACK_MS))
      if (!isCurrentOperation(operationGeneration, operationSessionId) || stage.value !== 'analyzing') return
      const recording = await currentRecorder.stop()
      if (!isCurrentOperation(operationGeneration, operationSessionId) || stage.value !== 'analyzing') return
      captureDiagnostics.value = recording.diagnostics
      const sampleRate = recording.diagnostics.sampleRate > 0
        ? recording.diagnostics.sampleRate
        : currentSweep.sampleRate
      if (captureMetadata.value) {
        captureMetadata.value = {
          ...captureMetadata.value,
          sampleRate,
          channelCount: recording.diagnostics.channelCount,
          trackSampleRate: captureMetadata.value.trackSampleRate ?? captureMetadata.value.sampleRate,
          trackChannelCount: captureMetadata.value.trackChannelCount ?? captureMetadata.value.channelCount,
        }
      }
      if (!currentProfile) throw new Error('Microphone calibration profile is unavailable.')
      const result = await analyzeInWorker(recording.samples, sampleRate, currentSweep, currentProfile)
      if (!isCurrentOperation(operationGeneration, operationSessionId) || stage.value !== 'analyzing') return
      const diagnosticsFor = (child: MeasurementAnalysis, channel: 'left' | 'right'): MeasurementDiagnosticsValues => ({
        channel,
        analysisStatus: child.status,
        failureReason: child.diagnostics.failureReason,
        signalRms: child.diagnostics.signalRms,
        signalPeak: child.diagnostics.signalPeak,
        snrEstimateDb: Number.isFinite(child.diagnostics.snrEstimateDb ?? Number.NaN) ? child.diagnostics.snrEstimateDb : null,
        detectionOffsetMs: Number.isFinite(child.diagnostics.detectionOffsetMs ?? Number.NaN) ? child.diagnostics.detectionOffsetMs : null,
        envelopeOnlyOffsetMs: Number.isFinite(child.diagnostics.envelopeOnlyOffsetMs ?? Number.NaN) ? child.diagnostics.envelopeOnlyOffsetMs : null,
        startMarkerSample: result.detection.leadingMarkerSample,
        endMarkerSample: result.detection.trailingMarkerSample,
        expectedMarkerSeparationSamples: result.detection.expectedMarkerSeparationSamples,
        observedMarkerSeparationSamples: result.detection.observedMarkerSeparationSamples,
        syncMarkerConfidence: child.diagnostics.rawLeadingMarkerConfidence,
        endingMarkerConfidence: child.diagnostics.endingMarkerConfidence,
        rawLeadingMarkerConfidence: child.diagnostics.rawLeadingMarkerConfidence,
        rawTrailingMarkerConfidence: child.diagnostics.rawTrailingMarkerConfidence,
        bestLeadingMarkerSample: child.diagnostics.bestLeadingMarkerSample,
        bestTrailingMarkerSample: child.diagnostics.bestTrailingMarkerSample,
        markerPairScore: child.diagnostics.markerPairScore,
        markerSeparationError: child.diagnostics.markerSeparationError,
        markerTimingAgreement: child.diagnostics.markerTimingAgreement,
        syncMarkerFailureReason: child.diagnostics.syncMarkerFailureReason,
        clockDriftPpm: Number.isFinite(child.diagnostics.clockDriftPpm ?? Number.NaN) ? child.diagnostics.clockDriftPpm : null,
        clipped: child.diagnostics.clipped,
        clippedSamples: child.diagnostics.clippedSamples,
        directArrivalMs: child.room?.directArrivalMs ?? null,
        directToLateDb: child.room?.directToLateDb ?? null,
        c50Db: child.room?.c50Db ?? null,
        c80Db: child.room?.c80Db ?? null,
        edtMs: child.room?.edtMs ?? null,
        t20Ms: child.room?.t20Ms ?? null,
        t30Ms: child.room?.t30Ms ?? null,
        earlyReflections: child.room?.earlyReflections.length ?? 0,
        decayConfidence: child.room?.decayConfidence ?? 'low',
        ...(captureMetadata.value ? { captureMetadata: captureMetadata.value } : {}),
      })
      const leftDiagnostics = diagnosticsFor(result.left, 'left')
      const rightDiagnostics = diagnosticsFor(result.right, 'right')
      const currentPositionCount = currentContext.positionCount
      connection.send('measurement.diagnostics', {
        sessionId: operationSessionId,
        context: currentContext,
        current: progress.value.current,
        total: currentPositionCount,
        diagnostics: leftDiagnostics,
      })
      connection.send('measurement.diagnostics', {
        sessionId: operationSessionId,
        context: currentContext,
        current: progress.value.current,
        total: currentPositionCount,
        diagnostics: rightDiagnostics,
      })

      const acceptedRecords = (child: MeasurementAnalysis, channel: 'left' | 'right'): MeasurementRecord[] =>
        child.status === 'ok' && child.correctedPoints.length > 1
          ? [{ context: currentContext, channel, analysis: child }]
          : []
      const rejectedDiagnostics = [
        result.left.status === 'ok' ? null : { context: currentContext, diagnostics: leftDiagnostics },
        result.right.status === 'ok' ? null : { context: currentContext, diagnostics: rightDiagnostics },
      ].filter((value): value is { context: MeasurementContext; diagnostics: MeasurementDiagnosticsValues } => value !== null)
      if (rejectedDiagnostics.length > 0) failedTakeDiagnostics.value = [...failedTakeDiagnostics.value, ...rejectedDiagnostics]

      if (sessionMode === 'validation') {
        const nextRecords = [
          ...acceptedRecords(result.left, 'left'),
          ...acceptedRecords(result.right, 'right'),
        ]
        validationRecords.value = [...validationRecords.value, ...nextRecords]
        validationAnalysis.value = result.left.status === 'ok' ? result.left : result.right
        rebuildValidationAggregates()
        const hasBothChannels = result.left.status === 'ok' && result.right.status === 'ok'
        if (!hasBothChannels && !validationConfirmationUsed) {
          validationConfirmationUsed = true
          const confirmation = { ...currentContext, attemptIndex: 1 }
          plan[planIndex] = confirmation
          activeContext.value = confirmation
          message.value = 'Validation was inconclusive. One confirmation reading will be taken.'
          sendPrepare(confirmation)
          return
        }
        if (!hasBothChannels && validationConfirmationUsed) {
          await fail(analysisErrorCode(result.left.status === 'ok' ? result.right.status : result.left.status), measurementFailureMessage(result.left.status === 'ok' ? result.right : result.left))
          return
        }
        progress.value = { current: 1, total: 1 }
        advanceAfterCapture(currentContext)
        return
      }

      if (sessionMode === 'probe') {
        records.value = [...records.value, ...acceptedRecords(result.left, 'left'), ...acceptedRecords(result.right, 'right')]
        rebuildAggregates()
        if (result.status !== 'ok' && currentContext.attemptIndex + 1 < currentContext.attemptCount) {
          const retry = { ...currentContext, attemptIndex: currentContext.attemptIndex + 1 }
          plan[planIndex] = retry
          activeContext.value = retry
          message.value = 'Repeating this position. The previous reading was not clear enough.'
          sendPrepare(retry)
          return
        }
        progress.value = { current: progress.value.current + 1, total: progress.value.total }
        advanceAfterCapture(currentContext)
        return
      }
      if (!positionLedger) throw new Error('Calibration position ledger is unavailable.')
      const acceptedChannelsBefore = projectAcceptedRecords(positionLedger).length
      const previousAggregatePoints = aggregateBoth.value?.points ?? null
      positionLedger = appendCompositeCapture(positionLedger, {
        context: currentContext,
        analysis: result,
        captureMetadata: captureMetadata.value,
        acceptedAt: Date.now(),
      })
      const acceptedRecordsInLedger = projectAcceptedRecords(positionLedger)
      const acceptedEvidenceChanged = hasNewAcceptedEvidence(acceptedChannelsBefore, acceptedRecordsInLedger.length)
      records.value = acceptedRecordsInLedger
      const projected = projectPhysicalPositionLedger(positionLedger)
      const acceptedPositionTotal = projected.positions.filter((position) => position.left.kind === 'accepted' && position.right.kind === 'accepted').length
      if (acceptedEvidenceChanged) persistPositionCheckpoint()
      previousConvergencePoints = previousAggregatePoints
      analysis.value = result.left.status === 'ok' ? result.left : result.right
      progress.value = { current: acceptedPositionTotal, total: Math.max(progress.value.total, currentPositionCount) }
      if (result.status !== 'ok') {
        message.value = result.status === 'partial'
          ? 'Repeating this position. One channel reading was not clear enough.'
          : measurementFailureMessage(result.left.status !== 'ok' ? result.left : result.right)
        sendProgress('preparing', message.value)
      }
      advanceAfterCapture(currentContext, acceptedEvidenceChanged)
    } catch (error: unknown) {
      if (!isCurrentOperation(operationGeneration, operationSessionId) || stage.value !== 'analyzing') return
      await fail('sweep_not_found', error instanceof Error ? error.message : 'Measurement analysis failed.')
    }
  }

  function measurementFailureMessage(result: MeasurementAnalysis): string {
    if (result.status === 'capture_clipped') {
      return 'Capture rejected because the microphone clipped. Keep the phone still and lower background noise; the TV volume does not need to be raised.'
    }
    if (result.status === 'signal_too_low') {
      const snr = result.diagnostics.snrEstimateDb
      return snr != null && Number.isFinite(snr)
        ? `Capture rejected because it was too noisy (estimated SNR ${snr.toFixed(1)} dB). Keep the phone still and reduce background noise; do not raise the TV volume just to chase a higher peak.`
        : 'Capture rejected because the sweep signal was too weak or too noisy. Keep the phone still and reduce background noise; do not raise the TV volume unless it is genuinely inaudible.'
    }
    if (result.status === 'capture_too_short') {
      return 'Capture rejected because the recording ended before the full sweep. Keep the phone still until the sweep finishes.'
    }
    if (result.status === 'sync_marker_not_found') {
      return 'Capture rejected because the known synchronization marker was not found with sufficient confidence. Keep the phone still and retry.'
    }
    if (result.status === 'clock_drift_unreliable') {
      return 'Capture rejected because the TV/browser clock relationship was unreliable. Keep the phone still and retry.'
    }
    return 'Capture rejected because the sweep was not detected. Keep the phone still and try again.'
  }

  function continuePosition() {
    if (stage.value !== 'position-pause' || !preparedContext) return
    clearPositionKeepAlive()
    void startTake(preparedContext)
  }

  function finishCancelled(text = 'Calibration cancelled.', sendAbort = false) {
    const currentSessionId = sessionId
    if (!currentSessionId) {
      invalidateSessionGeneration()
      clearPersistedCheckpoint()
      validationFailed.value = false
      validationActive.value = false
      stage.value = 'idle'
      message.value = text
      return
    }
    invalidateSessionGeneration()
    if (sendAbort) {
      const abort = createCalibrationAbortCommand(currentSessionId, 'calibration_aborted')
      connection.send(abort.type, abort.payload)
      connection.send('state.get')
    }
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    void closeCapture()
    clearPersistedCheckpoint()
    sessionId = null
    sweep = null
    profile = null
    activeContext.value = null
    preparedContext = null
    validationFailed.value = false
    validationActive.value = false
    estimatedRemainingSeconds.value = null
    stage.value = 'idle'
    message.value = text
  }

  function onMessage(env: Envelope) {
    if (env.type === 'measurement.ready') {
      void onReady(env.payload)
      return
    }
    if (env.type === 'measurement.started' && stage.value === 'recording') {
      if (!sessionId || !isMeasurementReadyPayload(env.payload) || env.payload.sessionId !== sessionId ||
        !env.payload.context || !isSameMeasurementContext(env.payload.context, activeContext.value)) return
      message.value = 'Follow the instructions on the TV.'
      return
    }
    if (env.type === 'calibrationSession.loudness.started' && sessionId && typeof env.payload === 'object' && env.payload !== null &&
      'sessionId' in env.payload && env.payload.sessionId === sessionId) {
      stage.value = 'loudness'
      message.value = 'Follow the instructions on the TV.'
      sendProgress('loudness')
      return
    }
    if (env.type === 'calibrationSession.loudness.stopped' && sessionId && typeof env.payload === 'object' && env.payload !== null &&
      'sessionId' in env.payload && env.payload.sessionId === sessionId) {
      loudnessComplete = true
      stage.value = 'preparing'
      message.value = 'Follow the instructions on the TV.'
      prepareNextContext()
      return
    }
    if (env.type === 'calibrationSession.position.continued'
      && sessionId
      && isCalibrationSessionPositionContinuedPayload(env.payload)
      && env.payload.sessionId === sessionId
      && stage.value === 'position-pause'
      && preparedContext !== null
      && isSameMeasurementContext(env.payload.context, preparedContext)) {
      continuePosition()
      return
    }
    if (env.type === 'measurement.finished') {
      void onFinished(env.payload)
      return
    }
    if (env.type === 'measurement.error' && sessionId && typeof env.payload === 'object' && env.payload !== null &&
      'sessionId' in env.payload && env.payload.sessionId === sessionId) {
      const text = 'message' in env.payload && typeof env.payload.message === 'string'
        ? env.payload.message
        : 'The TV rejected the measurement.'
      const code = 'code' in env.payload ? errorCode(env.payload.code) : 'invalid_session'
      if (isUserCancellationCode(code) && sessionMode !== 'validation') {
        finishCancelled('Calibration cancelled.')
        return
      }
      void fail(code, text)
      return
    }
    if (env.type === 'calibrationSession.ended' && sessionId && typeof env.payload === 'object' && env.payload !== null &&
      'sessionId' in env.payload && env.payload.sessionId === sessionId) {
      const endedSessionId = sessionId
      const endedMode = sessionMode
      const endedAbort = abortRecovery.value
      const hadAnalysis = records.value.length > 0 || validationRecords.value.length > 0
      invalidateSessionGeneration()
      clearTimeoutTimer()
      clearPositionKeepAlive()
      clearSessionKeepAlive()
      void closeCapture()
      sessionId = null
      sweep = null
      profile = null
      activeContext.value = null
      preparedContext = null
      validationActive.value = false
      estimatedRemainingSeconds.value = null
      if (endedMode === 'validation' && (endedAbort.state === 'pending' || endedAbort.state === 'awaiting-readback')) {
        abortRecovery.value = {
          state: 'awaiting-readback',
          details: endedAbort.details,
        }
        connection.send('state.get')
        scheduleAbortRecoveryPoll(true)
        stage.value = 'error'
        message.value = endedAbort.details.message
        return
      }
      if (endedMode === 'measurement' && hadAnalysis) {
        completedMeasurementId.value = endedSessionId
        if (positionLedger && acceptedPositionCount(positionLedger) >= 3) clearPersistedCheckpoint()
      }
      stage.value = hadAnalysis ? 'complete' : 'idle'
      message.value = hadAnalysis
        ? endedMode === 'validation'
          ? 'Validation complete. Compare the measured result with the original response.'
          : endedMode === 'probe'
            ? probeRepeatabilityPassed.value
              ? 'Diagnostic probe complete. Export the captured response before changing the curve.'
              : `Diagnostic probe repeatability is inconclusive at ${repeatabilityFailureMessage(probeFailedRepeatabilityGroups.value)}.`
            : repeatabilityPassed.value
              ? 'Advanced measurement complete. Review the response and room metrics below.'
              : `Calibration failed. Measurements were not repeatable at ${repeatabilityFailureMessage(failedRepeatabilityGroups.value)}.`
        : 'Calibration cancelled.'
    }
  }

  const off = connection.onMessage(onMessage)

  function cancel() {
    if (!sessionId) {
      if (abortRecovery.value.state === 'pending' || abortRecovery.value.state === 'awaiting-readback') return
      finishCancelled()
      return
    }
    if (sessionMode === 'validation') {
      if (abortRecovery.value.state !== 'idle') return
      beginValidationAbort('calibration_aborted', 'Calibration cancelled.')
      invalidateSessionGeneration()
      clearTimeoutTimer()
      clearPositionKeepAlive()
      clearSessionKeepAlive()
      void closeCapture()
      sweep = null
      profile = null
      activeContext.value = null
      preparedContext = null
      validationFailed.value = false
      validationActive.value = true
      estimatedRemainingSeconds.value = null
      stage.value = 'ending'
      message.value = 'Waiting for the TV to restore the previous calibration.'
      return
    }
    finishCancelled('Calibration cancelled.', true)
  }

  onScopeDispose(() => {
    disposed = true
    invalidateSessionGeneration()
    off()
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    clearAbortRecoveryPolling()
    if (sessionId && abortRecovery.value.state === 'idle') {
      const abort = createCalibrationAbortCommand(sessionId, 'calibration_aborted')
      connection.send(abort.type, abort.payload)
    }
    void closeCapture()
    sessionId = null
    sweep = null
    profile = null
    activeContext.value = null
    preparedContext = null
    validationFailed.value = false
    validationActive.value = false
    estimatedRemainingSeconds.value = null
  })

  return {
    stage: readonly(stage),
    validationActive: readonly(validationActive),
    validationFailed: readonly(validationFailed),
    validationCandidateId: readonly(validationCandidateId),
    completedMeasurementId: readonly(completedMeasurementId),
    abortRecovery: readonly(abortRecovery),
    message: readonly(message),
    analysis,
    validationAnalysis,
    records: readonly(records),
    validationRecords: readonly(validationRecords),
    aggregateLeft: readonly(aggregateLeft),
    aggregateRight: readonly(aggregateRight),
    aggregateBoth: readonly(aggregateBoth),
    validationAggregateLeft: readonly(validationAggregateLeft),
    validationAggregateRight: readonly(validationAggregateRight),
    repeatabilityPassed,
    repeatabilitySummaries: readonly(repeatabilitySummaries),
    failedRepeatabilityGroups: readonly(failedRepeatabilityGroups),
    probeRepeatabilityPassed,
    probeRepeatabilitySummaries: readonly(probeRepeatabilitySummaries),
    probeFailedRepeatabilityGroups: readonly(probeFailedRepeatabilityGroups),
    currentContext: readonly(activeContext),
    currentPosition,
    currentChannel,
    currentInstruction,
    progress: readonly(progress),
    estimatedRemainingSeconds: readonly(estimatedRemainingSeconds),
    captureDiagnostics,
    failedTakeDiagnostics: readonly(failedTakeDiagnostics),
    captureInfo,
    captureMetadata: readonly(captureMetadata),
    resumeAvailable: readonly(resumeAvailable),
    resumePositionCount: readonly(resumePositionCount),
    resumeMessage: readonly(resumeMessage),
    profiles: readonly(profiles),
    selectedProfileId,
    profileError: readonly(profileError),
    loadProfiles,
    start,
    resume,
    refreshResumeCheckpoint,
    startValidation,
    startProbe,
    retryFailedGroups,
    cancel,
    observeAbortRecoverySnapshot,
  }
}
