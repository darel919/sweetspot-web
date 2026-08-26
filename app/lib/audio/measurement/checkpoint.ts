import { isMeasurementContext, type MeasurementCaptureMetadata, type MeasurementContext } from '../../../../shared/types/protocol'
import type { PositionLedger } from './position-ledger'

export const CALIBRATION_CHECKPOINT_SCHEMA_VERSION = 3 as const
export const CALIBRATION_CHECKPOINT_ORIENTATION = 'iphone-upright-bottom-edge-to-tv' as const
export const CALIBRATION_CHECKPOINT_STORE = 'sweetspot-calibration-checkpoints'
const configuredBuildSha = import.meta.env.NUXT_PUBLIC_BUILD_SHA

export const CALIBRATION_ANALYSIS_REVISION = 'response-direct-arrival-v3' as const
export const CALIBRATION_SWEEP_REVISION = 'android-sweep-v1' as const
export const CALIBRATION_WEB_BUILD_SHA = configuredBuildSha || 'local'
export type CalibrationConvergenceOutcome = 'sufficient' | 'bounded' | 'insufficient'

export interface CalibrationCheckpointDevice {
  id: string
  appVersion: string
  buildId: string
}

export interface CalibrationCheckpointMicrophone {
  profileId: string
  sourceDate: string
  capturePathStatus: 'validated' | 'provisional' | 'unvalidated'
  sampleRate: number | null
}

export interface CalibrationCheckpoint {
  schemaVersion: typeof CALIBRATION_CHECKPOINT_SCHEMA_VERSION
  sessionId: string
  device: CalibrationCheckpointDevice
  microphone: CalibrationCheckpointMicrophone
  webBuildSha: string
  analysisRevision: typeof CALIBRATION_ANALYSIS_REVISION
  sweepRevision: typeof CALIBRATION_SWEEP_REVISION
  convergenceOutcome: CalibrationConvergenceOutcome | null
  orientation: typeof CALIBRATION_CHECKPOINT_ORIENTATION
  captureMetadata: MeasurementCaptureMetadata | null
  ledger: PositionLedger
  correctionState: {
    generated: boolean
    candidateId: string | null
  }
  validationStarted: boolean
  savedAt: number
}

export interface CalibrationCheckpointIdentity {
  deviceId: string
  appVersion: string
  buildId: string
  profileId: string
  profileSourceDate: string
  capturePathStatus: CalibrationCheckpointMicrophone['capturePathStatus']
  sampleRate: number | null
  webBuildSha: string
  analysisRevision: typeof CALIBRATION_ANALYSIS_REVISION
  sweepRevision: typeof CALIBRATION_SWEEP_REVISION
}

