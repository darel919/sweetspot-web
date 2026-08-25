import type { CorrectionStrength } from '~/lib/audio/correction/optimizer'
import type { SharedLfAssessment } from '~/lib/audio/correction/shared-lf'
import type { CaptureTrackSettings } from '~/lib/audio/capture/microphone'
import type { AggregateResponse } from '~/lib/audio/measurement/aggregation'
import type { CalibrationPositionId } from '#shared/types/protocol'

export interface RecommendedCorrection {
  bandsDb: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
  independent: boolean
  maxCutDb: number
  maxBoostDb: number
  headroomDb: number
  lfExtension3DbHz?: number
  lfExtension6DbHz?: number
  lfExtensionConfidence?: number
  sharedLf?: {
    commonThroughHz: number
    independentFromHz: number
    assessment?: SharedLfAssessment
  }
}

export interface CalibrationCaptureInfo {
  settings: CaptureTrackSettings
  expectedSampleCount?: number
  expectedDurationMs?: number
}

export interface CalibrationValidationMetrics {
  before: number
  after: number
  objective: 'spatial'
  positionIds: CalibrationPositionId[]
}

export type CalibrationResultStatus = 'improved' | 'inconclusive' | 'worse' | 'cancelled' | 'error'

export interface CorrectionStrengthOption {
  id: Exclude<CorrectionStrength, 'off'>
  label: string
}

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
