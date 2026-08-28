import { computed, onScopeDispose, readonly, ref, shallowRef, watch } from 'vue'
import type {
  CalibrationCaptureMetadata,
  CalibrationCaptureFrameMetadata,
  CalibrationMicrophoneProfilePayload,
  CalibrationJobView,
  CalibrationNextAction,
  CalibrationPositionId,
  Envelope,
} from '../../../shared/types/protocol'
import { isCalibrationJobView } from '../../../shared/types/protocol'
import {
  encodeCaptureBegin,
  encodeCaptureChunk,
  encodeCaptureEnd,
  type CalibrationCaptureStreamMetadata,
} from '../../../shared/transport/captureStream'
import { discoverMicCalibrationProfiles } from '../../lib/audio/mics/registry'
import { isMicCalibrationProfileEligibleForCorrection } from '../../lib/audio/mics/profile'
import type { MicCalibrationProfile } from '../../lib/audio/mics/types'
import { closeMicrophone, openMicrophone, type MicrophoneCapture } from '../../lib/audio/capture/microphone'
import { createPcmRecorder, type PcmRecorder } from '../../lib/audio/capture/pcm-recorder'
import { Sha256 } from '../../lib/transport/sha256'
import type { DirectConnectionState } from '../../lib/transport/types'
import { useScreenWakeLock } from '../ui/useScreenWakeLock'

export type RemoteMicCaptureState = 'idle' | 'opening' | 'recording' | 'uploading' | 'waiting' | 'error'

export interface CalibrationRemoteMicConnection {
  send(type: string, payload?: unknown): string
  sendCaptureFrame(data: ArrayBuffer): Promise<void>
  sessionId?(): string | null
  onMessage(handler: (env: Envelope) => void): () => void
  onStateChange?(handler: (state: DirectConnectionState) => void): () => void
}

interface CalibrationRemoteMicDependencies {
  openMicrophone: typeof openMicrophone
  closeMicrophone: typeof closeMicrophone
  createPcmRecorder: typeof createPcmRecorder
  discoverMicCalibrationProfiles: typeof discoverMicCalibrationProfiles
  now: () => number
}

export interface CalibrationRemoteMicOptions {
  dependencies?: Partial<CalibrationRemoteMicDependencies>
  defaultProfileId?: string
}

export interface CalibrationCaptureBuildInput {
  jobId: string
  action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>
  captureSettings: MicrophoneCapture['settings']
  sampleRate: number
  sampleCount: number
  contentSha256: string
  microphoneProfile: MicCalibrationProfile
  capturedAtMs: number
}

export interface CalibrationCaptureBuildResult {
  metadata: CalibrationCaptureMetadata
  readyType: 'calibration.capture.ready' | 'calibration.validation.capture.ready'
  readyPayload:
    | { jobId: string; captureId: string }
    | { jobId: string; captureId: string; candidateId: string }
}

interface CalibrationCaptureBaseInput {
  jobId: string
  action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>
  captureSettings: MicrophoneCapture['settings']
  sampleRate: number
  microphoneProfile: MicCalibrationProfile
  capturedAtMs: number
}

interface ActiveCaptureStream {
  sessionId: string
  captureId: string
  metadata: CalibrationCaptureStreamMetadata
  hash: Sha256
  sampleCount: number
  byteCount: number
  sequence: number
  beginPromise: Promise<void>
  cancelled: boolean
}

const DEFAULT_PROFILE_ID = 'apple_iphone17pro_2025'
const CAPTURE_ACK_TIMEOUT_MS = 30_000

const defaultDependencies: CalibrationRemoteMicDependencies = {
  openMicrophone,
  closeMicrophone,
  createPcmRecorder,
  discoverMicCalibrationProfiles,
  now: () => Date.now(),
}

function profileForId(
  profiles: readonly MicCalibrationProfile[],
  profileId: string,
): MicCalibrationProfile | null {
  return profiles.find((candidate) => candidate.id === profileId
    && isMicCalibrationProfileEligibleForCorrection(candidate)) ?? null
}

function validSampleRate(value: number): boolean {
  return Number.isInteger(value) && value >= 8_000 && value <= 192_000
}

