import { describe, expect, test } from 'bun:test'
import { CALIBRATION_POSITION_TARGETS, type MeasurementContext } from '../../../../shared/types/protocol'
import { decideNextCapture, type ConvergenceAssessment } from './adaptive-planner'
import {
  acceptedPositionCount,
  appendCompositeCapture,
  createPositionLedger,
  projectAcceptedRecords,
  projectPhysicalPositionLedger,
} from './position-ledger'
import type { CompositeMeasurementAnalysis, MeasurementAnalysis } from './response'

function analysis(status: MeasurementAnalysis['status'] = 'ok', offsetDb = 0): MeasurementAnalysis {
  const points = [
    { frequencyHz: 100, magnitudeDb: offsetDb },
    { frequencyHz: 1_000, magnitudeDb: offsetDb },
    { frequencyHz: 10_000, magnitudeDb: offsetDb },
  ]
  return {
    status,
    rawPoints: status === 'ok' ? points : [],
    correctedPoints: status === 'ok' ? points : [],
    displayPoints: status === 'ok' ? points : [],
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
      detected: status === 'ok',
      detectionOffsetMs: status === 'ok' ? 0 : null,
      envelopeOnlyOffsetMs: null,
      detectionConfidence: status === 'ok' ? 0.9 : 0,
      endingMarkerConfidence: status === 'ok' ? 0.9 : 0,
      rawLeadingMarkerConfidence: status === 'ok' ? 0.9 : 0,
      rawTrailingMarkerConfidence: status === 'ok' ? 0.9 : 0,
      bestLeadingMarkerSample: status === 'ok' ? 0 : null,
      bestTrailingMarkerSample: status === 'ok' ? 90 : null,
      markerPairScore: status === 'ok' ? 0.9 : null,
      markerSeparationError: status === 'ok' ? 0 : null,
      markerTimingAgreement: status === 'ok' ? 1 : null,
      syncMarkerFailureReason: status === 'ok' ? null : 'marker_pair_low_confidence',
      clockDriftPpm: status === 'ok' ? 0 : null,
      signalRms: status === 'ok' ? 0.1 : 0,
      signalPeak: status === 'ok' ? 0.2 : 0,
      snrEstimateDb: status === 'ok' ? 30 : null,
      clipped: false,
      clippedSamples: 0,
      sampleCount: 100,
      frequencyPoints: status === 'ok' ? points.length : 0,
      failureReason: status === 'ok' ? null : status,
    },
  }
}

function composite(
  left: MeasurementAnalysis = analysis(),
  right: MeasurementAnalysis = analysis(),
): CompositeMeasurementAnalysis {
  const detection = {
    found: left.status === 'ok' || right.status === 'ok',
    startSample: 10,
    rightStartSample: 30,
    leadingMarkerSample: 0,
    trailingMarkerSample: 90,
    envelopeOnlyOffsetMs: null,
    offsetMs: 1,
    confidence: 0.9,
    endingMarkerConfidence: 0.9,
    rawLeadingMarkerConfidence: 0.9,
    rawTrailingMarkerConfidence: 0.9,
    bestLeadingMarkerSample: 0,
    bestTrailingMarkerSample: 90,
    markerPairScore: 0.9,
    markerSeparationError: 0,
    markerTimingAgreement: 1,
    clockRatio: 1,
    driftPpm: 0,
    expectedMarkerSeparationSamples: 90,
    observedMarkerSeparationSamples: 90,
    failureReason: null,
  }
  return {
    status: left.status === 'ok' && right.status === 'ok'
      ? 'ok'
      : left.status === 'ok' || right.status === 'ok'
        ? 'partial'
        : left.status,
    detection,
    left,
    right,
  }
}

function context(
  positionId: MeasurementContext['positionId'],
  positionIndex: number,
  attemptIndex = 0,
  repairChannel: MeasurementContext['repairChannel'] = 'both',
): MeasurementContext {
  return {
    positionId,
    ...CALIBRATION_POSITION_TARGETS[positionId],
    positionIndex,
    positionCount: 3,
    channel: 'both',
    captureKind: 'position-composite',
    repairChannel,
    attemptIndex,
    attemptCount: 2,
    phase: 'measurement',
  }
}

const converged: ConvergenceAssessment = {
  sufficient: true,
  medianCorrectionChangeDb: 0.4,
  p95CorrectionChangeDb: 0.9,
  medianSpatialSpreadDb: 1,
  lowFrequencySpreadDb: 1,
  highConfidenceBandFraction: 0.9,
}

function append(
  ledger: ReturnType<typeof createPositionLedger>,
  captureContext: MeasurementContext,
  result: CompositeMeasurementAnalysis,
) {
  return appendCompositeCapture(ledger, {
    context: captureContext,
    analysis: result,
    captureMetadata: null,
    acceptedAt: 100,
  })
}

