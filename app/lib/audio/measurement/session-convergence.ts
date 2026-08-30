import type { AggregateResponse } from './aggregation'
import type { ConvergenceAssessment } from './adaptive-planner'
import { projectPhysicalPositionLedger, type PositionLedger } from './position-ledger'
import type { ResponsePoint } from './response'

const MAX_MEDIAN_CORRECTION_CHANGE_DB = 1.5
const MAX_P95_CORRECTION_CHANGE_DB = 3

export interface MeasurementConvergenceInput {
  ledger: PositionLedger
  aggregate: AggregateResponse | null
  previousPoints: readonly ResponsePoint[] | null
}

export function assessMeasurementConvergence({
  ledger,
  aggregate,
  previousPoints,
}: MeasurementConvergenceInput): ConvergenceAssessment | null {
  const physical = projectPhysicalPositionLedger(ledger)
  if (physical.positions.filter((position) => position.left.kind === 'accepted' && position.right.kind === 'accepted').length < 3) {
    return null
  }
  const spread = aggregate?.spreadDb ?? []
  const currentPoints = aggregate?.points ?? []
  if (spread.length === 0) {
    return {
      sufficient: false,
      medianCorrectionChangeDb: null,
      p95CorrectionChangeDb: null,
      medianSpatialSpreadDb: null,
      lowFrequencySpreadDb: null,
      highConfidenceBandFraction: 0,
    }
  }
  const sorted = spread.map((point) => point.magnitudeDb).sort((left, right) => left - right)
  const percentile = (fraction: number): number | null => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))
    return sorted[index] ?? null
  }
  const lowFrequency = spread.filter((point) => point.frequencyHz <= 200).map((point) => point.magnitudeDb)
  const lowSorted = lowFrequency.sort((left, right) => left - right)
  const lowMedian = lowSorted.length === 0 ? null : lowSorted[Math.floor(lowSorted.length / 2)] ?? null
  const medianSpread = percentile(0.5)
  const p95Spread = percentile(0.95)
  const correctionChanges = previousPoints === null
    ? []
    : currentPoints.flatMap((point) => {
      const previous = previousPoints.find((candidate) => Math.abs(candidate.frequencyHz - point.frequencyHz) < 0.001)
      return previous ? [Math.abs(point.magnitudeDb - previous.magnitudeDb)] : []
    }).sort((left, right) => left - right)
  const correctionPercentile = (fraction: number): number | null => {
    if (correctionChanges.length === 0) return null
    const index = Math.min(correctionChanges.length - 1, Math.max(0, Math.round((correctionChanges.length - 1) * fraction)))
    return correctionChanges[index] ?? null
  }
  const medianCorrectionChangeDb = correctionPercentile(0.5)
  const p95CorrectionChangeDb = correctionPercentile(0.95)
  const highConfidenceBandFraction = spread.filter((point) => point.magnitudeDb <= 3).length / spread.length
  const correctionStable = medianCorrectionChangeDb !== null && (
    medianCorrectionChangeDb <= MAX_MEDIAN_CORRECTION_CHANGE_DB
    && (p95CorrectionChangeDb ?? Number.POSITIVE_INFINITY) <= MAX_P95_CORRECTION_CHANGE_DB
  )
  return {
    sufficient: medianSpread !== null
      && p95Spread !== null
      && (lowMedian === null || lowMedian <= 4)
      && medianSpread <= 3
      && p95Spread <= 6
      && correctionStable
      && highConfidenceBandFraction >= 0.5,
    medianCorrectionChangeDb,
    p95CorrectionChangeDb,
    medianSpatialSpreadDb: medianSpread,
    lowFrequencySpreadDb: lowMedian,
    highConfidenceBandFraction,
  }
}
