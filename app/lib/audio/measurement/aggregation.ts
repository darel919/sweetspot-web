import type { MeasurementContext } from '#shared/types/protocol'
import type { CalibrationPositionId } from '#shared/types/protocol'
import type { MeasurementAnalysis, ResponsePoint } from './response'

export type MeasurementChannel = 'left' | 'right' | 'both'
export type PositionChannel = Exclude<MeasurementChannel, 'both'>

export interface MeasurementRecord {
  context: MeasurementContext
  channel: PositionChannel
  analysis: MeasurementAnalysis
}

export interface RepeatabilitySummary {
  positionId: CalibrationPositionId
  positionIndex: number
  positionCount: number
  channel: MeasurementChannel
  captureCount: number
  expectedCaptureCount: 1
  failedAttemptIndices: readonly number[]
  medianSpreadDb: number | null
  maxSpreadDb: number | null
  withinTwoDbFraction: number | null
  passed: boolean
  failureReason: 'capture_rejected' | null
}

export interface PositionResponse {
  positionId: CalibrationPositionId
  positionIndex: number
  positionCount: number
  channel: MeasurementChannel
  points: ResponsePoint[]
  broadbandLevelDb: number | null
}

export interface AggregateResponse {
  channel: MeasurementChannel
  points: ResponsePoint[]
  spreadDb: ResponsePoint[]
  positionResponses: PositionResponse[]
  records: MeasurementRecord[]
  spatialConsistency: RepeatabilitySummary[]
  failedGroups: RepeatabilitySummary[]
  broadbandLevelDb: number | null
  relativeChannelLevelDb: number | null
}

function median(values: readonly number[]): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  const current = sorted[middle]
  if (current === undefined) return null
  if (sorted.length % 2 !== 0) return current
  const previous = sorted[middle - 1]
  return previous === undefined ? current : (previous + current) / 2
}

function interpolateLog(points: readonly ResponsePoint[], frequencyHz: number): number | null {
  if (points.length === 0) return null
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return null
  if (frequencyHz <= first.frequencyHz) return first.magnitudeDb
  if (frequencyHz >= last.frequencyHz) return last.magnitudeDb
  let low = 0
  let high = points.length - 1
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    const point = points[middle]
    if (!point || point.frequencyHz <= frequencyHz) low = middle
    else high = middle
  }
  const lower = points[low]
  const upper = points[high]
  if (!lower || !upper || !(upper.frequencyHz > lower.frequencyHz)) return null
  const position = Math.log(frequencyHz / lower.frequencyHz) / Math.log(upper.frequencyHz / lower.frequencyHz)
  return lower.magnitudeDb + (upper.magnitudeDb - lower.magnitudeDb) * position
}

function validRecords(records: readonly MeasurementRecord[]): MeasurementRecord[] {
  return records.filter((record) => record.analysis.status === 'ok' && record.analysis.correctedPoints.length > 1)
}

function broadbandLevelDb(record: MeasurementRecord): number | null {
  const rms = record.analysis.diagnostics.signalRms
  return rms > 0 && Number.isFinite(rms) ? 20 * Math.log10(rms) : null
}

function summarizePosition(records: readonly MeasurementRecord[]): {
  summary: RepeatabilitySummary
  response: PositionResponse | null
} {
  const first = records[0]
  if (!first) throw new Error('Position capture group cannot be empty.')
  const usable = validRecords(records)
  const summary: RepeatabilitySummary = {
    positionId: first.context.positionId,
    positionIndex: first.context.positionIndex,
    positionCount: first.context.positionCount,
    channel: first.channel,
    captureCount: usable.length,
    expectedCaptureCount: 1,
    failedAttemptIndices: usable.length > 0 ? [] : [first.context.attemptIndex],
    medianSpreadDb: null,
    maxSpreadDb: null,
    withinTwoDbFraction: null,
    passed: usable.length > 0,
    failureReason: usable.length > 0 ? null : 'capture_rejected',
  }
  const firstUsable = usable[0]
  if (!firstUsable) return { summary, response: null }
  const frequencies = firstUsable.analysis.correctedPoints.map((point) => point.frequencyHz)
  const spread = frequencies.map((frequencyHz) => {
    const values = usable.flatMap((record) => {
      const value = interpolateLog(record.analysis.correctedPoints, frequencyHz)
      return value === null ? [] : [value]
    })
    return values.length > 1 ? Math.max(...values) - Math.min(...values) : 0
  })
  const medianSpreadDb = median(spread)
  const maxSpreadDb = spread.length > 0 ? Math.max(...spread) : null
  const withinTwoDbFraction = spread.length > 0 ? spread.filter((value) => value <= 2).length / spread.length : null
  const response: PositionResponse = {
    positionId: first.context.positionId,
    positionIndex: first.context.positionIndex,
    positionCount: first.context.positionCount,
    channel: first.channel,
    points: frequencies.map((frequencyHz) => ({
      frequencyHz,
      magnitudeDb: median(usable.flatMap((record) => {
        const value = interpolateLog(record.analysis.correctedPoints, frequencyHz)
        return value === null ? [] : [value]
      })) ?? 0,
    })),
    broadbandLevelDb: median(usable.map(broadbandLevelDb).filter((value): value is number => value !== null)),
  }
  return {
    summary: {
      ...summary,
      medianSpreadDb,
      maxSpreadDb,
      withinTwoDbFraction,
    },
    response,
  }
}

