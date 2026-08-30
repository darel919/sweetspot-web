import type {
  CalibrationPositionId,
  CalibrationSessionOutcome,
} from '#shared/types/protocol'
import type { RepeatabilitySummary } from './aggregation'
import type { MeasurementAnalysis } from './response'

export interface CalibrationOutcomeMessageInput {
  outcome: CalibrationSessionOutcome
  mode: 'measurement' | 'validation' | 'probe'
  hadAnalysis: boolean
  measurementQualityPassed: boolean
  convergenceOutcome: 'sufficient' | 'bounded' | 'insufficient' | null
  probeCaptureQualityPassed: boolean
  probeFailedRepeatabilityGroups: readonly RepeatabilitySummary[]
  isMarkerProbe: boolean
  failedMarkerProbePositions: readonly CalibrationPositionId[]
  failedMeasurementAttemptCount: number
}

export function measurementFailureMessage(result: MeasurementAnalysis): string {
  switch (result.diagnostics.syncMarkerFailureReason) {
    case 'leading_marker_weak':
      return 'The start marker was too weak to identify reliably. Retry this position without moving the phone.'
    case 'trailing_marker_weak':
      return 'The end marker was too weak to identify reliably. Retry this position without moving the phone.'
    case 'marker_pair_low_confidence':
      return 'The marker pair confidence was too low to trust. Retry this position without moving the phone.'
    case 'marker_pair_ambiguous':
      return 'Multiple marker pairs looked plausible, so the timing could not be trusted. Retry this position without moving the phone.'
    case 'marker_pair_bad_timing':
      return 'Marker peaks were found, but their separation did not match the known TV signal timing. Retry this position without moving the phone.'
  }
  if (result.status === 'capture_clipped') {
    return 'Capture rejected because the microphone clipped. Keep the phone still and lower background noise; the TV volume does not need to be raised.'
  }
  if (result.status === 'signal_too_low') {
    const snr = result.diagnostics.snrEstimateDb
    return snr != null && Number.isFinite(snr)
      ? `Capture rejected because it was too noisy (estimated SNR ${snr.toFixed(1)} dB). Keep the phone still and reduce background noise; do not raise the TV volume just to chase a higher peak.`
      : 'Capture rejected because the sweep signal was too weak or too noisy. Keep the phone still and reduce background noise; do not raise the TV volume unless it is genuinely inaudible.'
  }
  if (result.status === 'capture_too_short') {
    return 'Capture rejected because the recording ended before the full sweep. Keep the phone still until the sweep finishes.'
  }
  if (result.status === 'sync_marker_not_found') {
    return 'Capture rejected because the known synchronization marker was not found with sufficient confidence. Keep the phone still and retry.'
  }
  if (result.status === 'clock_drift_unreliable') {
    return 'Capture rejected because the TV/browser clock relationship was unreliable. Keep the phone still and retry.'
  }
  if (result.status === 'direct_arrival_low_confidence' || result.status === 'impulse_not_found') {
    const ratio = result.diagnostics.directPeakToNoiseDb
    return ratio == null
      ? 'Capture synchronized, but the direct acoustic arrival was too weak to trust. Move the phone closer, reduce background noise, and retry.'
      : `Capture synchronized, but the direct acoustic arrival was too weak to trust (peak/noise ${ratio.toFixed(1)} dB). Move the phone closer or reduce background noise, then retry.`
  }
  if (result.status === 'response_not_generated') {
    return 'The synchronized capture did not produce a usable frequency response. Keep the phone still and retry.'
  }
  return 'Capture rejected because the sweep was not detected. Keep the phone still and try again.'
}

export function spatialConsistencyFailureMessage(groups: readonly RepeatabilitySummary[]): string {
  if (groups.length === 0) return ''
  return groups.map((group) => {
    if (group.failureReason === 'capture_rejected') return `${group.positionId} ${group.channel} channel was not usable`
    const medianSpread = group.medianSpreadDb === null ? 'unknown' : `${group.medianSpreadDb.toFixed(1)} dB`
    const maxSpread = group.maxSpreadDb === null ? 'unknown' : `${group.maxSpreadDb.toFixed(1)} dB`
    const withinTwoDb = group.withinTwoDbFraction === null ? 'unknown' : `${Math.round(group.withinTwoDbFraction * 100)}%`
    return `${group.positionId} ${group.channel} channel (median ${medianSpread}, max ${maxSpread}, ${withinTwoDb} within 2 dB)`
  }).join('; ')
}

export function finalOutcomeMessage(input: CalibrationOutcomeMessageInput): string {
  const {
    outcome,
    mode,
    hadAnalysis,
    measurementQualityPassed,
    convergenceOutcome,
    probeCaptureQualityPassed,
    probeFailedRepeatabilityGroups,
    isMarkerProbe,
    failedMarkerProbePositions,
    failedMeasurementAttemptCount,
  } = input
  if (outcome === 'cancelled') return 'Calibration cancelled.'
  if (outcome === 'error') return 'Calibration ended with an error. Review the diagnostics before retrying.'
  if (mode === 'measurement' && outcome === 'sufficient' && measurementQualityPassed && convergenceOutcome === 'sufficient') {
    return 'Advanced measurement complete. Review the response and room metrics below.'
  }
  if (outcome === 'bounded') {
    return 'Measurement finished, but convergence was not reached. The result is inconclusive and no correction was staged.'
  }
  if (outcome === 'insufficient') {
    return 'Measurement finished without enough usable evidence. No correction was generated.'
  }
  if (mode === 'validation') return 'Validation complete. Compare the measured result with the original response.'
  if (mode === 'probe' && isMarkerProbe) {
    return failedMarkerProbePositions.length > 0
      ? `Diagnostic marker probe complete with ${failedMarkerProbePositions.length} failed physical position${failedMarkerProbePositions.length === 1 ? '' : 's'}: ${failedMarkerProbePositions.map((position) => `${position} position`).join(', ')}.`
      : 'Diagnostic marker probe complete. Review the marker timing diagnostics before changing the curve.'
  }
  if (mode === 'probe') {
    return probeCaptureQualityPassed
      ? 'Diagnostic probe complete. Export the captured response before changing the curve.'
      : `Diagnostic probe capture quality is inconclusive at ${spatialConsistencyFailureMessage(probeFailedRepeatabilityGroups)}.`
  }
  if (hadAnalysis && failedMeasurementAttemptCount > 0) {
    return `Calibration needs review. ${failedMeasurementAttemptCount} capture attempt${failedMeasurementAttemptCount === 1 ? '' : 's'} failed before a retry.`
  }
  return 'Calibration failed. Accepted position evidence was incomplete.'
}
