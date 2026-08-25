import { describe, expect, test } from 'bun:test'
import { isCalibrationOperationCurrent, isSameMeasurementContext } from '../lib/audio/measurement/session-guard'
import { CALIBRATION_POSITION_TARGETS, type MeasurementContext } from '../../shared/types/protocol'

const context: MeasurementContext = {
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
    const retry = { ...context, attemptIndex: 1 }

    expect(isSameMeasurementContext(context, context)).toBe(true)
    expect(isSameMeasurementContext(context, retry)).toBe(false)
  })
})