describe('append-only physical-position ledger', () => {
  test('retains all accepted channels and projects six records from three positions', () => {
    let ledger = createPositionLedger('session-1')
    ledger = append(ledger, context('center', 0), composite(analysis('ok', 0), analysis('ok', 1)))
    ledger = append(ledger, context('left', 1), composite(analysis('ok', 2), analysis('ok', 3)))
    ledger = append(ledger, context('right', 2), composite(analysis('ok', 4), analysis('ok', 5)))

    const projected = projectPhysicalPositionLedger(ledger)
    expect(acceptedPositionCount(ledger)).toBe(3)
    expect(projected.positions).toHaveLength(3)
    expect(projectAcceptedRecords(ledger)).toHaveLength(6)
    expect(decideNextCapture(projected, converged)).toEqual({
      kind: 'finish',
      outcome: 'sufficient',
      reason: 'convergence-sufficient',
    })
  })

  test('repairs only the rejected right channel and keeps the original left evidence', () => {
    let ledger = createPositionLedger('session-2')
    ledger = append(ledger, context('center', 0), composite())
    ledger = append(ledger, context('left', 1), composite())
    const rightContext = context('right', 2)
    ledger = append(ledger, rightContext, composite(analysis('ok', 2), analysis('signal_too_low')))

    const projectedBeforeRepair = projectPhysicalPositionLedger(ledger)
    const repair = decideNextCapture(projectedBeforeRepair, null)
    expect(repair).toMatchObject({ kind: 'capture', position: { id: 'right' }, repairChannel: 'right', attemptIndex: 1 })

    const repairedRight = analysis('ok', 3)
    ledger = append(ledger, context('right', 2, 1, 'right'), composite(analysis('sweep_not_found'), repairedRight))
    const projected = projectPhysicalPositionLedger(ledger)
    const right = projected.positions.find((position) => position.positionId === 'right')
    expect(right?.left.kind).toBe('accepted')
    expect(right?.right.kind).toBe('accepted')
    if (right?.left.kind !== 'accepted') throw new Error('Expected the original left response.')
    expect(right.left.analysis.correctedPoints[0]?.magnitudeDb).toBe(2)
    expect(projectAcceptedRecords(ledger)).toHaveLength(6)
  })

  test('ignores a duplicate capture without changing the append-only ledger', () => {
    const captureContext = context('center', 0)
    const initial = append(createPositionLedger('session-3'), captureContext, composite())
    const duplicate = append(initial, captureContext, composite(analysis('signal_too_low'), analysis('signal_too_low')))

    expect(duplicate).toEqual(initial)
  })

  test('aborts after two systemic center failures before any spatial position is scheduled', () => {
    let ledger = createPositionLedger('session-4')
    ledger = append(ledger, context('center', 0), composite(analysis('sync_marker_not_found'), analysis('sync_marker_not_found')))
    let decision = decideNextCapture(projectPhysicalPositionLedger(ledger), null)
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'center' }, attemptIndex: 1 })

    ledger = append(ledger, context('center', 0, 1), composite(analysis('sync_marker_not_found'), analysis('sync_marker_not_found')))
    decision = decideNextCapture(projectPhysicalPositionLedger(ledger), null)
    expect(decision).toMatchObject({ kind: 'abort', reason: 'systemic-center-failure' })
    expect(ledger.captures.some((capture) => capture.context.positionId !== 'center')).toBe(false)
  })

  test('bounds repeated optional failure and finishes with the accepted minimum', () => {
    let ledger = createPositionLedger('session-5')
    ledger = append(ledger, context('center', 0), composite())
    ledger = append(ledger, context('left', 1), composite())
    ledger = append(ledger, context('right', 2), composite())

    let decision = decideNextCapture(projectPhysicalPositionLedger(ledger), { ...converged, sufficient: false })
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'forward' } })
    ledger = append(ledger, context('forward', 3), composite(analysis('signal_too_low'), analysis('signal_too_low')))
    decision = decideNextCapture(projectPhysicalPositionLedger(ledger), { ...converged, sufficient: false })
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'forward' }, attemptIndex: 1 })

    ledger = append(ledger, context('forward', 3, 1), composite(analysis('signal_too_low'), analysis('signal_too_low')))
    decision = decideNextCapture(projectPhysicalPositionLedger(ledger), { ...converged, sufficient: false })
    expect(decision).toMatchObject({ kind: 'capture', position: { id: 'backward' }, reason: 'replace-failed-position' })

    ledger = append(ledger, context('backward', 4), composite(analysis('signal_too_low'), analysis('signal_too_low')))
    ledger = append(ledger, context('backward', 4, 1), composite(analysis('signal_too_low'), analysis('signal_too_low')))
    expect(decideNextCapture(projectPhysicalPositionLedger(ledger), { ...converged, sufficient: false })).toMatchObject({
      kind: 'finish',
      outcome: 'bounded',
    })
  })
})
