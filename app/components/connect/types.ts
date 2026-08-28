import type { AggregateResponse } from '~/lib/audio/measurement/aggregation'

export interface ConnectDebugLogEntry {
  at: number
  direction: 'in' | 'out'
  text: string
}

export interface ProbeCaptureEvidence {
  id: string
  mode: 'transfer' | 'routing'
  cutChannel: 'common' | 'left' | 'right' | 'flat'
  bandIndex: number
  gainDb: number
  qualityPassed: boolean
  capturedAt: string
  positionResponses: AggregateResponse['positionResponses']
  spatialConsistency: AggregateResponse['spatialConsistency']
}
