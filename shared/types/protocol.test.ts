import { describe, expect, test } from 'bun:test'
import {
  isEnvelope,
  isCalibrationPackage,
  KNOWN_TYPES,
  isMeasurementContext,
  isMeasurementSweep,
  isRoomSocketServerMessage,
  isStateSnapshot,
  validatePayload,
} from './protocol'

const sweep = {
  algorithm: 'exponential-sine-v1',
  captureKind: 'position-composite',
  sampleRate: 48_000,
  startHz: 20,
  endHz: 20_000,
  durationMs: 8_000,
  preRollMs: 1_000,
  postRollMs: 1_000,
  syncMarkerStartHz: 1_000,
  syncMarkerEndHz: 4_000,
  syncMarkerDurationMs: 40,
  syncMarkerGapMs: 10,
  endMarkerStartHz: 3_500,
  endMarkerEndHz: 1_500,
  endMarkerDurationMs: 40,
  interSweepGapMs: 50,
  levelDbfs: -12,
  fadeInMs: 20,
  fadeOutMs: 20,
}

const context = {
  positionId: 'center',
  positionIndex: 0,
  positionCount: 5,
  channel: 'both',
  captureKind: 'position-composite',
  repairChannel: 'both',
  attemptIndex: 0,
  attemptCount: 2,
  phase: 'measurement',
} as const

