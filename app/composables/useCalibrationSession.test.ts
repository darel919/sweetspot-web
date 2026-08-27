import { describe, expect, test } from 'bun:test'
import { effectScope } from 'vue'
import type { Envelope, MeasurementContext, MeasurementSweep } from '../../shared/types/protocol'
import { CALIBRATION_POSITION_TARGETS } from '../../shared/types/protocol'
import type { CompositeMeasurementAnalysis, MeasurementAnalysis } from '../lib/audio/measurement/response'
import type { MicCalibrationProfile } from '../lib/audio/mics/types'
import type { MicrophoneCapture } from '../lib/audio/capture/microphone'
import type { PcmRecorder, PcmRecording } from '../lib/audio/capture/pcm-recorder'
import {
  CALIBRATION_ANALYSIS_REVISION,
  CALIBRATION_SWEEP_REVISION,
  CALIBRATION_WEB_BUILD_SHA,
  createCalibrationCheckpoint,
  type CalibrationCheckpoint,
} from '../lib/audio/measurement/checkpoint'
import { createPositionLedger } from '../lib/audio/measurement/position-ledger'
import {
  useCalibrationSession,
  type CalibrationSessionDependencies,
  type CalibrationSessionOptions,
} from './useCalibrationSession'
import { isCalibrationOperationCurrent, isSameMeasurementContext } from '../lib/audio/measurement/session-guard'

const sweep: MeasurementSweep = {
  sweepRevision: 'android-sweep-v3' as const,
  algorithm: 'exponential-sine-v1',
  captureKind: 'position-composite',
  markerChannel: 'left',
  sampleRate: 48_000,
  startHz: 20,
  endHz: 20_000,
  durationMs: 1_500,
  preRollMs: 500,
  postRollMs: 500,
  syncMarkerStartHz: 1_000,
  syncMarkerEndHz: 4_000,
  syncMarkerDurationMs: 40,
  syncMarkerGapMs: 10,
  endMarkerStartHz: 3_500,
  endMarkerEndHz: 1_500,
  endMarkerDurationMs: 40,
  interSweepGapMs: 50,
  sweepLevelDbfs: -12,
  markerLevelDbfs: -12,
  fadeInMs: 20,
  fadeOutMs: 20,
}

const profile: MicCalibrationProfile = {
  id: 'fixture-mic',
  name: 'Fixture microphone',
  author: 'test',
  manufacturer: 'test',
  model: 'fixture',
  sourceUrl: 'https://example.com/mic',
  sourceDate: '2026-01-01',
  referenceType: 'free-field',
  sourceSmoothing: 'none',
  capturePath: 'fixture',
  capturePathStatus: 'validated',
  dataMethod: 'published-data',
  normalizeAtHz: 1_000,
  referenceMicrophone: 'fixture',
  referenceMicSpacingMm: 0,
  referenceMicSpacingApproximate: false,
  measurementEnvironment: 'fixture',
  excitation: 'fixture',
  orientationsAveraged: 1,
  referenceCalibration: 'fixture',
  publishedTraces: [],
  directivityMeasuredSeparately: false,
  points: [{ frequencyHz: 100, responseDb: 0 }, { frequencyHz: 10_000, responseDb: 0 }],
  trust: { minHz: 100, fullTrustMaxHz: 10_000, taperToHz: 20_000 },
}

