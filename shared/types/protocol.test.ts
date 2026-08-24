import { describe, expect, test } from 'bun:test'
import {
  isMeasurementContext,
  isMeasurementSweep,
  isRoomSocketPingMessage,
  isRoomSocketServerMessage,
  validatePayload,
} from './protocol'

const sweep = {
  algorithm: 'exponential-sine-v1',
  sampleRate: 48_000,
  startHz: 20,
  endHz: 20_000,
  durationMs: 8_000,
  preRollMs: 1_000,
  postRollMs: 1_000,
  levelDbfs: -12,
  fadeInMs: 20,
  fadeOutMs: 20,
}

const context = {
  positionId: 'center',
  positionIndex: 0,
  positionCount: 5,
  channel: 'left',
  takeIndex: 0,
  takeCount: 3,
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

  test('accepts a routed position/take context and rejects invalid indexes', () => {
    expect(isMeasurementContext(context)).toBe(true)
    expect(validatePayload('measurement.prepare', {
      sessionId: 'cal_test',
      channel: 'left',
      context,
    })).toBeNull()
    expect(validatePayload('measurement.playSweep', {
      sessionId: 'cal_test',
      context,
    })).toBeNull()
    expect(validatePayload('measurement.finished', {
      sessionId: 'cal_test',
      context: { ...context, takeIndex: 3 },
    })).not.toBeNull()
  })

  test('accepts validation-session semantics and rejects an unknown phase', () => {
    expect(validatePayload('calibrationSession.begin', {
      sessionId: 'cal_test',
      channel: 'both',
      phase: 'validation',
    })).toBeNull()
    expect(validatePayload('calibrationSession.begin', {
      sessionId: 'cal_test',
      channel: 'both',
      phase: 'other',
    })).not.toBeNull()
  })

  test('requires paired 64-band channel curves when applying independent calibration', () => {
    const bandsDb = Array.from({ length: 64 }, () => 0)
    expect(validatePayload('calibration.apply', { bandsDb })).toBeNull()
    expect(validatePayload('calibration.apply', {
      bandsDb,
      leftBandsDb: bandsDb,
      rightBandsDb: bandsDb,
    })).toBeNull()
    expect(validatePayload('calibration.apply', {
      bandsDb,
      leftBandsDb: bandsDb,
    })).not.toBeNull()
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
    expect(isRoomSocketPingMessage({ kind: 'room.ping' })).toBe(true)
    expect(isRoomSocketServerMessage({ kind: 'room.presence', deviceOnline: false })).toBe(true)
    expect(isRoomSocketServerMessage({ kind: 'room.ready', deviceOnline: true, messages: [] })).toBe(true)
    expect(isRoomSocketServerMessage({ kind: 'room.ready', deviceOnline: true, messages: [{ type: 'bad' }] })).toBe(false)
  })
})
