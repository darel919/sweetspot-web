import { computed, onScopeDispose, readonly, ref, shallowRef } from 'vue'
import type {
  CalibrationCaptureMetadata,
  CalibrationJobView,
  CalibrationNextAction,
  CalibrationPositionId,
  Envelope,
} from '../../shared/types/protocol'
import { isCalibrationJobView } from '../../shared/types/protocol'
import { encodeCalibrationCaptureFrame } from '../../shared/transport/calibrationCaptureFrame'
import { discoverMicCalibrationProfiles } from '../lib/audio/mics/registry'
import type { MicCalibrationProfile } from '../lib/audio/mics/types'
import { closeMicrophone, openMicrophone, type MicrophoneCapture } from '../lib/audio/capture/microphone'
import { createPcmRecorder, type PcmRecorder } from '../lib/audio/capture/pcm-recorder'

export type RemoteMicCaptureState = 'idle' | 'opening' | 'recording' | 'uploading' | 'waiting' | 'error'

export interface CalibrationRemoteMicConnection {
  send(type: string, payload?: unknown): string
  uploadBinary(data: ArrayBuffer): boolean
  onMessage(handler: (env: Envelope) => void): () => void
}

export interface CalibrationRemoteMicDependencies {
  openMicrophone: typeof openMicrophone
  closeMicrophone: typeof closeMicrophone
  createPcmRecorder: typeof createPcmRecorder
  discoverMicCalibrationProfiles: typeof discoverMicCalibrationProfiles
  digest: (data: ArrayBuffer) => Promise<string>
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
  microphoneProfile: Pick<MicCalibrationProfile, 'id' | 'sourceDate'>
  capturedAtMs: number
}

export interface CalibrationCaptureBuildResult {
  metadata: CalibrationCaptureMetadata
  readyType: 'calibration.capture.ready' | 'calibration.validation.capture.ready'
  readyPayload:
    | { jobId: string; captureId: string }
    | { jobId: string; captureId: string; candidateId: string }
}

const DEFAULT_PROFILE_ID = 'apple_iphone17pro_2025'

const defaultDependencies: CalibrationRemoteMicDependencies = {
  openMicrophone,
  closeMicrophone,
  createPcmRecorder,
  discoverMicCalibrationProfiles,
  digest: async (data) => {
    const digest = await crypto.subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  },
  now: () => Date.now(),
}

