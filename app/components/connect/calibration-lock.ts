import type { CalibrationJobPhase } from '#shared/types/protocol'
import type { RemoteMicCaptureState } from '~/composables/calibration/useCalibrationRemoteMic'

const TERMINAL_PHASES: readonly CalibrationJobPhase[] = ['complete', 'failed', 'cancelled']

export function shouldLockCalibrationInteraction(
  phase: CalibrationJobPhase | undefined,
  captureState: RemoteMicCaptureState,
  measurementBusy: boolean,
  startPending: boolean,
): boolean {
  const remoteJobActive = phase !== undefined && !TERMINAL_PHASES.includes(phase)
  return startPending || remoteJobActive || captureState !== 'idle' || measurementBusy
}
