import type {
  CalibrationErrorCode,
  Envelope,
  MeasurementCaptureKind,
  MeasurementContext,
  MeasurementDiagnosticsValues,
} from '../../../shared/types/protocol'
import {
  CALIBRATION_ERROR_CODES,
  isMarkerDiagnosticCaptureKind,
} from '../../../shared/types/protocol'
import { openMicrophone, closeMicrophone } from '../../lib/audio/capture/microphone'
import { createPcmRecorder, type CaptureSignalDiagnostics } from '../../lib/audio/capture/pcm-recorder'
import { analyzeInWorker } from '../../lib/audio/measurement/worker-client'
import type { MeasurementAnalysis } from '../../lib/audio/measurement/response'
import type { ProbePlanKind } from '../../lib/audio/measurement/plan'
import {
  clearCalibrationCheckpoint,
  loadCalibrationCheckpoint,
  saveCalibrationCheckpoint,
} from '../../lib/audio/measurement/checkpoint'
import { downloadCalibrationDebugBundle } from '../../lib/audio/measurement/debug-bundle'
import { discoverMicCalibrationProfiles } from '../../lib/audio/mics/registry'

export type CalibrationSessionConnection = {
  send: (type: string, payload?: unknown) => string
  onMessage: (handler: (env: Envelope) => void) => () => void
  isDeviceOnline: () => boolean
}

export interface CalibrationSessionDependencies {
  openMicrophone: typeof openMicrophone
  closeMicrophone: typeof closeMicrophone
  createPcmRecorder: typeof createPcmRecorder
  analyzeInWorker: typeof analyzeInWorker
  discoverMicCalibrationProfiles: typeof discoverMicCalibrationProfiles
  loadCalibrationCheckpoint: typeof loadCalibrationCheckpoint
  saveCalibrationCheckpoint: typeof saveCalibrationCheckpoint
  clearCalibrationCheckpoint: typeof clearCalibrationCheckpoint
  downloadCalibrationDebugBundle: typeof downloadCalibrationDebugBundle
}

export interface CalibrationSessionOptions {
  getDeviceIdentity?: () => { id: string; appVersion: string; buildId: string } | null
  debugCaptureExport?: boolean
  dependencies?: Partial<CalibrationSessionDependencies>
}

export type CalibrationStage =
  | 'idle'
  | 'requesting-microphone'
  | 'preparing'
  | 'loudness'
  | 'position-pause'
  | 'recording'
  | 'analyzing'
  | 'ending'
  | 'complete'
  | 'error'

export const CALIBRATION_ACTIVE_STAGES: readonly CalibrationStage[] = [
  'requesting-microphone',
  'preparing',
  'loudness',
  'position-pause',
  'recording',
  'analyzing',
  'ending',
]

export interface CalibrationTakeDiagnostics {
  context: MeasurementContext
  capture: CaptureSignalDiagnostics
  left: MeasurementDiagnosticsValues
  right: MeasurementDiagnosticsValues
}

export function isCalibrationActiveStage(stage: CalibrationStage): boolean {
  return CALIBRATION_ACTIVE_STAGES.includes(stage)
}

export function newSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.()
  return `cal_${random ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`}`
}

export function analysisErrorCode(status: MeasurementAnalysis['status']): CalibrationErrorCode {
  if (status === 'capture_clipped') return 'capture_clipped'

  if (status === 'direct_arrival_low_confidence') return 'direct_arrival_low_confidence'
  if (status === 'impulse_not_found') return 'impulse_not_found'
  if (status === 'response_not_generated') return 'response_not_generated'
  if (status === 'sync_marker_not_found') return 'sync_marker_not_found'
  if (status === 'clock_drift_unreliable') return 'clock_drift_unreliable'
  if (status === 'capture_too_short') return 'capture_too_short'
  return 'signal_too_low'
}

export function errorCode(value: unknown): CalibrationErrorCode {
  for (const code of CALIBRATION_ERROR_CODES) {
    if (value === code) return code
  }
  return 'invalid_session'
}

export function isUserCancellationCode(code: CalibrationErrorCode): boolean {
  return code === 'calibration_aborted' || code === 'calibration_ui_closed'
}

export function isMarkerProbePlan(kind: ProbePlanKind | null): boolean {
  if (kind === null) return false
  const captureKind: MeasurementCaptureKind = kind === 'transfer' || kind === 'routing'
    ? 'position-composite'
    : kind
  return isMarkerDiagnosticCaptureKind(captureKind)
}