export type CalibrationCheckpointCompatibility =
  | { compatible: true }
  | {
      compatible: false
      reason: 'schema' | 'device' | 'device-build' | 'app-version' | 'web-build' | 'analysis-revision' | 'sweep-revision' | 'microphone-profile' | 'capture-path' | 'sample-rate' | 'orientation' | 'pending-transaction'
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isMeasurementCaptureMetadata(value: unknown): value is MeasurementCaptureMetadata {
  return isRecord(value)
    && isFiniteOrNull(value.sampleRate)
    && isFiniteOrNull(value.channelCount)
    && (value.echoCancellation === null || typeof value.echoCancellation === 'boolean')
    && (value.noiseSuppression === null || typeof value.noiseSuppression === 'boolean')
    && (value.autoGainControl === null || typeof value.autoGainControl === 'boolean')
    && Array.isArray(value.echoCancellationCapabilities)
    && value.echoCancellationCapabilities.every((entry) => typeof entry === 'boolean')
    && Array.isArray(value.noiseSuppressionCapabilities)
    && value.noiseSuppressionCapabilities.every((entry) => typeof entry === 'boolean')
    && Array.isArray(value.autoGainControlCapabilities)
    && value.autoGainControlCapabilities.every((entry) => typeof entry === 'boolean')
}

function isMeasurementAnalysis(value: unknown): boolean {
  if (!isRecord(value)) return false
  const statuses = ['ok', 'signal_too_low', 'direct_arrival_low_confidence', 'impulse_not_found', 'response_not_generated', 'sync_marker_not_found', 'clock_drift_unreliable', 'capture_too_short', 'capture_clipped']
  return typeof value.status === 'string'
    && statuses.includes(value.status)
    && Array.isArray(value.rawPoints)
    && Array.isArray(value.correctedPoints)
    && Array.isArray(value.displayPoints)
    && isRecord(value.micProfile)
    && typeof value.micProfile.id === 'string'
    && typeof value.micProfile.name === 'string'
    && isRecord(value.diagnostics)
    && typeof value.diagnostics.signalRms === 'number'
    && Number.isFinite(value.diagnostics.signalRms)
    && isFiniteOrNull(value.diagnostics.snrEstimateDb)
}

function isCaptureQuality(value: unknown): boolean {
  return isRecord(value)
    && (value.failureReason === null || typeof value.failureReason === 'string')
    && (value.failureClass === null || value.failureClass === 'systemic' || value.failureClass === 'local' || value.failureClass === 'spatial')
    && isFiniteOrNull(value.snrDb)
    && isFiniteOrNull(value.markerConfidence)
    && isFiniteOrNull(value.endingMarkerConfidence)
    && typeof value.clipped === 'boolean'
    && isFiniteOrNull(value.clockDriftPpm)
}

function isLedgerSubmeasurement(value: unknown): boolean {
  if (!isRecord(value)
    || (value.kind !== 'accepted' && value.kind !== 'rejected' && value.kind !== 'ignored')
    || typeof value.captureKey !== 'string'
    || (value.channel !== 'left' && value.channel !== 'right')
    || !isRecord(value.quality)
    || !isCaptureQuality(value.quality)) return false
  if (value.kind === 'ignored') return value.reason === 'sibling-already-accepted'
  return isMeasurementAnalysis(value.analysis)
}

function isCapturePathStatus(value: unknown): value is CalibrationCheckpointMicrophone['capturePathStatus'] {
  return value === 'validated' || value === 'provisional' || value === 'unvalidated'
}

function isCalibrationConvergenceOutcome(value: unknown): value is CalibrationConvergenceOutcome | null {
  return value === null || value === 'sufficient' || value === 'bounded' || value === 'insufficient'
}

function isCheckpointLedger(value: unknown): value is PositionLedger {
  return isRecord(value)
    && value.schemaVersion === 2
    && typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && Array.isArray(value.captures)
    && value.captures.every((capture) => isRecord(capture)
      && typeof capture.captureKey === 'string'
      && isMeasurementContext(capture.context)
      && isLedgerSubmeasurement(capture.left)
      && isLedgerSubmeasurement(capture.right)
      && (capture.captureMetadata === null || isMeasurementCaptureMetadata(capture.captureMetadata))
      && (capture.acceptedAt === null || (typeof capture.acceptedAt === 'number' && Number.isFinite(capture.acceptedAt))))
    && typeof value.systemicCenterFailures === 'number'
    && Number.isInteger(value.systemicCenterFailures)
    && value.systemicCenterFailures >= 0
}

/** Parse at the persistence boundary; raw microphone PCM is never part of this schema. */
export function parseCalibrationCheckpoint(value: unknown): CalibrationCheckpoint | null {
  if (!isRecord(value)
    || value.schemaVersion !== CALIBRATION_CHECKPOINT_SCHEMA_VERSION
    || typeof value.sessionId !== 'string'
    || value.sessionId.length === 0
    || !isRecord(value.device)
    || typeof value.device.id !== 'string'
    || value.device.id.length === 0
    || typeof value.device.appVersion !== 'string'
    || typeof value.device.buildId !== 'string'
    || value.device.buildId.length === 0
    || !isRecord(value.microphone)
    || typeof value.microphone.profileId !== 'string'
    || typeof value.microphone.sourceDate !== 'string'
    || !isCapturePathStatus(value.microphone.capturePathStatus)
    || !isFiniteOrNull(value.microphone.sampleRate)
    || typeof value.webBuildSha !== 'string'
    || value.webBuildSha.length === 0
    || value.analysisRevision !== CALIBRATION_ANALYSIS_REVISION
    || value.sweepRevision !== CALIBRATION_SWEEP_REVISION
    || !isCalibrationConvergenceOutcome(value.convergenceOutcome)
    || value.orientation !== CALIBRATION_CHECKPOINT_ORIENTATION
    || (value.captureMetadata !== null && !isMeasurementCaptureMetadata(value.captureMetadata))
    || !isCheckpointLedger(value.ledger)
    || !isRecord(value.correctionState)
    || typeof value.correctionState.generated !== 'boolean'
    || (value.correctionState.candidateId !== null && typeof value.correctionState.candidateId !== 'string')
    || typeof value.validationStarted !== 'boolean'
    || typeof value.savedAt !== 'number'
    || !Number.isFinite(value.savedAt)) return null

  return value as unknown as CalibrationCheckpoint
}

export function serializeCalibrationCheckpoint(checkpoint: CalibrationCheckpoint): string {
  return JSON.stringify(checkpoint)
}

export function parseSerializedCalibrationCheckpoint(value: string): CalibrationCheckpoint | null {
  try {
    return parseCalibrationCheckpoint(JSON.parse(value) as unknown)
  } catch {
    return null
  }
}

export function checkpointStoreKey(deviceId: string): string {
  return `device:${deviceId}`
}

export function createCalibrationCheckpoint(input: {
  sessionId: string
  device: CalibrationCheckpointDevice
  microphone: CalibrationCheckpointMicrophone
  webBuildSha?: string
  analysisRevision?: typeof CALIBRATION_ANALYSIS_REVISION
  sweepRevision?: typeof CALIBRATION_SWEEP_REVISION
  convergenceOutcome?: CalibrationConvergenceOutcome | null
  captureMetadata: MeasurementCaptureMetadata | null
  ledger: PositionLedger
  correctionState?: CalibrationCheckpoint['correctionState']
  validationStarted?: boolean
  savedAt?: number
}): CalibrationCheckpoint {
  return {
    schemaVersion: CALIBRATION_CHECKPOINT_SCHEMA_VERSION,
    sessionId: input.sessionId,
    device: { ...input.device },
    microphone: { ...input.microphone },
    webBuildSha: input.webBuildSha ?? CALIBRATION_WEB_BUILD_SHA,
    analysisRevision: input.analysisRevision ?? CALIBRATION_ANALYSIS_REVISION,
    sweepRevision: input.sweepRevision ?? CALIBRATION_SWEEP_REVISION,
    convergenceOutcome: input.convergenceOutcome ?? null,
    orientation: CALIBRATION_CHECKPOINT_ORIENTATION,
    captureMetadata: input.captureMetadata ? { ...input.captureMetadata } : null,
    ledger: input.ledger,
    correctionState: input.correctionState ?? { generated: false, candidateId: null },
    validationStarted: input.validationStarted ?? false,
    savedAt: input.savedAt ?? Date.now(),
  }
}

export function checkCalibrationCheckpointCompatibility(
  checkpoint: CalibrationCheckpoint,
  expected: CalibrationCheckpointIdentity,
  options: { requireSampleRate?: boolean } = {},
): CalibrationCheckpointCompatibility {
  if (checkpoint.schemaVersion !== CALIBRATION_CHECKPOINT_SCHEMA_VERSION) return { compatible: false, reason: 'schema' }
  if (checkpoint.orientation !== CALIBRATION_CHECKPOINT_ORIENTATION) return { compatible: false, reason: 'orientation' }
  if (checkpoint.validationStarted || checkpoint.correctionState.generated || checkpoint.correctionState.candidateId !== null) {
    return { compatible: false, reason: 'pending-transaction' }
  }
  if (checkpoint.device.id !== expected.deviceId) return { compatible: false, reason: 'device' }
  if (checkpoint.device.buildId !== expected.buildId) return { compatible: false, reason: 'device-build' }
  if (checkpoint.device.appVersion !== expected.appVersion) return { compatible: false, reason: 'app-version' }
  if (checkpoint.webBuildSha !== expected.webBuildSha) return { compatible: false, reason: 'web-build' }
  if (checkpoint.analysisRevision !== expected.analysisRevision) return { compatible: false, reason: 'analysis-revision' }
  if (checkpoint.sweepRevision !== expected.sweepRevision) return { compatible: false, reason: 'sweep-revision' }
  if (checkpoint.microphone.profileId !== expected.profileId || checkpoint.microphone.sourceDate !== expected.profileSourceDate) {
    return { compatible: false, reason: 'microphone-profile' }
  }
  if (checkpoint.microphone.capturePathStatus !== expected.capturePathStatus) return { compatible: false, reason: 'capture-path' }
  if (checkpoint.microphone.sampleRate !== null) {
    if (expected.sampleRate === null) {
      // Safari can expose track settings before AudioContext has established its rate.
      // The first resumed recording performs the strict comparison before playback.
    } else if (Math.abs(checkpoint.microphone.sampleRate - expected.sampleRate) > 1) {
      return { compatible: false, reason: 'sample-rate' }
    }
  }
  return { compatible: true }
}

interface StoredCheckpoint {
  key: string
  serialized: string
}

function openCheckpointDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'))
      return
    }
    const request = indexedDB.open(CALIBRATION_CHECKPOINT_STORE, 1)
    request.onerror = () => reject(request.error ?? new Error('Could not open calibration checkpoint storage.'))
    request.onupgradeneeded = () => {
      request.result.createObjectStore('sessions', { keyPath: 'key' })
    }
    request.onsuccess = () => resolve(request.result)
  })
}

