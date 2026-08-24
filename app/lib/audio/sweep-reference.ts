import type { MeasurementSweep } from '#shared/types/protocol'

export function sampleCountForMilliseconds(milliseconds: number, sampleRate: number): number {
  return Math.max(0, Math.round(milliseconds * sampleRate / 1000))
}

export function sweepSampleParts(sweep: MeasurementSweep, sampleRate = sweep.sampleRate): {
  preRollSamples: number
  sweepSamples: number
  postRollSamples: number
} {
  return {
    preRollSamples: sampleCountForMilliseconds(sweep.preRollMs, sampleRate),
    sweepSamples: Math.max(1, sampleCountForMilliseconds(sweep.durationMs, sampleRate)),
    postRollSamples: sampleCountForMilliseconds(sweep.postRollMs, sampleRate),
  }
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
  const reference = new Float32Array(parts.preRollSamples + parts.sweepSamples + parts.postRollSamples)
  reference.set(generateSweepSignal(sweep, sampleRate), parts.preRollSamples)
  return reference
}
