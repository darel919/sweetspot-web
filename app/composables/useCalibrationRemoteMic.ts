import { computed, onScopeDispose, readonly, ref, shallowRef, watch } from 'vue'
import type {
  CalibrationCaptureMetadata,
  CalibrationMicrophoneProfilePayload,
  CalibrationJobView,
  CalibrationNextAction,
  CalibrationPositionId,
  Envelope,
} from '../../shared/types/protocol'
import { isCalibrationJobView } from '../../shared/types/protocol'
import { encodeCalibrationCaptureFrame } from '../../shared/transport/calibrationCaptureFrame'
import { discoverMicCalibrationProfiles } from '../lib/audio/mics/registry'
import { isMicCalibrationProfileEligibleForCorrection } from '../lib/audio/mics/profile'
import type { MicCalibrationProfile } from '../lib/audio/mics/types'
import { closeMicrophone, openMicrophone, type MicrophoneCapture } from '../lib/audio/capture/microphone'
import { createPcmRecorder, type PcmRecorder } from '../lib/audio/capture/pcm-recorder'
import { useScreenWakeLock } from './useScreenWakeLock'

export type RemoteMicCaptureState = 'idle' | 'opening' | 'recording' | 'uploading' | 'waiting' | 'error'

export interface CalibrationRemoteMicConnection {
  send(type: string, payload?: unknown): string
  uploadBinary(data: ArrayBuffer): boolean
  onMessage(handler: (env: Envelope) => void): () => void
}

interface CalibrationRemoteMicDependencies {
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
    microphoneProfile: microphoneProfilePayload(input.microphoneProfile),
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
  let pendingUpload: { frame: ArrayBuffer; metadata: CalibrationCaptureMetadata } | null = null
  let completionInFlight: Promise<void> | null = null

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
        const pcm = encodeCalibrationPcm(recording.samples)
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
    const action = job.value?.nextAction
    if (action?.kind === 'capture' || action?.kind === 'validate') void prepareCapture(action)
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
      const actionCaptureId = action?.kind === 'capture' || action?.kind === 'validate'
        ? action.captureId
        : null
      if (pendingUpload && pendingUpload.metadata.captureId !== actionCaptureId) {
        pendingUpload = null
        captureMetadata.value = null
      }
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
      if (typeof payload.jobId !== 'string' || payload.jobId !== captureMetadata.value?.jobId
        || typeof payload.captureId !== 'string' || payload.captureId !== captureMetadata.value?.captureId) return
      if ('status' in payload && payload.status === 'rejected') {
        captureState.value = 'error'
        captureError.value = 'reason' in payload && typeof payload.reason === 'string' && payload.reason.trim().length > 0
          ? payload.reason
          : 'The TV rejected this calibration recording.'
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
