import type {
  CalibrationPositionTarget,
  CalibrationPositionId,
  MeasurementCaptureMetadata,
} from '#shared/types/protocol'
import { CALIBRATION_POSITION_TARGETS } from '../../../../shared/types/protocol'
import type { MeasurementAnalysis, ResponsePoint } from './response'

export type CaptureFailureClass = 'systemic' | 'local' | 'spatial'
export type CaptureChannel = 'left' | 'right'

type SpatialOffsetCm = Omit<CalibrationPositionTarget, 'reference'>

export interface PositionSpec {
  id: CalibrationPositionId
  label: string
  instruction: string
  retryInstruction: string
  target: CalibrationPositionTarget
}

function distanceCm(value: number): string {
  return `${Math.abs(Math.round(value))} cm`
}

function labelForPosition(id: CalibrationPositionId, target: CalibrationPositionTarget): string {
  return {
    center: 'normal listening position',
    left: `${distanceCm(target.xCm)} left`,
    right: `${distanceCm(target.xCm)} right`,
    forward: `${distanceCm(target.zCm)} toward the TV and ${distanceCm(target.yCm)} higher`,
    backward: `${distanceCm(target.zCm)} away from the TV and ${distanceCm(target.yCm)} lower`,
  }[id]
}

function instructionForPosition(id: CalibrationPositionId, target: CalibrationPositionTarget): string {
  switch (id) {
    case 'center':
      return 'Hold the iPhone upright at your normal listening position. This is the original center reference point. Point the bottom edge toward the center of the TV.'
    case 'left':
      return `Place the iPhone about ${distanceCm(target.xCm)} to the LEFT of the original center position. Keep the same height. Keep the phone upright and point the bottom edge toward the center of the TV.`
    case 'right':
      return `Place the iPhone about ${distanceCm(target.xCm)} to the RIGHT of the original center position. If you just measured LEFT, this is about ${distanceCm(target.xCm - CALIBRATION_POSITION_TARGETS.left.xCm)} across from that position. Keep the same height. Keep the phone upright and point the bottom edge toward the center of the TV.`
    case 'forward':
      return `Return to the original center line. Place the iPhone about ${distanceCm(target.zCm)} TOWARD THE TV and about ${distanceCm(target.yCm)} higher than the original center position. Keep the phone upright and point the bottom edge toward the center of the TV.`
    case 'backward':
      return `Return to the original center line. Place the iPhone about ${distanceCm(target.zCm)} AWAY FROM THE TV and about ${distanceCm(target.yCm)} lower than the original center position. Keep the phone upright and point the bottom edge toward the center of the TV.`
  }
}

function retryLabelForPosition(id: CalibrationPositionId): string {
  return {
    center: 'center',
    left: 'left-side',
    right: 'right-side',
    forward: 'forward',
    backward: 'back',
  }[id]
}

function retryInstructionForPosition(id: CalibrationPositionId): string {
  const title = id === 'backward' ? 'BACK POSITION' : `${id.toUpperCase()} POSITION`
  return `RETRY — ${title}. Keep the iPhone at the same ${retryLabelForPosition(id)} position. Do not move it. Keep the phone upright and point the bottom edge toward the center of the TV.`
}

export interface CaptureQuality {
  failureReason: string | null
  failureClass: CaptureFailureClass | null
  snrDb: number | null
  markerConfidence: number | null
  endingMarkerConfidence: number | null
  clipped: boolean
  clockDriftPpm: number | null
}

export type ChannelMeasurement =
  | { kind: 'pending' }
  | {
      kind: 'accepted'
      response: ResponsePoint[]
      analysis: MeasurementAnalysis
      quality: CaptureQuality
      acceptedAt: number
    }
  | {
      kind: 'rejected'
      analysis: MeasurementAnalysis | null
      quality: CaptureQuality
    }

export interface PositionMeasurement {
  id: string
  positionId: CalibrationPositionId
  positionIndex: number
  requestedPositionCount: number
  spatialOffset: SpatialOffsetCm
  left: ChannelMeasurement
  right: ChannelMeasurement
  captureMetadata: MeasurementCaptureMetadata | null
  attemptIndex: number
  acceptedAt: number | null
}