export function calculateRepeatability(records: readonly MeasurementRecord[]): RepeatabilitySummary | null {
  if (records.length === 0) return null
  return summarizePosition(records).summary
}

function aggregatePositions(records: readonly MeasurementRecord[], channel: PositionChannel): {
  summaries: RepeatabilitySummary[]
  responses: PositionResponse[]
} {
  const groups = new Map<string, MeasurementRecord[]>()
  for (const record of records) {
    if (record.channel !== channel) continue
    const key = record.context.positionId
    const existing = groups.get(key)
    if (existing) existing.push(record)
    else groups.set(key, [record])
  }
  const values = [...groups.values()].map(summarizePosition)
  return {
    summaries: values.map((value) => value.summary),
    responses: values.flatMap((value) => value.response ? [value.response] : []),
  }
}

function combineBothChannels(
  records: readonly MeasurementRecord[],
  left: readonly PositionResponse[],
  right: readonly PositionResponse[],
): PositionResponse[] {
  const rightByPosition = new Map(right.map((response) => [response.positionId, response]))
  return left.flatMap((leftResponse) => {
    const rightResponse = rightByPosition.get(leftResponse.positionId)
    if (!rightResponse) return []
    return [{
      positionId: leftResponse.positionId,
      positionIndex: leftResponse.positionIndex,
      positionCount: leftResponse.positionCount,
      channel: 'both' as const,
      points: leftResponse.points.map((point, index) => ({
        frequencyHz: point.frequencyHz,
        magnitudeDb: (point.magnitudeDb + (rightResponse.points[index]?.magnitudeDb ?? point.magnitudeDb)) / 2,
      })),
      broadbandLevelDb: leftResponse.broadbandLevelDb !== null && rightResponse.broadbandLevelDb !== null
        ? (leftResponse.broadbandLevelDb + rightResponse.broadbandLevelDb) / 2
        : null,
    }]
  }).sort((leftResponse, rightResponse) => leftResponse.positionIndex - rightResponse.positionIndex)
}

function spatialAggregate(positionResponses: readonly PositionResponse[]): {
  points: ResponsePoint[]
  spreadDb: ResponsePoint[]
} {
  const frequencies = positionResponses[0]?.points.map((point) => point.frequencyHz) ?? []
  return {
    points: frequencies.map((frequencyHz) => {
      const values = positionResponses.flatMap((response) => {
        const value = interpolateLog(response.points, frequencyHz)
        return value === null ? [] : [value]
      })
      return { frequencyHz, magnitudeDb: median(values) ?? 0 }
    }),
    spreadDb: frequencies.map((frequencyHz) => {
      const values = positionResponses.flatMap((response) => {
        const value = interpolateLog(response.points, frequencyHz)
        return value === null ? [] : [value]
      })
      return { frequencyHz, magnitudeDb: values.length > 1 ? Math.max(...values) - Math.min(...values) : 0 }
    }),
  }
}

export function aggregateResponse(
  records: readonly MeasurementRecord[],
  channel: MeasurementChannel,
): AggregateResponse | null {
  if (records.length === 0) return null
  const left = aggregatePositions(records, 'left')
  const right = aggregatePositions(records, 'right')
  const positionResponses = channel === 'left'
    ? left.responses
    : channel === 'right'
      ? right.responses
      : combineBothChannels(records, left.responses, right.responses)
  const spatial = spatialAggregate(positionResponses)
  const summaries = channel === 'left' ? left.summaries : channel === 'right' ? right.summaries : [...left.summaries, ...right.summaries]
  const leftLevel = median(left.responses.map((response) => response.broadbandLevelDb).filter((value): value is number => value !== null))
  const rightLevel = median(right.responses.map((response) => response.broadbandLevelDb).filter((value): value is number => value !== null))
  return {
    channel,
    points: spatial.points,
    spreadDb: spatial.spreadDb,
    positionResponses,
    records: records.filter((record) => channel === 'both' || record.channel === channel),
    spatialConsistency: summaries,
    failedGroups: summaries.filter((summary) => !summary.passed),
    broadbandLevelDb: median(positionResponses.map((response) => response.broadbandLevelDb).filter((value): value is number => value !== null)),
    relativeChannelLevelDb: channel === 'both' && leftLevel !== null && rightLevel !== null ? leftLevel - rightLevel : null,
  }
}

export function allCaptureQualityPassed(aggregate: AggregateResponse | null): boolean {
  return Boolean(
    aggregate
      && aggregate.points.length > 1
      && aggregate.spatialConsistency.length > 0
      && aggregate.spatialConsistency.every((summary) => summary.passed),
  )
}
