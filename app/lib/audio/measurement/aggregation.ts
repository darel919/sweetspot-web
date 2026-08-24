import type { MeasurementContext } from '#shared/types/protocol'
import type { MeasurementAnalysis, ResponsePoint } from './response'

// Keep the domain name local to this module; the shared protocol calls it CalibrationChannel.
export type MeasurementChannel = 'left' | 'right' | 'both'

export interface MeasurementRecord {
  context: MeasurementContext
  analysis: MeasurementAnalysis
}

export interface RepeatabilitySummary {
  takeCount: number
  medianSpreadDb: number
  maxSpreadDb: number
  withinTwoDbFraction: number
  passed: boolean
}

export interface AggregateResponse {
  channel: Exclude<MeasurementChannel, 'both'> | 'both'
  points: ResponsePoint[]
  spreadDb: ResponsePoint[]
  records: MeasurementRecord[]
  repeatability: RepeatabilitySummary[]
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

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

function validRecords(records: readonly MeasurementRecord[]): MeasurementRecord[] {
  return records.filter((record) => record.analysis.status === 'ok' && record.analysis.points.length > 1)
}

export function calculateRepeatability(records: readonly MeasurementRecord[]): RepeatabilitySummary | null {
  const usable = validRecords(records)
  if (usable.length < 2) return null
  const frequencies = usable[0].analysis.points.map((point) => point.frequencyHz)
  const spreads = frequencies.map((frequencyHz) => {
    const values = usable.map((record) => interpolateLog(record.analysis.points, frequencyHz))
    return Math.max(...values) - Math.min(...values)
  })
  const withinTwoDbFraction = spreads.filter((spread) => spread <= 2).length / Math.max(1, spreads.length)
  return {
    takeCount: usable.length,
    medianSpreadDb: median(spreads),
    maxSpreadDb: Math.max(...spreads),
    withinTwoDbFraction,
    // One isolated room/mic bin should not fail the whole run, but broad
    // disagreement must block automatic correction.
    passed: median(spreads) <= 1.5 && withinTwoDbFraction >= 0.8,
  }
}

export function aggregateResponse(
  records: readonly MeasurementRecord[],
  channel: MeasurementChannel | 'both',
): AggregateResponse | null {
  const filtered = validRecords(records).filter((record) => channel === 'both' || record.context.channel === channel)
  if (filtered.length === 0) return null
  const frequencies = filtered[0].analysis.points.map((point) => point.frequencyHz)
  const points: ResponsePoint[] = []
  const spreadDb: ResponsePoint[] = []
  for (const frequencyHz of frequencies) {
    const values = filtered.map((record) => interpolateLog(record.analysis.points, frequencyHz))
    points.push({ frequencyHz, magnitudeDb: median(values) })
    spreadDb.push({ frequencyHz, magnitudeDb: Math.max(...values) - Math.min(...values) })
  }
  const groupKeys = new Set(filtered.map((record) => `${record.context.positionId}:${record.context.channel}`))
  const repeatability = [...groupKeys].map((key) => {
    const [positionId, recordChannel] = key.split(':')
    return calculateRepeatability(filtered.filter((record) =>
      record.context.positionId === positionId && record.context.channel === recordChannel))
  }).filter((value): value is RepeatabilitySummary => value !== null)
  return {
    channel,
    points,
    spreadDb,
    records: filtered,
    repeatability,
  }
}

export function allRepeatabilityPassed(aggregate: AggregateResponse | null): boolean {
  return Boolean(aggregate && aggregate.repeatability.length > 0 && aggregate.repeatability.every((summary) => summary.passed))
}
