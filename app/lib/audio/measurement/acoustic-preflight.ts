type AcousticPreflightFailure = 'capture_too_short' | 'signal_too_low' | 'capture_clipped'

export interface AcousticPreflightResult {
  ok: boolean
  failure: AcousticPreflightFailure | null
  rms: number
  peak: number
  clippedSamples: number
  sampleCount: number
}

export function assessCaptureLevelPreflight(samples: Float32Array, sampleRate: number): AcousticPreflightResult {
  let sumSquares = 0
  let peak = 0
  let clippedSamples = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    sumSquares += sample * sample
    if (magnitude > peak) peak = magnitude
    if (magnitude >= 0.999) clippedSamples++
  }
  const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0
  const minimumSamples = Math.max(1, Math.round(sampleRate * 0.5))
  const failure = samples.length < minimumSamples
    ? 'capture_too_short'
    : clippedSamples > 0
      ? 'capture_clipped'
      : rms < 0.0015
        ? 'signal_too_low'
        : null
  return {
    ok: failure === null,
    failure,
    rms,
    peak,
    clippedSamples,
    sampleCount: samples.length,
  }
}
