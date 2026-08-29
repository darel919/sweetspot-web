import { computed, onScopeDispose, readonly, ref, shallowRef, watch } from 'vue'
import type {
  CalibrationCaptureMetadata,
  CalibrationCaptureFrameMetadata,
  CalibrationMicrophoneProfilePayload,
  CalibrationJobView,
  CalibrationJobStartMode,
  CalibrationNextAction,
  CalibrationPositionId,
  Envelope,
} from '../../../shared/types/protocol'
import {
  isCalibrationCaptureUploadedPayload,
  isCalibrationCaptureWindowPayload,
  isCalibrationJobView,
} from '../../../shared/types/protocol'
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
import { createPcmRecorder, preloadPcmCaptureWorklet, type PcmRecorder } from '../../lib/audio/capture/pcm-recorder'
import { Sha256 } from '../../lib/transport/sha256'
import type { DirectConnectionState } from '../../lib/transport/types'
import { useScreenWakeLock } from '../ui/useScreenWakeLock'

export type RemoteMicCaptureState = 'idle' | 'opening' | 'recording' | 'uploading' | 'waiting' | 'error'

export interface CalibrationRemoteMicConnection {
  state?(): DirectConnectionState
  send(type: string, payload?: unknown): string
  sendCaptureFrame(data: ArrayBuffer, options?: { signal?: AbortSignal }): Promise<void>
  sessionId?(): string | null
  onMessage(handler: (env: Envelope) => void): () => void
  onStateChange?(handler: (state: DirectConnectionState) => void): () => void
}

interface CalibrationRemoteMicDependencies {
  openMicrophone: typeof openMicrophone
  closeMicrophone: typeof closeMicrophone
  createPcmRecorder: typeof createPcmRecorder
  preloadPcmCaptureWorklet: typeof preloadPcmCaptureWorklet
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
  captureAttemptId: string
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
    | { jobId: string; captureId: string; captureAttemptId: string }
    | { jobId: string; captureId: string; candidateId: string; captureAttemptId: string }
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
  captureAttemptId: string
  metadata: CalibrationCaptureStreamMetadata | null
  hash: Sha256
  sampleCount: number
  byteCount: number
  sequence: number
  beginPromise: Promise<void>
  startedPromise: Promise<void>
  started: boolean
  resolveStarted: () => void
  rejectStarted: (error: Error) => void
  nextWindowSequence: number
  windowSize: number
  windowWaiters: CaptureWindowWaiter[]
  abortController: AbortController
  cancelled: boolean
}

