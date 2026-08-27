import type { CaptureChannel, PhysicalPositionLedger, PositionMeasurement, PositionSpec } from './physical-position'
import {
  acceptedPositionCount,
  DEFAULT_POSITION_SPECS,
  isCenterAccepted,
  isPositionAccepted,
  positionStatus,
} from './physical-position'

export interface ConvergenceAssessment {
  sufficient: boolean
  medianCorrectionChangeDb: number | null
  p95CorrectionChangeDb: number | null
  medianSpatialSpreadDb: number | null
  lowFrequencySpreadDb: number | null
  highConfidenceBandFraction: number
}

export interface AdaptivePlannerPolicy {
  minimumPositions: 3
  maximumPositions: 5
  maxPositionAttempts: 2
  positions: readonly [PositionSpec, ...PositionSpec[]]
}

export const DEFAULT_ADAPTIVE_POLICY: AdaptivePlannerPolicy = {
  minimumPositions: 3,
  maximumPositions: 5,
  maxPositionAttempts: 2,
  positions: DEFAULT_POSITION_SPECS,
}

export type CaptureReason =
  | 'center-required'
  | 'initial-position'
  | 'repair-channel'
  | 'retry-position'
  | 'spatial-uncertainty'
  | 'replace-failed-position'

export type AdaptivePlanDecision =
  | {
      kind: 'capture'
      position: PositionSpec
      positionIndex: number
      requestedPositionCount: number
      repairChannel: CaptureChannel | 'both'
      attemptIndex: number
      reason: CaptureReason
    }
  | { kind: 'finish'; outcome: 'sufficient' | 'bounded' | 'insufficient'; reason: string }
  | { kind: 'abort'; reason: 'systemic-center-failure'; message: string }

function positionSpec(
  policy: AdaptivePlannerPolicy,
  positionId: PositionSpec['id'],
): PositionSpec | null {
  return policy.positions.find((candidate) => candidate.id === positionId) ?? null
}

function captureDecision(
  spec: PositionSpec,
  position: PositionMeasurement | null,
  requestedPositionCount: number,
  repairChannel: CaptureChannel | 'both',
  reason: CaptureReason,
  positionIndex = position?.positionIndex ?? 0,
): AdaptivePlanDecision {
  return {
    kind: 'capture',
    position: spec,
    positionIndex,
    requestedPositionCount,
    repairChannel,
    attemptIndex: position?.attemptIndex ?? 0,
    reason,
  }
}

function missingChannel(position: PositionMeasurement): CaptureChannel | null {
  if (position.left.kind !== 'accepted' && position.right.kind === 'accepted') return 'left'
  if (position.right.kind !== 'accepted' && position.left.kind === 'accepted') return 'right'
  return null
}

function retryablePosition(
  position: PositionMeasurement,
  policy: AdaptivePlannerPolicy,
): AdaptivePlanDecision | null {
  const missing = missingChannel(position)
  if (missing && position.attemptIndex + 1 < policy.maxPositionAttempts) {
    return captureDecision(
      positionSpec(policy, position.positionId) ?? policy.positions[0]!,
      { ...position, attemptIndex: position.attemptIndex + 1 },
      position.requestedPositionCount,
      missing,
      'repair-channel',
    )
  }
  if (positionStatus(position) === 'rejected' && position.attemptIndex + 1 < policy.maxPositionAttempts) {
    return captureDecision(
      positionSpec(policy, position.positionId) ?? policy.positions[0]!,
      { ...position, attemptIndex: position.attemptIndex + 1 },
      position.requestedPositionCount,
      'both',
      'retry-position',
    )
  }
  return null
}

function nextMissingInitialPosition(
  positions: readonly PositionMeasurement[],
  policy: AdaptivePlannerPolicy,
): PositionSpec | null {
  for (const id of ['center', 'left', 'right'] as const) {
    const spec = positionSpec(policy, id)
    if (!spec) continue
    const existing = positions.find((position) => position.positionId === id)
    // A bounded retry is handled before this pass. Once a position has used
    // its retry budget, leave its evidence in the ledger and move on; asking
    // for it here again would reuse the same capture identity indefinitely.
    if (!existing) return spec
  }
  return null
}

