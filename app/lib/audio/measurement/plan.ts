import type { CalibrationChannel, CalibrationPositionId, MeasurementContext } from '#shared/types/protocol'

export interface CalibrationPosition {
  id: CalibrationPositionId
  label: string
  instruction: string
}

export const CALIBRATION_POSITIONS: readonly CalibrationPosition[] = [
  { id: 'center', label: 'normal head position', instruction: 'Hold the iPhone at your normal listening position.' },
  { id: 'left', label: '20 cm left', instruction: 'Move the iPhone about 20 cm to the left.' },
  { id: 'right', label: '20 cm right', instruction: 'Move the iPhone about 20 cm to the right.' },
  { id: 'forward', label: '20 cm forward / slightly up', instruction: 'Move the iPhone about 20 cm forward and slightly up.' },
  { id: 'backward', label: '20 cm backward / slightly down', instruction: 'Move the iPhone about 20 cm backward and slightly down.' },
]

export const MEASUREMENT_CHANNELS: readonly Exclude<CalibrationChannel, 'both'>[] = ['left', 'right']
export const REPEAT_COUNT = 3

export function createMeasurementPlan(
  repeats = REPEAT_COUNT,
  phase: MeasurementContext['phase'] = 'measurement',
): MeasurementContext[] {
  const plan: MeasurementContext[] = []
  for (let positionIndex = 0; positionIndex < CALIBRATION_POSITIONS.length; positionIndex++) {
    const position = CALIBRATION_POSITIONS[positionIndex]
    for (const channel of MEASUREMENT_CHANNELS) {
      for (let takeIndex = 0; takeIndex < repeats; takeIndex++) {
        plan.push({
          positionId: position.id,
          positionIndex,
          positionCount: CALIBRATION_POSITIONS.length,
          channel,
          takeIndex,
          takeCount: repeats,
          phase,
        })
      }
    }
  }
  return plan
}

export function positionForContext(context: MeasurementContext): CalibrationPosition {
  return CALIBRATION_POSITIONS.find((position) => position.id === context.positionId) ?? CALIBRATION_POSITIONS[0]
}