describe('measurement protocol boundary', () => {
  test('accepts the deterministic sweep descriptor', () => {
    expect(isMeasurementSweep(sweep)).toBe(true)
    expect(validatePayload('measurement.ready', { sessionId: 'cal_test', sweep })).toBeNull()
  })

  test('rejects missing session and malformed sweep payloads', () => {
    expect(validatePayload('measurement.playSweep', {})).not.toBeNull()
    expect(validatePayload('measurement.ready', { sessionId: 'cal_test', sweep: { ...sweep, endHz: 1 } })).not.toBeNull()
  })

  test('accepts a composite position context and rejects invalid indexes', () => {
    expect(isMeasurementContext(context)).toBe(true)
    expect(validatePayload('measurement.prepare', {
      sessionId: 'cal_test',
      channel: 'both',
      context,
    })).toBeNull()
    expect(validatePayload('measurement.playSweep', {
      sessionId: 'cal_test',
      context,
    })).toBeNull()
    expect(validatePayload('measurement.finished', {
      sessionId: 'cal_test',
      context: { ...context, repairChannel: 'invalid' },
    })).not.toBeNull()
    expect(validatePayload('measurement.finished', {
      sessionId: 'cal_test',
      context: { ...context, attemptIndex: 2 },
    })).not.toBeNull()
    expect(validatePayload('measurement.finished', {
      sessionId: 'cal_test',
      context: { ...context, captureKind: 'single-channel' },
    })).not.toBeNull()
  })

  test('accepts validation-session semantics and rejects an unknown phase', () => {
    expect(validatePayload('calibrationSession.begin', {
      sessionId: 'cal_test',
      channel: 'both',
      phase: 'validation',
      candidateId: 'candidate-test',
    })).toBeNull()
    expect(validatePayload('calibrationSession.begin', {
      sessionId: 'cal_test',
      channel: 'both',
      phase: 'other',
    })).not.toBeNull()
    expect(validatePayload('calibrationSession.begin', {
      sessionId: 'cal_test',
      channel: 'both',
      phase: 'validation',
    })).not.toBeNull()
    expect(validatePayload('calibrationSession.begin', {
      sessionId: 'cal_test',
      channel: 'both',
      phase: 'measurement',
      candidateId: 'candidate-test',
    })).not.toBeNull()
  })

  test('preserves a DSP restore failure as a typed measurement error', () => {
    expect(validatePayload('measurement.error', {
      sessionId: 'cal_test',
      code: 'dsp_restore_failed',
      message: 'The TV could not restore its previous audio state',
    })).toBeNull()
    expect(validatePayload('measurement.error', {
      sessionId: 'cal_test',
      code: 'candidate_rollback_failed',
      message: 'The TV could not roll back the pending candidate',
    })).toBeNull()
  })

  test('requires a valid abort code and bounds its optional message', () => {
    expect(validatePayload('calibrationSession.abort', {
      sessionId: 'cal_test',
      code: 'calibration_aborted',
    })).toBeNull()
    expect(validatePayload('calibrationSession.abort', {
      sessionId: 'cal_test',
    })).not.toBeNull()
    expect(validatePayload('calibrationSession.abort', {
      sessionId: 'cal_test',
      code: 'not-a-calibration-error',
    })).not.toBeNull()
    expect(validatePayload('calibrationSession.abort', {
      sessionId: 'cal_test',
      code: 'calibration_aborted',
      message: 'x'.repeat(1024),
    })).toBeNull()
    expect(validatePayload('calibrationSession.abort', {
      sessionId: 'cal_test',
      code: 'calibration_aborted',
      message: 'x'.repeat(1025),
    })).not.toBeNull()
  })

  test('rejects malformed state snapshots and expired envelopes', () => {
    const snapshot = {
      device: { id: 'tv-1', name: 'TV', appVersion: '0.1.0' },
      engine: { enabled: true, hasControl: true, activePreset: 1, presetName: 'Flat' },
      userEq: {
        bandsDb: Array.from({ length: 24 }, () => 0),
        frequenciesHz: Array.from({ length: 24 }, (_, index) => index + 1),
        minDb: -15,
        maxDb: 15,
      },
      calibration: {
        active: false,
        bandsDb: Array.from({ length: 64 }, () => 0),
        frequenciesHz: Array.from({ length: 64 }, (_, index) => index + 20),
        transaction: { state: 'none' },
      },
      profiles: [],
      capabilities: {
        channels: 2,
        calibrationBandCount: 64,
        userBandCount: 24,
        supportsSweep: true,
        supportsIndependentCalibration: false,
        supportsCalibratedCorrection: false,
        supportsHeadroomCompensation: false,
        presets: [{ id: 1, name: 'Flat' }],
      },
    }
    expect(isStateSnapshot(snapshot)).toBe(true)
    expect(isStateSnapshot({
      ...snapshot,
      calibration: {
        ...snapshot.calibration,
        active: true,
        transaction: {
          state: 'candidate_pending',
          candidateId: 'candidate-test',
          validationStatus: 'rolling_back',
          beforeDb: null,
          afterDb: null,
          reason: 'rollback is in progress',
        },
      },
    })).toBe(true)
    expect(isStateSnapshot({
      ...snapshot,
      calibration: {
        ...snapshot.calibration,
        active: true,
        transaction: {
          state: 'candidate_pending',
          candidateId: 'candidate-imported',
          validationStatus: 'imported',
          beforeDb: null,
          afterDb: null,
          reason: 'Imported calibration is staged',
        },
      },
    })).toBe(true)
    expect(isStateSnapshot({ ...snapshot, calibration: { ...snapshot.calibration, bandsDb: [0] } })).toBe(false)
    expect(isEnvelope({ v: 1, id: 'message', type: 'state.get', ts: 1_000, expiresAt: 31_000, payload: {} })).toBe(true)
    expect(isEnvelope({ v: 1, id: 'message', type: 'state.get', ts: 1_000, expiresAt: 1_000, payload: {} })).toBe(false)
    expect(isEnvelope({ v: 1, id: 'message', type: 'state.get', ts: 1_000, expiresAt: 121_001, payload: {} })).toBe(false)
  })

  test('requires paired 64-band channel curves when applying independent calibration', () => {
    const bandsDb = Array.from({ length: 64 }, () => 0)
    expect(validatePayload('calibration.applyCandidate', { bandsDb })).toBeNull()
    expect(validatePayload('calibration.applyCandidate', {
      bandsDb,
      leftBandsDb: bandsDb,
      rightBandsDb: bandsDb,
    })).toBeNull()
    expect(validatePayload('calibration.applyCandidate', {
      bandsDb,
      leftBandsDb: bandsDb,
    })).not.toBeNull()
    expect(validatePayload('calibration.acceptCandidate', { candidateId: 'candidate-1' })).toBeNull()
    expect(validatePayload('calibration.rollbackCandidate', { candidateId: 'candidate-1' })).toBeNull()
    expect(validatePayload('calibration.validation.result', {
      candidateId: 'candidate-1',
      status: 'inconclusive',
      reason: 'The center takes were not repeatable.',
    })).toBeNull()
  })

  test('validates portable calibration export and import messages', () => {
    const bandsDb = Array.from({ length: 64 }, () => -1)
    const pkg = {
      format: 'sweetspot.calibration',
      version: 1,
      exportedAt: 1_757_000_000_000,
      sourceDevice: { id: 'tv-1', name: 'TV', appVersion: '0.1.0' },
      active: true,
      frequenciesHz: Array.from({ length: 64 }, (_, index) => index + 20),
      bandsDb,
      effectiveBandsDb: bandsDb,
    }
    expect(isCalibrationPackage(pkg)).toBe(true)
    expect(KNOWN_TYPES.has('calibration.export')).toBe(true)
    expect(KNOWN_TYPES.has('calibration.import')).toBe(true)
    expect(KNOWN_TYPES.has('calibration.exported')).toBe(true)
    expect(validatePayload('calibration.export', {})).toBeNull()
    expect(validatePayload('calibration.export', { unexpected: true })).not.toBeNull()
    expect(validatePayload('calibration.import', pkg)).toBeNull()
    expect(validatePayload('calibration.exported', pkg)).toBeNull()
    expect(validatePayload('calibration.import', { ...pkg, bandsDb: [...bandsDb.slice(0, 63), 13] })).not.toBeNull()
    expect(validatePayload('calibration.import', { ...pkg, leftBandsDb: bandsDb })).not.toBeNull()
  })

  test('accepts bounded diagnostic curves and rejects unsafe probe payloads', () => {
    const flat = Array.from({ length: 64 }, () => 0)
    const cut = flat.map((value, index) => index === 31 ? -6 : value)
    expect(validatePayload('probe.persistent.start', { bands: 64 })).toBeNull()
    expect(validatePayload('probe.curve.apply', { bandsDb: flat })).toBeNull()
    expect(validatePayload('probe.curve.apply', {
      bandsDb: flat,
      leftBandsDb: cut,
      rightBandsDb: flat,
    })).toBeNull()
    expect(validatePayload('probe.curve.apply', {
      bandsDb: flat.map(() => 7),
    })).not.toBeNull()
    expect(validatePayload('probe.persistent.start', { bands: 32 })).not.toBeNull()
  })

  test('accepts loudness preflight and TV progress messages', () => {
    expect(validatePayload('calibrationSession.loudness.start', { sessionId: 'cal_test' })).toBeNull()
    expect(validatePayload('calibrationSession.loudness.stop', { sessionId: 'cal_test' })).toBeNull()
    expect(validatePayload('calibrationSession.progress', {
      sessionId: 'cal_test',
      stage: 'loudness',
      current: 0,
      total: 30,
      estimatedRemainingSeconds: 420,
      message: 'Set the volume on the TV.',
    })).toBeNull()
    expect(validatePayload('calibrationSession.progress', {
      sessionId: 'cal_test',
      stage: 'analyzing',
      current: 31,
      total: 30,
    })).not.toBeNull()
  })

  test('accepts the device position-continued event with an exact context shape', () => {
    expect(KNOWN_TYPES.has('calibrationSession.position.continued')).toBe(true)
    expect(validatePayload('calibrationSession.position.continued', {
      sessionId: 'cal_test',
      context: {
        positionId: 'center',
        positionIndex: 0,
        positionCount: 1,
        channel: 'both',
        captureKind: 'position-composite',
        repairChannel: 'both',
        attemptIndex: 0,
        attemptCount: 2,
        phase: 'validation',
      },
    })).toBeNull()
    expect(validatePayload('calibrationSession.position.continued', {
      sessionId: 'cal_test',
      context: { ...context, attemptIndex: 2 },
    })).not.toBeNull()
  })

  test('accepts compact measurement diagnostics without accepting a response curve', () => {
    expect(validatePayload('measurement.diagnostics', {
      sessionId: 'cal_test',
      context,
      current: 1,
      total: 30,
      diagnostics: {
        signalRms: 0.05,
        signalPeak: 0.2,
        snrEstimateDb: 24,
        detectionOffsetMs: 1012,
        startMarkerSample: 48_576,
        endMarkerSample: 197_376,
        expectedMarkerSeparationSamples: 148_800,
        observedMarkerSeparationSamples: 148_800,
        syncMarkerConfidence: 0.9,
        endingMarkerConfidence: 0.88,
        rawLeadingMarkerConfidence: 0.9,
        rawTrailingMarkerConfidence: 0.88,
        bestLeadingMarkerSample: 48_576,
        bestTrailingMarkerSample: 197_376,
        markerPairScore: 0.9,
        markerSeparationError: 0,
        markerTimingAgreement: 1,
        syncMarkerFailureReason: null,
        clockDriftPpm: 25,
        clipped: false,
        clippedSamples: 0,
        directArrivalMs: 4.2,
        directToLateDb: 8.4,
        c50Db: 5.1,
        c80Db: 7.4,
        edtMs: 210,
        t20Ms: 390,
        t30Ms: null,
        earlyReflections: 3,
        decayConfidence: 'medium',
        captureMetadata: {
          sampleRate: 48_000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRateRange: { min: 44_100, max: 48_000 },
          channelCountRange: { min: 1, max: 2 },
          echoCancellationCapabilities: [false, true],
          noiseSuppressionCapabilities: [false, true],
          autoGainControlCapabilities: [false, true],
          browserUserAgent: 'Safari test',
          micProfileId: 'iphone-17-pro-safari',
          micProfileSourceDate: '2026-08-24',
        },
      },
    })).toBeNull()
    expect(validatePayload('measurement.diagnostics', {
      sessionId: 'cal_test',
      context,
      current: 1,
      total: 30,
      diagnostics: {
        signalRms: 0.05,
        signalPeak: 0.2,
        snrEstimateDb: null,
        detectionOffsetMs: null,
        syncMarkerConfidence: 0.24,
        endingMarkerConfidence: 0.26,
        rawLeadingMarkerConfidence: 0.24,
        rawTrailingMarkerConfidence: 0.26,
        bestLeadingMarkerSample: 48_576,
        bestTrailingMarkerSample: 197_376,
        markerPairScore: null,
        markerSeparationError: null,
        markerTimingAgreement: null,
        syncMarkerFailureReason: 'marker_pair_low_confidence',
        clockDriftPpm: null,
        clipped: false,
        clippedSamples: 0,
        directArrivalMs: null,
        directToLateDb: null,
        c50Db: null,
        c80Db: null,
        edtMs: null,
        t20Ms: null,
        t30Ms: null,
        earlyReflections: 0,
        decayConfidence: 'low',
      },
    })).toBeNull()
    expect(validatePayload('measurement.diagnostics', {
      sessionId: 'cal_test',
      context,
      current: 1,
      total: 30,
      diagnostics: { signalRms: 0.05 },
    })).not.toBeNull()
  })

  test('accepts compact aggregate response curves and rejects malformed points', () => {
    const curve = {
      frequenciesHz: [20, 100, 1_000, 20_000],
      magnitudesDb: [1.1, 0.8, 0.2, -1.4],
    }
    expect(validatePayload('measurement.response', {
      sessionId: 'cal_test',
      current: 7,
      total: 20,
      left: curve,
      right: null,
    })).toBeNull()
    expect(validatePayload('measurement.response', {
      sessionId: 'cal_test',
      current: 7,
      total: 20,
      left: { ...curve, magnitudesDb: [0] },
      right: null,
    })).not.toBeNull()
    expect(validatePayload('measurement.response', {
      sessionId: 'cal_test',
      current: 7,
      total: 20,
      left: { ...curve, magnitudesDb: [1, 2, Number.NaN, 4] },
      right: null,
    })).not.toBeNull()
  })

  test('recognizes room socket control messages separately from envelopes', () => {
    expect(isRoomSocketServerMessage({ kind: 'room.presence', deviceOnline: false })).toBe(true)
    expect(isRoomSocketServerMessage({ kind: 'room.ready', role: 'client', deviceOnline: true, messages: [] })).toBe(true)
    expect(isRoomSocketServerMessage({ kind: 'room.ready', role: 'device', deviceOnline: true, messages: [] })).toBe(true)
    expect(isRoomSocketServerMessage({ kind: 'room.clientPresence', clientOnline: true })).toBe(true)
    expect(isRoomSocketServerMessage({ kind: 'room.ping' })).toBe(false)
    expect(isRoomSocketServerMessage({ kind: 'room.ready', deviceOnline: true, messages: [] })).toBe(false)
    expect(isRoomSocketServerMessage({ kind: 'room.ready', deviceOnline: true, messages: [{ type: 'bad' }] })).toBe(false)
  })
})
