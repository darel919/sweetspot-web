import type { MeasurementSweep } from '#shared/types/protocol'

export function sampleCountForMilliseconds(milliseconds: number, sampleRate: number): number {
  return Math.max(0, Math.round(milliseconds * sampleRate / 1000))
}

export function sweepSampleParts(sweep: MeasurementSweep, sampleRate = sweep.sampleRate): {
  preRollSamples: number
  syncMarkerSamples: number
  syncMarkerGapSamples: number
  sweepSamples: number
  postRollSamples: number
  leadingMarkerStartSamples: number
  sweepStartSamples: number
  trailingMarkerStartSamples: number
  totalSamples: number
} {
  const preRollSamples = sampleCountForMilliseconds(sweep.preRollMs, sampleRate)
  const syncMarkerSamples = Math.max(1, sampleCountForMilliseconds(sweep.syncMarkerDurationMs, sampleRate))
  const syncMarkerGapSamples = sampleCountForMilliseconds(sweep.syncMarkerGapMs, sampleRate)
  const sweepSamples = Math.max(1, sampleCountForMilliseconds(sweep.durationMs, sampleRate))
  const postRollSamples = sampleCountForMilliseconds(sweep.postRollMs, sampleRate)
  const leadingMarkerStartSamples = Math.max(0, preRollSamples - syncMarkerSamples - syncMarkerGapSamples)
  const sweepStartSamples = preRollSamples
  const trailingMarkerStartSamples = sweepStartSamples + sweepSamples + postRollSamples + syncMarkerGapSamples
  return {
    preRollSamples,
    syncMarkerSamples,
    syncMarkerGapSamples,
    sweepSamples,
    postRollSamples,
    leadingMarkerStartSamples,
    sweepStartSamples,
    trailingMarkerStartSamples,
    totalSamples: trailingMarkerStartSamples + syncMarkerSamples,
  }
}

export function generateSyncMarker(sweep: MeasurementSweep, sampleRate = sweep.sampleRate): Float32Array {
  const parts = sweepSampleParts(sweep, sampleRate)
  const marker = new Float32Array(parts.syncMarkerSamples)
  const amplitude = 10 ** (sweep.levelDbfs / 20)
  const durationSeconds = sweep.syncMarkerDurationMs / 1000
  const chirpRate = (sweep.syncMarkerEndHz - sweep.syncMarkerStartHz) / durationSeconds
  for (let index = 0; index < marker.length; index++) {
    const progress = marker.length === 1 ? 0 : index / (marker.length - 1)
    const time = progress * durationSeconds
    const phase = 2 * Math.PI * (sweep.syncMarkerStartHz * time + 0.5 * chirpRate * time * time)
    const window = marker.length <= 1 ? 1 : Math.sin(Math.PI * progress)
    marker[index] = amplitude * window * Math.sin(phase)
  }
  return marker
}

export function generateSweepSignal(sweep: MeasurementSweep, sampleRate = sweep.sampleRate): Float32Array {
  const parts = sweepSampleParts(sweep, sampleRate)
  const signal = new Float32Array(parts.sweepSamples)
  const amplitude = 10 ** (sweep.levelDbfs / 20)
  const durationSeconds = sweep.durationMs / 1000
  const logarithmicRate = Math.log(sweep.endHz / sweep.startHz) / durationSeconds
  const phaseScale = 2 * Math.PI * sweep.startHz / logarithmicRate
  const fadeInSamples = sampleCountForMilliseconds(sweep.fadeInMs, sampleRate)
  const fadeOutSamples = sampleCountForMilliseconds(sweep.fadeOutMs, sampleRate)

  for (let index = 0; index < parts.sweepSamples; index++) {
    const progress = parts.sweepSamples === 1 ? 0 : index / (parts.sweepSamples - 1)
    const time = progress * durationSeconds
    const phase = phaseScale * (Math.exp(logarithmicRate * time) - 1)
    const fadeIn = fadeInSamples <= 1 ? 1 : Math.min(1, index / (fadeInSamples - 1))
    const remaining = parts.sweepSamples - 1 - index
    const fadeOut = fadeOutSamples <= 1 ? 1 : Math.min(1, remaining / (fadeOutSamples - 1))
    signal[index] = amplitude * fadeIn * fadeOut * Math.sin(phase)
  }

  return signal
}

export function generateSweepReference(sweep: MeasurementSweep, sampleRate = sweep.sampleRate): Float32Array {
  const parts = sweepSampleParts(sweep, sampleRate)
  const reference = new Float32Array(parts.totalSamples)
  const marker = generateSyncMarker(sweep, sampleRate)
  reference.set(marker, parts.leadingMarkerStartSamples)
  reference.set(generateSweepSignal(sweep, sampleRate), parts.sweepStartSamples)
  reference.set(marker, parts.trailingMarkerStartSamples)
  return reference
}
