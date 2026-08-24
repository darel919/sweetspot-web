import type { CalibrationChannel, CalibrationPositionId, MeasurementContext } from '#shared/types/protocol'

export interface CalibrationPosition {
  id: CalibrationPositionId
  label: string
  instruction: string
}

export const CALIBRATION_POSITIONS: readonly [CalibrationPosition, ...CalibrationPosition[]] = [
  { id: 'center', label: 'normal head position', instruction: 'Hold the iPhone at your normal listening position.' },
  { id: 'left', label: '20 cm left', instruction: 'Move the iPhone about 20 cm to the left.' },
  { id: 'right', label: '20 cm right', instruction: 'Move the iPhone about 20 cm to the right.' },
  { id: 'forward', label: '20 cm forward / slightly up', instruction: 'Move the iPhone about 20 cm forward and slightly up.' },
  { id: 'backward', label: '20 cm backward / slightly down', instruction: 'Move the iPhone about 20 cm backward and slightly down.' },
]

export const MEASUREMENT_CHANNELS: readonly Exclude<CalibrationChannel, 'both'>[] = ['left', 'right']
export const REPEAT_COUNT = 2
export const MAX_REPEAT_COUNT = 3

export interface MeasurementGroup {
  positionId: CalibrationPositionId
  positionIndex: number
  positionCount: number
  channel: Exclude<CalibrationChannel, 'both'>
}

export function measurementGroupForContext(context: MeasurementContext): MeasurementGroup | null {
  if (context.channel === 'both') return null
  return {
    positionId: context.positionId,
    positionIndex: context.positionIndex,
    positionCount: context.positionCount,
    channel: context.channel,
  }
}

export function measurementGroupKey(group: {
  positionId: CalibrationPositionId
  channel: CalibrationChannel
}): string {
  return `${group.positionId}:${group.channel}`
}

function contextsForGroups(
  groups: readonly MeasurementGroup[],
  repeats: number,
  phase: MeasurementContext['phase'],
): MeasurementContext[] {
  const takeCount = Math.max(1, Math.min(MAX_REPEAT_COUNT, Math.floor(repeats)))
  return groups.flatMap((group) => Array.from({ length: takeCount }, (_, takeIndex) => ({
    ...group,
    takeIndex,
    takeCount,
    phase,
  })))
}

export function createMeasurementPlan(
  repeats = REPEAT_COUNT,
  phase: MeasurementContext['phase'] = 'measurement',
): MeasurementContext[] {
  const groups: MeasurementGroup[] = CALIBRATION_POSITIONS.flatMap((position, positionIndex) =>
    MEASUREMENT_CHANNELS.map((channel) => ({
      positionId: position.id,
      positionIndex,
      positionCount: CALIBRATION_POSITIONS.length,
      channel,
    })))
  return contextsForGroups(groups, repeats, phase)
}

export function createMeasurementPlanForGroups(
  groups: readonly MeasurementGroup[],
  phase: MeasurementContext['phase'] = 'measurement',
): MeasurementContext[] {
  return contextsForGroups(groups, REPEAT_COUNT, phase)
}

export function createThirdTakeContext(context: MeasurementContext): MeasurementContext {
  return {
    ...context,
    takeIndex: MAX_REPEAT_COUNT - 1,
    takeCount: MAX_REPEAT_COUNT,
  }
}

export function positionForContext(context: MeasurementContext): CalibrationPosition {
  return CALIBRATION_POSITIONS.find((position) => position.id === context.positionId) ?? CALIBRATION_POSITIONS[0]
}
