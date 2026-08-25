import { describe, expect, test } from 'bun:test'
import {
  CALIBRATION_ANALYSIS_REVISION,
  CALIBRATION_CHECKPOINT_ORIENTATION,
  CALIBRATION_SWEEP_REVISION,
  CALIBRATION_WEB_BUILD_SHA,
  checkCalibrationCheckpointCompatibility,
  createCalibrationCheckpoint,
  parseSerializedCalibrationCheckpoint,
  serializeCalibrationCheckpoint,
} from './checkpoint'
import { createPositionLedger } from './position-ledger'

const checkpoint = createCalibrationCheckpoint({
  sessionId: 'session-1',
  device: { id: 'tv-1', appVersion: '1.2.3' },
  microphone: {
    profileId: 'iphone-test',
    sourceDate: '2026-08-24',
    capturePathStatus: 'unvalidated',
    sampleRate: 48_000,
  },
  captureMetadata: null,
  ledger: createPositionLedger('session-1'),
  savedAt: 123,
})

const identity = {
  deviceId: 'tv-1',
  appVersion: '1.2.3',
  profileId: 'iphone-test',
  profileSourceDate: '2026-08-24',
  capturePathStatus: 'unvalidated' as const,
  sampleRate: 48_000,
  webBuildSha: CALIBRATION_WEB_BUILD_SHA,
  analysisRevision: CALIBRATION_ANALYSIS_REVISION,
  sweepRevision: CALIBRATION_SWEEP_REVISION,
}

describe('calibration checkpoint persistence contract', () => {
  test('round-trips the append-only session without raw PCM', () => {
    const serialized = serializeCalibrationCheckpoint(checkpoint)
    const restored = parseSerializedCalibrationCheckpoint(serialized)

    expect(restored).toEqual(checkpoint)
    expect(serialized.includes('samples')).toBe(false)
    expect(restored?.orientation).toBe(CALIBRATION_CHECKPOINT_ORIENTATION)
  })

  test('keeps an incomplete measurement checkpoint outside the DSP transaction', () => {
    expect(checkpoint.correctionState).toEqual({ generated: false, candidateId: null })
    expect('previousActive' in checkpoint).toBe(false)
    expect('candidate' in checkpoint).toBe(false)
  })

  test('rejects malformed or incompatible checkpoints before resume', () => {
    expect(parseSerializedCalibrationCheckpoint('{"schemaVersion":1}')).toBeNull()
    expect(checkCalibrationCheckpointCompatibility(checkpoint, { ...identity, deviceId: 'other-tv' })).toEqual({ compatible: false, reason: 'device' })
    expect(checkCalibrationCheckpointCompatibility(checkpoint, {
      ...identity,
      profileId: 'different-profile',
    })).toEqual({ compatible: false, reason: 'microphone-profile' })
    expect(checkCalibrationCheckpointCompatibility({
      ...checkpoint,
      validationStarted: true,
    }, identity)).toEqual({ compatible: false, reason: 'pending-transaction' })
  })
})
