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
  calculateRepeatability,
  decideAdaptiveTake,
  decideInvalidTake,
  type AggregateResponse,
  type MeasurementRecord,
  type RepeatabilitySummary,
} from '../lib/audio/measurement/aggregation'
import type { MeasurementAnalysis } from '../lib/audio/measurement/response'
import {
  createMeasurementPlan,
  createMeasurementPlanForGroups,
  createProbeMeasurementPlan,
  createRetryContext,
  createThirdTakeContext,
  measurementGroupKey,
  positionForContext,
  requiresRemoteContinue,
  type MeasurementGroup,
  type ProbePlanKind,
} from '../lib/audio/measurement/plan'
import { sweepSampleParts } from '../lib/audio/sweep-reference'
import { discoverMicCalibrationProfiles } from '../lib/audio/mics/registry'
import type { MicCalibrationProfile } from '../lib/audio/mics/types'
import {
  isCalibrationOperationCurrent,
  isSameMeasurementContext,
} from '../lib/audio/measurement/session-guard'
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

const ABORT_RECOVERY_POLL_INTERVAL_MS = 400

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

export function useCalibrationSession(connection: Connection) {
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
  let sessionMode: 'measurement' | 'validation' | 'probe' = 'measurement'
  let probePlanKind: ProbePlanKind | null = null
  const activeContext = shallowRef<MeasurementContext | null>(null)
  let preparedContext: MeasurementContext | null = null
  let takeStartInFlightGeneration: number | null = null
  let loudnessRequested = false
  let loudnessComplete = false

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
    const channel = activeContext.value?.channel
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

  function sessionRecords(): readonly MeasurementRecord[] {
    return sessionMode === 'validation' ? validationRecords.value : records.value
  }

  function groupRecords(group: Pick<MeasurementContext, 'positionId' | 'channel'>): MeasurementRecord[] {
    const key = measurementGroupKey(group)
    return sessionRecords().filter((record) => measurementGroupKey(record.context) === key)
  }

  function maybeScheduleThirdTake(context: MeasurementContext): boolean {
    const decision = decideAdaptiveTake(sessionRecords(), context)
    if (decision.kind !== 'schedule-third') return false
    plan.splice(planIndex + 1, 0, createThirdTakeContext(context))
    progress.value = { ...progress.value, total: progress.value.total + 1 }
    return true
  }

  function repeatabilityFailureMessage(groups: readonly RepeatabilitySummary[]): string {
    if (groups.length === 0) return ''
    return groups.map((group) => {
      if (group.failureReason === 'insufficient_takes') {
        const failedTakes = group.failedTakeIndices.map((index) => index + 1).join(', ')
        return `${group.positionId} ${group.channel} channel (only ${group.takeCount}/${group.expectedTakeCount} valid takes; failed take${group.failedTakeIndices.length === 1 ? '' : 's'} ${failedTakes})`
      }
      return `${group.positionId} ${group.channel} channel (median ${group.medianSpreadDb.toFixed(1)} dB, max ${group.maxSpreadDb.toFixed(1)} dB, ${Math.round(group.withinTwoDbFraction * 100)}% within 2 dB)`
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
      connection.send('calibrationSession.abort', { sessionId: currentSessionId, code })
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

  function advanceAfterTake(
    currentContext: MeasurementContext,
    addedThirdTake = false,
    notice: string | null = null,
  ) {
    const operationGeneration = sessionGeneration
    const operationSessionId = sessionId
    if (!isCurrentOperation(operationGeneration, operationSessionId)) return
    planIndex++
    if (sessionMode === 'validation') rebuildValidationAggregates()
    else rebuildAggregates()
    if (sessionMode === 'measurement') sendResponseGraph(progress.value.current, progress.value.total)
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
    if (notice) {
      message.value = notice
      sendProgress('preparing', notice)
    } else if (addedThirdTake) {
      message.value = `${currentContext.positionId} ${currentContext.channel} measurements were borderline. Adding one repeat to check them.`
      sendProgress('preparing', message.value)
    }
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
    retryGroups: readonly MeasurementGroup[] | null = null,
    candidateId: string | null = null,
    nextProbePlanKind: ProbePlanKind | null = null,
  ) {
    if (disposed || ['requesting-microphone', 'preparing', 'loudness', 'position-pause', 'recording', 'analyzing', 'ending'].includes(stage.value)) return
    if (abortRecovery.value.state === 'pending' || abortRecovery.value.state === 'awaiting-readback') return
    if (mode === 'validation' && !candidateId) {
      stage.value = 'error'
      message.value = 'Validation requires a pending calibration candidate.'
      return
    }
    sessionMode = mode
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
      if (mode === 'measurement' && retryGroups && retryGroups.length > 0) {
        const retryKeys = new Set(retryGroups.map((group) => measurementGroupKey(group)))
        records.value = records.value.filter((record) => !retryKeys.has(measurementGroupKey(record.context)))
      } else {
        records.value = []
      }
      if (mode === 'measurement' && retryGroups && retryGroups.length > 0) rebuildAggregates()
      else {
        aggregateLeft.value = null
        aggregateRight.value = null
        aggregateBoth.value = null
      }
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
          { positionId: 'center', positionIndex: 0, positionCount: 1, channel: 'left' },
          { positionId: 'center', positionIndex: 0, positionCount: 1, channel: 'right' },
        ], 'validation')
      : mode === 'probe'
        ? createProbeMeasurementPlan(probePlanKind as ProbePlanKind)
        : retryGroups && retryGroups.length > 0
          ? createMeasurementPlanForGroups(retryGroups)
          : createMeasurementPlan()
    progress.value = { current: 0, total: plan.length }
    estimatedRemainingSeconds.value = null
    planIndex = 0
    activeContext.value = null
    preparedContext = null
    loudnessRequested = false
    loudnessComplete = false
    stage.value = 'requesting-microphone'
    message.value = 'Loading microphone profiles…'
    try {
      await loadAndOpenCapture()
      if (disposed || operationGeneration !== sessionGeneration) {
        await closeCapture()
        return
      }
      sessionId = newSessionId()
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

  function startValidation(candidateId: string) {
    void startMode('validation', null, candidateId)
  }

  function startProbe(kind: ProbePlanKind) {
    void startMode('probe', null, null, kind)
  }

  function retryFailedGroups() {
    if (stage.value !== 'complete' || sessionMode !== 'measurement') return
    const groups = failedRepeatabilityGroups.value.filter((summary): summary is RepeatabilitySummary & MeasurementGroup =>
      summary.channel === 'left' || summary.channel === 'right')
    if (groups.length === 0) return
    void startMode('measurement', groups)
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
      const nextProgress = { current: progress.value.current + 1, total: progress.value.total }
      const diagnostics: MeasurementDiagnosticsValues = {
        analysisStatus: result.status,
        failureReason: result.diagnostics.failureReason,
        signalRms: result.diagnostics.signalRms,
        signalPeak: result.diagnostics.signalPeak,
        snrEstimateDb: Number.isFinite(result.diagnostics.snrEstimateDb ?? Number.NaN) ? result.diagnostics.snrEstimateDb : null,
        detectionOffsetMs: Number.isFinite(result.diagnostics.detectionOffsetMs ?? Number.NaN) ? result.diagnostics.detectionOffsetMs : null,
        envelopeOnlyOffsetMs: Number.isFinite(result.diagnostics.envelopeOnlyOffsetMs ?? Number.NaN) ? result.diagnostics.envelopeOnlyOffsetMs : null,
        syncMarkerConfidence: result.diagnostics.detectionConfidence,
        endingMarkerConfidence: result.diagnostics.endingMarkerConfidence,
        clockDriftPpm: Number.isFinite(result.diagnostics.clockDriftPpm ?? Number.NaN) ? result.diagnostics.clockDriftPpm : null,
        clipped: result.diagnostics.clipped,
        clippedSamples: result.diagnostics.clippedSamples,
        directArrivalMs: result.room?.directArrivalMs ?? null,
        directToLateDb: result.room?.directToLateDb ?? null,
        c50Db: result.room?.c50Db ?? null,
        c80Db: result.room?.c80Db ?? null,
        edtMs: result.room?.edtMs ?? null,
        t20Ms: result.room?.t20Ms ?? null,
        t30Ms: result.room?.t30Ms ?? null,
        earlyReflections: result.room?.earlyReflections.length ?? 0,
        decayConfidence: result.room?.decayConfidence ?? 'low',
        ...(captureMetadata.value ? { captureMetadata: captureMetadata.value } : {}),
      }
      if (!isCurrentOperation(operationGeneration, operationSessionId) || stage.value !== 'analyzing') return
      connection.send('measurement.diagnostics', {
        sessionId: operationSessionId,
        context: currentContext,
        current: result.status === 'ok' ? nextProgress.current : progress.value.current,
        total: nextProgress.total,
        diagnostics,
      })
      if (result.status !== 'ok') {
        const invalidDecision = decideInvalidTake(currentContext.attemptIndex)
        const retryContext = invalidDecision.kind === 'retry' ? createRetryContext(currentContext) : null
        if (retryContext) {
          plan[planIndex] = retryContext
          activeContext.value = retryContext
          message.value = `${retryContext.positionId} ${retryContext.channel} channel · Take ${retryContext.takeIndex + 1} of ${retryContext.takeCount}\n` +
            `Retry ${retryContext.attemptIndex} of ${retryContext.attemptCount - 1}\n` +
            `Previous attempt rejected: ${result.status.replaceAll('_', ' ')}`
          sendPrepare(retryContext)
          return
        }
        if (sessionMode === 'validation') {
          failedTakeDiagnostics.value = [...failedTakeDiagnostics.value, { context: currentContext, diagnostics }]
          await fail(analysisErrorCode(result.status), measurementFailureMessage(result))
          return
        }
        failedTakeDiagnostics.value = [...failedTakeDiagnostics.value, { context: currentContext, diagnostics }]
        records.value = [...records.value, { context: currentContext, analysis: result }]
        progress.value = nextProgress
        advanceAfterTake(currentContext, false, measurementFailureMessage(result))
        return
      }
      if (sessionMode === 'validation') {
        validationAnalysis.value = result
        validationRecords.value = [...validationRecords.value, { context: currentContext, analysis: result }]
      } else {
        analysis.value = result
        records.value = [...records.value, { context: currentContext, analysis: result }]
      }
      progress.value = nextProgress
      const addedThirdTake = maybeScheduleThirdTake(currentContext)
      const finalGroupSummary = (sessionMode === 'measurement' || sessionMode === 'probe') && currentContext.takeIndex === 2
        ? calculateRepeatability(groupRecords(currentContext))
        : null
      const finalGroupNotice = finalGroupSummary && !finalGroupSummary.passed
        ? `${currentContext.positionId} ${currentContext.channel} repeatability still failed: ${repeatabilityFailureMessage([finalGroupSummary])}`
        : null
      advanceAfterTake(currentContext, addedThirdTake, finalGroupNotice)
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
      if (endedMode === 'measurement' && hadAnalysis) completedMeasurementId.value = endedSessionId
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
    profiles: readonly(profiles),
    selectedProfileId,
    profileError: readonly(profileError),
    loadProfiles,
    start,
    startValidation,
    startProbe,
    retryFailedGroups,
    cancel,
    observeAbortRecoverySnapshot,
  }
}
