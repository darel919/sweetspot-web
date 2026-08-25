import type {
  CalibrationPositionId,
  MeasurementCaptureMetadata,
} from '#shared/types/protocol'
import type { MeasurementAnalysis, ResponsePoint } from './response'

export type CaptureFailureClass = 'systemic' | 'local' | 'spatial'
export type CaptureChannel = 'left' | 'right'

export interface SpatialOffsetCm {
  xCm: number
  yCm: number
  zCm: number
}

export interface PositionSpec {
  id: CalibrationPositionId
  label: string
  instruction: string
  offset: SpatialOffsetCm
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
    label: 'normal listening position',
    instruction: 'Hold the iPhone upright at your normal listening position.',
    offset: { xCm: 0, yCm: 0, zCm: 0 },
  },
  {
    id: 'left',
    label: '35 cm left',
    instruction: 'Move the iPhone about 30–40 cm to the left. Keep the bottom edge pointed at the TV.',
    offset: { xCm: -35, yCm: 0, zCm: 0 },
  },
  {
    id: 'right',
    label: '35 cm right',
    instruction: 'Move the iPhone about 30–40 cm to the right. Keep the bottom edge pointed at the TV.',
    offset: { xCm: 35, yCm: 0, zCm: 0 },
  },
  {
    id: 'forward',
    label: '35 cm forward and slightly up',
    instruction: 'Move the iPhone about 30–40 cm forward and slightly up. Keep the bottom edge pointed at the TV.',
    offset: { xCm: 0, yCm: 10, zCm: 35 },
  },
  {
    id: 'backward',
    label: '35 cm backward and slightly down',
    instruction: 'Move the iPhone about 30–40 cm backward and slightly down. Keep the bottom edge pointed at the TV.',
    offset: { xCm: 0, yCm: -10, zCm: -35 },
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
    spatialOffset: { ...spec.offset },
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

export function acceptedChannelCount(position: PositionMeasurement): number {
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

export function acceptedResponse(
  position: PositionMeasurement,
  channel: CaptureChannel,
): ResponsePoint[] | null {
  const measurement = channelMeasurement(position, channel)
  return measurement.kind === 'accepted' ? measurement.response : null
}

export function toChannelRecord(
  position: PositionMeasurement,
  channel: CaptureChannel,
): { position: PositionMeasurement; channel: CaptureChannel; analysis: MeasurementAnalysis } | null {
  const measurement = channelMeasurement(position, channel)
  if (measurement.kind !== 'accepted') return null
  return { position, channel, analysis: measurement.analysis }
}
