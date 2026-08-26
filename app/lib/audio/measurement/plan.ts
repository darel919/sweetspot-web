import type {
  CalibrationChannel,
  MeasurementCaptureKind,
  CalibrationPositionId,
  MeasurementContext,
} from '#shared/types/protocol'
import { DEFAULT_POSITION_SPECS, type PositionSpec } from './physical-position'

export interface CalibrationPosition extends PositionSpec {}

export const CALIBRATION_POSITIONS: readonly [CalibrationPosition, ...CalibrationPosition[]] = DEFAULT_POSITION_SPECS

export const MAX_ATTEMPT_COUNT = 2
export const MIN_POSITION_COUNT = 3
export const MAX_POSITION_COUNT = 5

export function requiresRemoteContinue(context: Pick<MeasurementContext, 'positionIndex' | 'repairChannel' | 'attemptIndex'>): boolean {
  return context.positionIndex > 0 && context.attemptIndex === 0 && context.repairChannel === 'both'
}

export interface MeasurementGroup {
  positionId: CalibrationPositionId
  positionIndex: number
  positionCount: number
  channel: CalibrationChannel
}

export function measurementGroupForContext(context: MeasurementContext): MeasurementGroup {
  return {
    positionId: context.positionId,
    positionIndex: context.positionIndex,
    positionCount: context.positionCount,
    channel: context.channel,
  }
}

export function measurementGroupKey(group: {
  positionId: CalibrationPositionId
  channel?: CalibrationChannel
}): string {
  return group.positionId
}

export function measurementContextForPosition(
  position: PositionSpec,
  positionIndex: number,
  positionCount: number,
  phase: MeasurementContext['phase'],
  repairChannel: MeasurementContext['repairChannel'] = 'both',
  attemptIndex = 0,
  captureKind: MeasurementCaptureKind = 'position-composite',
): MeasurementContext {
  return {
    positionId: position.id,
    reference: position.target.reference,
    xCm: position.target.xCm,
    yCm: position.target.yCm,
    zCm: position.target.zCm,
    positionIndex,
    positionCount,
    channel: 'both',
    captureKind,
    repairChannel,
    attemptIndex,
    attemptCount: MAX_ATTEMPT_COUNT,
    phase,
  }
}

export function createMeasurementPlan(
  _repeats = 1,
  phase: MeasurementContext['phase'] = 'measurement',
): MeasurementContext[] {
  return DEFAULT_POSITION_SPECS.slice(0, MIN_POSITION_COUNT)
    .map((position, positionIndex) => measurementContextForPosition(position, positionIndex, MIN_POSITION_COUNT, phase))
}

export function createMeasurementPlanForGroups(
  groups: readonly MeasurementGroup[],
  phase: MeasurementContext['phase'] = 'measurement',
): MeasurementContext[] {
  const positions = groups
    .map((group) => DEFAULT_POSITION_SPECS.find((position) => position.id === group.positionId))
    .filter((position): position is PositionSpec => position !== undefined)
    .filter((position, index, all) => all.findIndex((candidate) => candidate.id === position.id) === index)
  const positionCount = Math.max(1, Math.min(MAX_POSITION_COUNT, positions.length))
  return positions.map((position, positionIndex) => measurementContextForPosition(position, positionIndex, positionCount, phase))
}

export type ProbePlanKind = 'transfer' | 'routing' | 'marker-only'

export function createProbeMeasurementPlan(
  kind: ProbePlanKind,
  _repeats = 1,
): MeasurementContext[] {
  const positions = kind === 'transfer'
    ? [DEFAULT_POSITION_SPECS[0]!]
    : kind === 'routing'
      ? [DEFAULT_POSITION_SPECS[1]!, DEFAULT_POSITION_SPECS[2]!]
      : DEFAULT_POSITION_SPECS
  return positions.map((position, positionIndex) => measurementContextForPosition(
    position,
    positionIndex,
    positions.length,
    'measurement',
    'both',
    0,
    kind === 'marker-only' ? 'marker-only' : 'position-composite',
  ))
}

export function createRetryContext(context: MeasurementContext): MeasurementContext | null {
  if (context.attemptIndex >= context.attemptCount - 1) return null
  return { ...context, attemptIndex: context.attemptIndex + 1 }
}

export function createRepairContext(
  context: MeasurementContext,
  repairChannel: Exclude<MeasurementContext['repairChannel'], 'both'>,
): MeasurementContext {
  return {
    ...context,
    repairChannel,
    attemptIndex: Math.min(context.attemptCount - 1, context.attemptIndex + 1),
  }
}

export function positionForContext(context: MeasurementContext): CalibrationPosition {
  return CALIBRATION_POSITIONS.find((position) => position.id === context.positionId) ?? CALIBRATION_POSITIONS[0]!
}
