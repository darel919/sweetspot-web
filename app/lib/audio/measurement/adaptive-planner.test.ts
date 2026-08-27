import { describe, expect, test } from 'bun:test'
import type { MeasurementAnalysis } from './response'
import {
  decideNextCapture,
  type ConvergenceAssessment,
} from './adaptive-planner'
import {
  createPendingPosition,
  DEFAULT_POSITION_SPECS,
  type CaptureQuality,
  type ChannelMeasurement,
  type PhysicalPositionLedger,
  withChannelMeasurement,
} from './physical-position'

const analysis: MeasurementAnalysis = {
  status: 'ok',
  rawPoints: [],
  correctedPoints: [],
  displayPoints: [],
  room: null,
  impulse: null,
  micProfile: {
    id: 'test',
    name: 'Test microphone',
    author: 'Test',
    sourceUrl: '',
    sourceDate: '',
    referenceType: 'unknown',
    capturePath: 'test',
    capturePathStatus: 'validated',
    dataMethod: 'published-data',
  },
  diagnostics: {
    detected: true,
    detectionOffsetMs: 0,
    envelopeOnlyOffsetMs: null,
    detectionConfidence: 0.9,
    endingMarkerConfidence: 0.9,
    rawLeadingMarkerConfidence: 0.9,
    rawTrailingMarkerConfidence: 0.9,
    bestLeadingMarkerSample: 0,
    bestTrailingMarkerSample: 90,
    markerPairScore: 0.9,
    markerSeparationError: 0,
    markerTimingAgreement: 1,
    syncMarkerFailureReason: null,
    clockDriftPpm: 0,
    signalRms: 0.1,
    signalPeak: 0.2,
    snrEstimateDb: 30,
    clipped: false,
    clippedSamples: 0,
    sampleCount: 10,
    frequencyPoints: 0,
    failureReason: null,
  },
}

const acceptedQuality: CaptureQuality = {
  failureReason: null,
  failureClass: null,
  snrDb: 30,
  markerConfidence: 0.9,
  endingMarkerConfidence: 0.9,
  clipped: false,
  clockDriftPpm: 0,
}

function accepted(): ChannelMeasurement {
  return {
    kind: 'accepted',
    response: [],
    analysis,
    quality: acceptedQuality,
    acceptedAt: 1,
  }
}

function rejected(failureClass: CaptureQuality['failureClass'] = 'local'): ChannelMeasurement {
  return {
    kind: 'rejected',
    analysis: null,
    quality: {
      ...acceptedQuality,
      failureReason: failureClass === 'systemic' ? 'sync_marker_not_found' : 'signal_too_low',
      failureClass,
    },
  }
}

function position(id: 'center' | 'left' | 'right' | 'forward' | 'backward', index: number, options: {
  left?: ChannelMeasurement
  right?: ChannelMeasurement
  attemptIndex?: number
} = {}) {
  const spec = DEFAULT_POSITION_SPECS.find((candidate) => candidate.id === id)
  if (!spec) throw new Error(`Missing position ${id}`)
  let value = createPendingPosition(spec, index, Math.max(3, index + 1), `${id}-${index}`, options.attemptIndex ?? 0)
  value = withChannelMeasurement(value, 'left', options.left ?? accepted())
  value = withChannelMeasurement(value, 'right', options.right ?? accepted())
  return value
}

function ledger(positions: PhysicalPositionLedger['positions'] = [], systemicCenterFailures = 0): PhysicalPositionLedger {
  return { schemaVersion: 1, sessionId: 'cal_test', positions, systemicCenterFailures }
}

const converged: ConvergenceAssessment = {
  sufficient: true,
  medianCorrectionChangeDb: 0.4,
  p95CorrectionChangeDb: 0.9,
  medianSpatialSpreadDb: 1.2,
  lowFrequencySpreadDb: 1.5,
  highConfidenceBandFraction: 0.8,
}

const unconverged: ConvergenceAssessment = { ...converged, sufficient: false }

