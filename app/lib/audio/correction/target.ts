import type { ResponsePoint } from '../measurement/response'

export interface TargetAnchor {
  frequencyHz: number
  targetDb: number
}

export const SWEETSPOT_TARGET_ANCHORS: readonly TargetAnchor[] = [
  { frequencyHz: 20, targetDb: 4 },
  { frequencyHz: 30, targetDb: 4 },
  { frequencyHz: 60, targetDb: 3.5 },
  { frequencyHz: 100, targetDb: 3 },
  { frequencyHz: 200, targetDb: 1.5 },
  { frequencyHz: 500, targetDb: 0.5 },
  { frequencyHz: 1_000, targetDb: 0 },
  { frequencyHz: 2_000, targetDb: -0.5 },
  { frequencyHz: 5_000, targetDb: -1.5 },
  { frequencyHz: 10_000, targetDb: -2.5 },
  { frequencyHz: 20_000, targetDb: -3 },
]

export function sweetSpotTargetDbAtHz(frequencyHz: number): number {
  const anchors = SWEETSPOT_TARGET_ANCHORS
  if (frequencyHz <= anchors[0].frequencyHz) return anchors[0].targetDb
  if (frequencyHz >= anchors[anchors.length - 1].frequencyHz) return anchors[anchors.length - 1].targetDb
  let low = 0
  let high = anchors.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (anchors[middle].frequencyHz <= frequencyHz) low = middle
    else high = middle
  }
  const lower = anchors[low]
  const upper = anchors[high]
  const position = Math.log(frequencyHz / lower.frequencyHz) / Math.log(upper.frequencyHz / lower.frequencyHz)
  return lower.targetDb + (upper.targetDb - lower.targetDb) * position
}

export function targetPointsFor(points: readonly ResponsePoint[]): ResponsePoint[] {
  return points.map((point) => ({
    frequencyHz: point.frequencyHz,
    magnitudeDb: sweetSpotTargetDbAtHz(point.frequencyHz),
  }))
}

/**
 * Finds a broad low-frequency rolloff against a stable 100-300 Hz reference.
 * A narrow notch cannot make the detected extension move down by itself.
 */
export function detectLfExtensionHz(points: readonly ResponsePoint[]): number {
  const referenceValues = points
    .filter((point) => point.frequencyHz >= 100 && point.frequencyHz <= 300)
    .map((point) => point.magnitudeDb)
  if (referenceValues.length === 0) return 40
  const reference = referenceValues.sort((left, right) => left - right)[Math.floor(referenceValues.length / 2)]
  const low = points.filter((point) => point.frequencyHz >= 20 && point.frequencyHz <= 160)
  for (let index = 0; index < low.length; index++) {
    const window = low.slice(index, index + 3)
    if (window.length < 3) break
    const broadLoss = window.every((point) => point.magnitudeDb <= reference - 3)
    if (broadLoss) return Math.max(20, Math.min(160, window[window.length - 1].frequencyHz))
  }
  return 20
}
