import type { MeasurementContext } from '#shared/types/protocol'
import type { MeasurementAnalysis, ResponsePoint } from './response'
import type { CalibrationPositionId } from '#shared/types/protocol'
import { measurementGroupForContext, measurementGroupKey } from './plan'

// Keep the domain name local to this module; the shared protocol calls it CalibrationChannel.
export type MeasurementChannel = 'left' | 'right' | 'both'

export interface MeasurementRecord {
  context: MeasurementContext
  analysis: MeasurementAnalysis
}

export interface RepeatabilitySummary {
  positionId: CalibrationPositionId
  positionIndex: number
  positionCount: number
  channel: MeasurementChannel
  takeCount: number
  expectedTakeCount: number
  failedTakeIndices: readonly number[]
  medianSpreadDb: number
  maxSpreadDb: number
  withinTwoDbFraction: number
  passed: boolean
  failureReason: 'insufficient_takes' | 'spread' | null
}

export interface AggregateResponse {
  channel: Exclude<MeasurementChannel, 'both'> | 'both'
  points: ResponsePoint[]
  spreadDb: ResponsePoint[]
  records: MeasurementRecord[]
  repeatability: RepeatabilitySummary[]
  failedGroups: RepeatabilitySummary[]
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  const current = sorted[middle]
  if (current === undefined) return 0
  if (sorted.length % 2 !== 0) return current
  const previous = sorted[middle - 1]
  return previous === undefined ? current : (previous + current) / 2
}

function interpolateLog(points: readonly ResponsePoint[], frequencyHz: number): number {
  if (points.length === 0) return 0
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return 0
  if (frequencyHz <= first.frequencyHz) return first.magnitudeDb
  if (frequencyHz >= last.frequencyHz) return last.magnitudeDb
  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    const middlePoint = points[middle]
    if (!middlePoint || middlePoint.frequencyHz <= frequencyHz) low = middle
    else high = middle
  }
  const lower = points[low]
  const upper = points[high]
  if (!lower || !upper) return 0
  const position = Math.log(frequencyHz / lower.frequencyHz) / Math.log(upper.frequencyHz / lower.frequencyHz)
  return lower.magnitudeDb + (upper.magnitudeDb - lower.magnitudeDb) * position
}

function validRecords(records: readonly MeasurementRecord[]): MeasurementRecord[] {
  return records.filter((record) => record.analysis.status === 'ok' && record.analysis.points.length > 1)
}

function summarizeGroup(records: readonly MeasurementRecord[]): RepeatabilitySummary | null {
  if (records.length === 0) return null
  const usable = validRecords(records)
  const firstRecord = records[0]
  if (!firstRecord) return null
  const firstContext = firstRecord.context
  const expectedTakeCount = Math.max(
    1,
    ...records.map((record) => Math.max(record.context.takeCount, record.context.takeIndex + 1)),
  )
  const usableTakeIndices = new Set(usable.map((record) => record.context.takeIndex))
  const failedTakeIndices = Array.from({ length: expectedTakeCount }, (_, takeIndex) => takeIndex)
    .filter((takeIndex) => !usableTakeIndices.has(takeIndex))

  if (usable.length < 2) {
    return {
      positionId: firstContext.positionId,
      positionIndex: firstContext.positionIndex,
      positionCount: firstContext.positionCount,
      channel: firstContext.channel,
      takeCount: usable.length,
      expectedTakeCount,
      failedTakeIndices,
      medianSpreadDb: 0,
      maxSpreadDb: 0,
      withinTwoDbFraction: 0,
      passed: false,
      failureReason: 'insufficient_takes',
    }
  }

  const firstUsable = usable[0]
  if (!firstUsable) return null
  const frequencies = firstUsable.analysis.points.map((point) => point.frequencyHz)
  const spreads = frequencies.map((frequencyHz) => {
    const values = usable.map((record) => interpolateLog(record.analysis.points, frequencyHz))
    return Math.max(...values) - Math.min(...values)
  })
  const withinTwoDbFraction = spreads.filter((spread) => spread <= 2).length / Math.max(1, spreads.length)
  const passed = failedTakeIndices.length === 0 && median(spreads) <= 1.5 && withinTwoDbFraction >= 0.8
  return {
    positionId: firstContext.positionId,
    positionIndex: firstContext.positionIndex,
    positionCount: firstContext.positionCount,
    channel: firstContext.channel,
    takeCount: usable.length,
    expectedTakeCount,
    failedTakeIndices,
    medianSpreadDb: median(spreads),
    maxSpreadDb: Math.max(...spreads),
    withinTwoDbFraction,
    // One isolated room/mic bin should not fail the whole run, but broad
    // disagreement or a missing usable take must block correction.
    passed,
    failureReason: failedTakeIndices.length > 0 ? 'insufficient_takes' : passed ? null : 'spread',
  }
}

export function calculateRepeatability(records: readonly MeasurementRecord[]): RepeatabilitySummary | null {
  return summarizeGroup(records)
}

export function aggregateResponse(
  records: readonly MeasurementRecord[],
  channel: MeasurementChannel | 'both',
): AggregateResponse | null {
  const filtered = records.filter((record) => channel === 'both' || record.context.channel === channel)
  if (filtered.length === 0) return null
  const usable = validRecords(filtered)
  const frequencies = usable[0]?.analysis.points.map((point) => point.frequencyHz) ?? []
  const points: ResponsePoint[] = []
  const spreadDb: ResponsePoint[] = []
  for (const frequencyHz of frequencies) {
    const values = usable.map((record) => interpolateLog(record.analysis.points, frequencyHz))
    points.push({ frequencyHz, magnitudeDb: median(values) })
    spreadDb.push({ frequencyHz, magnitudeDb: Math.max(...values) - Math.min(...values) })
  }
  const groups = new Map<string, MeasurementRecord[]>()
  for (const record of filtered) {
    const group = measurementGroupForContext(record.context)
    if (!group) continue
    const key = measurementGroupKey(group)
    const existing = groups.get(key)
    if (existing) existing.push(record)
    else groups.set(key, [record])
  }
  const repeatability = [...groups.values()]
    .map((group) => summarizeGroup(group))
    .filter((value): value is RepeatabilitySummary => value !== null)
  return {
    channel,
    points,
    spreadDb,
    records: filtered,
    repeatability,
    failedGroups: repeatability.filter((summary) => !summary.passed),
  }
}

export function allRepeatabilityPassed(aggregate: AggregateResponse | null): boolean {
  const expectedGroups = aggregate?.repeatability.reduce(
    (count, summary) => Math.max(count, summary.positionCount),
    0,
  ) ?? 0
  return Boolean(
    aggregate
      && aggregate.points.length > 1
      && aggregate.repeatability.length > 0
      && aggregate.repeatability.length >= expectedGroups
      && aggregate.repeatability.every((summary) => summary.passed),
  )
}
