import type { MeasurementContext } from '#shared/types/protocol'
import type { MeasurementAnalysis, ResponsePoint } from './response'
import type { CalibrationPositionId } from '#shared/types/protocol'
import { MAX_REPEAT_COUNT, measurementGroupForContext, measurementGroupKey } from './plan'

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
  rejectedTakeIndex: number | null
  passed: boolean
  failureReason: 'insufficient_takes' | 'spread' | null
}

export interface PositionResponse {
  positionId: CalibrationPositionId
  positionIndex: number
  positionCount: number
  channel: MeasurementChannel
  points: ResponsePoint[]
  /** Relative broadband level in the recorder's arbitrary linear scale. */
  broadbandLevelDb: number | null
}

export interface AggregateResponse {
  channel: Exclude<MeasurementChannel, 'both'> | 'both'
  points: ResponsePoint[]
  spreadDb: ResponsePoint[]
  positionResponses: PositionResponse[]
  records: MeasurementRecord[]
  repeatability: RepeatabilitySummary[]
  failedGroups: RepeatabilitySummary[]
  /** Robust broadband level; never presented as calibrated SPL. */
  broadbandLevelDb: number | null
  /** Left minus right broadband level when both channels are combined. */
  relativeChannelLevelDb: number | null
}

export type AdaptiveTakeDecision =
  | { kind: 'not-eligible' }
  | { kind: 'no-third'; summary: RepeatabilitySummary }
  | { kind: 'schedule-third'; summary: RepeatabilitySummary }

export type InvalidTakeDecision =
  | { kind: 'retry'; nextAttempts: number }
  | { kind: 'terminal' }

export const MAX_INVALID_TAKE_RETRIES = 2

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

function broadbandLevelDb(record: MeasurementRecord): number | null {
  const signalRms = record.analysis.diagnostics.signalRms
  return signalRms > 0 && Number.isFinite(signalRms) ? 20 * Math.log10(signalRms) : null
}

function medianFinite(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
  return finite.length > 0 ? median(finite) : null
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
  return records.filter((record) => record.analysis.status === 'ok' && record.analysis.correctedPoints.length > 1)
}

function curveDistance(left: MeasurementRecord, right: MeasurementRecord, frequencies: readonly number[]): number {
  return median(frequencies.map((frequencyHz) => Math.abs(
    interpolateLog(left.analysis.correctedPoints, frequencyHz) - interpolateLog(right.analysis.correctedPoints, frequencyHz),
  )))
}

function acceptedThreeTakeRecords(
  records: readonly MeasurementRecord[],
  frequencies: readonly number[],
): { records: MeasurementRecord[]; rejectedTakeIndex: number | null } {
  if (records.length !== 3) return { records: [...records], rejectedTakeIndex: null }
  const pairs = [
    { first: 0, second: 1 },
    { first: 0, second: 2 },
    { first: 1, second: 2 },
  ].map((pair) => ({
    ...pair,
    distance: curveDistance(records[pair.first], records[pair.second], frequencies),
  })).sort((left, right) => left.distance - right.distance)
  const bestPair = pairs[0]
  if (!bestPair) return { records: [...records], rejectedTakeIndex: null }
  const rejectedIndex = [0, 1, 2].find((index) => index !== bestPair.first && index !== bestPair.second)
  if (rejectedIndex === undefined) return { records: [...records], rejectedTakeIndex: null }
  const rejectedRecord = records[rejectedIndex]
  const firstPairRecord = records[bestPair.first]
  const secondPairRecord = records[bestPair.second]
  if (!rejectedRecord || !firstPairRecord || !secondPairRecord) return { records: [...records], rejectedTakeIndex: null }
  const rejectedDistance = Math.min(
    curveDistance(rejectedRecord, firstPairRecord, frequencies),
    curveDistance(rejectedRecord, secondPairRecord, frequencies),
  )
  const pairIsStrong = bestPair.distance <= 1.5
  const thirdIsBroadOutlier = rejectedDistance >= 3 && rejectedDistance - bestPair.distance >= 1.5
  if (!pairIsStrong || !thirdIsBroadOutlier) return { records: [...records], rejectedTakeIndex: null }
  return {
    records: records.filter((_, index) => index !== rejectedIndex),
    rejectedTakeIndex: rejectedRecord.context.takeIndex,
  }
}

interface GroupAggregation {
  summary: RepeatabilitySummary
  positionResponse: PositionResponse | null
}

function summarizeGroup(records: readonly MeasurementRecord[]): GroupAggregation | null {
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
      summary: {
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
        rejectedTakeIndex: null,
        passed: false,
        failureReason: 'insufficient_takes',
      },
      positionResponse: null,
    }
  }

  const firstUsable = usable[0]
  if (!firstUsable) return null
  const frequencies = firstUsable.analysis.correctedPoints.map((point) => point.frequencyHz)
  const adjudicated = acceptedThreeTakeRecords(usable, frequencies)
  const spreads = frequencies.map((frequencyHz) => {
    const values = adjudicated.records.map((record) => interpolateLog(record.analysis.correctedPoints, frequencyHz))
    return Math.max(...values) - Math.min(...values)
  })
  const withinTwoDbFraction = spreads.filter((spread) => spread <= 2).length / Math.max(1, spreads.length)
  const passed = failedTakeIndices.length === 0 && median(spreads) <= 1.5 && withinTwoDbFraction >= 0.8
  const summary: RepeatabilitySummary = {
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
    rejectedTakeIndex: adjudicated.rejectedTakeIndex,
    passed,
    failureReason: failedTakeIndices.length > 0 ? 'insufficient_takes' : passed ? null : 'spread',
  }
  return {
    summary,
    positionResponse: {
      positionId: firstContext.positionId,
      positionIndex: firstContext.positionIndex,
      positionCount: firstContext.positionCount,
      channel: firstContext.channel,
      points: frequencies.map((frequencyHz) => ({
        frequencyHz,
        magnitudeDb: median(adjudicated.records.map((record) => interpolateLog(record.analysis.correctedPoints, frequencyHz))),
      })),
      broadbandLevelDb: medianFinite(adjudicated.records.map(broadbandLevelDb)),
    },
  }
}