interface CaptureWindowWaiter {
  sequence: number
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const DEFAULT_PROFILE_ID = 'apple_iphone17pro_2025'
const CAPTURE_ACK_TIMEOUT_MS = 30_000
const CAPTURE_WINDOW_TIMEOUT_MS = 30_000
const CAPTURE_START_TIMEOUT_MS = 30_000
const CAPTURE_ATTEMPT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

let captureAttemptCounter = 0

const defaultDependencies: CalibrationRemoteMicDependencies = {
  openMicrophone,
  closeMicrophone,
  createPcmRecorder,
  preloadPcmCaptureWorklet,
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

function validCaptureAttemptId(value: string): boolean {
  return CAPTURE_ATTEMPT_PATTERN.test(value)
}

function nextCaptureAttemptId(): string {
  const randomId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replaceAll('-', '')
    : [Date.now().toString(36), (captureAttemptCounter++).toString(36)].join('_')
  return ['capture', randomId].join('_')
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (error: Error) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
    void promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function actionPosition(
  action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>,
): CalibrationPositionId {
  return action.positionId
}

function isCaptureAction(
  action: CalibrationNextAction | null | undefined,
): action is Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }> {
  return action?.kind === 'capture' || action?.kind === 'validate'
}

function captureActionsMatch(
  current: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }> | null,
  next: CalibrationNextAction | null,
): boolean {
  if (!current || !isCaptureAction(next)) return false
  return captureActionKey(current) === captureActionKey(next)
}

function captureActionKey(
  action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>,
): string {
  return [
    action.kind,
    action.captureId,
    action.positionId,
    action.attemptIndex,
    action.kind === 'validate' ? action.candidateId : '',
  ].join(':')
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
  if (!validCaptureAttemptId(input.captureAttemptId)) throw new TypeError('The capture attempt identity is invalid.')
  const metadata: CalibrationCaptureMetadata = {
    ...buildCalibrationCaptureBase(input),
    sampleCount: input.sampleCount,
    byteCount: input.sampleCount * 4,
  }
  if (input.action.kind === 'capture') {
    return {
      metadata,
      readyType: 'calibration.capture.ready',
      readyPayload: {
        jobId: metadata.jobId,
        captureId: metadata.captureId,
        captureAttemptId: input.captureAttemptId,
      },
    }
  }
  return {
    metadata,
    readyType: 'calibration.validation.capture.ready',
    readyPayload: {
      jobId: metadata.jobId,
      captureId: metadata.captureId,
      candidateId: input.action.candidateId,
      captureAttemptId: input.captureAttemptId,
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

function isRejectedCommandPayload(payload: unknown): boolean {
  return typeof payload === 'object'
    && payload !== null
    && 'ok' in payload
    && payload.ok === false
}

export function useCalibrationRemoteMic(
  connection: CalibrationRemoteMicConnection,
  options: CalibrationRemoteMicOptions = {},
) {
  const dependencies: CalibrationRemoteMicDependencies = { ...defaultDependencies, ...options.dependencies }
  const job = shallowRef<CalibrationJobView | null>(null)
  const captureState = ref<RemoteMicCaptureState>('idle')
  const captureError = ref('')
  const captureMetadata = shallowRef<CalibrationCaptureFrameMetadata | null>(null)
  const profiles = shallowRef<MicCalibrationProfile[]>([])
  const selectedProfileId = ref(options.defaultProfileId ?? DEFAULT_PROFILE_ID)
  const profileError = ref('')
  const captureResourceReady = ref(false)
  const profileResourceReady = ref(false)
  const captureResourceError = ref('')
  const jobStateKnown = ref(false)
  const startPending = ref(false)
  const captureResourcesReady = computed(() => captureResourceReady.value && profileResourceReady.value)
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
  let pendingStartRequestId: string | null = null
  let profileLoadPromise: Promise<MicCalibrationProfile[]> | null = null
  let activeStream: ActiveCaptureStream | null = null
  let retryCapture: {
    jobId: string
    action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>
    captureAttemptId: string
  } | null = null
  let completionInFlight: Promise<void> | null = null
  let captureAckTimer: ReturnType<typeof setTimeout> | null = null
  let captureOperation = 0

  async function preloadCaptureWorklet(): Promise<void> {
    try {
      await dependencies.preloadPcmCaptureWorklet()
      captureResourceReady.value = true
      captureResourceError.value = ''
    } catch (error: unknown) {
      captureResourceReady.value = false
      captureResourceError.value = error instanceof Error
        ? error.message
        : 'The browser capture module could not be loaded.'
      throw error
    }
  }

  function clearCaptureAckTimer(): void {
    if (captureAckTimer === null) return
    clearTimeout(captureAckTimer)
    captureAckTimer = null
  }

  function clearStartPending(): void {
    startPending.value = false
    pendingStartRequestId = null
  }

  function abandonStart(): void {
    clearStartPending()
    armed = false
  }

  function waitForCaptureAcknowledgement(
    jobId: string,
    action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>,
    captureAttemptId: string,
  ): void {
    clearCaptureAckTimer()
    captureAckTimer = setTimeout(() => {
      captureAckTimer = null
      if (captureState.value !== 'waiting'
        || retryCapture?.jobId !== jobId
        || retryCapture.action.captureId !== action.captureId
        || retryCapture.captureAttemptId !== captureAttemptId) return
      captureState.value = 'error'
      captureError.value = 'The TV did not confirm this recording. Reconnect, then retry this measurement without moving the phone.'
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
        profileResourceReady.value = true
        return eligible
      })
      .catch((error: unknown) => {
        profileResourceReady.value = false
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
    captureOperation++
    const currentRecorder = recorder
    const currentCapture = capture
    const currentStream = activeStream
    if (currentStream) {
      currentStream.cancelled = true
      currentStream.abortController.abort()
      currentStream.rejectStarted(new Error('The capture upload was cancelled.'))
      rejectCaptureWindows(currentStream, new Error('The capture upload was cancelled.'))
    }
    recorder = null
    capture = null
    activeStream = null
    activeAction = null
    activeJobId = null
    preparedActionKey = null
    if (currentRecorder) await currentRecorder.dispose()
    if (currentCapture) dependencies.closeMicrophone(currentCapture)
  }

  function captureWindowOpen(stream: ActiveCaptureStream, sequence: number): boolean {
    return sequence < stream.nextWindowSequence + stream.windowSize
  }

  function waitForCaptureWindow(stream: ActiveCaptureStream, sequence: number): Promise<void> {
    if (stream.cancelled) return Promise.reject(new Error('The capture upload was cancelled.'))
    if (captureWindowOpen(stream, sequence)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter: CaptureWindowWaiter = {
        sequence,
        resolve,
        reject,
        timeout: setTimeout(() => {
          const index = stream.windowWaiters.indexOf(waiter)
          if (index >= 0) stream.windowWaiters.splice(index, 1)
          reject(new Error('The TV stopped accepting capture data. Reconnect, then retry this measurement without moving the phone.'))
        }, CAPTURE_WINDOW_TIMEOUT_MS),
      }
      stream.windowWaiters.push(waiter)
    })
  }

  function resolveCaptureWindow(stream: ActiveCaptureStream, nextSequence: number, windowSize: number): void {
    if (nextSequence > stream.nextWindowSequence) stream.nextWindowSequence = nextSequence
    stream.windowSize = windowSize
    const pending = stream.windowWaiters.splice(0)
    for (const waiter of pending) {
      if (captureWindowOpen(stream, waiter.sequence)) {
        clearTimeout(waiter.timeout)
        waiter.resolve()
      } else {
        stream.windowWaiters.push(waiter)
      }
    }
  }

  function rejectCaptureWindows(stream: ActiveCaptureStream, error: Error): void {
    const pending = stream.windowWaiters.splice(0)
    for (const waiter of pending) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
  }

  function handleTransportState(state: DirectConnectionState): void {
    if (state !== 'direct') {
      jobStateKnown.value = false
      abandonStart()
    }
    if ((state !== 'reconnecting' && state !== 'failed') || !activeStream || !activeAction || completionInFlight) return
    retryCapture = {
      jobId: activeJobId ?? job.value?.jobId ?? '',
      action: activeAction,
      captureAttemptId: activeStream.captureAttemptId,
    }
    captureState.value = 'error'
    captureError.value = 'Connection interrupted during this measurement. Reconnect, then retry this measurement without moving the phone.'
    void disposeCapture()
  }

  function isCurrentAction(action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>): boolean {
    const current = job.value?.nextAction
    return armed
      && activeJobId === job.value?.jobId
      && current !== null
      && current !== undefined
      && current.kind === action.kind
      && current.captureId === action.captureId
      && current.positionId === action.positionId
      && current.attemptIndex === action.attemptIndex
      && (action.kind !== 'validate'
        || current.kind === 'validate' && current.candidateId === action.candidateId)
  }

  async function prepareCapture(action: Extract<CalibrationNextAction, { kind: 'capture' | 'validate' }>): Promise<void> {
    const key = [job.value?.jobId ?? '', captureActionKey(action)].join(':')
    if (!armed || preparedActionKey === key || busy.value || disposed) return
    const operation = ++captureOperation
    const captureAttemptId = nextCaptureAttemptId()
    const isCurrentOperation = (): boolean => captureOperation === operation
      && armed
      && !disposed
      && (connection.state?.() === undefined || connection.state() === 'direct')
    preparedActionKey = key
    activeAction = action
    activeJobId = job.value?.jobId ?? null
    retryCapture = { jobId: activeJobId ?? '', action, captureAttemptId }
    captureState.value = 'opening'
    captureError.value = ''
    try {
      const [loadedProfiles] = await Promise.all([loadProfiles(), preloadCaptureWorklet()])
      if (!isCurrentOperation()) return
      const profile = profileForId(loadedProfiles, selectedProfileId.value)
      if (!profile) throw new Error('Select a microphone profile before calibration.')
      const opened = await dependencies.openMicrophone()
      if (!isCurrentOperation()) {
        dependencies.closeMicrophone(opened)
        return
      }
      const createdRecorder = dependencies.createPcmRecorder(opened, {
        onTrackEnded: () => {
          if (!isCurrentOperation()) return
          captureError.value = 'The microphone ended during calibration.'
          void cancelCapture().then(() => {
            captureState.value = 'error'
          })
        },
        onStreamError: (error) => {
          if (!isCurrentOperation()) return
          const stream = activeStream
          const currentAction = activeAction
          const jobId = activeJobId ?? job.value?.jobId ?? ''
          if (stream && currentAction) {
            retryCapture = {
              jobId,
              action: currentAction,
              captureAttemptId: stream.captureAttemptId,
            }
            connection.send('calibration.job.cancel', {
              jobId,
              scope: 'capture',
              captureId: currentAction.captureId,
              captureAttemptId: stream.captureAttemptId,
            })
          }
          captureError.value = error.message
          captureState.value = 'uploading'
          void disposeCapture().then(() => {
            if (!disposed && captureState.value === 'uploading') captureState.value = 'error'
          })
        },
        retainSamples: false,
        shouldStreamChunk: () => isCurrentOperation()
          && activeStream?.captureAttemptId === captureAttemptId,
        onChunk: async (samples) => {
          if (!isCurrentOperation()) return
          const stream = activeStream
          if (!stream || stream.captureAttemptId !== captureAttemptId || stream.cancelled) return
          await stream.startedPromise
          if (!isCurrentOperation() || stream.cancelled || activeStream !== stream) return
          const pcm = encodeCalibrationPcm(samples)
          const sequence = stream.sequence
          await stream.beginPromise
          if (!isCurrentOperation() || stream.cancelled || activeStream !== stream) return
          await waitForCaptureWindow(stream, sequence)
          if (!isCurrentOperation() || stream.cancelled || activeStream !== stream) return
          await connection.sendCaptureFrame(encodeCaptureChunk({
            sessionId: stream.sessionId,
            captureId: stream.captureId,
            captureAttemptId: stream.captureAttemptId,
            sequence,
            sampleCount: samples.length,
            pcm,
          }), { signal: stream.abortController.signal })
          stream.hash.update(pcm)
          stream.sampleCount += samples.length
          stream.byteCount += pcm.byteLength
          stream.sequence++
        },
      })
      if (!isCurrentOperation()) {
        await createdRecorder.dispose()
        dependencies.closeMicrophone(opened)
        return
      }
      capture = opened
      recorder = createdRecorder
      const started = deferred<void>()
      const stream: ActiveCaptureStream = {
        sessionId: connection.sessionId?.() ?? 'browser-session',
        captureId: action.captureId,
        captureAttemptId,
        metadata: null,
        hash: new Sha256(),
        sampleCount: 0,
        byteCount: 0,
        sequence: 0,
        beginPromise: Promise.resolve(),
        startedPromise: started.promise,
        started: false,
        resolveStarted: () => started.resolve(undefined),
        rejectStarted: started.reject,
        nextWindowSequence: 0,
        windowSize: 0,
        windowWaiters: [],
        abortController: new AbortController(),
        cancelled: false,
      }
      activeStream = stream
      const startPromise = createdRecorder.start()
      await withTimeout(
        startPromise,
        CAPTURE_START_TIMEOUT_MS,
        'The microphone capture did not start. Check microphone permission, then retry.',
      )
      const sampleRate = Math.round(createdRecorder.sampleRate() ?? 0)
      stream.metadata = buildCalibrationCaptureBase({
        jobId: activeJobId ?? job.value?.jobId ?? '',
        action,
        captureSettings: opened.settings,
        sampleRate,
        microphoneProfile: profile,
        capturedAtMs: dependencies.now(),
      })
      if (!isCurrentOperation()) {
        await disposeCapture()
        captureState.value = 'idle'
        return
      }
      stream.beginPromise = (async () => {
        await withTimeout(
          stream.startedPromise,
          CAPTURE_WINDOW_TIMEOUT_MS,
          'The TV did not start this calibration measurement. Reconnect, then retry this measurement without moving the phone.',
        )
        if (stream.cancelled) throw new Error('The capture upload was cancelled.')
        if (connection.state?.() !== undefined && connection.state() !== 'direct') {
          throw new Error('The direct connection closed before capture could start.')
        }
        if (!stream.metadata) throw new Error('The microphone capture metadata is unavailable. Retry this measurement without moving the phone.')
        await connection.sendCaptureFrame(encodeCaptureBegin({
          sessionId: stream.sessionId,
          captureId: stream.captureId,
          captureAttemptId: stream.captureAttemptId,
          metadata: stream.metadata,
          expectedSampleCount: null,
          expectedByteCount: null,
        }), { signal: stream.abortController.signal })
        await waitForCaptureWindow(stream, 0)
      })()
      void stream.beginPromise.catch((error: unknown) => {
        if (!isCurrentOperation() || stream.cancelled) return
        captureState.value = 'error'
        captureError.value = error instanceof Error
          ? error.message
          : 'The TV did not start this calibration measurement. Reconnect, then retry this measurement without moving the phone.'
        retryCapture = { jobId: activeJobId ?? job.value?.jobId ?? '', action, captureAttemptId }
        void disposeCapture()
      })
      if (!isCurrentOperation() || !isCurrentAction(action)) {
        await disposeCapture()
        captureState.value = 'idle'
        return
      }
      if (action.kind === 'capture') {
        connection.send('calibration.capture.ready', {
          jobId: activeJobId ?? '',
          captureId: action.captureId,
          captureAttemptId,
        })
      } else {
        connection.send('calibration.validation.capture.ready', {
          jobId: activeJobId ?? '',
          captureId: action.captureId,
          candidateId: action.candidateId,
          captureAttemptId,
        })
      }
      captureState.value = 'recording'
    } catch (error: unknown) {
      await disposeCapture()
      if (disposed || !armed) return
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
        if (!recording || recording.diagnostics.sampleCount === 0 || stream.sampleCount === 0
          || recording.diagnostics.sampleCount !== stream.sampleCount) {
          throw new Error('The microphone returned no samples.')
        }
        if (stream.cancelled || activeStream !== stream) return
        const sampleRate = Math.round(recording.diagnostics.sampleRate)
        const metadata = stream.metadata
        if (!metadata || sampleRate !== metadata.sampleRate) {
          throw new Error('The microphone sample rate changed during measurement. Retry this measurement without moving the phone.')
        }
        const profile = profileForId(profiles.value, selectedProfileId.value)
        if (!profile) throw new Error('The selected microphone profile is no longer available.')
        const hash = stream.hash.digestHex()
        if (stream.byteCount !== stream.sampleCount * 4) throw new Error('The capture byte count is invalid.')
        const built = buildCalibrationCapture({
          jobId: activeJobId ?? job.value?.jobId ?? '',
          action,
          captureAttemptId: stream.captureAttemptId,
          captureSettings: capture.settings,
          sampleRate,
          sampleCount: stream.sampleCount,
          contentSha256: hash,
          microphoneProfile: profile,
          capturedAtMs: metadata.capturedAtMs,
        })
        const finalMetadata: CalibrationCaptureFrameMetadata = { ...built.metadata, contentSha256: hash }
        captureMetadata.value = finalMetadata
        await connection.sendCaptureFrame(encodeCaptureEnd({
          sessionId: stream.sessionId,
          captureId: stream.captureId,
          captureAttemptId: stream.captureAttemptId,
          chunkCount: stream.sequence,
          finalSampleCount: stream.sampleCount,
          finalByteCount: stream.byteCount,
          finalSha256: hash,
          metadata: finalMetadata,
        }), { signal: stream.abortController.signal })
        if (stream.cancelled || activeStream !== stream) return
        const jobId = activeJobId ?? job.value?.jobId ?? ''
        retryCapture = { jobId, action, captureAttemptId: stream.captureAttemptId }
        captureState.value = 'waiting'
        waitForCaptureAcknowledgement(jobId, action, stream.captureAttemptId)
      } catch (error: unknown) {
        if (stream.cancelled) return
        clearCaptureAckTimer()
        retryCapture = {
          jobId: activeJobId ?? job.value?.jobId ?? '',
          action,
          captureAttemptId: stream.captureAttemptId,
        }
        captureState.value = 'error'
        captureError.value = error instanceof Error
          ? error.message
          : 'The calibration recording could not reach the TV. Retry this measurement without moving the phone.'
      } finally {
        await disposeCapture()
        completionInFlight = null
      }
    })()
    await completionInFlight
  }

  function retryCurrentCapture(): void {
    const retry = retryCapture
    if (!retry || captureState.value === 'uploading' || disposed) return
    if (connection.state?.() !== undefined && connection.state() !== 'direct') {
      captureState.value = 'error'
      captureError.value = 'Reconnect to the TV before retrying this measurement without moving the phone.'
      return
    }
    clearCaptureAckTimer()
    armed = true
    preparedActionKey = null
    captureError.value = ''
    captureMetadata.value = null
    void prepareCapture(retry.action)
  }

  function startNewJob(mode: CalibrationJobStartMode = 'auto'): void {
    if (busy.value || startPending.value || disposed) return
    armed = true
    jobStateKnown.value = false
    startPending.value = true
    retryCapture = null
    clearCaptureAckTimer()
    captureMetadata.value = null
    captureError.value = ''
    try {
      pendingStartRequestId = connection.send('calibration.job.start', { mode })
    } catch (error: unknown) {
      abandonStart()
      throw error
    }
  }

  function cancelPendingStart(): void {
    if (!startPending.value) return
    abandonStart()
  }

  function resumeJob(): void {
    if (busy.value || disposed) return
    armed = true
    jobStateKnown.value = false
    clearCaptureAckTimer()
    captureError.value = ''
    connection.send('calibration.job.get', job.value ? { jobId: job.value.jobId } : {})
    const action = job.value?.nextAction
    if (action?.kind === 'capture' || action?.kind === 'validate') void prepareCapture(action)
  }

  function refreshJob(): void {
    if (disposed) return
    jobStateKnown.value = false
    connection.send('calibration.job.get', job.value ? { jobId: job.value.jobId } : {})
  }

  async function cancelCapture(): Promise<void> {
    abandonStart()
    const currentJob = job.value
    const currentAction = activeAction ?? retryCapture?.action
    const currentJobId = currentJob?.jobId ?? activeJobId ?? retryCapture?.jobId
    const currentCaptureAttemptId = activeStream?.captureAttemptId ?? retryCapture?.captureAttemptId
    armed = false
    retryCapture = null
    clearCaptureAckTimer()
    if (currentJobId && currentAction) {
      connection.send('calibration.job.cancel', {
        jobId: currentJobId,
        scope: 'capture',
        captureId: currentAction.captureId,
        captureAttemptId: currentCaptureAttemptId,
      })
    }
    activeStream?.abortController.abort()
    await disposeCapture()
    captureState.value = 'idle'
  }

  async function cancelOptionalRefinement(): Promise<void> {
    abandonStart()
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

  function applyJobState(next: CalibrationJobView | null, settleStartPending = true): void {
    if (settleStartPending) clearStartPending()
    jobStateKnown.value = true
    if (!next) {
      if (job.value === null && activeStream === null && retryCapture === null) return
      job.value = null
      armed = false
      retryCapture = null
      clearCaptureAckTimer()
      captureMetadata.value = null
      void disposeCapture()
      captureState.value = 'idle'
      return
    }
    if (next === job.value) return
    const previousAction = activeAction
    job.value = next
    const action = next.nextAction
    const actionKey = isCaptureAction(action) ? captureActionKey(action) : null
    const activeCaptureNeedsReset = previousAction !== null && !captureActionsMatch(previousAction, action)
    if (retryCapture && captureActionKey(retryCapture.action) !== actionKey) {
      retryCapture = null
      clearCaptureAckTimer()
      captureMetadata.value = null
    }
    if (activeCaptureNeedsReset) {
      retryCapture = null
      clearCaptureAckTimer()
      captureMetadata.value = null
      if (next.phase === 'complete' || next.phase === 'failed' || next.phase === 'cancelled') armed = false
      captureState.value = 'idle'
      const expectedJobId = next.jobId
      const expectedRevision = next.revision
      void disposeCapture().then(() => {
        const currentAction = job.value?.nextAction
        if (disposed || !armed || job.value?.jobId !== expectedJobId || job.value.revision !== expectedRevision
          || !isCaptureAction(currentAction)) return
        void prepareCapture(currentAction)
      })
    } else if (isCaptureAction(action)) {
      void prepareCapture(action)
    } else if (next.phase === 'complete' || next.phase === 'failed' || next.phase === 'cancelled') {
      armed = false
      retryCapture = null
      clearCaptureAckTimer()
      void disposeCapture()
      captureState.value = 'idle'
    } else {
      captureState.value = 'idle'
    }
  }

  function onMessage(env: Envelope): void {
    if (pendingStartRequestId !== null
      && env.replyTo === pendingStartRequestId
      && isRejectedCommandPayload(env.payload)) {
      abandonStart()
    }
    if (env.type === 'calibration.job.state') {
      if (!isCalibrationJobView(env.payload)) return
      const next = acceptCalibrationJobState(job.value, env.payload)
      applyJobState(next, next !== job.value || env.replyTo === pendingStartRequestId)
      return
    }
    if (env.type === 'state.snapshot' || env.type === 'state.changed') {
      const payload = env.payload
      const incoming = typeof payload === 'object' && payload !== null && 'calibrationJob' in payload
        ? payload.calibrationJob
        : payload
      if (incoming === null) {
        applyJobState(null)
      } else if (isCalibrationJobView(incoming)) {
        const next = acceptCalibrationJobState(job.value, incoming)
        applyJobState(next, next !== job.value || env.replyTo === pendingStartRequestId)
      }
      return
    }
    if (env.type === 'calibration.capture.started') {
      const payload = env.payload
      const stream = activeStream
      if (typeof payload !== 'object' || payload === null
        || !('jobId' in payload) || !('captureId' in payload) || !('captureAttemptId' in payload)
        || typeof payload.jobId !== 'string' || typeof payload.captureId !== 'string') return
      if (typeof payload.captureAttemptId !== 'string'
        || payload.jobId !== activeJobId
        || !stream
        || payload.captureId !== stream.captureId
        || payload.captureAttemptId !== stream.captureAttemptId) return
      if (payload.jobId === activeJobId && payload.captureId === stream.captureId) {
        stream.started = true
        stream.resolveStarted()
      }
      return
    }
    if (env.type === 'calibration.capture.window') {
      if (!isCalibrationCaptureWindowPayload(env.payload)) return
      const stream = activeStream
      if (!stream || stream.captureId !== env.payload.captureId
        || stream.captureAttemptId !== env.payload.captureAttemptId) return
      resolveCaptureWindow(stream, env.payload.nextSequence, env.payload.windowSize)
      return
    }
    if (env.type === 'calibration.capture.finished') {
      const payload = env.payload
      if (typeof payload === 'object' && payload !== null
        && 'jobId' in payload && 'captureId' in payload
        && 'captureAttemptId' in payload
        && typeof payload.jobId === 'string' && typeof payload.captureId === 'string'
        && typeof payload.captureAttemptId === 'string'
        && payload.jobId === job.value?.jobId
        && payload.captureId === activeAction?.captureId
        && payload.captureAttemptId === activeStream?.captureAttemptId) {
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
      if (!isCalibrationCaptureUploadedPayload(env.payload)) return
      const payload = env.payload
      const expectedJobId = captureMetadata.value?.jobId ?? activeJobId
      const expectedCaptureId = captureMetadata.value?.captureId ?? activeAction?.captureId ?? retryCapture?.action.captureId
      const expectedCaptureAttemptId = retryCapture?.captureAttemptId
      if (typeof payload.jobId !== 'string' || payload.jobId !== expectedJobId
        || typeof payload.captureId !== 'string' || payload.captureId !== expectedCaptureId
        || typeof payload.captureAttemptId !== 'string' || payload.captureAttemptId !== expectedCaptureAttemptId) return
      const metadata = captureMetadata.value
      if (metadata !== null
        && (payload.contentSha256.toLowerCase() !== metadata.contentSha256.toLowerCase()
          || payload.sampleCount !== metadata.sampleCount
          || payload.byteCount !== metadata.byteCount)) return
      if ('status' in payload && payload.status === 'rejected') {
        clearCaptureAckTimer()
        if (!retryCapture && activeAction) {
          retryCapture = {
            jobId: expectedJobId ?? '',
            action: activeAction,
            captureAttemptId: payload.captureAttemptId,
          }
        }
        captureState.value = 'error'
        captureError.value = 'reason' in payload && typeof payload.reason === 'string' && payload.reason.trim().length > 0
          ? payload.reason
          : 'The TV rejected this calibration recording.'
      } else if ('status' in payload && payload.status === 'accepted') {
        clearCaptureAckTimer()
        retryCapture = null
        jobStateKnown.value = false
        connection.send('calibration.job.get', { jobId: payload.jobId })
      } else if ('status' in payload && payload.status === 'duplicate') {
        clearCaptureAckTimer()
        jobStateKnown.value = false
        connection.send('calibration.job.get', { jobId: payload.jobId })
      }
    }
    if (env.type === 'calibration.capture.rejected') {
      const payload = env.payload
      if (typeof payload !== 'object' || payload === null
        || !('jobId' in payload) || !('captureId' in payload) || !('reason' in payload)
        || !('captureAttemptId' in payload)
        || typeof payload.jobId !== 'string' || typeof payload.captureId !== 'string'
        || typeof payload.captureAttemptId !== 'string' || typeof payload.reason !== 'string') return
      if (retryCapture?.jobId !== payload.jobId
        || retryCapture.action.captureId !== payload.captureId
        || retryCapture.captureAttemptId !== payload.captureAttemptId) return
      clearCaptureAckTimer()
      captureState.value = 'error'
      captureError.value = payload.reason.trim() || 'The TV rejected this calibration recording.'
      void disposeCapture()
    }
  }

  const unsubscribe = connection.onMessage(onMessage)
  const unsubscribeTransportState = connection.onStateChange?.(handleTransportState) ?? (() => undefined)
  onScopeDispose(() => {
    disposed = true
    abandonStart()
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
    jobStateKnown: readonly(jobStateKnown),
    startPending: readonly(startPending),
    profiles: readonly(profiles),
    selectedProfileId: readonly(selectedProfileId),
    profileError: readonly(profileError),
    captureResourceReady: readonly(captureResourcesReady),
    captureResourceError: readonly(captureResourceError),
    busy: readonly(busy),
    loadProfiles,
    preloadCaptureWorklet,
    selectProfile,
    startNewJob,
    cancelPendingStart,
    resumeJob,
    refreshJob,
    cancelCapture,
    cancelOptionalRefinement,
    finishWithBest,
    discardJob,
    retryCurrentCapture,
  }
}
