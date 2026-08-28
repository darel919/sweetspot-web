import { describe, expect, test } from 'bun:test'
import { effectScope } from 'vue'
import type {
  CalibrationJobView,
  CalibrationNextAction,
  Envelope,
} from '../../shared/types/protocol'
import type { MicCalibrationProfile } from '../lib/audio/mics/types'
import type { MicrophoneCapture } from '../lib/audio/capture/microphone'
import type { PcmRecorder } from '../lib/audio/capture/pcm-recorder'
import { decodeCaptureStreamFrame } from '../../shared/transport/captureStream'
import { validatePayload } from '../../shared/types/protocol'
import {
  acceptCalibrationJobState,
  buildCalibrationCapture,
  encodeCalibrationPcm,
  useCalibrationRemoteMic,
} from './useCalibrationRemoteMic'

const captureSettings = {
  sampleRate: 48_000,
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

const microphoneProfile: MicCalibrationProfile = {
  id: 'apple_iphone17pro_2025',
  name: 'test microphone',
  author: 'test',
  manufacturer: 'test',
  model: 'test',
  sourceUrl: 'https://example.test',
  sourceDate: '2025-09-25',
  referenceType: 'free-field',
  sourceSmoothing: 'none',
  capturePath: 'test',
  capturePathStatus: 'validated',
  dataMethod: 'published-data',
  normalizeAtHz: 1_000,
  referenceMicrophone: 'test',
  referenceMicSpacingMm: 1,
  referenceMicSpacingApproximate: false,
  measurementEnvironment: 'test',
  excitation: 'test',
  orientationsAveraged: 1,
  referenceCalibration: 'test',
  publishedTraces: [],
  directivityMeasuredSeparately: false,
  points: [
    { frequencyHz: 20, responseDb: 0 },
    { frequencyHz: 20_000, responseDb: 0 },
  ],
  trust: { minHz: 30, fullTrustMaxHz: 8_000, taperToHz: 12_000 },
}

function job(revision: number, jobId = 'job-1'): CalibrationJobView {
  return {
    jobId,
    createdAtMs: 1_757_000_000_000,
    revision,
    analyzerRevision: 'android-response-v1',
    sweepRevision: 'android-sweep-v3',
    phase: 'measuring_required',
    acceptedPositions: [],
    excludedPositions: [],
    historicalAttemptCount: 0,
    optionalFailureCount: 0,
    minimumViableCalibration: false,
    bestSolution: null,
    confidence: null,
    nextAction: {
      kind: 'capture',
      captureId: 'center-left-0',
      positionId: 'center',
      channel: 'left',
      attemptIndex: 0,
      optional: false,
      instruction: 'Keep the phone still at center.',
    },
    activeCandidateId: null,
    validationState: 'none',
    lastError: null,
  }
}

function envelope(type: string, payload: unknown): Envelope {
  return { v: 1, id: `${type}-1`, type, ts: Date.now(), payload, transportSessionId: 'session-1' }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for the remote microphone')
}

describe('TV-owned calibration remote microphone', () => {
  test('ignores stale job states while accepting a newer revision', () => {
    const current = job(4)
    expect(acceptCalibrationJobState(current, job(3))).toBe(current)
    const next = job(5)
    expect(acceptCalibrationJobState(current, next)).toBe(next)
  })

  test('does not let an old job replace an active job after reconnect', () => {
    const current = job(4, 'job-current')
    expect(acceptCalibrationJobState(current, { ...job(99, 'job-old'), createdAtMs: current.createdAtMs - 1 })).toBe(current)
    const terminal = { ...current, phase: 'complete' as const }
    expect(acceptCalibrationJobState(terminal, job(1, 'job-new'))?.jobId).toBe('job-new')
  })

  test('encodes microphone PCM as little-endian Float32', () => {
    expect(Array.from(new Uint8Array(encodeCalibrationPcm(new Float32Array([1, -2, 0.25]))))).toEqual([
      0x00, 0x00, 0x80, 0x3f,
      0x00, 0x00, 0x00, 0xc0,
      0x00, 0x00, 0x80, 0x3e,
    ])
  })

  test('builds required-position metadata without doing analysis in the browser', () => {
    const action = {
      kind: 'capture',
      captureId: 'center-left-0',
      positionId: 'center',
      channel: 'left',
      attemptIndex: 0,
      optional: false,
      instruction: 'Keep the phone still at center.',
    } satisfies Extract<CalibrationNextAction, { kind: 'capture' }>
    const built = buildCalibrationCapture({
      jobId: 'job-1',
      action,
      captureSettings,
      sampleRate: 48_000,
      sampleCount: 12,
      contentSha256: 'a'.repeat(64),
      microphoneProfile,
      capturedAtMs: 1_757_000_000_000,
    })
    expect(built.readyType).toBe('calibration.capture.ready')
    expect(built.readyPayload).toEqual({ jobId: 'job-1', captureId: 'center-left-0' })
    expect(built.metadata).toMatchObject({
      jobId: 'job-1',
      captureId: 'center-left-0',
      positionId: 'center',
      channel: 'left',
      sampleRate: 48_000,
      sampleCount: 12,
      byteCount: 48,
    })
  })

  test('uses one both-channel validation capture and keeps its candidate identity', () => {
    const action = {
      kind: 'validate',
      captureId: 'validation-0',
      positionId: 'center',
      candidateId: 'candidate-4',
      attemptIndex: 0,
      instruction: 'Return the phone to center.',
    } satisfies Extract<CalibrationNextAction, { kind: 'validate' }>
    const built = buildCalibrationCapture({
      jobId: 'job-1',
      action,
      captureSettings,
      sampleRate: 48_000,
      sampleCount: 12,
      contentSha256: 'b'.repeat(64),
      microphoneProfile,
      capturedAtMs: 1_757_000_000_000,
    })
    expect(built.readyType).toBe('calibration.validation.capture.ready')
    expect(built.readyPayload).toEqual({
      jobId: 'job-1',
      captureId: 'validation-0',
      candidateId: 'candidate-4',
    })
    expect(built.metadata.channel).toBe('both')
    expect(validatePayload('calibration.capture.finished', {
      jobId: 'job-1',
      captureId: 'validation-0',
    })).toBeNull()
  })

  test('streams a capture through the generic transport and waits for the TV acknowledgement', async () => {
    const inbound = new Set<(message: Envelope) => void>()
    const commands: string[] = []
    const frames: ArrayBuffer[] = []
    let onChunk: ((samples: Float32Array) => Promise<void> | void) | undefined
    const track = {
      readyState: 'live',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as MediaStreamTrack
    const opened = {
      stream: { getTracks: () => [track] },
      track,
      settings: captureSettings,
      capabilities: {
        sampleRate: null,
        channelCount: null,
        echoCancellation: [],
        noiseSuppression: [],
        autoGainControl: [],
      },
    } as unknown as MicrophoneCapture
    const recorder: PcmRecorder = {
      start: async () => undefined,
      stop: async () => ({
        samples: new Float32Array(0),
        diagnostics: {
          sampleRate: 48_000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          rms: 0.25,
          peak: 0.5,
          clipped: false,
          clippedSamples: 0,
          sampleCount: 2,
        },
        startSample: 0,
        endSample: 2,
      }),
      dispose: async () => undefined,
      sampleRate: () => 48_000,
    }
    const connection = {
      send: (type: string) => {
        commands.push(type)
        return `${type}-1`
      },
      sendCaptureFrame: async (frame: ArrayBuffer) => {
        frames.push(frame.slice(0))
      },
      sessionId: () => 'session-1',
      onMessage: (handler: (message: Envelope) => void) => {
        inbound.add(handler)
        return () => inbound.delete(handler)
      },
      onStateChange: () => () => undefined,
    }
    const scope = effectScope()
    const remote = scope.run(() => useCalibrationRemoteMic(connection, {
      dependencies: {
        openMicrophone: async () => opened,
        closeMicrophone: () => undefined,
        createPcmRecorder: (_capture, options) => {
          onChunk = options.onChunk
          return recorder
        },
        discoverMicCalibrationProfiles: async () => [microphoneProfile],
        now: () => 1_757_000_000_000,
      },
    }))
    if (!remote) throw new Error('The remote microphone composable did not initialize')

    remote.resumeJob()
    inbound.forEach((handler) => handler(envelope('calibration.job.state', job(1))))
    await waitFor(() => commands.includes('calibration.capture.ready') && frames.length >= 1)
    await onChunk?.(new Float32Array([0.25, -0.5]))
    inbound.forEach((handler) => handler(envelope('calibration.capture.finished', {
      jobId: 'job-1',
      captureId: 'center-left-0',
    })))
    await waitFor(() => remote.captureState.value === 'waiting')

    const decodedKinds = frames.map((frame) => {
      const decoded = decodeCaptureStreamFrame(frame)
      return decoded.ok ? decoded.frame.kind : 'invalid'
    })
    expect(decodedKinds).toEqual(['begin', 'chunk', 'end'])
    expect(commands).toContain('calibration.capture.ready')
    const metadata = remote.captureMetadata.value
    if (!metadata) throw new Error('The capture metadata was not published')
    inbound.forEach((handler) => handler(envelope('calibration.capture.uploaded', {
      jobId: metadata.jobId,
      captureId: metadata.captureId,
      contentSha256: metadata.contentSha256,
      sampleCount: metadata.sampleCount,
      byteCount: metadata.byteCount,
      status: 'accepted',
    })))
    await waitFor(() => remote.captureState.value === 'waiting')
    scope.stop()
  })
})
