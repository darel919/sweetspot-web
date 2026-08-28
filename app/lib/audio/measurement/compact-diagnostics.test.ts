import { describe, expect, test } from 'bun:test'
import {
  CALIBRATION_POSITION_TARGETS,
  isValidPayload,
  type MeasurementContext,
  type MeasurementDiagnosticsValues,
} from '../../../../shared/types/protocol'
import { compactMeasurementDiagnostics } from './compact-diagnostics'

const context: MeasurementContext = {
  positionId: 'backward',
  ...CALIBRATION_POSITION_TARGETS.backward,
  positionIndex: 4,
  positionCount: 5,
  channel: 'both',
  captureKind: 'position-composite',
  repairChannel: 'left',
  attemptIndex: 1,
  attemptCount: 2,
  phase: 'measurement',
}

function fullDiagnostics(channel: 'left' | 'right', analysisStatus: MeasurementDiagnosticsValues['analysisStatus'] = 'direct_arrival_low_confidence'): MeasurementDiagnosticsValues {
  return {
    channel,
    analysisStatus,
    failureReason: 'peak_below_noise',
    signalRms: 0.01,
    signalPeak: 0.05,
    snrEstimateDb: 16.49,
    detectionOffsetMs: 10.8,
    envelopeOnlyOffsetMs: 10.7,
    startMarkerSample: 48_576,
    endMarkerSample: 197_376,
    expectedMarkerSeparationSamples: 148_800,
    observedMarkerSeparationSamples: 148_799,
    syncMarkerConfidence: 0.7,
    endingMarkerConfidence: 0.8,
    rawLeadingMarkerConfidence: 0.7,
    rawTrailingMarkerConfidence: 0.8,
    bestLeadingMarkerSample: 48_576,
    bestTrailingMarkerSample: 197_376,
    leadingMarkerCandidates: Array.from({ length: 16 }, (_, index) => ({ sample: index, correlation: 0.5 })),
    trailingMarkerCandidates: Array.from({ length: 16 }, (_, index) => ({ sample: index + 100, correlation: 0.5 })),
    markerPairCandidates: Array.from({ length: 16 }, (_, index) => ({
      leadingSample: index,
      trailingSample: index + 100,
      leadingCorrelation: 0.5,
      trailingCorrelation: 0.5,
      observedSeparationSamples: 100,
      separationPpm: 0,
      timingAgreement: 1,
      pairScore: 0.5,
      accepted: false,
      rejectionReason: 'marker_pair_low_confidence',
    })),
    leadingBestCorrelation: 0.7,
    leadingSecondCorrelation: 0.6,
    leadingCorrelationMargin: 0.1,
    trailingBestCorrelation: 0.8,
    trailingSecondCorrelation: 0.7,
    trailingCorrelationMargin: 0.1,
    markerPairScore: 0.6,
    secondMarkerPairScore: 0.5,
    markerPairScoreMargin: 0.1,
    markerPairScoreRatio: 1.2,
    markerSeparationError: 1,
    markerTimingAgreement: 0.9,
    markerSeparationPpm: -6,
    syncMarkerFailureReason: null,
    clockDriftPpm: -6,
    clipped: false,
    clippedSamples: 0,
    directArrivalMs: null,
    directPeak: 0.00198,
    deconvolvedNoiseFloorRms: 0.00039,
    directPeakToNoiseDb: 14.11,
    directArrivalAcceptanceThreshold: 0.002341,
    directArrivalCandidateSample: 521,
    directArrivalAcceptedSample: null,
    directArrivalRejectionReason: 'peak_below_noise',
    directSupportWindowRms: 0,
    directSupportWindowThreshold: 0.000585,
    directSupportSampleCount: 2,
    bestLaterReflectionSample: 900,
    bestLaterReflectionPeak: 0.0008,
    directToLateDb: null,
    c50Db: null,
    c80Db: null,
    edtMs: null,
    t20Ms: null,
    t30Ms: null,
    earlyReflections: 0,
    decayConfidence: 'low',
  }
}

describe('compact diagnostics', () => {
  test('removes candidate arrays while preserving direct-arrival evidence', () => {
    const compact = compactMeasurementDiagnostics({
      ...fullDiagnostics('left'),
      captureMetadata: {
        sampleRate: 48_000,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRateRange: { min: 44_100, max: 48_000 },
        channelCountRange: { min: 1, max: 2 },
        echoCancellationCapabilities: [false, true],
        noiseSuppressionCapabilities: [false, true],
        autoGainControlCapabilities: [false, true],
        browserUserAgent: 'Safari test',
        micProfileId: 'fixture-mic',
        micProfileSourceDate: '2026-01-01',
        trackSampleRate: 48_000,
        trackChannelCount: 1,
      },
    })
    const payload = { sessionId: 'cal_test', context, current: 4, total: 5, diagnostics: compact }

    expect(isValidPayload('measurement.diagnostics', payload)).toBe(true)
    expect(compact).not.toHaveProperty('leadingMarkerCandidates')
    expect(compact).not.toHaveProperty('trailingMarkerCandidates')
    expect(compact).not.toHaveProperty('markerPairCandidates')
    expect(compact).not.toHaveProperty('topEarlyImpulsePeaks')
    expect(compact.captureMetadata).toEqual({
      sampleRate: 48_000,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      trackSampleRate: 48_000,
      trackChannelCount: 1,
    })
    expect(compact.directArrivalCandidateSample).toBe(521)
    expect(compact.directArrivalRejectionReason).toBe('peak_below_noise')
  })

  test('represents an unmeasured sibling channel without an envelope error', () => {
    const compact = compactMeasurementDiagnostics({
      ...fullDiagnostics('right', 'ok'),
      analysisStatus: 'not_measured',
      failureReason: null,
      snrEstimateDb: null,
      directArrivalMs: null,
      directArrivalRejectionReason: null,
    })
    expect(isValidPayload('measurement.diagnostics', {
      sessionId: 'cal_test',
      context,
      current: 4,
      total: 5,
      diagnostics: compact,
    })).toBe(true)
  })
})
