import { describe, expect, test } from 'bun:test'
import {
  CALIBRATION_CHECKPOINT_ORIENTATION,
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

describe('calibration checkpoint persistence contract', () => {
  test('round-trips the append-only session without raw PCM', () => {
    const serialized = serializeCalibrationCheckpoint(checkpoint)
    const restored = parseSerializedCalibrationCheckpoint(serialized)

    expect(restored).toEqual(checkpoint)
    expect(serialized.includes('samples')).toBe(false)
    expect(restored?.orientation).toBe(CALIBRATION_CHECKPOINT_ORIENTATION)
  })

  test('rejects malformed or incompatible checkpoints before resume', () => {
    expect(parseSerializedCalibrationCheckpoint('{"schemaVersion":1}')).toBeNull()
    expect(checkCalibrationCheckpointCompatibility(checkpoint, {
      deviceId: 'other-tv',
      appVersion: '1.2.3',
      profileId: 'iphone-test',
      profileSourceDate: '2026-08-24',
      capturePathStatus: 'unvalidated',
      sampleRate: 48_000,
    })).toEqual({ compatible: false, reason: 'device' })
    expect(checkCalibrationCheckpointCompatibility(checkpoint, {
      deviceId: 'tv-1',
      appVersion: '1.2.3',
      profileId: 'different-profile',
      profileSourceDate: '2026-08-24',
      capturePathStatus: 'unvalidated',
      sampleRate: 48_000,
    })).toEqual({ compatible: false, reason: 'microphone-profile' })
    expect(checkCalibrationCheckpointCompatibility({
      ...checkpoint,
      validationStarted: true,
    }, {
      deviceId: 'tv-1',
      appVersion: '1.2.3',
      profileId: 'iphone-test',
      profileSourceDate: '2026-08-24',
      capturePathStatus: 'unvalidated',
      sampleRate: 48_000,
    })).toEqual({ compatible: false, reason: 'pending-transaction' })
  })
})