describe('adaptive physical-position planner', () => {
  test('starts with center, left, and right as three composite captures', () => {
    const center = decideNextCapture(ledger(), null)
    expect(center).toMatchObject({ kind: 'capture', position: { id: 'center' }, repairChannel: 'both', requestedPositionCount: 3 })

    const left = decideNextCapture(ledger([position('center', 0)]), null)
    expect(left).toMatchObject({ kind: 'capture', position: { id: 'left' }, repairChannel: 'both', requestedPositionCount: 3 })

    const right = decideNextCapture(ledger([position('center', 0), position('left', 1)]), null)
    expect(right).toMatchObject({ kind: 'capture', position: { id: 'right' }, repairChannel: 'both', requestedPositionCount: 3 })
  })

  test('stops after three accepted positions when convergence is sufficient', () => {
    const decision = decideNextCapture(
      ledger([position('center', 0), position('left', 1), position('right', 2)]),
      converged,
    )
    expect(decision).toEqual({ kind: 'finish', outcome: 'sufficient', reason: 'convergence-sufficient' })
  })

  test('requests forward only after the first convergence check fails', () => {
    const decision = decideNextCapture(
      ledger([position('center', 0), position('left', 1), position('right', 2)]),
      unconverged,
    )
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'forward' }, requestedPositionCount: 4, reason: 'spatial-uncertainty' })
  })

  test('finishes after forward converges without scheduling backward', () => {
    const decision = decideNextCapture(
      ledger([position('center', 0), position('left', 1), position('right', 2), position('forward', 3)]),
      converged,
    )
    expect(decision).toEqual({ kind: 'finish', outcome: 'sufficient', reason: 'convergence-sufficient' })
  })

  test('caps a difficult room at five positions', () => {
    const decision = decideNextCapture(
      ledger([position('center', 0), position('left', 1), position('right', 2), position('forward', 3), position('backward', 4)]),
      unconverged,
    )
    expect(decision).toEqual({ kind: 'finish', outcome: 'bounded', reason: 'maximum-position-cap' })
  })

  test('repairs only a rejected right channel after left was accepted', () => {
    const partial = position('right', 2, { left: accepted(), right: rejected() })
    const decision = decideNextCapture(
      ledger([position('center', 0), position('left', 1), partial]),
      null,
    )
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'right' }, repairChannel: 'right', reason: 'repair-channel' })
  })

  test('retries a transient center failure once without entering spatial calibration', () => {
    const failedCenter = position('center', 0, { left: rejected(), right: rejected(), attemptIndex: 0 })
    const decision = decideNextCapture(ledger([failedCenter], 1), null)
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'center' }, repairChannel: 'both', attemptIndex: 1, reason: 'retry-position' })
  })

  test('does not reissue an initial position after its retry budget is exhausted', () => {
    const failedLeft = position('left', 1, { left: rejected(), right: rejected(), attemptIndex: 1 })
    const decision = decideNextCapture(
      ledger([position('center', 0), failedLeft]),
      null,
    )
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'right' }, reason: 'initial-position' })
    expect(decision).not.toMatchObject({ position: { id: 'left' } })
  })

  test('aborts after the repeated systemic center failure', () => {
    const failedCenter = position('center', 0, { left: rejected('systemic'), right: rejected('systemic'), attemptIndex: 1 })
    const decision = decideNextCapture(ledger([failedCenter], 2), null)
    expect(decision).toMatchObject({ kind: 'abort', reason: 'systemic-center-failure' })
  })

  test('uses backward as a replacement when an optional position fails', () => {
    const failedForward = position('forward', 3, { left: rejected(), right: rejected(), attemptIndex: 1 })
    const decision = decideNextCapture(
      ledger([position('center', 0), position('left', 1), position('right', 2), failedForward]),
      unconverged,
    )
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'backward' }, reason: 'replace-failed-position' })
  })

  test('does not restart when an optional position fails after convergence is enough', () => {
    const failedBackward = position('backward', 4, { left: rejected(), right: rejected(), attemptIndex: 1 })
    const decision = decideNextCapture(
      ledger([position('center', 0), position('left', 1), position('right', 2), position('forward', 3), failedBackward]),
      converged,
    )
    expect(decision).toEqual({ kind: 'finish', outcome: 'sufficient', reason: 'convergence-sufficient' })
  })

  test('repairs an exhausted optional position only when explicitly requested', () => {
    const failedForward = position('forward', 3, { left: rejected(), right: rejected(), attemptIndex: 1 })
    const decision = decideNextCapture(
      ledger([position('center', 0), position('left', 1), position('right', 2), failedForward]),
      converged,
      undefined,
      { forceRepair: true },
    )
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'forward' }, reason: 'explicit-repair' })
    expect(decision).toMatchObject({ attemptIndex: 2 })
  })
})