export async function saveCalibrationCheckpoint(checkpoint: CalibrationCheckpoint): Promise<void> {
  const db = await openCheckpointDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite')
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save calibration checkpoint.'))
      transaction.oncomplete = () => resolve()
      transaction.objectStore('sessions').put({
        key: checkpointStoreKey(checkpoint.device.id),
        serialized: serializeCalibrationCheckpoint(checkpoint),
      } satisfies StoredCheckpoint)
    })
  } finally {
    db.close()
  }
}

export async function loadCalibrationCheckpoint(deviceId: string): Promise<CalibrationCheckpoint | null> {
  const db = await openCheckpointDb()
  try {
    const stored = await new Promise<StoredCheckpoint | undefined>((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readonly')
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not load calibration checkpoint.'))
      const request = transaction.objectStore('sessions').get(checkpointStoreKey(deviceId))
      request.onerror = () => reject(request.error ?? new Error('Could not load calibration checkpoint.'))
      request.onsuccess = () => resolve(request.result as StoredCheckpoint | undefined)
    })
    return stored ? parseSerializedCalibrationCheckpoint(stored.serialized) : null
  } finally {
    db.close()
  }
}

export async function clearCalibrationCheckpoint(deviceId: string): Promise<void> {
  const db = await openCheckpointDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('sessions', 'readwrite')
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear calibration checkpoint.'))
      transaction.oncomplete = () => resolve()
      transaction.objectStore('sessions').delete(checkpointStoreKey(deviceId))
    })
  } finally {
    db.close()
  }
}