function capture(sampleRate: number | null = 48_000): MicrophoneCapture {
  const track = {
    readyState: 'live',
    getSettings: () => ({ ...(sampleRate === null ? {} : { sampleRate }), channelCount: 1 }),
    getCapabilities: () => ({}),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  return { stream, track, settings: { sampleRate, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, capabilities: { sampleRate: null, channelCount: null, echoCancellation: [], noiseSuppression: [], autoGainControl: [] } } as unknown as MicrophoneCapture
}

function recording(sampleRate: number, length: number): PcmRecording {
  return {
    samples: new Float32Array(length).fill(0.1),
    diagnostics: {
      sampleRate,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      rms: 0.1,
      peak: 0.1,
      clipped: false,
      clippedSamples: 0,
      sampleCount: length,
    },
    startSample: 0,
    endSample: length,
  }
}

function analysis(profileValue: MicCalibrationProfile, status: MeasurementAnalysis['status'] = 'ok'): MeasurementAnalysis {
  const points = [{ frequencyHz: 100, magnitudeDb: 0 }, { frequencyHz: 1_000, magnitudeDb: 0 }, { frequencyHz: 10_000, magnitudeDb: 0 }]
  return {
    status,
    rawPoints: points,
    correctedPoints: status === 'ok' ? points : [],
    displayPoints: points,
    room: null,
    impulse: null,
    micProfile: {
      id: profileValue.id,
      name: profileValue.name,
      author: profileValue.author,
      sourceUrl: profileValue.sourceUrl,
      sourceDate: profileValue.sourceDate,
      referenceType: profileValue.referenceType,
      capturePath: profileValue.capturePath,
      capturePathStatus: profileValue.capturePathStatus,
      dataMethod: profileValue.dataMethod,
    },
    diagnostics: {
      detected: status === 'ok',
      detectionOffsetMs: 0,
      envelopeOnlyOffsetMs: null,
      detectionConfidence: 1,
      endingMarkerConfidence: 1,
      rawLeadingMarkerConfidence: 1,
      rawTrailingMarkerConfidence: 1,
      bestLeadingMarkerSample: 1,
      bestTrailingMarkerSample: 2,
      markerPairScore: 1,
      markerSeparationError: 0,
      markerTimingAgreement: 1,
      markerSeparationPpm: 0,
      syncMarkerFailureReason: null,
      clockDriftPpm: 0,
      signalRms: 0.1,
      signalPeak: 0.1,
      snrEstimateDb: 40,
      clipped: false,
      clippedSamples: 0,
      sampleCount: 1,
      frequencyPoints: points.length,
      failureReason: status === 'ok' ? null : status,
    },
  }
}

function composite(profileValue: MicCalibrationProfile, leftStatus: MeasurementAnalysis['status'] = 'ok', rightStatus = leftStatus): CompositeMeasurementAnalysis {
  return {
    status: leftStatus === 'ok' && rightStatus === 'ok' ? 'ok' : leftStatus === 'ok' || rightStatus === 'ok' ? 'partial' : leftStatus,
    detection: {
      found: true,
      startSample: 0,
      rightStartSample: 1,
      leadingMarkerSample: 0,
      trailingMarkerSample: 2,
      envelopeOnlyOffsetMs: null,
      offsetMs: 0,
      confidence: 1,
      endingMarkerConfidence: 1,
      rawLeadingMarkerConfidence: 1,
      rawTrailingMarkerConfidence: 1,
      bestLeadingMarkerSample: 0,
      bestTrailingMarkerSample: 2,
      markerPairScore: 1,
      markerSeparationError: 0,
      markerTimingAgreement: 1,
      markerSeparationPpm: 0,
      clockRatio: 1,
      driftPpm: 0,
      expectedMarkerSeparationSamples: 2,
      observedMarkerSeparationSamples: 2,
      failureReason: null,
    },
    left: analysis(profileValue, leftStatus),
    right: analysis(profileValue, rightStatus),
  }
}

class FakeConnection {
  readonly sent: { type: string; payload: any }[] = []
  private handler: ((env: Envelope) => void) | null = null
  online = true

  send = (type: string, payload: unknown = {}): string => {
    this.sent.push({ type, payload })
    return `reply-${this.sent.length}`
  }

  onMessage = (handler: (env: Envelope) => void): (() => void) => {
    this.handler = handler
    return () => { this.handler = null }
  }

  isDeviceOnline = (): boolean => this.online

  emit(type: string, payload: unknown) {
    this.handler?.({ type, payload } as Envelope)
  }

  last(type: string): { type: string; payload: any } | undefined {
    return [...this.sent].reverse().find((entry) => entry.type === type)
  }
}

class CalibrationHarness {
  readonly connection = new FakeConnection()
  readonly scope = effectScope()
  readonly analyzerStatuses: [MeasurementAnalysis['status'], MeasurementAnalysis['status']][] = []
  readonly downloaded: unknown[] = []
  readonly recordings: PcmRecording[] = []
  readonly savedCheckpoints: CalibrationCheckpoint[] = []
  readonly device = { id: 'fixture-device', appVersion: '0.1.0', buildId: 'fixture-build' }
  recorderStarts = 0
  recorderStops = 0
  actualSampleRate: number
  session: ReturnType<typeof useCalibrationSession>

  constructor(actualSampleRate = 48_000, statuses: MeasurementAnalysis['status'][] = [], checkpoint: CalibrationCheckpoint | null = null, reportedTrackSampleRate: number | null = actualSampleRate) {
    this.actualSampleRate = actualSampleRate
    let statusIndex = 0
    const dependencies: Partial<CalibrationSessionDependencies> = {
      discoverMicCalibrationProfiles: async () => [profile],
      openMicrophone: async () => capture(reportedTrackSampleRate),
      closeMicrophone: () => undefined,
      createPcmRecorder: () => {
        const recorder: PcmRecorder = {
          start: async () => { this.recorderStarts += 1 },
          stop: async () => {
            this.recorderStops += 1
            const next = this.recorderStops === 1 ? recording(this.actualSampleRate, Math.round(this.actualSampleRate * 0.5)) : recording(this.actualSampleRate, 1_024)
            this.recordings.push(next)
            return next
          },
          dispose: async () => undefined,
          sampleRate: () => this.actualSampleRate,
        }
        return recorder
      },
      analyzeInWorker: async (_samples, _sampleRate, _sweep, micProfile) => {
        const leftStatus = statuses[statusIndex] ?? 'ok'
        const rightStatus = statuses[statusIndex + 1] ?? leftStatus
        statusIndex += 2
        return composite(micProfile, leftStatus, rightStatus)
      },
      loadCalibrationCheckpoint: async () => checkpoint,
      saveCalibrationCheckpoint: async (value) => { this.savedCheckpoints.push(value) },
      clearCalibrationCheckpoint: async () => undefined,
      downloadCalibrationDebugBundle: (value) => { this.downloaded.push(value) },
    }
    const options: CalibrationSessionOptions = {
      getDeviceIdentity: () => this.device,
      debugCaptureExport: true,
      dependencies,
    }
    this.session = this.scope.run(() => useCalibrationSession(this.connection, options))!
  }

  async waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    throw new Error('Timed out waiting for calibration harness state')
  }

  async start(): Promise<void> {
    this.session.start()
    await this.waitFor(() => this.connection.last('calibrationSession.begin') !== undefined)
  }

  async completeLoudness(): Promise<void> {
    const begin = this.connection.last('calibrationSession.begin')
    const sessionId = begin?.payload.sessionId
    this.connection.emit('measurement.ready', { sessionId, sweep })
    await this.waitFor(() => this.connection.last('calibrationSession.loudness.start') !== undefined)
    this.connection.emit('calibrationSession.loudness.started', { sessionId })
    await this.waitFor(() => this.recorderStarts === 1)
    this.connection.emit('calibrationSession.loudness.stopped', { sessionId })
    await this.waitFor(() => this.connection.last('measurement.prepare') !== undefined)
  }

  async completeTake(): Promise<void> {
    const prepare = this.connection.last('measurement.prepare')
    const sessionId = prepare?.payload.sessionId
    const context = prepare?.payload.context as MeasurementContext
    const playSweepCount = this.connection.sent.filter((entry) => entry.type === 'measurement.playSweep').length
    this.connection.emit('measurement.ready', { sessionId, sweep, context })
    if (this.session.stage.value === 'position-pause') {
      this.connection.emit('calibrationSession.position.continued', { sessionId, context })
    }
    await this.waitFor(() =>
      this.connection.sent.filter((entry) => entry.type === 'measurement.playSweep').length > playSweepCount
        && this.connection.last('measurement.playSweep')?.payload.context === context,
    )
    this.connection.emit('measurement.finished', { sessionId, context })
    await this.waitFor(() => this.session.stage.value !== 'analyzing')
  }

  dispose() {
    this.scope.stop()
  }
}

describe('useCalibrationSession integration state machine', () => {
  test('completes a marker-only probe without response records', async () => {
    const harness = new CalibrationHarness()
    try {
      harness.session.startProbe('marker-only')
      await harness.waitFor(() => harness.connection.last('calibrationSession.begin') !== undefined)
      const sessionId = harness.connection.last('calibrationSession.begin')?.payload.sessionId
      harness.connection.emit('measurement.ready', { sessionId, sweep })
      await harness.waitFor(() => harness.connection.last('measurement.prepare') !== undefined)
      for (let index = 0; index < 5; index++) await harness.completeTake()
      await harness.waitFor(() => harness.connection.last('calibrationSession.end') !== undefined)
      harness.connection.emit('calibrationSession.ended', { sessionId, outcome: 'sufficient', completedSessionId: sessionId })
      await harness.waitFor(() => harness.session.stage.value === 'complete')

      expect(harness.session.records.value).toHaveLength(0)
      expect(harness.session.takeDiagnostics.value).toHaveLength(5)
      expect(harness.session.message.value).toContain('Diagnostic marker probe complete')
    } finally {
      harness.dispose()
    }
  })

  test('completes a marker-only probe with failed positions as diagnostics', async () => {
    const statuses = [
      ...Array.from({ length: 8 }, () => 'ok' as const),
      'sync_marker_not_found' as const,
      'sync_marker_not_found' as const,
      'sync_marker_not_found' as const,
      'sync_marker_not_found' as const,
    ]
    const harness = new CalibrationHarness(48_000, statuses)
    try {
      harness.session.startProbe('marker-only')
      await harness.waitFor(() => harness.connection.last('calibrationSession.begin') !== undefined)
      const sessionId = harness.connection.last('calibrationSession.begin')?.payload.sessionId
      harness.connection.emit('measurement.ready', { sessionId, sweep })
      await harness.waitFor(() => harness.connection.last('measurement.prepare') !== undefined)
      for (let index = 0; index < 5; index++) {
        await harness.completeTake()
      }
      await harness.completeTake()
      await harness.waitFor(() => harness.connection.last('calibrationSession.end') !== undefined)
      harness.connection.emit('calibrationSession.ended', { sessionId, outcome: 'sufficient', completedSessionId: sessionId })
      await harness.waitFor(() => harness.session.stage.value === 'complete')

      expect(harness.session.records.value).toHaveLength(0)
      expect(harness.session.takeDiagnostics.value).toHaveLength(6)
      expect(harness.session.failedTakeDiagnostics.value).toHaveLength(1)
    } finally {
      harness.dispose()
    }
  })

  test('resolves a failed marker retry without poisoning the final probe result', async () => {
    const statuses = [
      'ok' as const, 'ok' as const,
      'sync_marker_not_found' as const, 'ok' as const,
      'ok' as const, 'ok' as const,
      'ok' as const, 'ok' as const,
      'ok' as const, 'ok' as const,
      'ok' as const, 'ok' as const,
    ]
    const harness = new CalibrationHarness(48_000, statuses)
    try {
      harness.session.startProbe('marker-only')
      await harness.waitFor(() => harness.connection.last('calibrationSession.begin') !== undefined)
      const sessionId = harness.connection.last('calibrationSession.begin')?.payload.sessionId
      harness.connection.emit('measurement.ready', { sessionId, sweep })
      await harness.waitFor(() => harness.connection.last('measurement.prepare') !== undefined)
      for (let attempt = 0; attempt < 7 && !harness.connection.last('calibrationSession.end'); attempt++) {
        await harness.completeTake()
      }
      await harness.waitFor(() => harness.connection.last('calibrationSession.end') !== undefined)
      harness.connection.emit('calibrationSession.ended', { sessionId, outcome: 'sufficient', completedSessionId: sessionId })
      await harness.waitFor(() => harness.session.stage.value === 'complete')

      expect(harness.session.takeDiagnostics.value).toHaveLength(6)
      expect(harness.session.failedTakeDiagnostics.value).toHaveLength(0)
      expect(harness.session.probeSummary.value).toEqual({
        requestedPositionCount: 5,
        completedPositionCount: 5,
        failedPositionIds: [],
        historicalAttemptCount: 6,
        historicalFailureCount: 1,
        passed: true,
      })
      expect(harness.session.message.value).toContain('Diagnostic marker probe complete')
    } finally {
      harness.dispose()
    }
  })

  test('aborting a marker-only probe returns to idle', async () => {
    const harness = new CalibrationHarness()
    try {
      harness.session.startProbe('marker-only')
      await harness.waitFor(() => harness.connection.last('calibrationSession.begin') !== undefined)
      harness.session.cancel()
      await harness.waitFor(() => harness.session.stage.value === 'idle')
    } finally {
      harness.dispose()
    }
  })

  test('reports a marker-only transport failure as an error', async () => {
    const harness = new CalibrationHarness()
    try {
      harness.session.startProbe('marker-only')
      await harness.waitFor(() => harness.connection.last('calibrationSession.begin') !== undefined)
      const sessionId = harness.connection.last('calibrationSession.begin')?.payload.sessionId
      harness.connection.emit('measurement.ready', { sessionId, sweep })
      await harness.waitFor(() => harness.connection.last('measurement.prepare') !== undefined)
      harness.connection.emit('measurement.error', { sessionId, code: 'sweep_playback_failed', message: 'transport failed' })
      await harness.waitFor(() => harness.session.stage.value === 'error')
      expect(harness.session.message.value).toBe('transport failed')
      expect(harness.connection.last('state.get')).toBeDefined()
    } finally {
      harness.dispose()
    }
  })

  test('runs microphone opening, loudness preflight, center capture, and ignores stale events', async () => {
    const harness = new CalibrationHarness()
    try {
      await harness.start()
      expect(harness.session.stage.value).toBe('preparing')
      await harness.completeLoudness()
      await harness.completeTake()
      expect(harness.session.records.value).toHaveLength(2)
      expect(harness.session.currentContext.value?.positionId).toBeDefined()
      await harness.waitFor(() => harness.savedCheckpoints.length > 0)

      const oldSessionId = harness.connection.last('calibrationSession.begin')?.payload.sessionId
      harness.session.cancel()
      await harness.waitFor(() => harness.session.stage.value === 'idle')
      harness.connection.emit('measurement.finished', { sessionId: oldSessionId, context: harness.session.currentContext.value })
      expect(harness.session.stage.value).toBe('idle')
    } finally {
      harness.dispose()
    }
  })

  test('keeps a failed channel visible until the integration retry repairs it', async () => {
    const harness = new CalibrationHarness(48_000, ['ok', 'direct_arrival_low_confidence', 'ok', 'ok'])
    try {
      await harness.start()
      await harness.completeLoudness()
      await harness.completeTake()
      expect(harness.session.failedTakeDiagnostics.value.length).toBeGreaterThan(0)
      await harness.completeTake()
      expect(harness.session.failedTakeDiagnostics.value).toHaveLength(0)
      expect(harness.session.records.value.length).toBeGreaterThan(1)
    } finally {
      harness.dispose()
    }
  })

  test('retries both channels after a composite failure', async () => {
    const harness = new CalibrationHarness(48_000, ['direct_arrival_low_confidence', 'impulse_not_found', 'ok', 'ok'])
    try {
      await harness.start()
      await harness.completeLoudness()
      await harness.completeTake()
      expect(harness.session.failedTakeDiagnostics.value.length).toBeGreaterThan(0)
      await harness.completeTake()
      expect(harness.session.failedTakeDiagnostics.value).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  test('clears prior-session diagnostics before a fresh session can be aborted', async () => {
    const harness = new CalibrationHarness(48_000, ['ok', 'direct_arrival_low_confidence'])
    try {
      await harness.start()
      await harness.completeLoudness()
      await harness.completeTake()
      expect(harness.session.failedTakeDiagnostics.value).toHaveLength(1)

      harness.session.cancel()
      await harness.waitFor(() => harness.session.stage.value === 'idle')

      await harness.start()
      expect(harness.session.progress.value).toEqual({ current: 0, total: 3 })
      expect(harness.session.failedTakeDiagnostics.value).toHaveLength(0)
      expect(harness.session.takeDiagnostics.value).toHaveLength(0)

      harness.session.cancel()
      await harness.waitFor(() => harness.session.stage.value === 'idle')
      expect(harness.session.failedTakeDiagnostics.value).toHaveLength(0)
    } finally {
      harness.dispose()
    }
  })

  test('rejects a resumed sweep before playback when the recorder rate changed', async () => {
    const checkpoint: CalibrationCheckpoint = createCalibrationCheckpoint({
      sessionId: 'previous-session',
      device: { id: 'fixture-device', appVersion: '0.1.0', buildId: 'fixture-build' },
      microphone: { profileId: profile.id, sourceDate: profile.sourceDate, capturePathStatus: profile.capturePathStatus, sampleRate: 48_000 },
      webBuildSha: CALIBRATION_WEB_BUILD_SHA,
      analysisRevision: CALIBRATION_ANALYSIS_REVISION,
      sweepRevision: CALIBRATION_SWEEP_REVISION,
      captureMetadata: null,
      ledger: createPositionLedger('previous-session'),
    })
    const harness = new CalibrationHarness(44_100, [], checkpoint)
    try {
      await harness.session.loadProfiles()
      await harness.session.refreshResumeCheckpoint()
      expect(harness.session.resumeAvailable.value).toBe(true)
      await harness.session.resume()
      await harness.waitFor(() => harness.session.stage.value === 'error')
      expect(harness.connection.last('measurement.playSweep')).toBeUndefined()
      expect(checkpoint.microphone.sampleRate).toBe(48_000)
    } finally {
      harness.dispose()
    }
  })

  test('resumes with an unknown initial track rate when the recorder establishes the stored rate', async () => {
    const checkpoint = createCalibrationCheckpoint({
      sessionId: 'previous-session',
      device: { id: 'fixture-device', appVersion: '0.1.0', buildId: 'fixture-build' },
      microphone: { profileId: profile.id, sourceDate: profile.sourceDate, capturePathStatus: profile.capturePathStatus, sampleRate: 48_000 },
      captureMetadata: null,
      ledger: createPositionLedger('previous-session'),
    })
    const harness = new CalibrationHarness(48_000, [], checkpoint, null)
    try {
      await harness.session.loadProfiles()
      await harness.session.resume()
      await harness.waitFor(() => harness.connection.last('calibrationSession.begin') !== undefined)
      expect(harness.session.stage.value).toBe('preparing')
    } finally {
      harness.dispose()
    }
  })

  test('starts validation against the accepted physical position and keeps the candidate id', async () => {
    const harness = new CalibrationHarness()
    try {
      harness.session.startValidation('candidate-1', ['center'])
      await harness.waitFor(() => harness.connection.last('calibrationSession.begin') !== undefined)
      expect(harness.session.validationActive.value).toBe(true)
      expect(harness.session.validationCandidateId.value).toBe('candidate-1')
      const begin = harness.connection.last('calibrationSession.begin')
      harness.connection.emit('measurement.ready', { sessionId: begin?.payload.sessionId, sweep })
      await harness.waitFor(() => harness.connection.last('measurement.prepare') !== undefined)
      await harness.completeTake()
      expect(harness.session.validationRecords.value).toHaveLength(2)
      expect(harness.connection.last('calibrationSession.end')).toBeDefined()
    } finally {
      harness.dispose()
    }
  })

  test('exports the retained debug capture with the session identity', async () => {
    const harness = new CalibrationHarness()
    try {
      await harness.start()
      await harness.completeLoudness()
      await harness.completeTake()
      harness.session.exportDebugBundle()
      expect(harness.downloaded).toHaveLength(1)
      expect((harness.downloaded[0] as { sessionIds?: string[]; markerChannel?: string }).sessionIds).toEqual([expect.stringMatching(/^cal_/)])
      expect((harness.downloaded[0] as { markerChannel?: string }).markerChannel).toBe('left')
    } finally {
      harness.dispose()
    }
  })
})

const guardContext: MeasurementContext = {
  positionId: 'center',
  ...CALIBRATION_POSITION_TARGETS.center,
  positionIndex: 0,
  positionCount: 1,
  channel: 'both',
  captureKind: 'position-composite',
  repairChannel: 'both',
  attemptIndex: 0,
  attemptCount: 2,
  phase: 'measurement',
}

describe('calibration operation fencing', () => {
  test('accepts the current session generation and rejects a cancelled generation', () => {
    expect(isCalibrationOperationCurrent(4, 4, 'session-1', 'session-1')).toBe(true)
    expect(isCalibrationOperationCurrent(4, 5, 'session-1', 'session-1')).toBe(false)
    expect(isCalibrationOperationCurrent(4, 4, 'session-1', null)).toBe(false)
  })

  test('treats a retry as a different playback context for stale event filtering', () => {
    const retry = { ...guardContext, attemptIndex: 1 }

    expect(isSameMeasurementContext(guardContext, guardContext)).toBe(true)
    expect(isSameMeasurementContext(guardContext, retry)).toBe(false)
  })
})
