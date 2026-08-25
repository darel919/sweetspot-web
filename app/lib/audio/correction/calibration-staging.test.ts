import { describe, expect, test } from 'bun:test'
import {
  isValidCorrection,
  shouldStageAutomaticCorrection,
  type AutomaticCorrectionStageInput,
} from './calibration-staging'

function curve(gainDb = 0): number[] {
  return Array.from({ length: 64 }, (_, index) => index === 32 ? gainDb : 0)
}

const correction = { bandsDb: curve(-2), independent: false }

const eligible: AutomaticCorrectionStageInput = {
  measurementComplete: true,
  convergenceSufficient: true,
  measurementId: 'measurement-1',
  correction,
  supportsCalibratedCorrection: true,
  capturePathEligible: true,
  deviceOnline: true,
  candidatePending: false,
  applyInProgress: false,
  attemptedMeasurementId: null,
  failedMeasurementId: null,
  unresolvedFailureCount: 0,

  acceptedPositionCount: 3,
}

describe('automatic calibration staging guards', () => {
  test('allows one eligible completed measurement to stage its correction', () => {
    expect(shouldStageAutomaticCorrection(eligible)).toBe(true)
    expect(shouldStageAutomaticCorrection({ ...eligible, measurementComplete: false })).toBe(false)
    expect(shouldStageAutomaticCorrection({ ...eligible, supportsCalibratedCorrection: false })).toBe(false)
  })

  test('requires a valid correction', () => {
    expect(isValidCorrection(null)).toBe(false)
    expect(isValidCorrection({ bandsDb: curve(), independent: false })).toBe(true)
    expect(shouldStageAutomaticCorrection({ ...eligible, correction: null })).toBe(false)
  })

  test('rejects an ineligible microphone profile', () => {
    expect(shouldStageAutomaticCorrection({ ...eligible, capturePathEligible: false })).toBe(false)
  })

  test('rejects an existing candidate', () => {
    expect(shouldStageAutomaticCorrection({ ...eligible, candidatePending: true })).toBe(false)
  })

  test('rejects an offline device', () => {
    expect(shouldStageAutomaticCorrection({ ...eligible, deviceOnline: false })).toBe(false)
  })

  test('rejects a correction apply already in progress', () => {
    expect(shouldStageAutomaticCorrection({ ...eligible, applyInProgress: true })).toBe(false)
  })

  test('uses the completed measurement id to reject duplicate snapshots', () => {
    expect(shouldStageAutomaticCorrection({
      ...eligible,
      attemptedMeasurementId: 'measurement-1',
    })).toBe(false)
    expect(shouldStageAutomaticCorrection({
      ...eligible,
      failedMeasurementId: 'measurement-1',
    })).toBe(false)
    expect(shouldStageAutomaticCorrection({
      ...eligible,
      measurementId: 'measurement-2',
      attemptedMeasurementId: 'measurement-1',
    })).toBe(true)
  })

  test('allows resolved historical failures when no failure remains unresolved', () => {
    const historical = { ...eligible, failedAttemptCount: 2 } as AutomaticCorrectionStageInput & { failedAttemptCount: number }
    expect(shouldStageAutomaticCorrection(historical)).toBe(true)
  })
})
