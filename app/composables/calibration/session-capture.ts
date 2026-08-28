import type { MeasurementCaptureMetadata, MeasurementContext, MeasurementSweep } from '../../../shared/types/protocol'
import { compactMeasurementDiagnostics } from '../../lib/audio/measurement/compact-diagnostics'
import type { PcmRecording } from '../../lib/audio/capture/pcm-recorder'
import { createMeasurementDiagnostics, suppressRepairChannelDiagnostics } from '../../lib/audio/measurement/session-diagnostics'
import type { MeasurementAnalysis } from '../../lib/audio/measurement/response'
import type { MicCalibrationProfile } from '../../lib/audio/mics/types'
import type { CalibrationSessionDependencies, CalibrationTakeDiagnostics } from './session-types'

export interface CalibrationCaptureAnalysis {
  result: MeasurementAnalysis
  leftDiagnostics: CalibrationTakeDiagnostics['left']
  rightDiagnostics: CalibrationTakeDiagnostics['right']
  compactLeftDiagnostics: CalibrationTakeDiagnostics['left']
  compactRightDiagnostics: CalibrationTakeDiagnostics['right']
}

export async function analyzeCalibrationCapture(input: {
  recording: PcmRecording
  sampleRate: number
  sweep: MeasurementSweep
  profile: MicCalibrationProfile
  context: MeasurementContext
  captureMetadata: MeasurementCaptureMetadata | null
  repairChannel: MeasurementContext['repairChannel']
  analyzeInWorker: CalibrationSessionDependencies['analyzeInWorker']
  signal: AbortSignal
}): Promise<CalibrationCaptureAnalysis> {
  const result = await input.analyzeInWorker(
    input.recording.samples,
    input.sampleRate,
    input.sweep,
    input.profile,
    input.signal,
  )
  const leftDiagnostics = suppressRepairChannelDiagnostics(
    createMeasurementDiagnostics(result.left, 'left', result.detection, input.captureMetadata),
    input.repairChannel,
    'left',
  )
  const rightDiagnostics = suppressRepairChannelDiagnostics(
    createMeasurementDiagnostics(result.right, 'right', result.detection, input.captureMetadata),
    input.repairChannel,
    'right',
  )
  return {
    result,
    leftDiagnostics,
    rightDiagnostics,
    compactLeftDiagnostics: compactMeasurementDiagnostics(leftDiagnostics),
    compactRightDiagnostics: compactMeasurementDiagnostics(rightDiagnostics),
  }
}
