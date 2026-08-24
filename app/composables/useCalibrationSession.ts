import { computed, onScopeDispose, readonly, ref, shallowRef } from 'vue'
import type {
  CalibrationProgressStage,
  CalibrationErrorCode,
  Envelope,
  MeasurementContext,
  MeasurementDiagnosticsValues,
  MeasurementResponsePayload,
  MeasurementSweep,
} from '#shared/types/protocol'
import {
  CALIBRATION_ERROR_CODES,
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
  type AggregateResponse,
  type MeasurementRecord,
  type RepeatabilitySummary,
} from '../lib/audio/measurement/aggregation'
import type { MeasurementAnalysis } from '../lib/audio/measurement/response'
import {
  createMeasurementPlan,
  createMeasurementPlanForGroups,
  createThirdTakeContext,
  measurementGroupKey,
  positionForContext,
  type MeasurementGroup,
} from '../lib/audio/measurement/plan'
import { discoverMicCalibrationProfiles } from '../lib/audio/mics/registry'
import type { MicCalibrationProfile } from '../lib/audio/mics/types'

type Connection = {
  send: (type: string, payload?: unknown) => string
  onMessage: (handler: (env: Envelope) => void) => () => void
}

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
  if (status === 'capture_too_short') return 'capture_too_short'
  return 'signal_too_low'
}

function isSameContext(left: MeasurementContext | null, right: MeasurementContext | null): boolean {
  if (!left || !right) return left === right
  return left.positionId === right.positionId
    && left.positionIndex === right.positionIndex
    && left.positionCount === right.positionCount
    && left.channel === right.channel
    && left.takeIndex === right.takeIndex
    && left.takeCount === right.takeCount
    && left.phase === right.phase
}

