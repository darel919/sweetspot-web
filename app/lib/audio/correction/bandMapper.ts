import type { ResponsePoint } from '../measurement/response'

function interpolateLog(points: readonly ResponsePoint[], frequencyHz: number): number {
  if (points.length === 0) return 0
  if (frequencyHz <= points[0].frequencyHz) return points[0].magnitudeDb
  if (frequencyHz >= points[points.length - 1].frequencyHz) return points[points.length - 1].magnitudeDb
  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle].frequencyHz <= frequencyHz) low = middle
    else high = middle
  }
  const lower = points[low]
  const upper = points[high]
  const position = Math.log(frequencyHz / lower.frequencyHz) / Math.log(upper.frequencyHz / lower.frequencyHz)
  return lower.magnitudeDb + (upper.magnitudeDb - lower.magnitudeDb) * position
}

/**
 * Maps a continuous correction to DynamicsProcessing's band intervals. The
 * supplied frequencies are upper cutoffs, not PEQ center/Q pairs.
 */
export function mapCorrectionToBands(
  correction: readonly ResponsePoint[],
  bandCutoffsHz: readonly number[],
  minHz = 20,
  maxHz = 20_000,
): number[] {
  if (bandCutoffsHz.length === 0) return []
  return bandCutoffsHz.map((cutoff, index) => {
    const lower = Math.max(minHz, index === 0 ? minHz : bandCutoffsHz[index - 1])
    const upper = Math.min(maxHz, cutoff)
    if (!(upper > lower)) return interpolateLog(correction, Math.max(minHz, Math.min(maxHz, cutoff)))
    const samples = 9
    let total = 0
    for (let sample = 0; sample < samples; sample++) {
      const progress = samples === 1 ? 0 : sample / (samples - 1)
      const frequencyHz = lower * (upper / lower) ** progress
      total += interpolateLog(correction, frequencyHz)
    }
    return total / samples
  })
}

/**
 * Maps the curve while refusing a positive interval gain when any measured
 * correction sample inside that interval is non-positive. A narrow null must
 * not become a boost merely because an interval average includes its
 * neighbors.
 */
export function mapCorrectionToBandsConservative(
  correction: readonly ResponsePoint[],
  bandCutoffsHz: readonly number[],
  minHz = 20,
  maxHz = 20_000,
): number[] {
  return bandCutoffsHz.map((cutoff, index) => {
    const lower = Math.max(minHz, index === 0 ? minHz : bandCutoffsHz[index - 1])
    const upper = Math.min(maxHz, cutoff)
    const mapped = mapCorrectionToBands(correction, [cutoff], lower, upper)[0] ?? 0
    const hasNonPositiveSample = correction.some((point) =>
      point.frequencyHz >= lower && point.frequencyHz <= upper && point.magnitudeDb <= 0,
    )
    return mapped > 0 && hasNonPositiveSample ? 0 : mapped
  })
}
