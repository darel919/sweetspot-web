import { describe, expect, test } from 'bun:test'
import { CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB } from '../../../../shared/types/protocol'
import { classifyCalibrationValidation, shouldStartAutomaticValidation } from './calibration-validation'

const quality = { baselineRepeatable: true, validationRepeatable: true }

describe('calibration validation classification', () => {
  test('starts automatic validation only once for an eligible candidate', () => {
    const eligible = {
      measurementComplete: true,
      measurementId: 'measurement-1',
      candidateId: 'candidate-1',
      baselineRepeatable: true,
      deviceValidationReady: true,
      capturePathEligible: true,
      deviceOnline: true,
      validationActive: false,
      startedCandidateId: null,
      stagingFailedMeasurementId: null,
    }
    expect(shouldStartAutomaticValidation(eligible)).toBe(true)
    expect(shouldStartAutomaticValidation({ ...eligible, startedCandidateId: 'candidate-1' })).toBe(false)
    expect(shouldStartAutomaticValidation({ ...eligible, baselineRepeatable: false })).toBe(false)
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
    expect(classifyCalibrationValidation({ ...quality, baselineRepeatable: false, beforeDb: 4, afterDb: 1 }).status).toBe('inconclusive')
    expect(classifyCalibrationValidation({ ...quality, validationRepeatable: false, beforeDb: 4, afterDb: 1 }).status).toBe('inconclusive')
  })
})
