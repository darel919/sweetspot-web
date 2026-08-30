import type { ResponsePoint } from '../measurement/response'

interface TargetAnchor {
  frequencyHz: number
  targetDb: number
}

interface LfCapabilityEstimate {
  frequencyHz: number
  confidence: number
}

export interface LfCapability {
  minus3Db: LfCapabilityEstimate
  minus6Db: LfCapabilityEstimate
}

const SWEETSPOT_TARGET_ANCHORS: readonly TargetAnchor[] = [
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

function sweetSpotTargetDbAtHz(frequencyHz: number): number {
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

function finiteSortedPoints(points: readonly ResponsePoint[]): ResponsePoint[] {
  return points
    .filter((point) => Number.isFinite(point.frequencyHz)
      && point.frequencyHz > 0
      && Number.isFinite(point.magnitudeDb))
    .sort((left, right) => left.frequencyHz - right.frequencyHz)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

interface StableReference {
  magnitudeDb: number
  confidence: number
}

function adaptiveLowMidReference(points: readonly ResponsePoint[]): StableReference | null {
  const smoothed = smoothLf(finiteSortedPoints(points))
  const lowMid = smoothed.filter((point) => point.frequencyHz >= 80 && point.frequencyHz <= 1_200)
  if (lowMid.length < 5) return null
  const highMid = smoothed
    .filter((point) => point.frequencyHz >= 400 && point.frequencyHz <= 2_000)
    .map((point) => point.magnitudeDb)
  const anchor = median(highMid.length >= 5 ? highMid : lowMid.map((point) => point.magnitudeDb))
  let best: {
    magnitudeDb: number
    confidence: number
    score: number
  } | null = null

  for (let start = 0; start < lowMid.length; start++) {
    const first = lowMid[start]
    if (!first) continue
    const window = lowMid.slice(start).filter((point) => point.frequencyHz <= first.frequencyHz * 1.8)
    const last = window[window.length - 1]
    if (!last || window.length < 4 || last.frequencyHz / first.frequencyHz < 1.35) continue
    const values = window.map((point) => point.magnitudeDb)
    const center = median(values)
    const spread = median(values.map((value) => Math.abs(value - center)))
    const midpoint = Math.floor(window.length / 2)
    const lowerHalf = median(window.slice(0, midpoint).map((point) => point.magnitudeDb))
    const upperHalf = median(window.slice(midpoint).map((point) => point.magnitudeDb))
    const octaveSpan = Math.max(0.25, Math.log2(last.frequencyHz / first.frequencyHz))
    const slope = Math.abs(upperHalf - lowerHalf) / octaveSpan
    const roughness = median(window.slice(1).map((point, index) =>
      Math.abs(point.magnitudeDb - (window[index]?.magnitudeDb ?? point.magnitudeDb))))
    const score = spread * 2 + slope + roughness + Math.abs(center - anchor) * 0.35
    const confidence = clamp(1 - score / 3.5, 0, 1)
    if (!best || score < best.score) best = { magnitudeDb: center, confidence, score }
  }
  return best ? { magnitudeDb: best.magnitudeDb, confidence: best.confidence } : null
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

interface ThresholdCrossing {
  frequencyHz: number
  confidence: number
}

function thresholdCrossing(
  points: readonly ResponsePoint[],
  reference: StableReference,
  thresholdDb: number,
): ThresholdCrossing | null {
  const low = finiteSortedPoints(points).filter((point) => point.frequencyHz <= 1_200)
  const smoothed = smoothLf(low)
  for (let index = 1; index < smoothed.length; index++) {
    const previous = smoothed[index - 1]
    const current = smoothed[index]
    if (!previous || !current || previous.magnitudeDb > thresholdDb || current.magnitudeDb < thresholdDb) continue
    let lowRunStart = index - 1
    while (lowRunStart > 0 && (smoothed[lowRunStart - 1]?.magnitudeDb ?? thresholdDb + 1) <= thresholdDb) lowRunStart--
    const lowRunLength = index - lowRunStart
    if (lowRunLength < 2 && lowRunStart !== 0) continue
    const lowRunFirst = smoothed[lowRunStart]
    if (!lowRunFirst) continue
    const lowRunSpan = previous.frequencyHz / lowRunFirst.frequencyHz
    if (lowRunStart !== 0 && lowRunSpan < 1.25) continue
    const recovery = smoothed
      .slice(index)
      .filter((point) => point.frequencyHz <= current.frequencyHz * 1.7)
    if (recovery.length < 3 || median(recovery.map((point) => point.magnitudeDb)) < thresholdDb + 0.25) continue
    const recoveryLast = recovery[recovery.length - 1]
    if (!recoveryLast) continue
    const lowRunConfidence = lowRunStart === 0
      ? 1
      : clamp(Math.log2(lowRunSpan) / 0.75, 0, 1)
    const recoveryConfidence = clamp(Math.log2(recoveryLast.frequencyHz / current.frequencyHz) / 0.75, 0, 1)
    const persistenceConfidence = clamp((recovery.length - 2) / 6, 0, 1)
    const confidence = clamp(reference.confidence * (
      0.4 + lowRunConfidence * 0.2 + recoveryConfidence * 0.2 + persistenceConfidence * 0.2
    ), 0, 1)
    return {
      frequencyHz: Math.max(20, logCrossingFrequency(previous, current, thresholdDb)),
      confidence,
    }
  }
  return null
}

function conservativeThresholdBoundary(
  points: readonly ResponsePoint[],
  reference: StableReference,
  thresholdDb: number,
): ThresholdCrossing | null {
  const smoothed = smoothLf(finiteSortedPoints(points).filter((point) => point.frequencyHz <= 1_200))
  const first = smoothed[0]
  if (!first || first.magnitudeDb > thresholdDb) return null
  let lastLowIndex = 0
  while (lastLowIndex + 1 < smoothed.length
    && (smoothed[lastLowIndex + 1]?.magnitudeDb ?? thresholdDb + 1) <= thresholdDb) {
    lastLowIndex++
  }
  const lastLow = smoothed[lastLowIndex]
  if (!lastLow) return null
  return {
    frequencyHz: Math.max(20, lastLow.frequencyHz),
    confidence: reference.confidence * 0.25,
  }
}

function fallbackEstimate(points: readonly ResponsePoint[]): LfCapabilityEstimate {
  const first = finiteSortedPoints(points)[0]
  // Unknown extension is a safety boundary, not evidence of a 20 Hz speaker.
  // Keep positive target energy out of the unmeasured sub-200 Hz region.
  return { frequencyHz: Math.max(200, first?.frequencyHz ?? 200), confidence: 0 }
}

export function detectLfCapability(points: readonly ResponsePoint[]): LfCapability {
  const fallback = fallbackEstimate(points)
  const reference = adaptiveLowMidReference(points)
  if (!reference) {
    return { minus3Db: fallback, minus6Db: fallback }
  }
  const minus3Candidate = thresholdCrossing(points, reference, reference.magnitudeDb - 3)
    ?? conservativeThresholdBoundary(points, reference, reference.magnitudeDb - 3)
  const minus3 = minus3Candidate ?? fallback
  const minus6Candidate = thresholdCrossing(points, reference, reference.magnitudeDb - 6)
    ?? conservativeThresholdBoundary(points, reference, reference.magnitudeDb - 6)
  const firstPoint = finiteSortedPoints(points)[0]
  const minus6 = minus6Candidate ?? {
    frequencyHz: Math.min(fallback.frequencyHz, minus3.frequencyHz),
    confidence: firstPoint !== undefined && firstPoint.magnitudeDb <= reference.magnitudeDb - 6
      ? reference.confidence * 0.5
      : 0,
  }
  return {
    minus3Db: minus3,
    minus6Db: {
      frequencyHz: Math.min(minus6.frequencyHz, minus3.frequencyHz),
      confidence: minus6.confidence,
    },
  }
}

function lfPositiveTaperAtHz(frequencyHz: number, capability: LfCapability): number {
  if (Math.min(capability.minus3Db.confidence, capability.minus6Db.confidence) < 0.5) {
    return frequencyHz >= 200 ? 1 : 0
  }
  const minus3Hz = Math.max(capability.minus3Db.frequencyHz, capability.minus6Db.frequencyHz)
  const minus6Hz = Math.min(capability.minus3Db.frequencyHz, capability.minus6Db.frequencyHz)
  if (frequencyHz <= minus6Hz) return 0
  if (frequencyHz >= minus3Hz || minus3Hz === minus6Hz) return 1
  return smoothstep((frequencyHz - minus6Hz) / (minus3Hz - minus6Hz))
}

export function targetPointsFor(
  points: readonly ResponsePoint[],
  capability: LfCapability = detectLfCapability(points),
): ResponsePoint[] {
  return points.map((point) => {
    const targetDb = sweetSpotTargetDbAtHz(point.frequencyHz)
    return {
      frequencyHz: point.frequencyHz,
      magnitudeDb: targetDb > 0 ? targetDb * lfPositiveTaperAtHz(point.frequencyHz, capability) : targetDb,
    }
  })
}

export function detectLfExtensionHz(points: readonly ResponsePoint[]): number {
  return detectLfCapability(points).minus3Db.frequencyHz
}