function profileForId(
  profiles: readonly MicCalibrationProfile[],
  profileId: string,
): Pick<MicCalibrationProfile, 'id' | 'sourceDate'> | null {
  const profile = profiles.find((candidate) => candidate.id === profileId)
  return profile ? { id: profile.id, sourceDate: profile.sourceDate } : null
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

export function buildCalibrationCapture(
  input: CalibrationCaptureBuildInput,
): CalibrationCaptureBuildResult {
  if (!validSampleRate(input.sampleRate)) throw new RangeError('The microphone reported an unsupported sample rate.')
  if (!validSampleCount(input.sampleCount)) throw new RangeError('The microphone returned no samples.')
  if (!/^[a-f0-9]{64}$/i.test(input.contentSha256)) throw new TypeError('The PCM hash is invalid.')

  const channel = input.action.kind === 'capture' ? input.action.channel : 'both'
  const metadata: CalibrationCaptureMetadata = {
    jobId: input.jobId,
    captureId: input.action.captureId,
    positionId: actionPosition(input.action),
    attemptIndex: input.action.attemptIndex,
    channel,
    sampleRate: input.sampleRate,
    channelCount: 1,
    sampleCount: input.sampleCount,
    byteCount: input.sampleCount * 4,
    settings: {
      echoCancellation: input.captureSettings.echoCancellation,
      noiseSuppression: input.captureSettings.noiseSuppression,
      autoGainControl: input.captureSettings.autoGainControl,
    },
    userAgent: typeof navigator === 'undefined' ? 'unknown-browser' : navigator.userAgent,
    microphoneProfileId: input.microphoneProfile.id,
    microphoneProfileRevision: input.microphoneProfile.sourceDate,
    capturedAtMs: input.capturedAtMs,
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
  if (next.jobId !== current.jobId) return true
  return next.revision >= current.revision
}

export function acceptCalibrationJobState(
  current: CalibrationJobView | null,
  incoming: unknown,
): CalibrationJobView | null {
  if (!isCalibrationJobView(incoming)) return current
  return jobStateIsCurrent(current, incoming) ? incoming : current
}

function payloadPosition(payload: unknown): CalibrationPositionId | null {
  if (typeof payload !== 'object' || payload === null || !('context' in payload)) return null
  const context = payload.context
  if (typeof context !== 'object' || context === null || !('positionId' in context)) return null
  const position = context.positionId
  return position === 'center'
    || position === 'left'
    || position === 'right'
    || position === 'forward'
    || position === 'backward'
    ? position
    : null
}

function isPlaybackFinishedFor(
  env: Envelope,
  action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>,
): boolean {
  if (env.type !== 'measurement.finished') return false
  const position = payloadPosition(env.payload)
  return position === null || position === action.positionId
}

function pcmBuffer(samples: Float32Array): ArrayBuffer {
  const result = new ArrayBuffer(samples.byteLength)
  new Uint8Array(result).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
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
  const busy = computed(() => captureState.value === 'opening'
    || captureState.value === 'recording'
    || captureState.value === 'uploading')

  let disposed = false
  let capture: MicrophoneCapture | null = null
  let recorder: PcmRecorder | null = null
  let activeAction: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }> | null = null
  let activeJobId: string | null = null
  let preparedActionKey: string | null = null
  let armed = false
  let profileLoadPromise: Promise<MicCalibrationProfile[]> | null = null
  let pendingUpload: { frame: ArrayBuffer; metadata: CalibrationCaptureMetadata } | null = null
  let completionInFlight: Promise<void> | null = null

  async function loadProfiles(): Promise<MicCalibrationProfile[]> {
    if (profiles.value.length > 0) return profiles.value
    if (profileLoadPromise) return profileLoadPromise
    profileLoadPromise = dependencies.discoverMicCalibrationProfiles()
      .then((loaded) => {
        profiles.value = loaded
        if (!loaded.some((candidate) => candidate.id === selectedProfileId.value)) {
          selectedProfileId.value = loaded[0]?.id ?? ''
        }
        profileError.value = ''
        return loaded
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
    recorder = null
    capture = null
    activeAction = null
    activeJobId = null
    preparedActionKey = null
    if (currentRecorder) await currentRecorder.dispose()
    if (currentCapture) dependencies.closeMicrophone(currentCapture)
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
    if (!armed || preparedActionKey === key || busy.value || disposed
      || pendingUpload?.metadata.captureId === action.captureId) return
    preparedActionKey = key
    activeAction = action
    activeJobId = job.value?.jobId ?? null
    captureState.value = 'opening'
    captureError.value = ''
    try {
      const loadedProfiles = await loadProfiles()
      const profile = profileForId(loadedProfiles, selectedProfileId.value)
      if (!profile) throw new Error('Select a microphone profile before calibration.')
      const opened = await dependencies.openMicrophone()
      const createdRecorder = dependencies.createPcmRecorder(opened, {
        onTrackEnded: () => {
          captureError.value = 'The microphone ended during calibration.'
          void cancelCapture().then(() => {
            captureState.value = 'error'
          })
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
    } catch (error: unknown) {
      await disposeCapture()
      captureState.value = 'error'
      captureError.value = error instanceof Error ? error.message : 'Microphone capture could not start.'
    }
  }

  async function completeCapture(): Promise<void> {
    if (completionInFlight || !recorder || !capture || !activeAction || disposed) return
    const action = activeAction
    completionInFlight = (async () => {
      captureState.value = 'uploading'
      try {
        const recording = await recorder?.stop()
        if (!recording || recording.samples.length === 0) throw new Error('The microphone returned no samples.')
        const pcm = pcmBuffer(recording.samples)
        const sampleRate = Math.round(recording.diagnostics.sampleRate)
        const profile = profileForId(profiles.value, selectedProfileId.value)
        if (!profile) throw new Error('The selected microphone profile is no longer available.')
        const hash = await dependencies.digest(pcm)
        const built = buildCalibrationCapture({
          jobId: activeJobId ?? job.value?.jobId ?? '',
          action,
          captureSettings: capture.settings,
          sampleRate,
          sampleCount: recording.samples.length,
          contentSha256: hash,
          microphoneProfile: profile,
          capturedAtMs: dependencies.now(),
        })
        const frame = encodeCalibrationCaptureFrame({
          metadata: { ...built.metadata, contentSha256: hash },
          pcm,
        })
        captureMetadata.value = built.metadata
        pendingUpload = { frame, metadata: built.metadata }
        if (!connection.uploadBinary(frame)) {
          captureState.value = 'error'
          captureError.value = 'The calibration recording could not reach the TV. Retry the upload without moving the phone.'
          return
        }
        connection.send('calibration.capture.metadata', built.metadata)
        captureState.value = 'waiting'
      } catch (error: unknown) {
        captureState.value = 'error'
        captureError.value = error instanceof Error ? error.message : 'Calibration recording could not be uploaded.'
      } finally {
        await disposeCapture()
        completionInFlight = null
      }
    })()
    await completionInFlight
  }

  function retryUpload(): void {
    const pending = pendingUpload
    if (!pending || captureState.value === 'uploading') return
    captureState.value = 'uploading'
    if (!connection.uploadBinary(pending.frame)) {
      captureState.value = 'error'
      captureError.value = 'The calibration recording could not reach the TV. Check the connection and retry.'
      return
    }
    connection.send('calibration.capture.metadata', pending.metadata)
    captureState.value = 'waiting'
  }

  function startNewJob(mode: 'auto' | 'advanced' = 'auto'): void {
    if (busy.value || disposed) return
    armed = true
    pendingUpload = null
    captureMetadata.value = null
    captureError.value = ''
    connection.send('calibration.job.start', { mode })
  }

  function resumeJob(): void {
    if (busy.value || disposed) return
    armed = true
    captureError.value = ''
    connection.send('calibration.job.get', job.value ? { jobId: job.value.jobId } : {})
  }

  function refreshJob(): void {
    if (disposed) return
    connection.send('calibration.job.get', job.value ? { jobId: job.value.jobId } : {})
  }

  async function cancelCapture(): Promise<void> {
    armed = false
    const currentJob = job.value
    const currentAction = activeAction
    if (currentJob && currentAction) {
      connection.send('calibration.job.cancel', {
        jobId: currentJob.jobId,
        scope: 'capture',
        captureId: currentAction.captureId,
      })
    }
    await disposeCapture()
    captureState.value = 'idle'
  }

  async function cancelOptionalRefinement(): Promise<void> {
    armed = false
    const currentJob = job.value
    if (currentJob) connection.send('calibration.job.cancel', { jobId: currentJob.jobId, scope: 'optional_refinement' })
    await disposeCapture()
    captureState.value = 'idle'
  }

  function finishWithBest(): void {
    const currentJob = job.value
    if (!currentJob?.minimumViableCalibration) return
    armed = false
    void disposeCapture()
    connection.send('calibration.job.finish', { jobId: currentJob.jobId })
  }

  function discardJob(): void {
    const currentJob = job.value
    if (!currentJob) return
    armed = false
    void disposeCapture()
    connection.send('calibration.job.discard', { jobId: currentJob.jobId })
  }

  function onMessage(env: Envelope): void {
    if (env.type === 'calibration.job.state') {
      const next = acceptCalibrationJobState(job.value, env.payload)
      if (next === job.value) return
      job.value = next
      const action = next?.nextAction
      if (action?.kind === 'capture' || action?.kind === 'validate') {
        void prepareCapture(action)
      } else if (next?.phase === 'complete' || next?.phase === 'failed' || next?.phase === 'cancelled') {
        armed = false
        pendingUpload = null
        void disposeCapture()
        captureState.value = 'idle'
      } else {
        captureState.value = 'idle'
      }
      return
    }
    if (activeAction && isPlaybackFinishedFor(env, activeAction)) {
      void completeCapture()
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
      if (typeof payload !== 'object' || payload === null || !('captureId' in payload)) return
      if (typeof payload.captureId !== 'string' || payload.captureId !== captureMetadata.value?.captureId) return
      if ('status' in payload && payload.status === 'rejected') {
        captureState.value = 'error'
        captureError.value = 'The TV rejected this calibration recording.'
      } else if ('status' in payload && (payload.status === 'accepted' || payload.status === 'duplicate')) {
        pendingUpload = null
      }
    }
  }

  const unsubscribe = connection.onMessage(onMessage)
  onScopeDispose(() => {
    disposed = true
    armed = false
    unsubscribe()
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
