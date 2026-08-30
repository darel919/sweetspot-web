import { PROTOCOL_VERSION } from '#shared/types/protocol'
import type { MeasurementContext, MeasurementCaptureMetadata, MeasurementMarkerChannel, MeasurementSweep } from '#shared/types/protocol'
import type { CaptureSignalDiagnostics } from '../capture/pcm-recorder'
import type { MicCalibrationProfile } from '../mics/types'

const CALIBRATION_DEBUG_BUNDLE_SCHEMA_VERSION = 2 as const

export interface CalibrationDebugCapture {
  sessionId: string
  candidateId: string | null
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
  calibrationId: string
  sessionIds: readonly string[]
  validationSessionIds: readonly string[]
  tvAppVersion: string | null
  tvBuildId: string | null
  webBuildSha: string
  protocolVersion: typeof PROTOCOL_VERSION
  pairingAuthVersion: 'pairing-v1'
  analysisRevision: string
  sweepRevision: string
  markerChannel: MeasurementMarkerChannel
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
  calibrationId: string,
  captures: readonly CalibrationDebugCapture[],
  identity: {
    tvAppVersion: string | null
    tvBuildId: string | null
    webBuildSha: string
    protocolVersion: typeof PROTOCOL_VERSION
    pairingAuthVersion: 'pairing-v1'
    analysisRevision: string
    sweepRevision: string
    markerChannel: MeasurementMarkerChannel
  },
): CalibrationDebugBundle {
  return {
    schemaVersion: CALIBRATION_DEBUG_BUNDLE_SCHEMA_VERSION,
    calibrationId,
    sessionIds: [...new Set(captures.map((capture) => capture.sessionId))],
    validationSessionIds: [...new Set(captures.filter((capture) => capture.context.phase === 'validation').map((capture) => capture.sessionId))],
    ...identity,
    exportedAt: new Date().toISOString(),
    captures,
  }
}

function serializeCalibrationDebugBundle(bundle: CalibrationDebugBundle): string {
  return JSON.stringify(bundle)
}

export function createCalibrationDebugCapture(input: {
  sessionId: string
  candidateId: string | null
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
    sessionId: input.sessionId,
    candidateId: input.candidateId,
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
  anchor.download = `sweetspot-calibration-debug-${bundle.calibrationId}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
