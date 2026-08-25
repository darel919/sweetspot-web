import type { MeasurementContext, MeasurementCaptureMetadata, MeasurementSweep } from '#shared/types/protocol'
import type { CaptureSignalDiagnostics } from '../capture/pcm-recorder'
import type { MicCalibrationProfile } from '../mics/types'

export const CALIBRATION_DEBUG_BUNDLE_SCHEMA_VERSION = 1 as const

export interface CalibrationDebugCapture {
  context: MeasurementContext
  sampleRate: number
  channelCount: number
  startSample: number
  endSample: number
  sampleCount: number
  pcmFloat32Base64: string
  captureMetadata: MeasurementCaptureMetadata | null
  signalDiagnostics: CaptureSignalDiagnostics
  analysisStatus: string | null
  analysisDiagnostics: Record<string, unknown> | null
  responsePoints: Record<string, unknown> | null
  sweep: MeasurementSweep
  microphoneProfile: MicCalibrationProfile
  plannerState: Record<string, unknown>
  positionLedger: unknown
}

export interface CalibrationDebugBundle {
  schemaVersion: typeof CALIBRATION_DEBUG_BUNDLE_SCHEMA_VERSION
  sessionId: string
  tvAppVersion: string | null
  webBuildSha: string
  analysisRevision: string
  sweepRevision: string
  exportedAt: string
  captures: readonly CalibrationDebugCapture[]
}

function float32Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

export function createCalibrationDebugBundle(
  sessionId: string,
  captures: readonly CalibrationDebugCapture[],
  identity: {
    tvAppVersion: string | null
    webBuildSha: string
    analysisRevision: string
    sweepRevision: string
  },
): CalibrationDebugBundle {
  return {
    schemaVersion: CALIBRATION_DEBUG_BUNDLE_SCHEMA_VERSION,
    sessionId,
    ...identity,
    exportedAt: new Date().toISOString(),
    captures,
  }
}

export function serializeCalibrationDebugBundle(bundle: CalibrationDebugBundle): string {
  return JSON.stringify(bundle)
}

export function createCalibrationDebugCapture(input: {
  context: MeasurementContext
  samples: Float32Array
  sampleRate: number
  channelCount: number
  startSample: number
  endSample: number
  captureMetadata: MeasurementCaptureMetadata | null
  signalDiagnostics: CaptureSignalDiagnostics
  analysisStatus: string | null
  analysisDiagnostics: Record<string, unknown> | null
  responsePoints: Record<string, unknown> | null
  sweep: MeasurementSweep
  microphoneProfile: MicCalibrationProfile
  plannerState: Record<string, unknown>
  positionLedger: unknown
}): CalibrationDebugCapture {
  return {
    context: input.context,
    sampleRate: input.sampleRate,
    channelCount: input.channelCount,
    startSample: input.startSample,
    endSample: input.endSample,
    sampleCount: input.samples.length,
    pcmFloat32Base64: float32Base64(input.samples),
    captureMetadata: input.captureMetadata,
    signalDiagnostics: input.signalDiagnostics,
    analysisStatus: input.analysisStatus,
    analysisDiagnostics: input.analysisDiagnostics,
    responsePoints: input.responsePoints,
    sweep: input.sweep,
    microphoneProfile: input.microphoneProfile,
    plannerState: input.plannerState,
    positionLedger: input.positionLedger,
  }
}

export function downloadCalibrationDebugBundle(bundle: CalibrationDebugBundle): void {
  const blob = new Blob([serializeCalibrationDebugBundle(bundle)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `sweetspot-calibration-debug-${bundle.sessionId}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
