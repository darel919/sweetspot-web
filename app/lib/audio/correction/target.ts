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

function smoothstep(value: number): number {
  const bounded = Math.max(0, Math.min(1, value))
  return bounded * bounded * (3 - 2 * bounded)
}

export function targetPointsFor(
  points: readonly ResponsePoint[],
  lfExtensionHz = 20,
): ResponsePoint[] {
  return points.map((point) => ({
    frequencyHz: point.frequencyHz,
    magnitudeDb: point.frequencyHz < lfExtensionHz
      ? sweetSpotTargetDbAtHz(point.frequencyHz) * smoothstep(point.frequencyHz / lfExtensionHz)
      : sweetSpotTargetDbAtHz(point.frequencyHz),
  }))
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  const current = sorted[middle]
  if (current === undefined) return 0
  if (sorted.length % 2 !== 0) return current
  const previous = sorted[middle - 1]
  return previous === undefined ? current : (previous + current) / 2
}

function smoothLf(points: readonly ResponsePoint[]): ResponsePoint[] {
  return points.map((point, index) => ({
    ...point,
    magnitudeDb: median(points
      .slice(Math.max(0, index - 2), Math.min(points.length, index + 3))
      .map((candidate) => candidate.magnitudeDb)),
  }))
}

function logCrossingFrequency(
  lower: ResponsePoint,
  upper: ResponsePoint,
  thresholdDb: number,
): number {
  if (upper.magnitudeDb === lower.magnitudeDb) return upper.frequencyHz
  const fraction = Math.max(0, Math.min(1, (thresholdDb - lower.magnitudeDb) / (upper.magnitudeDb - lower.magnitudeDb)))
  return lower.frequencyHz * (upper.frequencyHz / lower.frequencyHz) ** fraction
}

export function detectLfExtensionHz(points: readonly ResponsePoint[]): number {
  const referenceValues = points
    .filter((point) => point.frequencyHz >= 100 && point.frequencyHz <= 300)
    .map((point) => point.magnitudeDb)
  if (referenceValues.length === 0) return 40
  const reference = median(referenceValues)
  const low = points
    .filter((point) => point.frequencyHz >= 20 && point.frequencyHz <= 300)
    .sort((left, right) => left.frequencyHz - right.frequencyHz)
  const smoothed = smoothLf(low)
  const threshold = reference - 3
  for (let index = 1; index < smoothed.length; index++) {
    const previous = smoothed[index - 1]
    const current = smoothed[index]
    if (!previous || !current || previous.magnitudeDb > threshold || current.magnitudeDb < threshold) continue
    let lowRunStart = index - 1
    while (lowRunStart > 0 && (smoothed[lowRunStart - 1]?.magnitudeDb ?? threshold + 1) <= threshold) lowRunStart--
    if (index - lowRunStart < 3) continue
    const persistenceEndHz = current.frequencyHz * 1.5
    const recovery = smoothed.slice(index).filter((point) => point.frequencyHz <= persistenceEndHz)
    if (recovery.length < 3 || median(recovery.map((point) => point.magnitudeDb)) < threshold) continue
    return Math.max(20, Math.min(300, logCrossingFrequency(previous, current, threshold)))
  }
  return 20
}
