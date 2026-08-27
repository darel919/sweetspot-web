import { describe, expect, test } from 'bun:test'
import type {
  CalibrationJobView,
  CalibrationNextAction,
} from '../../shared/types/protocol'
import { validatePayload } from '../../shared/types/protocol'
import {
  acceptCalibrationJobState,
  buildCalibrationCapture,
} from './useCalibrationRemoteMic'

const captureSettings = {
  sampleRate: 48_000,
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
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

describe('TV-owned calibration remote microphone', () => {
  test('ignores stale job states while accepting a newer revision', () => {
    const current = job(4)
    expect(acceptCalibrationJobState(current, job(3))).toBe(current)
    const next = job(5)
    expect(acceptCalibrationJobState(current, next)).toBe(next)
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
      microphoneProfile: { id: 'apple_iphone17pro_2025', sourceDate: '2025-09-25' },
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
      microphoneProfile: { id: 'apple_iphone17pro_2025', sourceDate: '2025-09-25' },
      capturedAtMs: 1_757_000_000_000,
    })
    expect(built.readyType).toBe('calibration.validation.capture.ready')
    expect(built.readyPayload).toEqual({
      jobId: 'job-1',
      captureId: 'validation-0',
      candidateId: 'candidate-4',
    })
    expect(built.metadata.channel).toBe('both')
    expect(validatePayload('calibration.capture.metadata', built.metadata)).toBeNull()
    expect(validatePayload('calibration.capture.finished', {
      jobId: 'job-1',
      captureId: 'validation-0',
    })).toBeNull()
  })
})