function nextUntriedSpatialPosition(
  positions: readonly PositionMeasurement[],
  policy: AdaptivePlannerPolicy,
): PositionSpec | null {
  for (const spec of policy.positions.slice(3, policy.maximumPositions)) {
    if (!positions.some((position) => position.positionId === spec.id)) return spec
  }
  return null
}

export function decideNextCapture(
  ledger: PhysicalPositionLedger,
  convergence: ConvergenceAssessment | null,
  policy: AdaptivePlannerPolicy = DEFAULT_ADAPTIVE_POLICY,
): AdaptivePlanDecision {
  const center = ledger.positions.find((position) => position.positionId === 'center') ?? null
  if (!center) {
    const spec = positionSpec(policy, 'center') ?? policy.positions[0]!
    return captureDecision(spec, null, 3, 'both', 'center-required')
  }

  if (!isCenterAccepted(center)) {
    if (ledger.systemicCenterFailures >= 2) {
      return {
        kind: 'abort',
        reason: 'systemic-center-failure',
        message: "Setup check failed. SweetSpot couldn't reliably identify the TV test signal. Calibration has not started, so no room measurements were lost.",
      }
    }
    const retry = retryablePosition(center, policy)
    if (retry) return retry
    return {
      kind: 'finish',
      outcome: 'insufficient',
      reason: 'center-position-incomplete',
    }
  }

  for (const position of ledger.positions) {
    if (position.positionId === 'center' || isPositionAccepted(position)) continue
    const isRequiredPosition = policy.positions
      .slice(0, policy.minimumPositions)
      .some((spec) => spec.id === position.positionId)
    if (!isRequiredPosition
      && acceptedPositionCount(ledger.positions) >= policy.minimumPositions
      && convergence?.sufficient === true) continue
    const repair = retryablePosition(position, policy)
    if (repair) return repair
  }

  const initial = nextMissingInitialPosition(ledger.positions, policy)
  if (initial) {
    const existing = ledger.positions.find((position) => position.positionId === initial.id) ?? null
    const reason: CaptureReason = initial.id === 'center' ? 'center-required' : 'initial-position'
    return captureDecision(
      initial,
      existing,
      3,
      'both',
      reason,
      policy.positions.findIndex((spec) => spec.id === initial.id),
    )
  }

  const acceptedPositions = acceptedPositionCount(ledger.positions)
  if (acceptedPositions >= policy.minimumPositions && convergence?.sufficient === true) {
    return { kind: 'finish', outcome: 'sufficient', reason: 'convergence-sufficient' }
  }

  const nextSpatial = nextUntriedSpatialPosition(ledger.positions, policy)
  if (nextSpatial) {
    const failedOptionalPosition = ledger.positions.some((position) =>
      position.positionId !== 'center' && !isPositionAccepted(position),
    )
    return captureDecision(
      nextSpatial,
      null,
      Math.min(
        policy.maximumPositions,
        Math.max(
          policy.minimumPositions,
          acceptedPositions + 1,
          policy.positions.findIndex((spec) => spec.id === nextSpatial.id) + 1,
        ),
      ),
      'both',
      failedOptionalPosition ? 'replace-failed-position' : 'spatial-uncertainty',
      policy.positions.findIndex((spec) => spec.id === nextSpatial.id),
    )
  }

  return {
    kind: 'finish',
    outcome: acceptedPositions >= policy.minimumPositions ? 'bounded' : 'insufficient',
    reason: acceptedPositions >= policy.minimumPositions ? 'maximum-position-cap' : 'minimum-position-count-not-met',
  }
}

export function requestedPositionCount(decision: AdaptivePlanDecision): number {
  return decision.kind === 'capture' ? decision.requestedPositionCount : 0
}
