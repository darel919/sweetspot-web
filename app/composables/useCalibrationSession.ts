import { computed, onScopeDispose, readonly, ref, shallowRef } from 'vue'
import type {
  CalibrationProgressStage,
  CalibrationErrorCode,
  CalibrationSessionOutcome,
  CalibrationPositionId,
  Envelope,
  MeasurementContext,
  MeasurementDiagnosticsValues,
  MeasurementCaptureKind,
  MeasurementCaptureMetadata,
  MeasurementResponsePayload,
  MeasurementSweep,
} from '../../shared/types/protocol'
import {
  CALIBRATION_ERROR_CODES,
  PROTOCOL_VERSION,
  isCalibrationSessionPositionContinuedPayload,
  isCalibrationSessionEndedPayload,
  isMarkerDiagnosticCaptureKind,
  isMeasurementContext,
  isMeasurementReadyPayload,
} from '../../shared/types/protocol'
import { openMicrophone, closeMicrophone, type MicrophoneCapture } from '../lib/audio/capture/microphone'
import { createPcmRecorder, type CaptureSignalDiagnostics, type PcmRecorder } from '../lib/audio/capture/pcm-recorder'
import { analyzeInWorker } from '../lib/audio/measurement/worker-client'
import {
  aggregateResponse,
  allCaptureQualityPassed,
  type AggregateResponse,
  type MeasurementRecord,
  type RepeatabilitySummary,
} from '../lib/audio/measurement/aggregation'
import type { MeasurementAnalysis, ResponsePoint } from '../lib/audio/measurement/response'
import {
  createMeasurementPlan,
  createMeasurementPlanForGroups,
  createProbeMeasurementPlan,
  measurementContextForPosition,
  positionForContext,
  requiresRemoteContinue,
  type ProbePlanKind,
} from '../lib/audio/measurement/plan'
import {
  reconcileFailedTakeDiagnostics,
  summarizeMarkerProbe,
  type FailedTakeDiagnostic,
  type MarkerProbeSummary,
} from '../lib/audio/measurement/failure-diagnostics'
import {
  appendCompositeCapture,
  acceptedPositionCount,
  createPositionLedger,
  projectAcceptedRecords,
  projectPhysicalPositionLedger,
  type PositionLedger,
} from '../lib/audio/measurement/position-ledger'
import { decideNextCapture, type ConvergenceAssessment } from '../lib/audio/measurement/adaptive-planner'
import { validationRepairChannel } from '../lib/audio/measurement/validation-retry'
import {
  CALIBRATION_ANALYSIS_REVISION,
  CALIBRATION_SWEEP_REVISION,
  CALIBRATION_WEB_BUILD_SHA,
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
import { assessCaptureLevelPreflight } from '../lib/audio/measurement/acoustic-preflight'
import { combineChannelAggregates } from '../lib/audio/correction/optimizer'
import {
  createCalibrationDebugBundle,
  createCalibrationDebugCapture,
  downloadCalibrationDebugBundle,
  type CalibrationDebugCapture,
} from '../lib/audio/measurement/debug-bundle'
import { compactMeasurementDiagnostics } from '../lib/audio/measurement/compact-diagnostics'
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

export interface CalibrationSessionDependencies {
  openMicrophone: typeof openMicrophone
  closeMicrophone: typeof closeMicrophone
  createPcmRecorder: typeof createPcmRecorder
  analyzeInWorker: typeof analyzeInWorker
  discoverMicCalibrationProfiles: typeof discoverMicCalibrationProfiles
  loadCalibrationCheckpoint: typeof loadCalibrationCheckpoint
  saveCalibrationCheckpoint: typeof saveCalibrationCheckpoint
  clearCalibrationCheckpoint: typeof clearCalibrationCheckpoint
  downloadCalibrationDebugBundle: typeof downloadCalibrationDebugBundle
}

export interface CalibrationSessionOptions {
  getDeviceIdentity?: () => { id: string; appVersion: string; buildId: string } | null
  debugCaptureExport?: boolean
  dependencies?: Partial<CalibrationSessionDependencies>
}

const ABORT_RECOVERY_POLL_INTERVAL_MS = 400
// The Android sweep includes post-roll and measurement.finished is emitted only
// after AudioTrack consumed it. Keep a small drain margin for the worklet.
const CAPTURE_TAIL_AFTER_PLAYBACK_MS = 64
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

export interface CalibrationTakeDiagnostics {
  context: MeasurementContext
  capture: CaptureSignalDiagnostics
  left: MeasurementDiagnosticsValues
  right: MeasurementDiagnosticsValues
}

export function isCalibrationActiveStage(stage: CalibrationStage): boolean {
  return CALIBRATION_ACTIVE_STAGES.includes(stage)
}

function newSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return `cal_${random ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`}`
}

function analysisErrorCode(status: MeasurementAnalysis['status']): CalibrationErrorCode {
  if (status === 'capture_clipped') return 'capture_clipped'

  if (status === 'direct_arrival_low_confidence') return 'direct_arrival_low_confidence'
  if (status === 'impulse_not_found') return 'impulse_not_found'
  if (status === 'response_not_generated') return 'response_not_generated'
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

function isMarkerProbePlan(kind: ProbePlanKind | null): boolean {
  if (kind === null) return false
  const captureKind: MeasurementCaptureKind = kind === 'transfer' || kind === 'routing'
    ? 'position-composite'
    : kind
  return isMarkerDiagnosticCaptureKind(captureKind)
}

export function useCalibrationSession(connection: Connection, options: CalibrationSessionOptions = {}) {
  const dependencies: CalibrationSessionDependencies = {
    openMicrophone,
    closeMicrophone,
    createPcmRecorder,
    analyzeInWorker,
    discoverMicCalibrationProfiles,
    loadCalibrationCheckpoint,
    saveCalibrationCheckpoint,
    clearCalibrationCheckpoint,
    downloadCalibrationDebugBundle,
    ...options.dependencies,
  }
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
  const takeDiagnostics = shallowRef<CalibrationTakeDiagnostics[]>([])
  const failedTakeDiagnostics = shallowRef<FailedTakeDiagnostic[]>([])
  const profiles = shallowRef<MicCalibrationProfile[]>([])
  const selectedProfileId = ref('')
  const profileError = ref('')
  const captureInfo = shallowRef<{
    settings: MicrophoneCapture['settings']
    capabilities: MicrophoneCapture['capabilities']
    expectedSampleCount?: number
    expectedDurationMs?: number
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
  const convergenceOutcome = ref<'sufficient' | 'bounded' | 'insufficient' | null>(null)

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
  let analysisAbortController: AbortController | null = null
  let loudnessRequested = false
  let loudnessComplete = false
  let preflightCaptureActive = false
  let preflightStart: Promise<void> | null = null
  let preflightCompletionStarted = false
  let sessionSampleRate: number | null = null
  let resumeExpectedSampleRate: number | null = null

  let checkpointWriteChain: Promise<void> = Promise.resolve()
  let loadedResumeCheckpoint: CalibrationCheckpoint | null = null
  let previousConvergencePoints: readonly ResponsePoint[] | null = null
  const debugCaptures: CalibrationDebugCapture[] = []
  let calibrationId: string | null = null
  const failedMeasurementAttemptCount = ref(0)

  const countFailedMeasurementAttempts = (ledger: PositionLedger | null): number => ledger?.captures.filter((capture) => {
    if (capture.context.phase !== 'measurement') return false
    const channels: readonly ('left' | 'right')[] = capture.context.repairChannel === 'left' || capture.context.repairChannel === 'right'
      ? [capture.context.repairChannel]
      : ['left', 'right']
    return channels.some((channel) => capture[channel].kind === 'rejected')
  }).length ?? 0

  const completeAcceptedMeasurementPositionCount = computed(() => positionLedger ? acceptedPositionCount(positionLedger) : 0)
  const measurementQualityPassed = computed(() => {
    const physical = positionLedger ? projectPhysicalPositionLedger(positionLedger) : null
    const center = physical?.positions.find((position) => position.positionId === 'center')
    return allCaptureQualityPassed(aggregateLeft.value)
      && allCaptureQualityPassed(aggregateRight.value)
      && center?.left.kind === 'accepted'
      && center.right.kind === 'accepted'
      && completeAcceptedMeasurementPositionCount.value >= 3
  })
  const spatialConsistencySummaries = computed<RepeatabilitySummary[]>(() => [
    ...(aggregateLeft.value?.spatialConsistency ?? []),
    ...(aggregateRight.value?.spatialConsistency ?? []),
  ])
  const failedRepeatabilityGroups = computed(() =>
    spatialConsistencySummaries.value.filter((summary) => !summary.passed))
  const probeRepeatabilitySummaries = computed<RepeatabilitySummary[]>(() =>
    aggregateBoth.value?.spatialConsistency ?? [])
  const probeSummary = computed<MarkerProbeSummary>(() => summarizeMarkerProbe(
    takeDiagnostics.value,
    failedTakeDiagnostics.value,
    isMarkerProbePlan(probePlanKind) ? plan.length : 0,
  ))
  const probeCaptureQualityPassed = computed(() => {
    if (!isMarkerProbePlan(probePlanKind)) {
      return allCaptureQualityPassed(aggregateBoth.value)
    }
    return probeSummary.value.passed
  })
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
    if (sessionMode === 'probe' && !isMarkerDiagnosticCaptureKind(context.captureKind) && context.channel === 'both') {
      if (context.positionId === 'left') return 'Place the single microphone at the fixed left-speaker position and keep its orientation unchanged.'
      if (context.positionId === 'right') return 'Move the same microphone to the fixed right-speaker position and keep its orientation unchanged.'
      return 'Place the single microphone at the fixed center listening position and keep its orientation unchanged.'
    }
    const position = positionForContext(context)
    return context.attemptIndex > 0 ? position.retryInstruction : position.instruction
  })

  async function loadProfiles(): Promise<MicCalibrationProfile[]> {
    if (profiles.value.length > 0) return profiles.value
    if (profileLoadPromise) return profileLoadPromise
    profileLoadPromise = dependencies.discoverMicCalibrationProfiles()
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
    analysisAbortController?.abort()
    analysisAbortController = null
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
    if (currentCapture) dependencies.closeMicrophone(currentCapture)
  }

  function currentCheckpointIdentity(): CalibrationCheckpointIdentity | null {
    const device = options.getDeviceIdentity?.() ?? null
    const currentProfile = profile ?? profiles.value.find((candidate) => candidate.id === selectedProfileId.value) ?? null
    if (!device || !currentProfile) return null
    return {
      deviceId: device.id,
      appVersion: device.appVersion,
      buildId: device.buildId,
      profileId: currentProfile.id,
      profileSourceDate: currentProfile.sourceDate,
      capturePathStatus: currentProfile.capturePathStatus,
      sampleRate: captureMetadata.value?.sampleRate ?? null,
      webBuildSha: CALIBRATION_WEB_BUILD_SHA,
      analysisRevision: CALIBRATION_ANALYSIS_REVISION,
      sweepRevision: CALIBRATION_SWEEP_REVISION,
    }
  }

  async function refreshResumeCheckpoint(): Promise<void> {
    const identity = currentCheckpointIdentity()
    if (!identity) {
      loadedResumeCheckpoint = null
      resumeAvailable.value = false
      resumePositionCount.value = 0
      return
    }
    try {
      const checkpoint = await dependencies.loadCalibrationCheckpoint(identity.deviceId)
      loadedResumeCheckpoint = checkpoint
      if (!checkpoint) {
        loadedResumeCheckpoint = null
        resumeAvailable.value = false
        resumePositionCount.value = 0
        resumeMessage.value = ''
        return
      }
      const compatibility = checkCalibrationCheckpointCompatibility(checkpoint, identity)
      if (!compatibility.compatible) {
        loadedResumeCheckpoint = null
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
      device: { id: identity.deviceId, appVersion: identity.appVersion, buildId: identity.buildId },
      microphone: {
        profileId: profile.id,
        sourceDate: profile.sourceDate,
        capturePathStatus: profile.capturePathStatus,
        sampleRate: identity.sampleRate,
      },
      captureMetadata: captureMetadata.value,
      convergenceOutcome: convergenceOutcome.value,
      ledger,
      validationStarted: false,
    })
    checkpointWriteChain = checkpointWriteChain
      .then(() => dependencies.saveCalibrationCheckpoint(checkpoint))
      .catch(() => undefined)
    loadedResumeCheckpoint = checkpoint
    resumeAvailable.value = true
    resumePositionCount.value = acceptedPositionCount(ledger)
  }

  function clearPersistedCheckpoint(): void {
    const device = options.getDeviceIdentity?.() ?? null
    if (!device) return
    checkpointWriteChain = checkpointWriteChain
      .then(() => dependencies.clearCalibrationCheckpoint(device.id))
      .catch(() => undefined)
    loadedResumeCheckpoint = null
    resumeAvailable.value = false
    resumePositionCount.value = 0
    resumeMessage.value = ''
  }

  function exportDebugBundle(): void {
    const exportCalibrationId = calibrationId ?? completedMeasurementId.value
    if (!options.debugCaptureExport || !exportCalibrationId || debugCaptures.length === 0) return
    dependencies.downloadCalibrationDebugBundle(createCalibrationDebugBundle(exportCalibrationId, debugCaptures, {
      tvAppVersion: options.getDeviceIdentity?.()?.appVersion ?? null,
      tvBuildId: options.getDeviceIdentity?.()?.buildId ?? null,
      webBuildSha: CALIBRATION_WEB_BUILD_SHA,
      protocolVersion: PROTOCOL_VERSION,
      relayAuthVersion: 'pairing-v1',
      analysisRevision: CALIBRATION_ANALYSIS_REVISION,
      sweepRevision: CALIBRATION_SWEEP_REVISION,
      markerChannel: debugCaptures[0]!.sweep.markerChannel,
    }))
  }

  function rebuildAggregates() {
    const current = records.value
    const left = aggregateResponse(current, 'left')
    const right = aggregateResponse(current, 'right')
    aggregateLeft.value = left
    aggregateRight.value = right
    aggregateBoth.value = left && right
      ? combineChannelAggregates(left, right) ?? aggregateResponse(current, 'both')
      : aggregateResponse(current, 'both')
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
    return measurementContextForPosition(
      decision.position,
      decision.positionIndex,
      decision.requestedPositionCount,
      'measurement',
      decision.repairChannel,
      decision.attemptIndex,
    )
  }

  function scheduleAdaptiveNext(): void {
    if (!positionLedger) return
    const convergence = assessConvergence()
    const decision = decideNextCapture(projectPhysicalPositionLedger(positionLedger), convergence)
    if (decision.kind === 'finish') {
      convergenceOutcome.value = decision.outcome
      persistPositionCheckpoint()
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

  function spatialConsistencyFailureMessage(groups: readonly RepeatabilitySummary[]): string {
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
      connection.send('state.get')
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

  function setPreparingText(context: MeasurementContext) {
    message.value = sessionMode === 'measurement'
      && positionLedger?.captures.length === 0
      && context.positionId === 'center'
      && context.attemptIndex === 0
      ? 'Running the center acoustic pilot. The room walkaround starts only after this signal is synchronized and analyzed.'
      : 'Follow the instructions on the TV.'
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
      const actualSampleRate = recorder.sampleRate()
      if (resumeExpectedSampleRate !== null
        && (actualSampleRate === null || Math.abs(actualSampleRate - resumeExpectedSampleRate) > 1)
      ) {
        await fail(
          'capture_sample_rate_changed',
          `The resumed microphone sample rate is ${actualSampleRate ?? 'unknown'} Hz, but the checkpoint requires ${resumeExpectedSampleRate} Hz.`,
        )
        return
      }
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
        ? `Some measurements need attention: ${spatialConsistencyFailureMessage(failures)}`
        : 'Follow the instructions on the TV.'
    sendProgress('ending', message.value)
    connection.send('calibrationSession.end', {
      sessionId: currentSessionId,
      outcome: sessionMode === 'measurement' ? convergenceOutcome.value ?? 'insufficient' : 'sufficient',
    })
  }

  async function loadAndOpenCapture() {
    const loadedProfiles = await loadProfiles()
    const selectedProfile = loadedProfiles.find((candidate) => candidate.id === selectedProfileId.value) ?? loadedProfiles[0]
    if (!selectedProfile) throw new Error('No microphone calibration profiles are available.')
    profile = selectedProfile
    capture = await dependencies.openMicrophone()
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
    recorder = dependencies.createPcmRecorder(capture, {
      onTrackEnded: () => {
        void fail('signal_too_low', 'The microphone ended during calibration.')
      },
    })
  }

  async function startMode(
    mode: 'measurement' | 'validation' | 'probe',
    validationPositionIds: readonly CalibrationPositionId[] | null = null,
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
    if (mode === 'validation' && (!validationPositionIds || validationPositionIds.length === 0)) {
      stage.value = 'error'
      validationFailed.value = true
      message.value = 'Validation requires the accepted physical positions from the baseline measurement.'
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
    if (!resumingMeasurement) {
      takeDiagnostics.value = []
      failedTakeDiagnostics.value = []
      if (mode !== 'validation') debugCaptures.length = 0
    }
    captureInfo.value = null
    captureMetadata.value = null
    plan = mode === 'validation'
      ? createMeasurementPlanForGroups(
          validationPositionIds?.map((positionId, positionIndex) => ({
            positionId,
            positionIndex,
            positionCount: validationPositionIds.length,
            channel: 'both' as const,
          })) ?? [],
          'validation',
        )
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
    preflightCaptureActive = false
    preflightStart = null
    preflightCompletionStarted = false
    sessionSampleRate = null
    resumeExpectedSampleRate = resumingMeasurement ? resumeCheckpoint?.microphone.sampleRate ?? null : null
    if (mode !== 'validation') {
      failedMeasurementAttemptCount.value = 0
      convergenceOutcome.value = null
    }
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
          ? checkCalibrationCheckpointCompatibility(resumeCheckpoint, identity, { requireSampleRate: true })
          : { compatible: false as const, reason: 'device' as const }
        if (!compatibility.compatible) {
          resumeAvailable.value = false
          resumeMessage.value = 'The saved calibration cannot be resumed because the TV or microphone setup changed.'
          throw new Error(resumeMessage.value)
        }
      }
      sessionId = newSessionId()
      if (mode === 'measurement') {
        calibrationId = sessionId
        positionLedger = resumingMeasurement && resumeCheckpoint
          ? { ...resumeCheckpoint.ledger, sessionId }
          : createPositionLedger(sessionId)
        convergenceOutcome.value = resumingMeasurement && resumeCheckpoint ? resumeCheckpoint.convergenceOutcome : null
        failedMeasurementAttemptCount.value = countFailedMeasurementAttempts(positionLedger)
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

  function startValidation(candidateId: string, positionIds: readonly CalibrationPositionId[] = []) {
    void startMode('validation', positionIds, candidateId)
  }

  function startProbe(kind: ProbePlanKind) {
    void startMode('probe', null, null, kind)
  }

  async function retryFailedGroups() {
    if (stage.value !== 'complete' || sessionMode !== 'measurement') return
    if (failedRepeatabilityGroups.value.length === 0 && failedTakeDiagnostics.value.length === 0) return
    await refreshResumeCheckpoint()
    if (loadedResumeCheckpoint) {
      void startMode('measurement', null, null, null, loadedResumeCheckpoint)
      return
    }
    void startMode('measurement')
  }

  async function onReady(payload: unknown) {
    const operationGeneration = sessionGeneration
    const operationSessionId = sessionId
    if (!operationSessionId || !isCurrentOperation(operationGeneration, operationSessionId) || !isMeasurementReadyPayload(payload) || payload.sessionId !== operationSessionId) return
    const context = payload.context
    if (!context || !isMeasurementContext(context)) {
      if (stage.value !== 'preparing') return
      sweep = payload.sweep
      const parts = sweepSampleParts(sweep, captureInfo.value?.settings.sampleRate ?? sweep.sampleRate)
      if (captureInfo.value) {
        captureInfo.value = {
          ...captureInfo.value,
          expectedSampleCount: parts.totalSamples,
          expectedDurationMs: parts.totalSamples * 1000 / (captureInfo.value.settings.sampleRate ?? sweep.sampleRate),
        }
      }
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
      if (sessionSampleRate !== null && Math.abs(sampleRate - sessionSampleRate) > 1) {
        await fail('capture_sample_rate_changed', `Microphone sample rate changed from ${sessionSampleRate} Hz to ${sampleRate} Hz during calibration.`)
        return
      }
      sessionSampleRate ??= sampleRate
      if (captureMetadata.value) {
        captureMetadata.value = {
          ...captureMetadata.value,
          sampleRate,
          channelCount: recording.diagnostics.channelCount,
          trackSampleRate: captureMetadata.value.trackSampleRate ?? captureMetadata.value.sampleRate,
          trackChannelCount: captureMetadata.value.trackChannelCount ?? captureMetadata.value.channelCount,
        }
      }
      if (captureInfo.value) {
        const expectedParts = sweepSampleParts(currentSweep, sampleRate)
        captureInfo.value = {
          ...captureInfo.value,
          expectedSampleCount: expectedParts.totalSamples,
          expectedDurationMs: expectedParts.totalSamples * 1000 / sampleRate,
          settings: {
            ...captureInfo.value.settings,
            sampleRate,
            channelCount: recording.diagnostics.channelCount,
          },
        }
      }
      if (!currentProfile) throw new Error('Microphone calibration profile is unavailable.')
      const debugCaptureIndex = options.debugCaptureExport
        ? debugCaptures.push(createCalibrationDebugCapture({
          sessionId: operationSessionId,
          candidateId: validationCandidateId.value,
          context: currentContext,
          samples: recording.samples,
          sampleRate,
          channelCount: recording.diagnostics.channelCount,
          startSample: recording.startSample,
          endSample: recording.endSample,
          captureMetadata: captureMetadata.value,
          signalDiagnostics: recording.diagnostics,
          analysisStatus: null,
          analysisDiagnostics: null,
          responsePoints: null,
          sweep: currentSweep,
          microphoneProfile: currentProfile,
          plannerState: { convergenceOutcome: convergenceOutcome.value },
          positionLedger: positionLedger ? projectPhysicalPositionLedger(positionLedger) : null,
        })) - 1
        : -1
      const analysisController = new AbortController()
      analysisAbortController = analysisController
      const result = await dependencies.analyzeInWorker(recording.samples, sampleRate, currentSweep, currentProfile, analysisController.signal)
      if (analysisAbortController === analysisController) analysisAbortController = null
      if (!isCurrentOperation(operationGeneration, operationSessionId) || stage.value !== 'analyzing') return
      if (debugCaptureIndex >= 0) {
        const debugCapture = debugCaptures[debugCaptureIndex]
        if (debugCapture) debugCaptures[debugCaptureIndex] = {
          ...debugCapture,
          analysisStatus: `${result.left.status}/${result.right.status}`,
          analysisDiagnostics: {
            left: result.left.diagnostics as unknown as Record<string, unknown>,
            right: result.right.diagnostics as unknown as Record<string, unknown>,
          },
          responsePoints: {
            left: result.left.displayPoints,
            right: result.right.displayPoints,
          },
          plannerState: { convergenceOutcome: convergenceOutcome.value },
          positionLedger: positionLedger ? projectPhysicalPositionLedger(positionLedger) : null,
        }
      }
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
        leadingMarkerCandidates: child.diagnostics.leadingMarkerCandidates,
        trailingMarkerCandidates: child.diagnostics.trailingMarkerCandidates,
        markerPairCandidates: child.diagnostics.markerPairCandidates,
        leadingBestCorrelation: child.diagnostics.leadingBestCorrelation,
        leadingSecondCorrelation: child.diagnostics.leadingSecondCorrelation,
        leadingCorrelationMargin: child.diagnostics.leadingCorrelationMargin,
        trailingBestCorrelation: child.diagnostics.trailingBestCorrelation,
        trailingSecondCorrelation: child.diagnostics.trailingSecondCorrelation,
        trailingCorrelationMargin: child.diagnostics.trailingCorrelationMargin,
        markerPairScore: child.diagnostics.markerPairScore,
        secondMarkerPairScore: child.diagnostics.secondMarkerPairScore,
        markerPairScoreMargin: child.diagnostics.markerPairScoreMargin,
        markerPairScoreRatio: child.diagnostics.markerPairScoreRatio,
        markerSeparationError: child.diagnostics.markerSeparationError,
        markerTimingAgreement: child.diagnostics.markerTimingAgreement,
        markerSeparationPpm: child.diagnostics.markerSeparationPpm,
        syncMarkerFailureReason: child.diagnostics.syncMarkerFailureReason,
        clockDriftPpm: Number.isFinite(child.diagnostics.clockDriftPpm ?? Number.NaN) ? child.diagnostics.clockDriftPpm : null,
        clipped: child.diagnostics.clipped,
        clippedSamples: child.diagnostics.clippedSamples,
        directArrivalMs: child.room?.directArrivalMs ?? null,
        directPeak: child.diagnostics.directPeak ?? child.impulse?.directArrival.directPeak ?? null,
        deconvolvedNoiseFloorRms: child.diagnostics.deconvolvedNoiseFloorRms ?? child.impulse?.directArrival.noiseFloorRms ?? null,
        directPeakToNoiseDb: child.diagnostics.directPeakToNoiseDb ?? child.impulse?.directArrival.peakToNoiseDb ?? null,
        directArrivalAcceptanceThreshold: child.diagnostics.directArrivalAcceptanceThreshold ?? child.impulse?.directArrival.acceptanceThreshold ?? null,
        directArrivalCandidateSample: child.diagnostics.directArrivalCandidateSample ?? child.impulse?.directArrival.candidateArrivalIndex ?? null,
        directArrivalAcceptedSample: child.diagnostics.directArrivalAcceptedSample ?? child.impulse?.directArrival.acceptedArrivalIndex ?? null,
        directArrivalRejectionReason: child.diagnostics.directArrivalRejectionReason ?? child.impulse?.directArrival.rejectionReason ?? null,
        directSupportWindowRms: child.diagnostics.directSupportWindowRms ?? child.impulse?.directArrival.supportWindowRms ?? null,
        directSupportWindowThreshold: child.diagnostics.directSupportWindowThreshold ?? child.impulse?.directArrival.supportWindowThreshold ?? null,
        directSupportSampleCount: child.diagnostics.directSupportSampleCount ?? child.impulse?.directArrival.supportSampleCount ?? null,
        bestLaterReflectionSample: child.diagnostics.bestLaterReflectionSample ?? child.impulse?.directArrival.laterReflectionIndex ?? null,
        bestLaterReflectionPeak: child.diagnostics.bestLaterReflectionPeak ?? child.impulse?.directArrival.laterReflectionPeak ?? null,
        candidateAbsoluteTimeMs: child.diagnostics.candidateAbsoluteTimeMs ?? child.impulse?.directArrival.candidateAbsoluteTimeMs ?? null,
        earlySearchWindowStartSample: child.diagnostics.earlySearchWindowStartSample ?? child.impulse?.directArrival.earlySearchWindowStartSample ?? null,
        earlySearchWindowEndSample: child.diagnostics.earlySearchWindowEndSample ?? child.impulse?.directArrival.earlySearchWindowEndSample ?? null,
        topEarlyImpulsePeaks: child.diagnostics.topEarlyImpulsePeaks ?? child.impulse?.directArrival.topEarlyImpulsePeaks,
        strongestLaterReflectionDelayMs: child.diagnostics.strongestLaterReflectionDelayMs ?? child.impulse?.directArrival.strongestLaterReflectionDelayMs ?? null,
        localSupportWindowStartSample: child.diagnostics.localSupportWindowStartSample ?? child.impulse?.directArrival.localSupportWindowStartSample ?? null,
        localSupportWindowEndSample: child.diagnostics.localSupportWindowEndSample ?? child.impulse?.directArrival.localSupportWindowEndSample ?? null,
        localSupportWindowMax: child.diagnostics.localSupportWindowMax ?? child.impulse?.directArrival.localSupportWindowMax ?? null,
        localSupportSampleCount: child.diagnostics.localSupportSampleCount ?? child.impulse?.directArrival.localSupportSampleCount ?? null,
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
      const suppressRepairChannelDiagnostics = (diagnostics: MeasurementDiagnosticsValues, channel: 'left' | 'right'): MeasurementDiagnosticsValues => {
        const repairChannel = currentContext.repairChannel
        if ((repairChannel !== 'left' && repairChannel !== 'right') || repairChannel === channel) return diagnostics
        return {
          ...diagnostics,
          analysisStatus: 'not_measured',
          failureReason: null,
          syncMarkerFailureReason: null,
          snrEstimateDb: null,
          directArrivalMs: null,
          directArrivalRejectionReason: null,
        }
      }
      const leftDiagnostics = suppressRepairChannelDiagnostics(diagnosticsFor(result.left, 'left'), 'left')
      const rightDiagnostics = suppressRepairChannelDiagnostics(diagnosticsFor(result.right, 'right'), 'right')
      const compactLeftDiagnostics = compactMeasurementDiagnostics(leftDiagnostics)
      const compactRightDiagnostics = compactMeasurementDiagnostics(rightDiagnostics)
      takeDiagnostics.value = [...takeDiagnostics.value, {
        context: currentContext,
        capture: recording.diagnostics,
        left: leftDiagnostics,
        right: rightDiagnostics,
      }]
      const currentPositionCount = currentContext.positionCount
      const requiredChannels: readonly ('left' | 'right')[] = currentContext.repairChannel === 'left' || currentContext.repairChannel === 'right'
        ? [currentContext.repairChannel]
        : ['left', 'right']
      connection.send('measurement.diagnostics', {
        sessionId: operationSessionId,
        context: currentContext,
        current: progress.value.current,
        total: currentPositionCount,
        diagnostics: compactLeftDiagnostics,
      })
      connection.send('measurement.diagnostics', {
        sessionId: operationSessionId,
        context: currentContext,
        current: progress.value.current,
        total: currentPositionCount,
        diagnostics: compactRightDiagnostics,
      })

      const acceptedRecords = (child: MeasurementAnalysis, channel: 'left' | 'right'): MeasurementRecord[] =>
        currentContext.captureKind === 'position-composite' && child.status === 'ok' && child.correctedPoints.length > 1
          ? [{ context: currentContext, channel, analysis: child }]
          : []
      failedTakeDiagnostics.value = reconcileFailedTakeDiagnostics(
        failedTakeDiagnostics.value,
        currentContext,
        requiredChannels.map((channel) => ({
          channel,
          failed: result[channel].status !== 'ok',
          diagnostics: channel === 'left' ? leftDiagnostics : rightDiagnostics,
        })),
      )

      if (sessionMode === 'validation') {
        const nextRecords = requiredChannels.flatMap((channel) => acceptedRecords(result[channel], channel))
        const channelsToReplace = new Set(requiredChannels)
        validationRecords.value = [
          ...validationRecords.value.filter((record) =>
            record.context.positionId !== currentContext.positionId || !channelsToReplace.has(record.channel)),
          ...nextRecords,
        ]
        const analysisChannel = requiredChannels.find((channel) => result[channel].status === 'ok') ?? requiredChannels[0]
        validationAnalysis.value = analysisChannel === 'left' ? result.left : result.right
        rebuildValidationAggregates()
        const failedChannels = requiredChannels.filter((channel) => result[channel].status !== 'ok')
        const hasRequiredChannels = failedChannels.length === 0
        if (!hasRequiredChannels && currentContext.attemptIndex + 1 < currentContext.attemptCount) {
          const failedChannel = validationRepairChannel(failedChannels)
          if (!failedChannel) return
          const confirmation = {
            ...currentContext,
            repairChannel: failedChannel,
            attemptIndex: currentContext.attemptIndex + 1,
          }
          plan[planIndex] = confirmation
          activeContext.value = confirmation
          message.value = `Validation retry for the ${currentContext.positionId} position. Keep the phone still.`
          sendPrepare(confirmation)
          return
        }
        if (!hasRequiredChannels) {
          const failedChannel = failedChannels[0]
          if (!failedChannel) return
          await fail(analysisErrorCode(result[failedChannel].status), measurementFailureMessage(result[failedChannel]))
          return
        }
        progress.value = { current: Math.min(planIndex + 1, plan.length), total: plan.length }
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
      failedMeasurementAttemptCount.value = countFailedMeasurementAttempts(positionLedger)
      const acceptedRecordsInLedger = projectAcceptedRecords(positionLedger)
      const acceptedEvidenceChanged = hasNewAcceptedEvidence(acceptedChannelsBefore, acceptedRecordsInLedger.length)
      records.value = acceptedRecordsInLedger
      const projected = projectPhysicalPositionLedger(positionLedger)
      const acceptedPositionTotal = projected.positions.filter((position) => position.left.kind === 'accepted' && position.right.kind === 'accepted').length
      persistPositionCheckpoint()
      previousConvergencePoints = previousAggregatePoints
      analysis.value = result.left.status === 'ok' ? result.left : result.right
      progress.value = { current: acceptedPositionTotal, total: Math.max(progress.value.total, currentPositionCount) }
      if (result.status !== 'ok') {
        message.value = result.status === 'partial' && (currentContext.repairChannel === 'left' || currentContext.repairChannel === 'right')
          ? `The ${currentContext.repairChannel} channel was repaired. Continuing calibration.`
          : result.status === 'partial'
            ? 'Repeating this position. One channel reading was not clear enough.'
            : measurementFailureMessage(currentContext.repairChannel === 'left' ? result.left : result.right)
        sendProgress('preparing', message.value)
      }
      advanceAfterCapture(currentContext, acceptedEvidenceChanged)
    } catch (error: unknown) {
      if (!isCurrentOperation(operationGeneration, operationSessionId) || stage.value !== 'analyzing') return
      const debugCapture = debugCaptures.at(-1)
      if (debugCapture?.analysisStatus === null) {
        debugCaptures[debugCaptures.length - 1] = {
          ...debugCapture,
          analysisStatus: 'response_not_generated',
          analysisDiagnostics: { error: error instanceof Error ? error.message : 'Measurement analysis failed.' },
        }
      }
      await fail('response_not_generated', error instanceof Error ? error.message : 'Measurement analysis failed.')
    }
  }

  function measurementFailureMessage(result: MeasurementAnalysis): string {
    switch (result.diagnostics.syncMarkerFailureReason) {
      case 'leading_marker_weak':
        return 'The start marker was too weak to identify reliably. Retry this position without moving the phone.'
      case 'trailing_marker_weak':
        return 'The end marker was too weak to identify reliably. Retry this position without moving the phone.'
      case 'marker_pair_low_confidence':
        return 'The marker pair confidence was too low to trust. Retry this position without moving the phone.'
      case 'marker_pair_ambiguous':
        return 'Multiple marker pairs looked plausible, so the timing could not be trusted. Retry this position without moving the phone.'
      case 'marker_pair_bad_timing':
        return 'Marker peaks were found, but their separation did not match the known TV signal timing. Retry this position without moving the phone.'
    }
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
    if (result.status === 'direct_arrival_low_confidence' || result.status === 'impulse_not_found') {
      const ratio = result.diagnostics.directPeakToNoiseDb
      return ratio == null
        ? 'Capture synchronized, but the direct acoustic arrival was too weak to trust. Move the phone closer, reduce background noise, and retry.'
        : `Capture synchronized, but the direct acoustic arrival was too weak to trust (peak/noise ${ratio.toFixed(1)} dB). Move the phone closer or reduce background noise, then retry.`
    }
    if (result.status === 'response_not_generated') {
      return 'The synchronized capture did not produce a usable frequency response. Keep the phone still and retry.'
    }
    return 'Capture rejected because the sweep was not detected. Keep the phone still and try again.'
  }

  async function startLoudnessPreflightCapture(): Promise<void> {
    if (preflightCaptureActive || preflightCompletionStarted || !recorder || stage.value !== 'loudness') return
    preflightCaptureActive = true
    try {
      const start = recorder.start()
      preflightStart = start
      await start
      if (preflightStart === start) preflightStart = null
      if (disposed || stage.value !== 'loudness') {
        preflightCaptureActive = false
        preflightCompletionStarted = false
        return
      }
    } catch (error: unknown) {
      preflightCaptureActive = false
      preflightStart = null
      await fail('calibration_ui_failed', error instanceof Error ? error.message : 'Microphone preflight failed.')
    }
  }

  async function completeLoudnessPreflight(): Promise<void> {
    if (!preflightCaptureActive || preflightCompletionStarted || !recorder || stage.value !== 'loudness') return
    preflightCompletionStarted = true
    try {
      if (preflightStart) await preflightStart
      if (disposed || stage.value !== 'loudness') {
        preflightCaptureActive = false
        preflightCompletionStarted = false
        return
      }
      preflightCaptureActive = false
      const recording = await recorder.stop()
      captureDiagnostics.value = recording.diagnostics
      const preflightSampleRate = recording.diagnostics.sampleRate > 0
        ? recording.diagnostics.sampleRate
        : captureInfo.value?.settings.sampleRate ?? sweep?.sampleRate ?? 48_000
      const preflight = assessCaptureLevelPreflight(recording.samples, preflightSampleRate)
      const failure = preflight.failure
      if (failure !== null) {
        const messageText = failure === 'capture_clipped'
          ? 'Acoustic preflight clipped. Lower the TV volume or remove nearby noise before continuing.'
          : failure === 'capture_too_short'
            ? 'Acoustic preflight ended too early. Keep the TV pink noise running until the check completes.'
            : 'Acoustic preflight was too quiet. Check the TV route and listening volume before continuing.'
        await fail(failure, messageText)
        return
      }
      sessionSampleRate = preflightSampleRate
      preflightCompletionStarted = false
      loudnessComplete = true
      stage.value = 'preparing'
      message.value = 'Level preflight passed. The first center sweep will verify synchronization before the walkaround.'
      prepareNextContext()
    } catch (error: unknown) {
      preflightCaptureActive = false
      preflightStart = null
      await fail('calibration_ui_failed', error instanceof Error ? error.message : 'Acoustic preflight failed.')
    }
  }

  function continuePosition() {
    if (stage.value !== 'position-pause' || !preparedContext) return
    clearPositionKeepAlive()
    void startTake(preparedContext)
  }

  function finalOutcomeMessage(
    outcome: CalibrationSessionOutcome,
    mode: 'measurement' | 'validation' | 'probe',
    hadAnalysis: boolean,
    endedProbePlanKind: ProbePlanKind | null,
    failedMarkerProbePositions: readonly CalibrationPositionId[],
  ): string {
    if (outcome === 'cancelled') return 'Calibration cancelled.'
    if (outcome === 'error') return 'Calibration ended with an error. Review the diagnostics before retrying.'
    if (mode === 'measurement' && outcome === 'sufficient'
      && measurementQualityPassed.value && convergenceOutcome.value === 'sufficient') {
      return 'Advanced measurement complete. Review the response and room metrics below.'
    }
    if (outcome === 'bounded') {
      return 'Measurement finished, but convergence was not reached. The result is inconclusive and no correction was staged.'
    }
    if (outcome === 'insufficient') {
      return 'Measurement finished without enough usable evidence. No correction was generated.'
    }
    if (mode === 'validation') return 'Validation complete. Compare the measured result with the original response.'
    if (mode === 'probe' && isMarkerProbePlan(endedProbePlanKind)) {
      return failedMarkerProbePositions.length > 0
        ? `Diagnostic marker probe complete with ${failedMarkerProbePositions.length} failed physical position${failedMarkerProbePositions.length === 1 ? '' : 's'}: ${failedMarkerProbePositions.map((position) => `${position} position`).join(', ')}.`
        : 'Diagnostic marker probe complete. Review the marker timing diagnostics before changing the curve.'
    }
    if (mode === 'probe') {
      return probeCaptureQualityPassed.value
        ? 'Diagnostic probe complete. Export the captured response before changing the curve.'
        : `Diagnostic probe capture quality is inconclusive at ${spatialConsistencyFailureMessage(probeFailedRepeatabilityGroups.value)}.`
    }
    if (hadAnalysis && failedMeasurementAttemptCount.value > 0) {
      return `Calibration needs review. ${failedMeasurementAttemptCount.value} capture attempt${failedMeasurementAttemptCount.value === 1 ? '' : 's'} failed before a retry.`
    }
    return 'Calibration failed. Accepted position evidence was incomplete.'
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
      void startLoudnessPreflightCapture()
      return
    }
    if (env.type === 'calibrationSession.loudness.stopped' && sessionId && typeof env.payload === 'object' && env.payload !== null &&
      'sessionId' in env.payload && env.payload.sessionId === sessionId) {
      void completeLoudnessPreflight()
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
    if (env.type === 'calibrationSession.ended' && sessionId && isCalibrationSessionEndedPayload(env.payload) && env.payload.sessionId === sessionId) {
      const endedSessionId = sessionId
      const endedMode = sessionMode
      const endedOutcome = env.payload.outcome
      const endedProbePlanKind = probePlanKind
      const endedAbort = abortRecovery.value
      const hadMarkerProbeAnalysis = endedMode === 'probe'
        && isMarkerProbePlan(endedProbePlanKind)
        && takeDiagnostics.value.length > 0
      const hadAnalysis = hadMarkerProbeAnalysis || records.value.length > 0 || validationRecords.value.length > 0
      const failedMarkerProbePositions = hadMarkerProbeAnalysis
        ? probeSummary.value.failedPositionIds
        : []
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
      if (endedMode === 'measurement') {
        completedMeasurementId.value = endedSessionId
        if (hadAnalysis && positionLedger
          && acceptedPositionCount(positionLedger) >= 3
          && measurementQualityPassed.value
          && convergenceOutcome.value === 'sufficient') clearPersistedCheckpoint()
      }
      stage.value = (() => {
        if (endedOutcome === 'cancelled') return 'idle'
        if (endedOutcome === 'error') return 'error'
        if (hadAnalysis || endedOutcome === 'sufficient' || endedOutcome === 'bounded') return 'complete'
        return 'error'
      })()
      message.value = finalOutcomeMessage(
        endedOutcome,
        endedMode,
        hadAnalysis,
        endedProbePlanKind,
        failedMarkerProbePositions,
      )
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
      message.value = 'Waiting for the TV to remove the candidate and verify the original audio state.'
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
    convergenceOutcome: readonly(convergenceOutcome),
    debugCaptureExportEnabled: options.debugCaptureExport === true,
    exportDebugBundle,
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
    measurementQualityPassed,
    completeAcceptedPositionCount: completeAcceptedMeasurementPositionCount,
    failedMeasurementAttemptCount: readonly(failedMeasurementAttemptCount),
    spatialConsistencySummaries: readonly(spatialConsistencySummaries),
    failedRepeatabilityGroups: readonly(failedRepeatabilityGroups),
    probeCaptureQualityPassed,
    probeSummary: readonly(probeSummary),
    probeRepeatabilitySummaries: readonly(probeRepeatabilitySummaries),
    probeFailedRepeatabilityGroups: readonly(probeFailedRepeatabilityGroups),
    currentContext: readonly(activeContext),
    currentPosition,
    currentChannel,
    currentInstruction,
    progress: readonly(progress),
    estimatedRemainingSeconds: readonly(estimatedRemainingSeconds),
    captureDiagnostics,
    takeDiagnostics: readonly(takeDiagnostics),
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
