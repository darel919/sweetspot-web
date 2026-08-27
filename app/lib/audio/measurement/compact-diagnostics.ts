import type {
  CompactMeasurementDiagnosticsValues,
  MeasurementDiagnosticsValues,
} from '../../../../shared/types/protocol'

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== undefined && Number.isFinite(value) ? value : null
}

function boundedConfidence(value: number | null | undefined): number {
  const finite = finiteOrNull(value) ?? 0
  return Math.max(0, Math.min(1, finite))
}

function nonNegativeFinite(value: number | null | undefined): number {
  const finite = finiteOrNull(value) ?? 0
  return Math.max(0, finite)
}

export function compactMeasurementDiagnostics(
  diagnostics: MeasurementDiagnosticsValues,
): CompactMeasurementDiagnosticsValues {
  return {
    channel: diagnostics.channel,
    analysisStatus: diagnostics.analysisStatus,
    failureReason: diagnostics.failureReason ?? null,
    signalRms: nonNegativeFinite(diagnostics.signalRms),
    signalPeak: nonNegativeFinite(diagnostics.signalPeak),
    snrEstimateDb: finiteOrNull(diagnostics.snrEstimateDb),
    detectionOffsetMs: finiteOrNull(diagnostics.detectionOffsetMs),
    envelopeOnlyOffsetMs: finiteOrNull(diagnostics.envelopeOnlyOffsetMs),
    startMarkerSample: finiteOrNull(diagnostics.startMarkerSample),
    endMarkerSample: finiteOrNull(diagnostics.endMarkerSample),
    expectedMarkerSeparationSamples: finiteOrNull(diagnostics.expectedMarkerSeparationSamples),
    observedMarkerSeparationSamples: finiteOrNull(diagnostics.observedMarkerSeparationSamples),
    syncMarkerConfidence: boundedConfidence(diagnostics.syncMarkerConfidence),
    endingMarkerConfidence: boundedConfidence(diagnostics.endingMarkerConfidence),
    ...(diagnostics.rawLeadingMarkerConfidence === undefined
      ? {}
      : { rawLeadingMarkerConfidence: diagnostics.rawLeadingMarkerConfidence }),
    ...(diagnostics.rawTrailingMarkerConfidence === undefined
      ? {}
      : { rawTrailingMarkerConfidence: diagnostics.rawTrailingMarkerConfidence }),
    bestLeadingMarkerSample: finiteOrNull(diagnostics.bestLeadingMarkerSample),
    bestTrailingMarkerSample: finiteOrNull(diagnostics.bestTrailingMarkerSample),
    leadingBestCorrelation: finiteOrNull(diagnostics.leadingBestCorrelation),
    leadingSecondCorrelation: finiteOrNull(diagnostics.leadingSecondCorrelation),
    leadingCorrelationMargin: finiteOrNull(diagnostics.leadingCorrelationMargin),
    trailingBestCorrelation: finiteOrNull(diagnostics.trailingBestCorrelation),
    trailingSecondCorrelation: finiteOrNull(diagnostics.trailingSecondCorrelation),
    trailingCorrelationMargin: finiteOrNull(diagnostics.trailingCorrelationMargin),
    markerPairScore: finiteOrNull(diagnostics.markerPairScore),
    secondMarkerPairScore: finiteOrNull(diagnostics.secondMarkerPairScore),
    markerPairScoreMargin: finiteOrNull(diagnostics.markerPairScoreMargin),
    markerPairScoreRatio: finiteOrNull(diagnostics.markerPairScoreRatio),
    markerSeparationError: finiteOrNull(diagnostics.markerSeparationError),
    markerTimingAgreement: finiteOrNull(diagnostics.markerTimingAgreement),
    markerSeparationPpm: finiteOrNull(diagnostics.markerSeparationPpm),
    syncMarkerFailureReason: diagnostics.syncMarkerFailureReason ?? null,
    clockDriftPpm: finiteOrNull(diagnostics.clockDriftPpm),
    clipped: diagnostics.clipped,
    clippedSamples: Math.max(0, Math.floor(diagnostics.clippedSamples)),
    directArrivalMs: finiteOrNull(diagnostics.directArrivalMs),
    directPeak: finiteOrNull(diagnostics.directPeak),
    deconvolvedNoiseFloorRms: finiteOrNull(diagnostics.deconvolvedNoiseFloorRms),
    directPeakToNoiseDb: finiteOrNull(diagnostics.directPeakToNoiseDb),
    directArrivalAcceptanceThreshold: finiteOrNull(diagnostics.directArrivalAcceptanceThreshold),
    directArrivalCandidateSample: finiteOrNull(diagnostics.directArrivalCandidateSample),
    directArrivalAcceptedSample: finiteOrNull(diagnostics.directArrivalAcceptedSample),
    directArrivalRejectionReason: diagnostics.directArrivalRejectionReason ?? null,
    directSupportWindowRms: finiteOrNull(diagnostics.directSupportWindowRms),
    directSupportWindowThreshold: finiteOrNull(diagnostics.directSupportWindowThreshold),
    directSupportSampleCount: finiteOrNull(diagnostics.directSupportSampleCount),
    bestLaterReflectionSample: finiteOrNull(diagnostics.bestLaterReflectionSample),
    bestLaterReflectionPeak: finiteOrNull(diagnostics.bestLaterReflectionPeak),
    ...(diagnostics.captureMetadata ? {
      captureMetadata: {
        sampleRate: diagnostics.captureMetadata.sampleRate,
        channelCount: diagnostics.captureMetadata.channelCount,
        echoCancellation: diagnostics.captureMetadata.echoCancellation,
        noiseSuppression: diagnostics.captureMetadata.noiseSuppression,
        autoGainControl: diagnostics.captureMetadata.autoGainControl,
        ...(diagnostics.captureMetadata.trackSampleRate === undefined
          ? {}
          : { trackSampleRate: diagnostics.captureMetadata.trackSampleRate }),
        ...(diagnostics.captureMetadata.trackChannelCount === undefined
          ? {}
          : { trackChannelCount: diagnostics.captureMetadata.trackChannelCount }),
      },
    } : {}),
    directToLateDb: finiteOrNull(diagnostics.directToLateDb),
    c50Db: finiteOrNull(diagnostics.c50Db),
    c80Db: finiteOrNull(diagnostics.c80Db),
    edtMs: finiteOrNull(diagnostics.edtMs),
    t20Ms: finiteOrNull(diagnostics.t20Ms),
    t30Ms: finiteOrNull(diagnostics.t30Ms),
    earlyReflections: Math.max(0, Math.floor(diagnostics.earlyReflections)),
    decayConfidence: diagnostics.decayConfidence,
  }
}
