import type { CorrectionStrength } from '~/lib/audio/correction/optimizer'
import type { CaptureTrackSettings } from '~/lib/audio/capture/microphone'
import type { AggregateResponse } from '~/lib/audio/measurement/aggregation'

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
}

export interface CalibrationCaptureInfo {
  settings: CaptureTrackSettings
}

export interface CalibrationValidationMetrics {
  before: number
  after: number
}

export type CalibrationResultStatus = 'improved' | 'inconclusive' | 'worse' | 'error'

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
  repeatabilityPassed: boolean
  capturedAt: string
  positionResponses: AggregateResponse['positionResponses']
  repeatability: AggregateResponse['repeatability']
}
