import type { MeasurementSweep } from '#shared/types/protocol'

function isMarkerDiagnosticCaptureKind(value: MeasurementSweep['captureKind']): boolean {
  return value === 'marker-only' || value === 'marker-production-spacing'
}

function sampleCountForMilliseconds(milliseconds: number, sampleRate: number): number {
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
  rightSweepStartSamples: number
  trailingMarkerStartSamples: number
  endMarkerSamples: number
  totalSamples: number
} {
  const preRollSamples = sampleCountForMilliseconds(sweep.preRollMs, sampleRate)
  const syncMarkerSamples = Math.max(1, sampleCountForMilliseconds(sweep.syncMarkerDurationMs, sampleRate))
  const syncMarkerGapSamples = sampleCountForMilliseconds(sweep.syncMarkerGapMs, sampleRate)
  const sweepSamples = Math.max(1, sampleCountForMilliseconds(sweep.durationMs, sampleRate))
  const postRollSamples = sampleCountForMilliseconds(sweep.postRollMs, sampleRate)
  const leadingMarkerStartSamples = Math.max(0, preRollSamples - syncMarkerSamples - syncMarkerGapSamples)
  const sweepStartSamples = preRollSamples
  const rightSweepStartSamples = sweepStartSamples + sweepSamples + sampleCountForMilliseconds(sweep.interSweepGapMs, sampleRate)
  const trailingMarkerStartSamples = sweep.captureKind === 'marker-only'
    ? leadingMarkerStartSamples + syncMarkerSamples + syncMarkerGapSamples
    : rightSweepStartSamples + sweepSamples + syncMarkerGapSamples
  const endMarkerSamples = Math.max(1, sampleCountForMilliseconds(sweep.endMarkerDurationMs, sampleRate))
  return {
    preRollSamples,
    syncMarkerSamples,
    syncMarkerGapSamples,
    sweepSamples,
    postRollSamples,
    leadingMarkerStartSamples,
    sweepStartSamples,
    rightSweepStartSamples,
    trailingMarkerStartSamples,
    endMarkerSamples,
    totalSamples: trailingMarkerStartSamples + endMarkerSamples + postRollSamples,
  }
}

export function generateSyncMarker(
  sweep: MeasurementSweep,
  sampleRate = sweep.sampleRate,
  kind: 'start' | 'end' = 'start',
): Float32Array {
  const parts = sweepSampleParts(sweep, sampleRate)
  const marker = new Float32Array(kind === 'start' ? parts.syncMarkerSamples : parts.endMarkerSamples)
  const amplitude = 10 ** (sweep.markerLevelDbfs / 20)
  const durationSeconds = (kind === 'start' ? sweep.syncMarkerDurationMs : sweep.endMarkerDurationMs) / 1000
  const startHz = kind === 'start' ? sweep.syncMarkerStartHz : sweep.endMarkerStartHz
  const endHz = kind === 'start' ? sweep.syncMarkerEndHz : sweep.endMarkerEndHz
  const chirpRate = (endHz - startHz) / durationSeconds
  for (let index = 0; index < marker.length; index++) {
    const progress = marker.length === 1 ? 0 : index / (marker.length - 1)
    const time = progress * durationSeconds
    const phase = 2 * Math.PI * (startHz * time + 0.5 * chirpRate * time * time)
    const window = marker.length <= 1 ? 1 : Math.sin(Math.PI * progress)
    marker[index] = amplitude * window * Math.sin(phase)
  }
  return marker
}

export function generateSweepSignal(sweep: MeasurementSweep, sampleRate = sweep.sampleRate): Float32Array {
  const parts = sweepSampleParts(sweep, sampleRate)
  const signal = new Float32Array(parts.sweepSamples)
  const amplitude = 10 ** (sweep.sweepLevelDbfs / 20)
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
  reference.set(generateSyncMarker(sweep, sampleRate, 'start'), parts.leadingMarkerStartSamples)
  if (sweep.captureKind === 'position-composite') reference.set(generateSweepSignal(sweep, sampleRate), parts.sweepStartSamples)
  reference.set(generateSyncMarker(sweep, sampleRate, 'end'), parts.trailingMarkerStartSamples)
  return reference
}

export function generateCompositeSweepReference(sweep: MeasurementSweep, sampleRate = sweep.sampleRate): Float32Array {
  const parts = sweepSampleParts(sweep, sampleRate)
  const reference = generateSweepReference(sweep, sampleRate)
  if (sweep.captureKind !== 'position-composite') return reference
  const right = generateSweepSignal(sweep, sampleRate)
  for (let index = 0; index < right.length && parts.rightSweepStartSamples + index < reference.length; index++) {
    reference[parts.rightSweepStartSamples + index] = right[index] ?? 0
  }
  return reference
}

/** Interleaved stereo reference matching MeasurementSweepGenerator's routing. */
export function generateCompositeSweepStereoReference(
  sweep: MeasurementSweep,
  sampleRate = sweep.sampleRate,
): Float32Array {
  const parts = sweepSampleParts(sweep, sampleRate)
  const start = generateSyncMarker(sweep, sampleRate, 'start')
  const end = generateSyncMarker(sweep, sampleRate, 'end')
  const leftSweep = isMarkerDiagnosticCaptureKind(sweep.captureKind) ? new Float32Array(0) : generateSweepSignal(sweep, sampleRate)
  const rightSweep = isMarkerDiagnosticCaptureKind(sweep.captureKind) ? new Float32Array(0) : generateSweepSignal(sweep, sampleRate)
  const left = new Float32Array(parts.totalSamples)
  const right = new Float32Array(parts.totalSamples)
  const marker = sweep.markerChannel === 'left' ? left : right
  marker.set(start, parts.leadingMarkerStartSamples)
  if (leftSweep.length > 0) left.set(leftSweep, parts.sweepStartSamples)
  if (rightSweep.length > 0) right.set(rightSweep, parts.rightSweepStartSamples)
  marker.set(end, parts.trailingMarkerStartSamples)

  const interleaved = new Float32Array(parts.totalSamples * 2)
  for (let index = 0; index < parts.totalSamples; index++) {
    interleaved[index * 2] = left[index] ?? 0
    interleaved[index * 2 + 1] = right[index] ?? 0
  }
  return interleaved
}
