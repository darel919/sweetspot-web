import { describe, expect, test } from 'bun:test'
import { CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB } from '../../../../shared/types/protocol'
import type { CalibrationPositionId } from '../../../../shared/types/protocol'
import {
  classifyCalibrationValidation,
  matchedSpatialValidationMetrics,
  selectValidationConfirmationPositions,
  shouldRunValidationConfirmation,
  shouldStartAutomaticValidation,
} from './calibration-validation'
import type { AggregateResponse } from '../measurement/aggregation'

const quality = { baselineQualityValid: true, validationQualityValid: true }

function aggregate(positionIds: readonly CalibrationPositionId[], magnitudeDb: number): AggregateResponse {
  const points = [
    { frequencyHz: 100, magnitudeDb },
    { frequencyHz: 1_000, magnitudeDb },
    { frequencyHz: 10_000, magnitudeDb },
  ]
  const positionResponses = positionIds.map((positionId, positionIndex) => ({
    positionId,
    positionIndex,
    positionCount: positionIds.length,
    channel: 'both' as const,
    points: points.map((point) => ({ ...point })),
    broadbandLevelDb: null,
  }))
  return {
    channel: 'both',
    points,
    spreadDb: points.map((point) => ({ ...point, magnitudeDb: 0 })),
    positionResponses,
    records: [],
    spatialConsistency: [],
    failedGroups: [],
    broadbandLevelDb: null,
    relativeChannelLevelDb: null,
  }
}

describe('calibration validation classification', () => {
  test('starts automatic validation only once for an eligible candidate', () => {
    const eligible = {
      measurementComplete: true,
      measurementId: 'measurement-1',
      candidateId: 'candidate-1',
      baselineQualityValid: true,
      deviceValidationReady: true,
      capturePathEligible: true,
      deviceOnline: true,
      validationActive: false,
      startedCandidateId: null,
      stagingFailedMeasurementId: null,
    }
    expect(shouldStartAutomaticValidation(eligible)).toBe(true)
    expect(shouldStartAutomaticValidation({ ...eligible, startedCandidateId: 'candidate-1' })).toBe(false)
    expect(shouldStartAutomaticValidation({ ...eligible, baselineQualityValid: false })).toBe(false)
    expect(shouldStartAutomaticValidation({ ...eligible, deviceValidationReady: false })).toBe(false)
    expect(shouldStartAutomaticValidation({ ...eligible, capturePathEligible: false })).toBe(false)
    expect(shouldStartAutomaticValidation({ ...eligible, deviceOnline: false })).toBe(false)
    expect(shouldStartAutomaticValidation({ ...eligible, validationActive: true })).toBe(false)
    expect(shouldStartAutomaticValidation({ ...eligible, candidateId: null })).toBe(false)
    expect(shouldStartAutomaticValidation({ ...eligible, stagingFailedMeasurementId: 'measurement-1' })).toBe(false)
  })

  test('requires improvement to exceed the tolerance', () => {
    expect(classifyCalibrationValidation({
      ...quality,
      beforeDb: 4,
      afterDb: 4 - CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB,
    }).status).toBe('inconclusive')
    expect(classifyCalibrationValidation({
      ...quality,
      beforeDb: 4,
      afterDb: 4 - CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB - 0.01,
    }).status).toBe('improved')
  })

  test('requires worsening to exceed the same tolerance', () => {
    expect(classifyCalibrationValidation({
      ...quality,
      beforeDb: 4,
      afterDb: 4 + CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB,
    }).status).toBe('inconclusive')
    expect(classifyCalibrationValidation({
      ...quality,
      beforeDb: 4,
      afterDb: 4 + CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB + 0.01,
    }).status).toBe('worse')
  })

  test('treats missing or non-repeatable quality as inconclusive', () => {
    expect(classifyCalibrationValidation({ ...quality, beforeDb: null, afterDb: 2 }).status).toBe('inconclusive')
    expect(classifyCalibrationValidation({ ...quality, baselineQualityValid: false, beforeDb: 4, afterDb: 1 }).status).toBe('inconclusive')
    expect(classifyCalibrationValidation({ ...quality, validationQualityValid: false, beforeDb: 4, afterDb: 1 }).status).toBe('inconclusive')
  })

  test('allows exactly one confirmation capture for a borderline candidate', () => {
    const outcome = { status: 'inconclusive' as const, reason: 'borderline' }
    expect(shouldRunValidationConfirmation({ outcome, candidateId: 'candidate-1', confirmedCandidateId: null })).toBe(true)
    expect(shouldRunValidationConfirmation({ outcome, candidateId: 'candidate-1', confirmedCandidateId: 'candidate-1' })).toBe(false)
    expect(shouldRunValidationConfirmation({ outcome: { status: 'improved', beforeDb: 4, afterDb: 2 }, candidateId: 'candidate-1', confirmedCandidateId: null })).toBe(false)
  })

  test('targets one informative position for a borderline confirmation', () => {
    expect(selectValidationConfirmationPositions(['left', 'center', 'right'])).toEqual(['center'])
    expect(selectValidationConfirmationPositions(['right', 'backward'])).toEqual(['right'])
    expect(selectValidationConfirmationPositions([])).toEqual([])
  })

  test('uses matched physical positions for the spatial validation objective', () => {
    const metrics = matchedSpatialValidationMetrics(
      aggregate(['center', 'left', 'right'], 1),
      aggregate(['center', 'left', 'right'], 0),
    )

    expect(metrics?.objective).toBe('spatial')
    expect(metrics?.positionIds).toEqual(['center', 'left', 'right'])
    expect(metrics?.after).toBeLessThan(metrics?.before ?? 0)
    expect(matchedSpatialValidationMetrics(
      aggregate(['center', 'left', 'right'], 1),
      aggregate(['center', 'left'], 0),
    )).toBeNull()
  })
})
