import { describe, expect, test } from 'bun:test'
import {
  CALIBRATION_POSITION_TARGETS,
  isCalibrationJobView,
  isClientToDevice,
  isDeviceToClient,
  KNOWN_TYPES,
  validatePayload,
  type CalibrationJobView,
} from './protocol'

const confidence = {
  usableBandCount: 64,
  totalBandCount: 64 as const,
  score: 0.92,
  grade: 'sufficient' as const,
}

const usableView: CalibrationJobView = {
  jobId: 'job-1',
  createdAtMs: 1_757_000_000_000,
  revision: 4,
  analyzerRevision: 'android-response-v1',
  sweepRevision: 'android-sweep-v3',
  phase: 'validating',
  acceptedPositions: ['center', 'left', 'right', 'forward'],
  excludedPositions: [],
  historicalAttemptCount: 8,
  optionalFailureCount: 0,
  minimumViableCalibration: true,
  bestSolution: {
    solutionId: 'solution-4',
    sourcePositionIds: ['center', 'left', 'right', 'forward'],
    confidence,
    score: 0.92,
    correctionMode: 'normal',
  },
  confidence,
  nextAction: {
    kind: 'validate',
    captureId: 'validation-candidate-0',
    positionId: 'center',
    candidateId: 'candidate-4',
    attemptIndex: 0,
    instruction: 'Return the phone to the center position for validation.',
  },
  activeCandidateId: 'candidate-4',
  validationState: 'pending',
  lastError: null,
}

describe('TV-owned calibration job protocol', () => {
  test('routes the job and capture messages in the intended directions', () => {
    expect(isClientToDevice('calibration.job.start')).toBe(true)
    expect(isClientToDevice('calibration.job.get')).toBe(true)
    expect(isClientToDevice('calibration.job.cancel')).toBe(true)
    expect(isClientToDevice('calibration.job.discard')).toBe(true)
    expect(isClientToDevice('calibration.job.finish')).toBe(true)
    expect(isClientToDevice('calibration.capture.ready')).toBe(true)
    expect(isClientToDevice('calibration.validation.capture.ready')).toBe(true)
    expect(isDeviceToClient('calibration.capture.uploaded')).toBe(true)
    expect(isDeviceToClient('calibration.capture.rejected')).toBe(true)
    expect(isDeviceToClient('calibration.job.state')).toBe(true)
    expect(KNOWN_TYPES.has('calibration.job.state')).toBe(true)
  })

  test('validates job commands and preserves optional refinement cancellation', () => {
    expect(validatePayload('calibration.job.start', {})).toBeNull()
    expect(validatePayload('calibration.job.start', { mode: 'advanced' })).toBeNull()
    expect(validatePayload('calibration.job.start', { mode: 'unsafe' })).not.toBeNull()
    expect(validatePayload('calibration.job.get', {})).toBeNull()
    expect(validatePayload('calibration.job.get', { jobId: 'job-1' })).toBeNull()
    expect(validatePayload('calibration.job.cancel', {
      jobId: 'job-1',
      scope: 'capture',
      captureId: 'center-left-0',
    })).toBeNull()
    expect(validatePayload('calibration.job.cancel', {
      jobId: 'job-1',
      scope: 'optional_refinement',
    })).toBeNull()
    expect(validatePayload('calibration.job.cancel', {
      jobId: 'job-1',
      scope: 'optional_refinement',
      captureId: 'stale-capture',
    })).not.toBeNull()
    expect(validatePayload('calibration.job.finish', { jobId: 'job-1' })).toBeNull()
    expect(validatePayload('calibration.job.discard', { jobId: 'job-1' })).toBeNull()
  })

  test('validates capture readiness and upload acknowledgements', () => {
    expect(validatePayload('calibration.capture.ready', {
      jobId: 'job-1',
      captureId: 'center-left-0',
    })).toBeNull()
    expect(validatePayload('calibration.capture.uploaded', {
      jobId: 'job-1',
      captureId: 'center-left-0',
      contentSha256: 'a'.repeat(64),
      sampleCount: 4,
      byteCount: 16,
      status: 'accepted',
    })).toBeNull()
    expect(validatePayload('calibration.capture.uploaded', {
      jobId: 'job-1',
      captureId: 'center-left-0',
      contentSha256: 'invalid',
      sampleCount: 4,
      byteCount: 16,
      status: 'accepted',
    })).not.toBeNull()
    expect(validatePayload('calibration.capture.rejected', {
      jobId: 'job-1',
      captureId: 'center-left-0',
      reason: 'The capture stream was incomplete',
    })).toBeNull()
    expect(validatePayload('calibration.validation.capture.ready', {
      jobId: 'job-1',
      captureId: 'validation-candidate-0',
      candidateId: 'candidate-4',
    })).toBeNull()
    expect(validatePayload('calibration.capture.finished', {
      jobId: 'job-1',
      captureId: 'center-left-0',
    })).toBeNull()
  })

  test('accepts a usable job view and rejects contradictory usability', () => {
    expect(isCalibrationJobView(usableView)).toBe(true)
    expect(validatePayload('calibration.job.state', usableView)).toBeNull()
    expect(validatePayload('calibration.job.state', {
      ...usableView,
      minimumViableCalibration: false,
    })).not.toBeNull()
    expect(validatePayload('calibration.job.state', {
      ...usableView,
      nextAction: {
        kind: 'capture',
        captureId: 'backward-left-0',
        positionId: 'backward',
        channel: 'left',
        attemptIndex: 0,
        optional: false,
        instruction: 'Move backward.',
      },
    })).not.toBeNull()
    expect(validatePayload('calibration.job.state', {
      ...usableView,
      acceptedPositions: ['center', 'center'],
    })).not.toBeNull()
    expect(validatePayload('calibration.job.state', {
      ...usableView,
      bestSolution: {
        ...usableView.bestSolution,
        sourcePositionIds: ['left', 'right', 'forward'],
      },
    })).not.toBeNull()
  })

  test('keeps position geometry in the existing protocol vocabulary', () => {
    expect(CALIBRATION_POSITION_TARGETS.center).toEqual({ reference: 'center', xCm: 0, yCm: 0, zCm: 0 })
  })
})