function errorCode(value: unknown): CalibrationErrorCode {
  return CALIBRATION_ERROR_CODES.includes(value as CalibrationErrorCode)
    ? value as CalibrationErrorCode
    : 'invalid_session'
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
  const profiles = shallowRef<MicCalibrationProfile[]>([])
  const selectedProfileId = ref('')
  const profileError = ref('')
  const captureInfo = shallowRef<{
    settings: MicrophoneCapture['settings']
    capabilities: MicrophoneCapture['capabilities']
  } | null>(null)
  const progress = ref({ current: 0, total: 0 })
  const estimatedRemainingSeconds = ref<number | null>(null)

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
  let plan: MeasurementContext[] = []
  let planIndex = 0
  let sessionMode: 'measurement' | 'validation' = 'measurement'
  const retriedGroups = new Set<string>()
  const activeContext = shallowRef<MeasurementContext | null>(null)
  let preparedContext: MeasurementContext | null = null
  let invalidAttempts = 0
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
  const currentPosition = computed(() => activeContext.value ? positionForContext(activeContext.value) : null)
  const currentChannel = computed(() => {
    const channel = activeContext.value?.channel
    return channel === 'left' || channel === 'right' ? channel : null
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
    timeoutTimer = setTimeout(() => {
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

  function groupRecords(group: Pick<MeasurementContext, 'positionId' | 'channel'>): MeasurementRecord[] {
    const key = measurementGroupKey(group)
    return records.value.filter((record) => measurementGroupKey(record.context) === key)
  }

  function maybeScheduleThirdTake(context: MeasurementContext): boolean {
    if (sessionMode !== 'measurement' || context.takeIndex !== 1) return false
    const key = measurementGroupKey(context)
    if (retriedGroups.has(key)) return false
    const summary = calculateRepeatability(groupRecords(context))
    if (!summary || summary.passed) return false
    retriedGroups.add(key)
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

  async function fail(code: CalibrationErrorCode, text: string) {
    const currentSessionId = sessionId
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    if (currentSessionId) connection.send('calibrationSession.abort', { sessionId: currentSessionId, code })
    await closeCapture()
    sessionId = null
    sweep = null
    profile = null
    activeContext.value = null
    preparedContext = null
    estimatedRemainingSeconds.value = null
    stage.value = 'error'
    message.value = text
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
    const sweepSeconds = (sweep.preRollMs + sweep.durationMs + sweep.postRollMs) / 1000 + 2
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
    if (!sessionId) return
    preparedContext = null
    stage.value = 'preparing'
    setPreparingText(context)
    armTimeout()
    sendProgress('preparing')
    connection.send('measurement.prepare', {
      sessionId,
      channel: context.channel,
      context,
    })
  }

  function advanceAfterTake(
    currentContext: MeasurementContext,
    addedThirdTake = false,
    notice: string | null = null,
  ) {
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
      sendPrepare(next)
      stage.value = 'position-pause'
      message.value = 'Follow the instructions on the TV, then continue.'
      sendProgress('position-pause', positionForContext(next).instruction)
      activeContext.value = next
      clearPositionKeepAlive()
      positionKeepAlive = setInterval(() => {
        if (sessionId && preparedContext) {
          connection.send('measurement.prepare', {
            sessionId,
            channel: preparedContext.channel,
            context: preparedContext,
          })
        }
      }, 25_000)
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

  async function startTake(context: MeasurementContext) {
    if (!sessionId || !sweep || !recorder || disposed) return
    activeContext.value = context
    preparedContext = context
    try {
      await recorder.start()
      if (disposed || !sessionId) return
      stage.value = 'recording'
      message.value = 'Follow the instructions on the TV.'
      armTimeout()
      sendProgress('recording')
      connection.send('measurement.playSweep', { sessionId, context })
    } catch (error: unknown) {
      await fail('calibration_ui_failed', error instanceof Error ? error.message : 'Microphone recording failed.')
    }
  }

  function prepareNextContext() {
    const next = plan[planIndex]
    if (!next) {
      void finishMeasurement()
      return
    }
    const previous = activeContext.value
    activeContext.value = next
    sendPrepare(next)
    if (previous && previous.positionIndex !== next.positionIndex) {
      stage.value = 'preparing'
    }
  }

  async function finishMeasurement() {
    const currentSessionId = sessionId
    if (!currentSessionId) return
    await closeCapture()
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    if (sessionMode === 'validation') rebuildValidationAggregates()
    else rebuildAggregates()
    stage.value = 'ending'
    const failures = sessionMode === 'measurement' ? failedRepeatabilityGroups.value : []
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
    recorder = createPcmRecorder(capture, {
      onTrackEnded: () => {
        void fail('signal_too_low', 'The microphone ended during calibration.')
      },
    })
  }

  async function startMode(
    mode: 'measurement' | 'validation',
    retryGroups: readonly MeasurementGroup[] | null = null,
  ) {
    if (disposed || ['requesting-microphone', 'preparing', 'loudness', 'position-pause', 'recording', 'analyzing', 'ending'].includes(stage.value)) return
    sessionMode = mode
    if (mode === 'measurement') {
      analysis.value = null
      if (retryGroups && retryGroups.length > 0) {
        const retryKeys = new Set(retryGroups.map((group) => measurementGroupKey(group)))
        records.value = records.value.filter((record) => !retryKeys.has(measurementGroupKey(record.context)))
      } else {
        records.value = []
      }
      if (retryGroups && retryGroups.length > 0) rebuildAggregates()
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
    captureInfo.value = null
    retriedGroups.clear()
    plan = mode === 'validation'
      ? [
          { positionId: 'center', positionIndex: 0, positionCount: 1, channel: 'left', takeIndex: 0, takeCount: 1, phase: 'validation' },
          { positionId: 'center', positionIndex: 0, positionCount: 1, channel: 'right', takeIndex: 0, takeCount: 1, phase: 'validation' },
        ]
      : retryGroups && retryGroups.length > 0
        ? createMeasurementPlanForGroups(retryGroups)
        : createMeasurementPlan()
    progress.value = { current: 0, total: plan.length }
    estimatedRemainingSeconds.value = null
    planIndex = 0
    activeContext.value = null
    preparedContext = null
    invalidAttempts = 0
    loudnessRequested = false
    loudnessComplete = false
    stage.value = 'requesting-microphone'
    message.value = 'Loading microphone profiles…'
    try {
      await loadAndOpenCapture()
      sessionId = newSessionId()
      stage.value = 'preparing'
      message.value = 'Preparing the TV measurement. Follow the instructions on the TV.'
      armTimeout()
      connection.send('calibrationSession.begin', {
        sessionId,
        channel: 'both',
        phase: mode,
      })
      armSessionKeepAlive()
    } catch (error: unknown) {
      await closeCapture()
      sessionId = null
      profile = null
      stage.value = 'error'
      message.value = error instanceof Error ? error.message : 'Microphone access failed.'
    }
  }

  function start() {
    void startMode('measurement')
  }

  function startValidation() {
    void startMode('validation')
  }

  function retryFailedGroups() {
    if (stage.value !== 'complete' || sessionMode !== 'measurement') return
    const groups = failedRepeatabilityGroups.value.filter((summary): summary is RepeatabilitySummary & MeasurementGroup =>
      summary.channel === 'left' || summary.channel === 'right')
    if (groups.length === 0) return
    void startMode('measurement', groups)
  }

  async function onReady(payload: unknown) {
    if (!sessionId || !isMeasurementReadyPayload(payload) || payload.sessionId !== sessionId) return
    sweep = payload.sweep
    const context = payload.context
    if (!context || !isMeasurementContext(context)) {
      if (stage.value !== 'preparing') return
      if (sessionMode === 'measurement' && !loudnessRequested) {
        loudnessRequested = true
        stage.value = 'loudness'
        message.value = 'Follow the instructions on the TV.'
        sendProgress('loudness')
        connection.send('calibrationSession.loudness.start', { sessionId })
        return
      }
      if (loudnessComplete || sessionMode === 'validation') prepareNextContext()
      return
    }
    const wanted = plan[planIndex]
    if (!wanted || !isSameContext(context, wanted)) return
    preparedContext = context
    if (stage.value === 'position-pause') return
    await startTake(context)
  }

  async function onFinished(payload: unknown) {
    if (stage.value !== 'recording' || !sessionId || !sweep || !activeContext.value) return
    if (typeof payload !== 'object' || payload === null || !('sessionId' in payload) || payload.sessionId !== sessionId) return
    const context = 'context' in payload && isMeasurementContext(payload.context) ? payload.context : null
    if (context && !isSameContext(context, activeContext.value)) return
    const currentSweep = sweep
    const currentRecorder = recorder
    const currentProfile = profile
    const currentContext = activeContext.value
    const operationSessionId = sessionId
    if (!currentContext) return
    stage.value = 'analyzing'
    message.value = 'Follow the instructions on the TV.'
    sendProgress('analyzing')
    try {
      if (!currentRecorder) throw new Error('Microphone recorder is unavailable.')
      const recording = await currentRecorder.stop()
      if (sessionId !== operationSessionId || disposed || stage.value !== 'analyzing') return
      captureDiagnostics.value = recording.diagnostics
      const sampleRate = recording.diagnostics.sampleRate > 0
        ? recording.diagnostics.sampleRate
        : currentSweep.sampleRate
      if (!currentProfile) throw new Error('Microphone calibration profile is unavailable.')
      const result = await analyzeInWorker(recording.samples, sampleRate, currentSweep, currentProfile)
      if (sessionId !== operationSessionId || disposed || stage.value !== 'analyzing') return
      if (result.status !== 'ok') {
        if (invalidAttempts < 2) {
          invalidAttempts++
          message.value = `This sweep was rejected (${result.status.replaceAll('_', ' ')}). Repeating it…`
          sendPrepare(currentContext)
          return
        }
        if (sessionMode === 'validation') {
          await fail(analysisErrorCode(result.status), measurementFailureMessage(result))
          return
        }
        invalidAttempts = 0
        records.value = [...records.value, { context: currentContext, analysis: result }]
        progress.value = {
          current: progress.value.current + 1,
          total: progress.value.total,
        }
        advanceAfterTake(currentContext, false, measurementFailureMessage(result))
        return
      }
      invalidAttempts = 0
      const nextProgress = { current: progress.value.current + 1, total: progress.value.total }
      const diagnostics: MeasurementDiagnosticsValues = {
        signalRms: result.diagnostics.signalRms,
        signalPeak: result.diagnostics.signalPeak,
        snrEstimateDb: Number.isFinite(result.diagnostics.snrEstimateDb ?? Number.NaN) ? result.diagnostics.snrEstimateDb : null,
        detectionOffsetMs: Number.isFinite(result.diagnostics.detectionOffsetMs ?? Number.NaN) ? result.diagnostics.detectionOffsetMs : null,
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
      }
      connection.send('measurement.diagnostics', {
        sessionId: operationSessionId,
        context: currentContext,
        current: nextProgress.current,
        total: nextProgress.total,
        diagnostics,
      })
      if (sessionMode === 'validation') {
        validationAnalysis.value = result
        validationRecords.value = [...validationRecords.value, { context: currentContext, analysis: result }]
      } else {
        analysis.value = result
        records.value = [...records.value, { context: currentContext, analysis: result }]
      }
      progress.value = nextProgress
      const addedThirdTake = maybeScheduleThirdTake(currentContext)
      const finalGroupSummary = sessionMode === 'measurement' && currentContext.takeIndex === 2
        ? calculateRepeatability(groupRecords(currentContext))
        : null
      const finalGroupNotice = finalGroupSummary && !finalGroupSummary.passed
        ? `${currentContext.positionId} ${currentContext.channel} repeatability still failed: ${repeatabilityFailureMessage([finalGroupSummary])}`
        : null
      advanceAfterTake(currentContext, addedThirdTake, finalGroupNotice)
    } catch (error: unknown) {
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
    return 'Capture rejected because the sweep was not detected. Keep the phone still and try again.'
  }

  function continuePosition() {
    if (stage.value !== 'position-pause' || !preparedContext) return
    clearPositionKeepAlive()
    void startTake(preparedContext)
  }

  function onMessage(env: Envelope) {
    if (env.type === 'measurement.ready') {
      void onReady(env.payload)
      return
    }
    if (env.type === 'measurement.started' && stage.value === 'recording') {
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
      void fail(code, text)
      return
    }
    if (env.type === 'calibrationSession.ended' && sessionId && typeof env.payload === 'object' && env.payload !== null &&
      'sessionId' in env.payload && env.payload.sessionId === sessionId) {
      const hadAnalysis = records.value.length > 0 || validationRecords.value.length > 0
      clearTimeoutTimer()
      clearPositionKeepAlive()
      clearSessionKeepAlive()
      void closeCapture()
      sessionId = null
      sweep = null
      profile = null
      activeContext.value = null
      preparedContext = null
      estimatedRemainingSeconds.value = null
      stage.value = hadAnalysis ? 'complete' : 'idle'
      message.value = hadAnalysis
        ? sessionMode === 'validation'
          ? 'Validation complete. Compare the measured result with the original response.'
          : repeatabilityPassed.value
            ? 'Advanced measurement complete. Review the response and room metrics below.'
            : `Calibration failed. Measurements were not repeatable at ${repeatabilityFailureMessage(failedRepeatabilityGroups.value)}.`
        : 'Calibration cancelled.'
    }
  }

  const off = connection.onMessage(onMessage)

  function cancel() {
    if (!sessionId) {
      stage.value = 'idle'
      message.value = 'Calibration cancelled.'
      return
    }
    const currentSessionId = sessionId
    connection.send('calibrationSession.abort', { sessionId: currentSessionId, code: 'calibration_aborted' })
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    void closeCapture()
    sessionId = null
    sweep = null
    profile = null
    activeContext.value = null
    preparedContext = null
    estimatedRemainingSeconds.value = null
    stage.value = 'idle'
    message.value = 'Calibration cancelled.'
  }

  onScopeDispose(() => {
    disposed = true
    off()
    clearTimeoutTimer()
    clearPositionKeepAlive()
    clearSessionKeepAlive()
    if (sessionId) connection.send('calibrationSession.abort', { sessionId, code: 'calibration_aborted' })
    void closeCapture()
    sessionId = null
    sweep = null
    profile = null
    activeContext.value = null
    preparedContext = null
    estimatedRemainingSeconds.value = null
  })

  return {
    stage: readonly(stage),
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
    currentPosition,
    currentChannel,
    progress: readonly(progress),
    estimatedRemainingSeconds: readonly(estimatedRemainingSeconds),
    captureDiagnostics,
    captureInfo,
    profiles: readonly(profiles),
    selectedProfileId,
    profileError: readonly(profileError),
    loadProfiles,
    start,
    startValidation,
    retryFailedGroups,
    confirmLoudness: () => {
      if (stage.value !== 'loudness' || !sessionId || loudnessComplete) return
      stage.value = 'preparing'
      message.value = 'Follow the instructions on the TV.'
      armTimeout()
      sendProgress('preparing')
      connection.send('calibrationSession.loudness.stop', { sessionId })
    },
    continuePosition,
    cancel,
  }
}