export interface PhysicalPositionLedger {
  schemaVersion: 1
  sessionId: string
  positions: PositionMeasurement[]
  systemicCenterFailures: number
}

export const DEFAULT_POSITION_SPECS: readonly [PositionSpec, ...PositionSpec[]] = [
  {
    id: 'center',
    label: labelForPosition('center', CALIBRATION_POSITION_TARGETS.center),
    instruction: instructionForPosition('center', CALIBRATION_POSITION_TARGETS.center),
    retryInstruction: retryInstructionForPosition('center'),
    target: CALIBRATION_POSITION_TARGETS.center,
  },
  {
    id: 'left',
    label: labelForPosition('left', CALIBRATION_POSITION_TARGETS.left),
    instruction: instructionForPosition('left', CALIBRATION_POSITION_TARGETS.left),
    retryInstruction: retryInstructionForPosition('left'),
    target: CALIBRATION_POSITION_TARGETS.left,
  },
  {
    id: 'right',
    label: labelForPosition('right', CALIBRATION_POSITION_TARGETS.right),
    instruction: instructionForPosition('right', CALIBRATION_POSITION_TARGETS.right),
    retryInstruction: retryInstructionForPosition('right'),
    target: CALIBRATION_POSITION_TARGETS.right,
  },
  {
    id: 'forward',
    label: labelForPosition('forward', CALIBRATION_POSITION_TARGETS.forward),
    instruction: instructionForPosition('forward', CALIBRATION_POSITION_TARGETS.forward),
    retryInstruction: retryInstructionForPosition('forward'),
    target: CALIBRATION_POSITION_TARGETS.forward,
  },
  {
    id: 'backward',
    label: labelForPosition('backward', CALIBRATION_POSITION_TARGETS.backward),
    instruction: instructionForPosition('backward', CALIBRATION_POSITION_TARGETS.backward),
    retryInstruction: retryInstructionForPosition('backward'),
    target: CALIBRATION_POSITION_TARGETS.backward,
  },
]

export function createPendingPosition(
  spec: PositionSpec,
  positionIndex: number,
  requestedPositionCount: number,
  id: string,
  attemptIndex = 0,
): PositionMeasurement {
  return {
    id,
    positionId: spec.id,
    positionIndex,
    requestedPositionCount,
    spatialOffset: {
      xCm: spec.target.xCm,
      yCm: spec.target.yCm,
      zCm: spec.target.zCm,
    },
    left: { kind: 'pending' },
    right: { kind: 'pending' },
    captureMetadata: null,
    attemptIndex,
    acceptedAt: null,
  }
}

export function channelMeasurement(
  position: PositionMeasurement,
  channel: CaptureChannel,
): ChannelMeasurement {
  return position[channel]
}

function acceptedChannelCount(position: PositionMeasurement): number {
  return Number(position.left.kind === 'accepted') + Number(position.right.kind === 'accepted')
}

export function isPositionAccepted(position: PositionMeasurement): boolean {
  return position.left.kind === 'accepted' && position.right.kind === 'accepted'
}

export function isCenterAccepted(position: PositionMeasurement): boolean {
  return position.positionId === 'center' && isPositionAccepted(position)
}

export function positionStatus(position: PositionMeasurement): 'pending' | 'partial' | 'accepted' | 'rejected' {
  const accepted = acceptedChannelCount(position)
  if (accepted === 2) return 'accepted'
  if (accepted === 1) return 'partial'
  if (position.left.kind === 'rejected' || position.right.kind === 'rejected') return 'rejected'
  return 'pending'
}

export function withChannelMeasurement(
  position: PositionMeasurement,
  channel: CaptureChannel,
  measurement: ChannelMeasurement,
): PositionMeasurement {
  if (position[channel].kind === 'accepted') return position
  const next = channel === 'left'
    ? { ...position, left: measurement }
    : { ...position, right: measurement }
  return {
    ...next,
    acceptedAt: isPositionAccepted(next) ? next.acceptedAt ?? Date.now() : null,
  }
}

export function acceptedPositionCount(positions: readonly PositionMeasurement[]): number {
  return positions.filter(isPositionAccepted).length
}