function validSampleCount(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

function actionPosition(action: CalibrationNextAction): CalibrationPositionId {
  return action.positionId
}

function microphoneProfilePayload(profile: MicCalibrationProfile): CalibrationMicrophoneProfilePayload {
  return {
    id: profile.id,
    revision: profile.sourceDate,
    capturePathStatus: profile.capturePathStatus,
    frequenciesHz: profile.points.map((point) => point.frequencyHz),
    responseDb: profile.points.map((point) => point.responseDb),
    normalizeAtHz: profile.normalizeAtHz,
    trustMinHz: profile.trust.minHz,
    trustFullMaxHz: profile.trust.fullTrustMaxHz,
    trustTaperToHz: profile.trust.taperToHz,
  }
}

function buildCalibrationCaptureBase(input: CalibrationCaptureBaseInput): CalibrationCaptureStreamMetadata {
  if (!validSampleRate(input.sampleRate)) throw new RangeError('The microphone reported an unsupported sample rate.')
  const channel = input.action.kind === 'capture' ? input.action.channel : 'both'
  return {
    jobId: input.jobId,
    captureId: input.action.captureId,
    positionId: actionPosition(input.action),
    attemptIndex: input.action.attemptIndex,
    channel,
    sampleRate: input.sampleRate,
    channelCount: 1,
    settings: {
      echoCancellation: input.captureSettings.echoCancellation,
      noiseSuppression: input.captureSettings.noiseSuppression,
      autoGainControl: input.captureSettings.autoGainControl,
    },
    userAgent: typeof navigator === 'undefined' ? 'unknown-browser' : navigator.userAgent,
    microphoneProfileId: input.microphoneProfile.id,
    microphoneProfileRevision: input.microphoneProfile.sourceDate,
    microphoneProfile: microphoneProfilePayload(input.microphoneProfile),
    capturedAtMs: input.capturedAtMs,
  }
}

export function buildCalibrationCapture(
  input: CalibrationCaptureBuildInput,
): CalibrationCaptureBuildResult {
  if (!validSampleRate(input.sampleRate)) throw new RangeError('The microphone reported an unsupported sample rate.')
  if (!validSampleCount(input.sampleCount)) throw new RangeError('The microphone returned no samples.')
  if (!/^[a-f0-9]{64}$/i.test(input.contentSha256)) throw new TypeError('The PCM hash is invalid.')
  const metadata: CalibrationCaptureMetadata = {
    ...buildCalibrationCaptureBase(input),
    sampleCount: input.sampleCount,
    byteCount: input.sampleCount * 4,
  }
  if (input.action.kind === 'capture') {
    return {
      metadata,
      readyType: 'calibration.capture.ready',
      readyPayload: { jobId: metadata.jobId, captureId: metadata.captureId },
    }
  }
  return {
    metadata,
    readyType: 'calibration.validation.capture.ready',
    readyPayload: {
      jobId: metadata.jobId,
      captureId: metadata.captureId,
      candidateId: input.action.candidateId,
    },
  }
}

function jobStateIsCurrent(current: CalibrationJobView | null, next: CalibrationJobView): boolean {
  if (!current) return true
  if (next.jobId !== current.jobId) {
    return (current.phase === 'complete' || current.phase === 'failed' || current.phase === 'cancelled')
      && next.createdAtMs >= current.createdAtMs
  }
  return next.revision > current.revision || (next.revision === current.revision && next === current)
}

export function acceptCalibrationJobState(
  current: CalibrationJobView | null,
  incoming: unknown,
): CalibrationJobView | null {
  if (!isCalibrationJobView(incoming)) return current
  return jobStateIsCurrent(current, incoming) ? incoming : current
}

export function encodeCalibrationPcm(samples: Float32Array): ArrayBuffer {
  const result = new ArrayBuffer(samples.byteLength)
  const view = new DataView(result)
  samples.forEach((sample, index) => view.setFloat32(index * 4, sample, true))
  return result
}

export function useCalibrationRemoteMic(
  connection: CalibrationRemoteMicConnection,
  options: CalibrationRemoteMicOptions = {},
) {
  const dependencies: CalibrationRemoteMicDependencies = { ...defaultDependencies, ...options.dependencies }
  const job = shallowRef<CalibrationJobView | null>(null)
  const captureState = ref<RemoteMicCaptureState>('idle')
  const captureError = ref('')
  const captureMetadata = shallowRef<CalibrationCaptureMetadata | null>(null)
  const profiles = shallowRef<MicCalibrationProfile[]>([])
  const selectedProfileId = ref(options.defaultProfileId ?? DEFAULT_PROFILE_ID)
  const profileError = ref('')
  const screenWakeLock = useScreenWakeLock()
  const busy = computed(() => captureState.value === 'opening'
    || captureState.value === 'recording'
    || captureState.value === 'uploading')

  const stopWakeLockWatch = watch(captureState, (state) => {
    screenWakeLock.setActive(state === 'opening'
      || state === 'recording'
      || state === 'uploading'
      || state === 'waiting')
  }, { immediate: true })

  let disposed = false
  let capture: MicrophoneCapture | null = null
  let recorder: PcmRecorder | null = null
  let activeAction: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }> | null = null
  let activeJobId: string | null = null
  let preparedActionKey: string | null = null
  let armed = false
  let profileLoadPromise: Promise<MicCalibrationProfile[]> | null = null
  let activeStream: ActiveCaptureStream | null = null
  let retryCapture: { jobId: string; action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }> } | null = null
  let completionInFlight: Promise<void> | null = null
  let captureAckTimer: ReturnType<typeof setTimeout> | null = null

  function clearCaptureAckTimer(): void {
    if (captureAckTimer === null) return
    clearTimeout(captureAckTimer)
    captureAckTimer = null
  }

  function waitForCaptureAcknowledgement(
    jobId: string,
    action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>,
  ): void {
    clearCaptureAckTimer()
    captureAckTimer = setTimeout(() => {
      captureAckTimer = null
      if (captureState.value !== 'waiting'
        || retryCapture?.jobId !== jobId
        || retryCapture.action.captureId !== action.captureId) return
      captureState.value = 'error'
      captureError.value = 'The TV did not confirm this recording. Reconnect, then retry this capture.'
    }, CAPTURE_ACK_TIMEOUT_MS)
  }

  async function loadProfiles(): Promise<MicCalibrationProfile[]> {
    if (profiles.value.length > 0) return profiles.value
    if (profileLoadPromise) return profileLoadPromise
    profileLoadPromise = dependencies.discoverMicCalibrationProfiles()
      .then((loaded) => {
        const eligible = loaded.filter(isMicCalibrationProfileEligibleForCorrection)
        if (eligible.length === 0) {
          throw new Error('No validated microphone profile is available for automatic correction.')
        }
        profiles.value = eligible
        if (!eligible.some((candidate) => candidate.id === selectedProfileId.value)) {
          selectedProfileId.value = eligible[0]?.id ?? ''
        }
        profileError.value = ''
        return eligible
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

  function selectProfile(profileId: string): void {
    if (busy.value || !profiles.value.some((profile) => profile.id === profileId)) return
    selectedProfileId.value = profileId
  }

  async function disposeCapture(): Promise<void> {
    const currentRecorder = recorder
    const currentCapture = capture
    const currentStream = activeStream
    if (currentStream) currentStream.cancelled = true
    recorder = null
    capture = null
    activeStream = null
    activeAction = null
    activeJobId = null
    preparedActionKey = null
    if (currentRecorder) await currentRecorder.dispose()
    if (currentCapture) dependencies.closeMicrophone(currentCapture)
  }

  function handleTransportState(state: DirectConnectionState): void {
    if ((state !== 'reconnecting' && state !== 'failed') || !activeStream || !activeAction || completionInFlight) return
    retryCapture = {
      jobId: activeJobId ?? job.value?.jobId ?? '',
      action: activeAction,
    }
    captureState.value = 'error'
    captureError.value = 'Connection interrupted during this capture. Reconnect, then retry this capture without moving the phone.'
    void disposeCapture()
  }

  function isCurrentAction(action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>): boolean {
    const current = job.value?.nextAction
    return armed
      && current !== null
      && current !== undefined
      && current.kind === action.kind
      && current.captureId === action.captureId
      && current.positionId === action.positionId
  }

  async function prepareCapture(action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>): Promise<void> {
    const key = `${job.value?.jobId ?? ''}:${action.captureId}`
    if (!armed || preparedActionKey === key || busy.value || disposed) return
    preparedActionKey = key
    activeAction = action
    activeJobId = job.value?.jobId ?? null
    retryCapture = { jobId: activeJobId ?? '', action }
    captureState.value = 'opening'
    captureError.value = ''
    try {
      const loadedProfiles = await loadProfiles()
      const profile = profileForId(loadedProfiles, selectedProfileId.value)
      if (!profile) throw new Error('Select a microphone profile before calibration.')
      const opened = await dependencies.openMicrophone()
      let resolveStreamReady: (stream: ActiveCaptureStream) => void = () => undefined
      const streamReady = new Promise<ActiveCaptureStream>((resolve) => {
        resolveStreamReady = resolve
      })
      const createdRecorder = dependencies.createPcmRecorder(opened, {
        onTrackEnded: () => {
          captureError.value = 'The microphone ended during calibration.'
          void cancelCapture().then(() => {
            captureState.value = 'error'
          })
        },
        retainSamples: false,
        onChunk: async (samples) => {
          const stream = await streamReady
          if (stream.cancelled) return
          const pcm = encodeCalibrationPcm(samples)
          stream.hash.update(pcm)
          stream.sampleCount += samples.length
          stream.byteCount += pcm.byteLength
          const sequence = stream.sequence
          stream.sequence++
          await stream.beginPromise
          if (stream.cancelled) return
          await connection.sendCaptureFrame(encodeCaptureChunk({
            sessionId: stream.sessionId,
            captureId: stream.captureId,
            sequence,
            sampleCount: samples.length,
            pcm,
          }))
        },
      })
      capture = opened
      recorder = createdRecorder
      await createdRecorder.start()
      if (!isCurrentAction(action)) {
        await disposeCapture()
        captureState.value = 'idle'
        return
      }
      const sampleRate = Math.round(createdRecorder.sampleRate() ?? opened.settings.sampleRate ?? 0)
      const stream: ActiveCaptureStream = {
        sessionId: connection.sessionId?.() ?? 'browser-session',
        captureId: action.captureId,
        metadata: buildCalibrationCaptureBase({
          jobId: activeJobId ?? job.value?.jobId ?? '',
          action,
          captureSettings: opened.settings,
          sampleRate,
          microphoneProfile: profile,
          capturedAtMs: dependencies.now(),
        }),
        hash: new Sha256(),
        sampleCount: 0,
        byteCount: 0,
        sequence: 0,
        beginPromise: Promise.resolve(),
        cancelled: false,
      }
      activeStream = stream
      captureState.value = 'recording'
      if (action.kind === 'capture') {
        connection.send('calibration.capture.ready', {
          jobId: job.value?.jobId ?? '',
          captureId: action.captureId,
        })
      } else {
        connection.send('calibration.validation.capture.ready', {
          jobId: job.value?.jobId ?? '',
          captureId: action.captureId,
          candidateId: action.candidateId,
        })
      }
      stream.beginPromise = connection.sendCaptureFrame(encodeCaptureBegin({
        sessionId: stream.sessionId,
        captureId: stream.captureId,
        metadata: stream.metadata,
        expectedSampleCount: null,
        expectedByteCount: null,
      }))
      stream.beginPromise.catch(() => undefined)
      resolveStreamReady(stream)
    } catch (error: unknown) {
      await disposeCapture()
      captureState.value = 'error'
      captureError.value = error instanceof Error ? error.message : 'Microphone capture could not start.'
    }
  }

  async function completeCapture(): Promise<void> {
    if (completionInFlight || !recorder || !capture || !activeAction || !activeStream || disposed) return
    const action = activeAction
    const stream = activeStream
    completionInFlight = (async () => {
      captureState.value = 'uploading'
      try {
        const recording = await recorder?.stop()
        if (!recording || recording.diagnostics.sampleCount === 0 || stream.sampleCount === 0) {
          throw new Error('The microphone returned no samples.')
        }
        if (stream.cancelled || activeStream !== stream) return
        const sampleRate = Math.round(recording.diagnostics.sampleRate)
        if (sampleRate !== stream.metadata.sampleRate) {
          throw new Error('The microphone sample rate changed during capture. Retry this capture.')
        }
        const profile = profileForId(profiles.value, selectedProfileId.value)
        if (!profile) throw new Error('The selected microphone profile is no longer available.')
        const hash = stream.hash.digestHex()
        if (stream.byteCount !== stream.sampleCount * 4) throw new Error('The capture byte count is invalid.')
        const built = buildCalibrationCapture({
          jobId: activeJobId ?? job.value?.jobId ?? '',
          action,
          captureSettings: capture.settings,
          sampleRate,
          sampleCount: stream.sampleCount,
          contentSha256: hash,
          microphoneProfile: profile,
          capturedAtMs: stream.metadata.capturedAtMs,
        })
        captureMetadata.value = built.metadata
        const finalMetadata: CalibrationCaptureFrameMetadata = { ...built.metadata, contentSha256: hash }
        await connection.sendCaptureFrame(encodeCaptureEnd({
          sessionId: stream.sessionId,
          captureId: stream.captureId,
          chunkCount: stream.sequence,
          finalSampleCount: stream.sampleCount,
          finalByteCount: stream.byteCount,
          finalSha256: hash,
          metadata: finalMetadata,
        }))
        if (stream.cancelled || activeStream !== stream) return
        const jobId = activeJobId ?? job.value?.jobId ?? ''
        retryCapture = { jobId, action }
        captureState.value = 'waiting'
        waitForCaptureAcknowledgement(jobId, action)
      } catch (error: unknown) {
        if (stream.cancelled) return
        clearCaptureAckTimer()
        retryCapture = {
          jobId: activeJobId ?? job.value?.jobId ?? '',
          action,
        }
        captureState.value = 'error'
        captureError.value = error instanceof Error
          ? error.message
          : 'The calibration recording could not reach the TV. Retry this capture without moving the phone.'
      } finally {
        await disposeCapture()
        completionInFlight = null
      }
    })()
    await completionInFlight
  }

  function retryUpload(): void {
    const retry = retryCapture
    if (!retry || captureState.value === 'uploading' || disposed) return
    clearCaptureAckTimer()
    armed = true
    preparedActionKey = null
    captureError.value = ''
    captureMetadata.value = null
    void prepareCapture(retry.action)
  }

  function startNewJob(mode: 'auto' | 'advanced' = 'auto'): void {
    if (busy.value || disposed) return
    armed = true
    retryCapture = null
    clearCaptureAckTimer()
    captureMetadata.value = null
    captureError.value = ''
    connection.send('calibration.job.start', { mode })
  }

  function resumeJob(): void {
    if (busy.value || disposed) return
    armed = true
    clearCaptureAckTimer()
    captureError.value = ''
    connection.send('calibration.job.get', job.value ? { jobId: job.value.jobId } : {})
    const action = job.value?.nextAction
    if (action?.kind === 'capture' || action?.kind === 'validate') void prepareCapture(action)
  }

  function refreshJob(): void {
    if (disposed) return
    connection.send('calibration.job.get', job.value ? { jobId: job.value.jobId } : {})
  }

  async function cancelCapture(): Promise<void> {
    const currentJob = job.value
    const currentAction = activeAction ?? retryCapture?.action
    const currentJobId = currentJob?.jobId ?? activeJobId ?? retryCapture?.jobId
    armed = false
    retryCapture = null
    clearCaptureAckTimer()
    if (currentJobId && currentAction) {
      connection.send('calibration.job.cancel', {
        jobId: currentJobId,
        scope: 'capture',
        captureId: currentAction.captureId,
      })
    }
    await disposeCapture()
    captureState.value = 'idle'
  }

  async function cancelOptionalRefinement(): Promise<void> {
    armed = false
    retryCapture = null
    clearCaptureAckTimer()
    const currentJob = job.value
    if (currentJob) connection.send('calibration.job.cancel', { jobId: currentJob.jobId, scope: 'optional_refinement' })
    await disposeCapture()
    captureState.value = 'idle'
  }

  function finishWithBest(): void {
    const currentJob = job.value
    if (!currentJob?.minimumViableCalibration) return
    armed = false
    retryCapture = null
    clearCaptureAckTimer()
    void disposeCapture()
    connection.send('calibration.job.finish', { jobId: currentJob.jobId })
  }

  function discardJob(): void {
    const currentJob = job.value
    if (!currentJob) return
    armed = false
    retryCapture = null
    clearCaptureAckTimer()
    void disposeCapture()
    connection.send('calibration.job.discard', { jobId: currentJob.jobId })
  }

  function onMessage(env: Envelope): void {
    if (env.type === 'calibration.job.state') {
      const next = acceptCalibrationJobState(job.value, env.payload)
      if (next === job.value) return
      job.value = next
      const action = next?.nextAction
      const actionCaptureId = action?.kind === 'capture' || action?.kind === 'validate'
        ? action.captureId
        : null
      if (retryCapture && retryCapture.action.captureId !== actionCaptureId) {
        retryCapture = null
        clearCaptureAckTimer()
        captureMetadata.value = null
      }
      if (action?.kind === 'capture' || action?.kind === 'validate') {
        void prepareCapture(action)
      } else if (next?.phase === 'complete' || next?.phase === 'failed' || next?.phase === 'cancelled') {
        armed = false
        retryCapture = null
        clearCaptureAckTimer()
        void disposeCapture()
        captureState.value = 'idle'
      } else {
        captureState.value = 'idle'
      }
      return
    }
    if (env.type === 'calibration.capture.finished') {
      const payload = env.payload
      if (typeof payload === 'object' && payload !== null
        && 'jobId' in payload && 'captureId' in payload
        && typeof payload.jobId === 'string' && typeof payload.captureId === 'string'
        && payload.jobId === job.value?.jobId
        && payload.captureId === activeAction?.captureId) {
        void completeCapture()
      }
      return
    }
    if (env.type === 'measurement.error' && activeAction) {
      captureState.value = 'error'
      captureError.value = 'The TV could not complete this calibration sweep.'
      void disposeCapture()
      return
    }
    if (env.type === 'calibration.capture.uploaded') {
      const payload = env.payload
      if (typeof payload !== 'object' || payload === null || !('jobId' in payload) || !('captureId' in payload)) return
      const expectedJobId = captureMetadata.value?.jobId ?? activeJobId
      const expectedCaptureId = captureMetadata.value?.captureId ?? activeAction?.captureId
      if (typeof payload.jobId !== 'string' || payload.jobId !== expectedJobId
        || typeof payload.captureId !== 'string' || payload.captureId !== expectedCaptureId) return
      if ('status' in payload && payload.status === 'rejected') {
        clearCaptureAckTimer()
        if (!retryCapture && activeAction) {
          retryCapture = { jobId: expectedJobId ?? '', action: activeAction }
        }
        captureState.value = 'error'
        captureError.value = 'reason' in payload && typeof payload.reason === 'string' && payload.reason.trim().length > 0
          ? payload.reason
          : 'The TV rejected this calibration recording.'
      } else if ('status' in payload && (payload.status === 'accepted' || payload.status === 'duplicate')) {
        clearCaptureAckTimer()
        retryCapture = null
      }
    }
    if (env.type === 'calibration.capture.rejected') {
      const payload = env.payload
      if (typeof payload !== 'object' || payload === null
        || !('jobId' in payload) || !('captureId' in payload) || !('reason' in payload)
        || typeof payload.jobId !== 'string' || typeof payload.captureId !== 'string'
        || typeof payload.reason !== 'string') return
      if (retryCapture?.jobId !== payload.jobId || retryCapture.action.captureId !== payload.captureId) return
      clearCaptureAckTimer()
      captureState.value = 'error'
      captureError.value = payload.reason.trim() || 'The TV rejected this calibration recording.'
    }
  }

  const unsubscribe = connection.onMessage(onMessage)
  const unsubscribeTransportState = connection.onStateChange?.(handleTransportState) ?? (() => undefined)
  onScopeDispose(() => {
    disposed = true
    armed = false
    clearCaptureAckTimer()
    unsubscribe()
    unsubscribeTransportState()
    stopWakeLockWatch()
    screenWakeLock.dispose()
    void disposeCapture()
  })

  return {
    job: readonly(job),
    captureState: readonly(captureState),
    captureError: readonly(captureError),
    captureMetadata: readonly(captureMetadata),
    profiles: readonly(profiles),
    selectedProfileId: readonly(selectedProfileId),
    profileError: readonly(profileError),
    busy: readonly(busy),
    loadProfiles,
    selectProfile,
    startNewJob,
    resumeJob,
    refreshJob,
    cancelCapture,
    cancelOptionalRefinement,
    finishWithBest,
    discardJob,
    retryUpload,
  }
}
