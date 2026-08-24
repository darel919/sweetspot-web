import { onScopeDispose, readonly, ref, shallowRef } from 'vue'
import type { Envelope } from '#shared/types/protocol'
import {
  isMeasurementReadyPayload,
  type MeasurementErrorCode,
  type MeasurementSweep,
} from '#shared/types/protocol'
import { openMicrophone, closeMicrophone, type MicrophoneCapture } from '../lib/audio/capture/microphone'
import { createPcmRecorder, type CaptureSignalDiagnostics, type PcmRecorder } from '../lib/audio/capture/pcm-recorder'
import { analyzeInWorker } from '../lib/audio/measurement/worker-client'
import type { MeasurementAnalysis } from '../lib/audio/measurement/response'
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
  | 'recording'
  | 'analyzing'
  | 'ending'
  | 'complete'
  | 'error'

function newSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return `cal_${random ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`}`
}

function analysisErrorCode(status: MeasurementAnalysis['status']): MeasurementErrorCode {
  if (status === 'capture_clipped') return 'capture_clipped'
  if (status === 'sweep_not_found') return 'sweep_not_found'
  return 'signal_too_low'
}

export function useCalibrationSession(connection: Connection) {
  const stage = ref<CalibrationStage>('idle')
  const message = ref('')
  const analysis = shallowRef<MeasurementAnalysis | null>(null)
  const captureDiagnostics = shallowRef<CaptureSignalDiagnostics | null>(null)
  const profiles = shallowRef<MicCalibrationProfile[]>([])
  const selectedProfileId = ref('')
  const profileError = ref('')
  const captureInfo = shallowRef<{
    settings: MicrophoneCapture['settings']
    capabilities: MicrophoneCapture['capabilities']
  } | null>(null)

  let disposed = false
  let sessionId: string | null = null
  let sweep: MeasurementSweep | null = null
  let capture: MicrophoneCapture | null = null
  let recorder: PcmRecorder | null = null
  let profile: MicCalibrationProfile | null = null
  let profileLoadPromise: Promise<MicCalibrationProfile[]> | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null

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
      void fail('measurement_timeout', 'The TV did not finish the measurement in time.')
    }, 70_000)
  }

  async function closeCapture() {
    const currentRecorder = recorder
    const currentCapture = capture
    recorder = null
    capture = null
    if (currentRecorder) await currentRecorder.dispose()
    if (currentCapture) closeMicrophone(currentCapture)
  }

  async function fail(code: MeasurementErrorCode, text: string) {
    const currentSessionId = sessionId
    clearTimeoutTimer()
    if (currentSessionId) {
      connection.send('calibrationSession.abort', { sessionId: currentSessionId, code })
    }
    await closeCapture()
    sessionId = null
    sweep = null
    profile = null
    stage.value = 'error'
    message.value = text
  }

  async function start() {
    if (disposed || stage.value === 'requesting-microphone' || stage.value === 'preparing' ||
      stage.value === 'recording' || stage.value === 'analyzing' || stage.value === 'ending') return
    analysis.value = null
    captureDiagnostics.value = null
    captureInfo.value = null
    stage.value = 'requesting-microphone'
    message.value = 'Loading microphone profiles…'
    try {
      const loadedProfiles = await loadProfiles()
      const selectedProfile = loadedProfiles.find((candidate) => candidate.id === selectedProfileId.value) ?? loadedProfiles[0]
      if (!selectedProfile) throw new Error('No microphone calibration profiles are available.')
      profile = selectedProfile
      message.value = 'Requesting microphone access…'
      capture = await openMicrophone()
      captureInfo.value = { settings: capture.settings, capabilities: capture.capabilities }
      recorder = createPcmRecorder(capture)
      sessionId = newSessionId()
      stage.value = 'preparing'
      message.value = 'Preparing the TV measurement. Follow the instructions on the TV.'
      armTimeout()
      connection.send('calibrationSession.begin', { sessionId, channel: 'both' })
    } catch (error: unknown) {
      await closeCapture()
      sessionId = null
      profile = null
      stage.value = 'error'
      message.value = error instanceof Error ? error.message : 'Microphone access failed.'
    }
  }

  async function onReady(payload: unknown) {
    if (stage.value !== 'preparing' || !sessionId || !isMeasurementReadyPayload(payload)) return
    if (payload.sessionId !== sessionId) return
    sweep = payload.sweep
    try {
      if (!recorder) throw new Error('Microphone recorder is unavailable.')
      await recorder.start()
      if (disposed || !sessionId) return
      stage.value = 'recording'
      message.value = 'Follow the instructions on the TV. Recording locally…'
      connection.send('measurement.playSweep', { sessionId })
    } catch (error: unknown) {
      await fail('calibration_ui_failed', error instanceof Error ? error.message : 'Microphone recording failed.')
    }
  }

  async function onFinished(payload: unknown) {
    if (stage.value !== 'recording' || !sessionId || !sweep) return
    if (typeof payload !== 'object' || payload === null || !('sessionId' in payload) || payload.sessionId !== sessionId) return
    const currentSessionId = sessionId
    const currentSweep = sweep
    const currentRecorder = recorder
    const currentProfile = profile
    stage.value = 'analyzing'
    message.value = 'Analyzing locally in this browser…'
    try {
      if (!currentRecorder) throw new Error('Microphone recorder is unavailable.')
      const recording = await currentRecorder.stop()
      captureDiagnostics.value = recording.diagnostics
      const sampleRate = recording.diagnostics.sampleRate > 0
        ? recording.diagnostics.sampleRate
        : currentSweep.sampleRate
      if (!currentProfile) throw new Error('Microphone calibration profile is unavailable.')
      const result = await analyzeInWorker(recording.samples, sampleRate, currentSweep, currentProfile)
      if (result.status !== 'ok') {
        await fail(analysisErrorCode(result.status), `Measurement rejected: ${result.status.replaceAll('_', ' ')}.`)
        return
      }
      analysis.value = result
      await closeCapture()
      clearTimeoutTimer()
      stage.value = 'ending'
      message.value = 'Restoring the TV audio state…'
      connection.send('calibrationSession.end', { sessionId: currentSessionId })
    } catch (error: unknown) {
      await fail('sweep_not_found', error instanceof Error ? error.message : 'Measurement analysis failed.')
    }
  }

  function onMessage(env: Envelope) {
    if (env.type === 'measurement.ready') {
      void onReady(env.payload)
      return
    }
    if (env.type === 'measurement.started' && stage.value === 'recording') {
      message.value = 'Follow the instructions on the TV. Recording locally…'
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
      void fail('invalid_session', text)
      return
    }
    if (env.type === 'calibrationSession.ended' && sessionId && typeof env.payload === 'object' && env.payload !== null &&
      'sessionId' in env.payload && env.payload.sessionId === sessionId) {
      const hadAnalysis = analysis.value !== null
      clearTimeoutTimer()
      void closeCapture()
      sessionId = null
      sweep = null
      profile = null
      stage.value = hadAnalysis ? 'complete' : 'idle'
      message.value = hadAnalysis ? 'Measurement complete.' : 'Calibration cancelled.'
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
    void closeCapture()
    sessionId = null
    sweep = null
    profile = null
    stage.value = 'idle'
    message.value = 'Calibration cancelled.'
  }

  onScopeDispose(() => {
    disposed = true
    off()
    clearTimeoutTimer()
    if (sessionId) connection.send('calibrationSession.abort', { sessionId, code: 'calibration_aborted' })
    void closeCapture()
    sessionId = null
    sweep = null
    profile = null
  })

  return {
    stage: readonly(stage),
    message: readonly(message),
    analysis,
    captureDiagnostics,
    captureInfo,
    profiles: readonly(profiles),
    selectedProfileId,
    profileError: readonly(profileError),
    loadProfiles,
    start,
    cancel,
  }
}