export function calculateRepeatability(records: readonly MeasurementRecord[]): RepeatabilitySummary | null {
  return summarizeGroup(records)?.summary ?? null
}

export function decideAdaptiveTake(
  records: readonly MeasurementRecord[],
  context: MeasurementContext,
): AdaptiveTakeDecision {
  if (context.takeIndex !== 1) return { kind: 'not-eligible' }
  const key = measurementGroupKey(context)
  const groupRecords = records.filter((record) => measurementGroupKey(record.context) === key)
  if (groupRecords.some((record) => record.context.takeIndex >= MAX_REPEAT_COUNT - 1)) {
    return { kind: 'not-eligible' }
  }
  const summary = calculateRepeatability(groupRecords)
  if (!summary) return { kind: 'not-eligible' }
  return summary.passed
    ? { kind: 'no-third', summary }
    : { kind: 'schedule-third', summary }
}

export function decideInvalidTake(attempts: number): InvalidTakeDecision {
  return attempts < MAX_INVALID_TAKE_RETRIES
    ? { kind: 'retry', nextAttempts: attempts + 1 }
    : { kind: 'terminal' }
}

function combinePositionResponses(
  responses: readonly PositionResponse[],
  channel: MeasurementChannel,
): PositionResponse[] {
  const byPosition = new Map<string, PositionResponse[]>()
  for (const response of responses) {
    const existing = byPosition.get(response.positionId)
    if (existing) existing.push(response)
    else byPosition.set(response.positionId, [response])
  }
  return [...byPosition.values()]
    .filter((positionResponses) => {
      if (channel !== 'both') return true
      if (positionResponses.some((response) => response.channel === 'both')) {
        return positionResponses.some((response) => response.channel === 'both')
      }
      return positionResponses.length === 2
    })
    .map((positionResponses) => {
    const candidates = positionResponses.some((response) => response.channel === 'both')
      ? positionResponses.filter((response) => response.channel === 'both')
      : positionResponses
    const first = candidates[0]
    if (!first) throw new Error('Position response group cannot be empty.')
    const points = first.points.map((point) => ({
      frequencyHz: point.frequencyHz,
      magnitudeDb: median(candidates.map((response) => interpolateLog(response.points, point.frequencyHz))),
    }))
    return {
      positionId: first.positionId,
      positionIndex: first.positionIndex,
      positionCount: first.positionCount,
      channel,
      points,
      broadbandLevelDb: medianFinite(candidates.map((response) => response.broadbandLevelDb)),
    }
    })
}

function spatialAggregate(positionResponses: readonly PositionResponse[]): {
  points: ResponsePoint[]
  spreadDb: ResponsePoint[]
} {
  const frequencies = positionResponses[0]?.points.map((point) => point.frequencyHz) ?? []
  const points: ResponsePoint[] = []
  const spreadDb: ResponsePoint[] = []
  for (const frequencyHz of frequencies) {
    const values = positionResponses.map((response) => interpolateLog(response.points, frequencyHz))
    points.push({ frequencyHz, magnitudeDb: median(values) })
    spreadDb.push({ frequencyHz, magnitudeDb: Math.max(...values) - Math.min(...values) })
  }
  return { points, spreadDb }
}

export function aggregateResponse(
  records: readonly MeasurementRecord[],
  channel: MeasurementChannel | 'both',
): AggregateResponse | null {
  const filtered = records.filter((record) => channel === 'both' || record.context.channel === channel)
  if (filtered.length === 0) return null
  const groups = new Map<string, MeasurementRecord[]>()
  for (const record of filtered) {
    const group = measurementGroupForContext(record.context)
    const key = measurementGroupKey(group)
    const existing = groups.get(key)
    if (existing) existing.push(record)
    else groups.set(key, [record])
  }
  const groupAggregations = [...groups.values()]
    .map((group) => summarizeGroup(group))
    .filter((value): value is GroupAggregation => value !== null)
  const repeatability = groupAggregations.map((aggregation) => aggregation.summary)
  const groupedPositionResponses = groupAggregations
    .map((aggregation) => aggregation.positionResponse)
    .filter((value): value is PositionResponse => value !== null)
  const positionResponses = combinePositionResponses(groupedPositionResponses, channel)
  const spatial = spatialAggregate(positionResponses)
  return {
    channel,
    points: spatial.points,
    spreadDb: spatial.spreadDb,
    positionResponses,
    records: filtered,
    repeatability,
    failedGroups: repeatability.filter((summary) => !summary.passed),
    broadbandLevelDb: medianFinite(positionResponses.map((response) => response.broadbandLevelDb)),
    relativeChannelLevelDb: null,
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
