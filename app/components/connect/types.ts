import type { CorrectionStrength } from '~/lib/audio/correction/optimizer'
import type { CaptureTrackSettings } from '~/lib/audio/capture/microphone'

export interface RecommendedCorrection {
  bandsDb: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
  independent: boolean
  maxCutDb: number
  maxBoostDb: number
  headroomDb: number
}

export interface CalibrationCaptureInfo {
  settings: CaptureTrackSettings
}

export interface CalibrationValidationMetrics {
  before: number
  after: number
}

export interface CorrectionStrengthOption {
  id: Exclude<CorrectionStrength, 'off'>
  label: string
}

export interface ConnectDebugLogEntry {
  at: number
  direction: 'in' | 'out'
  text: string
}
