export const PROTOCOL_VERSION = 1 as const

export const MAX_PAYLOAD_BYTES = 16 * 1024

export type Role = 'device' | 'client'

export interface Envelope<P = unknown> {
  v: typeof PROTOCOL_VERSION
  id: string
  type: string
  ts: number
  payload: P
  replyTo?: string
  expiresAt?: number
}

export function normalizePairCode(code: string): string {
  return code.replaceAll('-', '').trim().toUpperCase()
}

export const PAIR_CODE_PATTERN = /^[A-Z0-9]{6,10}$/

export function isValidPairCode(code: string): boolean {
  return PAIR_CODE_PATTERN.test(normalizePairCode(code))
}

export function pairRoom(code: string): string {
  return `pair:${normalizePairCode(code)}`
}

export interface HelloPayload {
  role: Role
  room: string
}

export interface WelcomePayload {
  room: string
  peers: { deviceOnline: boolean; clients: number }
}

export interface PeerEventPayload {
  role: Role
}

export interface ErrorPayload {
  code:
    | 'bad_envelope'
    | 'version_mismatch'
    | 'unknown_type'
    | 'payload_too_large'
    | 'rate_limited'
    | 'not_in_room'
    | 'internal'
  message?: string
}

export interface DeviceInfo {
  id: string
  name: string
  appVersion: string
}

export interface EngineState {
  enabled: boolean
  hasControl: boolean
  activePreset: number
  presetName: string
}

export interface UserEqState {
  bandsDb: number[]
  frequenciesHz: number[]
  minDb: number
  maxDb: number
}

export interface CalibrationState {
  active: boolean
  bandsDb: number[]
  frequenciesHz: number[]
  requestedBandsDb?: number[]
  effectiveBandsDb?: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
  requestedLeftBandsDb?: number[]
  requestedRightBandsDb?: number[]
  effectiveLeftBandsDb?: number[]
  effectiveRightBandsDb?: number[]
  independent?: boolean
  headroomDb?: number
  headroomVerified?: boolean
  applicationVerified?: boolean
  applicationError?: string | null
  inputAttenuationDb?: number
  liveDspStatus?: 'verified' | 'degraded'
  transaction: CalibrationTransaction
}

export type CalibrationValidationStatus = 'pending' | 'rolling_back' | 'passed' | 'worse' | 'inconclusive' | 'failed'

export const CALIBRATION_VALIDATION_WORSE_TOLERANCE_DB = 0.5

export type CalibrationTransaction =
  | { state: 'none' }
  | {
      state: 'candidate_pending'
      candidateId: string
      validationStatus: CalibrationValidationStatus
      beforeDb: number | null
      afterDb: number | null
      reason: string | null
    }

export interface PresetOption {
  id: number
  name: string
}

export interface OkReply {
  ok: boolean
  error?: string
}

export interface ProfileListPayload {
  profiles: Array<{ id: string; name: string }>
}

export interface CalibrationCurvePayload extends CalibrationState {}

export interface ProbeResultEntry {
  requested: number
  constructed: boolean
  hasControl: boolean
  enabled: boolean
  actualBands: number
  pass: boolean
  exception?: string | null
}

export interface CurveSummary {
  bandsTotal: number
  bandsCut: number
  bandsFlat: number
}

export interface PersistentProbeState {
  active: boolean
  bands: number
  curve?: string | null
  curveSummary?: CurveSummary | null
  leftCurveSummary?: CurveSummary | null
  rightCurveSummary?: CurveSummary | null
}

export type CalibrationChannel = 'both' | 'left' | 'right'

export type CalibrationPositionId = 'center' | 'left' | 'right' | 'forward' | 'backward'

export type MeasurementPhase = 'measurement' | 'validation'

export type CalibrationProgressStage =
  | 'loudness'
  | 'preparing'
  | 'recording'
  | 'analyzing'
  | 'position-pause'
  | 'validation'
  | 'ending'

export interface MeasurementContext {
  positionId: CalibrationPositionId
  positionIndex: number
  positionCount: number
  channel: CalibrationChannel
  takeIndex: number
  takeCount: number
  phase: MeasurementPhase
}

export const CALIBRATION_ERROR_CODES = [
  'audio_focus_denied',
  'audio_focus_lost',
  'calibration_ui_failed',
  'calibration_ui_closed',
  'measurement_timeout',
  'sweep_playback_failed',
  'invalid_session',
  'already_measuring',
  'capture_clipped',
  'capture_too_short',
  'sweep_not_found',
  'sync_marker_not_found',
  'clock_drift_unreliable',
  'signal_too_low',
  'measurement_unstable',
  'dsp_state_unverified',
  'dsp_restore_failed',
  'calibration_aborted',
] as const

export type CalibrationErrorCode = (typeof CALIBRATION_ERROR_CODES)[number]

export interface CalibrationSessionPayload {
  sessionId: string
  channel?: CalibrationChannel
  phase?: MeasurementPhase
}

export interface CalibrationSessionBeginPayload extends CalibrationSessionPayload {
  channel: CalibrationChannel
  phase?: MeasurementPhase
  candidateId?: string
}

export interface CalibrationSessionEndPayload extends CalibrationSessionPayload {}

export interface CalibrationSessionAbortPayload extends CalibrationSessionPayload {
  code?: CalibrationErrorCode
  message?: string
}

export interface CalibrationSessionProgressPayload extends CalibrationSessionPayload {
  stage: CalibrationProgressStage
  current: number
  total: number
  estimatedRemainingSeconds?: number
  message?: string
}

export interface CalibrationLoudnessStartedPayload extends CalibrationSessionPayload {
  sampleRate: number
  levelDbfs: number
  loopDurationMs: number
}

export interface CalibrationLoudnessStoppedPayload extends CalibrationSessionPayload {}

export interface MeasurementSweep {
  algorithm: 'exponential-sine-v1'
  sampleRate: number
  startHz: number
  endHz: number
  durationMs: number
  preRollMs: number
  postRollMs: number
  syncMarkerStartHz: number
  syncMarkerEndHz: number
  syncMarkerDurationMs: number
  syncMarkerGapMs: number
  levelDbfs: number
  fadeInMs: number
  fadeOutMs: number
}

export interface MeasurementPreparePayload extends CalibrationSessionPayload {
  channel: CalibrationChannel
  context?: MeasurementContext
}

export interface MeasurementPlaySweepPayload extends CalibrationSessionPayload {
  context?: MeasurementContext
}

export interface MeasurementAbortPayload extends CalibrationSessionPayload {}

export interface MeasurementReadyPayload extends CalibrationSessionPayload {
  sweep: MeasurementSweep
  context?: MeasurementContext
}

export interface MeasurementStartedPayload extends CalibrationSessionPayload {
  sweep: MeasurementSweep
  context?: MeasurementContext
}

export interface MeasurementFinishedPayload extends CalibrationSessionPayload {
  context?: MeasurementContext
}

export interface MeasurementErrorPayload extends CalibrationSessionPayload {
  code: CalibrationErrorCode
  message?: string
}

export interface MeasurementDiagnosticsValues {
  analysisStatus?: 'ok' | 'signal_too_low' | 'sweep_not_found' | 'sync_marker_not_found' | 'clock_drift_unreliable' | 'capture_too_short' | 'capture_clipped'
  failureReason?: string | null
  signalRms: number
  signalPeak: number
  snrEstimateDb: number | null
  detectionOffsetMs: number | null
  envelopeOnlyOffsetMs?: number | null
  syncMarkerConfidence: number
  endingMarkerConfidence: number
  clockDriftPpm: number | null
  clipped: boolean
  clippedSamples: number
  directArrivalMs: number | null
  directToLateDb: number | null
  c50Db: number | null
  c80Db: number | null
  edtMs: number | null
  t20Ms: number | null
  t30Ms: number | null
  earlyReflections: number
  decayConfidence: 'high' | 'medium' | 'low'
  captureMetadata?: MeasurementCaptureMetadata
}

export interface MeasurementCaptureMetadata {
  sampleRate: number | null
  channelCount: number | null
  echoCancellation: boolean | null
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
  sampleRateRange: { min: number; max: number } | null
  channelCountRange: { min: number; max: number } | null
  echoCancellationCapabilities: boolean[]
  noiseSuppressionCapabilities: boolean[]
  autoGainControlCapabilities: boolean[]
  browserUserAgent?: string
  micProfileId?: string
  micProfileSourceDate?: string
  micProfileCapturePathStatus?: 'validated' | 'provisional' | 'unvalidated'
  trackSampleRate?: number | null
  trackChannelCount?: number | null
}

export interface MeasurementDiagnosticsPayload extends CalibrationSessionPayload {
  context: MeasurementContext
  current: number
  total: number
  diagnostics: MeasurementDiagnosticsValues
}

export interface MeasurementResponseChannel {
  frequenciesHz: number[]
  magnitudesDb: number[]
}

export interface MeasurementResponsePayload extends CalibrationSessionPayload {
  current: number
  total: number
  left: MeasurementResponseChannel | null
  right: MeasurementResponseChannel | null
}

/** Reply to probe.run / probe.status: DynamicsProcessing capacity + persistent instance state. */
export interface ProbeDiagnostics {
  running: boolean
  available: boolean
  results: ProbeResultEntry[]
  highest: number
  recommended: number
  persistent?: PersistentProbeState
}

export interface DeviceInfoPayload {
  javaHeapMax: number
  javaHeapTotal: number
  javaHeapFree: number
  nativeHeapAllocated: number
  nativeHeapSize: number
  pssTotalKb: number
  privateDirtyKb: number
  cpuPercent: number
  audioserverCpuPercent: number
  audioserverPid: number | null
  persistentProbeActive: boolean
  persistentProbeBands: number
}

export interface DeviceCapabilities {
  channels: number
  calibrationBandCount: number
  userBandCount: number
  supportsSweep: boolean
  supportsIndependentCalibration: boolean
  supportsCalibratedCorrection: boolean
  supportsHeadroomCompensation: boolean
  presets: PresetOption[]
}

export interface EffectInventoryEntry {
  name: string
  typeName: string
  typeUuid: string
  implUuid: string
  connectMode: string
  isVendor: boolean
}

export interface SessionProbe {
  effectType: string
  constructed: boolean
  hasControl: boolean
  enabled: boolean
  parameters: string
  exception?: string | null
}

export interface EffectsDiagnostics {
  inventory: EffectInventoryEntry[]
  sessionProbes: SessionProbe[]
  error?: string
}

export interface StateSnapshot {
  device: DeviceInfo
  engine: EngineState
  userEq: UserEqState
  calibration: CalibrationState
  profiles: Array<{ id: string; name: string }>
  capabilities: DeviceCapabilities
}

export interface StateGetPayload {}

function isCalibrationTransaction(value: unknown): value is CalibrationTransaction {
  if (!isRecord(value)) return false
  if (value.state === 'none') return true
  return value.state === 'candidate_pending'
    && isCandidateId(value.candidateId)
    && (value.validationStatus === 'pending'
      || value.validationStatus === 'rolling_back'
      || value.validationStatus === 'passed'
      || value.validationStatus === 'worse'
      || value.validationStatus === 'inconclusive'
      || value.validationStatus === 'failed')
    && isNullableFiniteNumber(value.beforeDb)
    && isNullableFiniteNumber(value.afterDb)
    && (value.reason === null || typeof value.reason === 'string')
}

function isPresetOption(value: unknown): value is PresetOption {
  return isRecord(value)
    && isInteger(value.id)
    && typeof value.name === 'string'
    && value.name.length <= 128
}

export function isStateSnapshot(value: unknown): value is StateSnapshot {
  if (!isRecord(value)
    || !isRecord(value.device)
    || !isRecord(value.engine)
    || !isRecord(value.userEq)
    || !isRecord(value.calibration)
    || !Array.isArray(value.profiles)
    || !isRecord(value.capabilities)
  ) return false
  const device = value.device
  const engine = value.engine
  const userEq = value.userEq
  const calibration = value.calibration
  const capabilities = value.capabilities
  const userBands = Array.isArray(userEq.bandsDb) && userEq.bandsDb.every(isFiniteNumber)
  const userFrequencies = Array.isArray(userEq.frequenciesHz) && userEq.frequenciesHz.every(isFiniteNumber)
  const calibrationArrays = isDbArray(calibration.bandsDb)
    && Array.isArray(calibration.frequenciesHz)
    && calibration.frequenciesHz.length === 64
    && calibration.frequenciesHz.every(isFiniteNumber)
    && (calibration.requestedBandsDb === undefined || isDbArray(calibration.requestedBandsDb))
    && (calibration.effectiveBandsDb === undefined || isDbArray(calibration.effectiveBandsDb))
    && (calibration.leftBandsDb === undefined || isDbArray(calibration.leftBandsDb))
    && (calibration.rightBandsDb === undefined || isDbArray(calibration.rightBandsDb))
    && (calibration.requestedLeftBandsDb === undefined || isDbArray(calibration.requestedLeftBandsDb))
    && (calibration.requestedRightBandsDb === undefined || isDbArray(calibration.requestedRightBandsDb))
    && (calibration.effectiveLeftBandsDb === undefined || isDbArray(calibration.effectiveLeftBandsDb))
    && (calibration.effectiveRightBandsDb === undefined || isDbArray(calibration.effectiveRightBandsDb))
  return typeof device.id === 'string'
    && typeof device.name === 'string'
    && typeof device.appVersion === 'string'
    && typeof engine.enabled === 'boolean'
    && typeof engine.hasControl === 'boolean'
    && isInteger(engine.activePreset)
    && typeof engine.presetName === 'string'
    && userBands
    && userFrequencies
    && userEq.bandsDb.length === userEq.frequenciesHz.length
    && isFiniteNumber(userEq.minDb)
    && isFiniteNumber(userEq.maxDb)
    && userEq.minDb <= userEq.maxDb
    && typeof calibration.active === 'boolean'
    && calibrationArrays
    && (calibration.independent === undefined || typeof calibration.independent === 'boolean')
    && (calibration.headroomDb === undefined || isFiniteNumber(calibration.headroomDb))
    && (calibration.headroomVerified === undefined || typeof calibration.headroomVerified === 'boolean')
    && (calibration.applicationVerified === undefined || typeof calibration.applicationVerified === 'boolean')
    && (calibration.applicationError === undefined || calibration.applicationError === null || typeof calibration.applicationError === 'string')
    && (calibration.inputAttenuationDb === undefined || isFiniteNumber(calibration.inputAttenuationDb))
    && (calibration.liveDspStatus === undefined || calibration.liveDspStatus === 'verified' || calibration.liveDspStatus === 'degraded')
    && isCalibrationTransaction(calibration.transaction)
    && value.profiles.every((profile) => isRecord(profile)
      && typeof profile.id === 'string'
      && typeof profile.name === 'string')
    && isInteger(capabilities.channels)
    && capabilities.channels >= 1
    && isInteger(capabilities.calibrationBandCount)
    && capabilities.calibrationBandCount === 64
    && isInteger(capabilities.userBandCount)
    && capabilities.userBandCount === userEq.bandsDb.length
    && typeof capabilities.supportsSweep === 'boolean'
    && typeof capabilities.supportsIndependentCalibration === 'boolean'
    && typeof capabilities.supportsCalibratedCorrection === 'boolean'
    && typeof capabilities.supportsHeadroomCompensation === 'boolean'
    && Array.isArray(capabilities.presets)
    && capabilities.presets.every(isPresetOption)
}

/** Command payloads (client to device). */

export interface SetBandsPayload {
  bandsDb: number[]
}

export interface ApplyPresetPayload {
  preset: number
}

export interface ProfileNamePayload {
  name: string
}

export interface CalibrationApplyPayload {
  bandsDb: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
}

export interface CalibrationCandidateActionPayload {
  candidateId: string
}

export type CalibrationValidationResultPayload =
  | {
      candidateId: string
      status: 'passed' | 'worse'
      beforeDb: number
      afterDb: number
    }
  | {
      candidateId: string
      status: 'inconclusive' | 'failed'
      reason: string
    }

export interface ProbeRunPayload {
  bands: number
}

export interface PersistentProbePayload {
  bands: number
}

export interface CurveApplyPayload {
  curve: 'hollow' | 'flat'
}

export interface ProbeBandsApplyPayload {
  bandsDb: number[]
  leftBandsDb?: number[]
  rightBandsDb?: number[]
}

export type ProbeCurveApplyPayload = CurveApplyPayload | ProbeBandsApplyPayload

const DEVICE_TARGETED_TYPES = [
  'state.get',
  'engine.enable',
  'engine.bypass',
  'engine.setBands',
  'engine.applyPreset',
  'profile.list',
  'profile.save',
  'profile.load',
  'profile.delete',
  'calibration.get',
  'calibration.applyCandidate',
  'calibration.acceptCandidate',
  'calibration.rollbackCandidate',
  'calibration.validation.result',
  'calibration.reset',
  'calibrationSession.begin',
  'calibrationSession.end',
  'calibrationSession.abort',
  'calibrationSession.loudness.start',
  'calibrationSession.loudness.stop',
  'calibrationSession.progress',
  'measurement.prepare',
  'measurement.playSweep',
  'measurement.abort',
  'measurement.diagnostics',
  'measurement.response',
  'probe.run',
  'probe.status',
  'probe.persistent.start',
  'probe.persistent.release',
  'probe.curve.apply',
  'diagnostics.deviceInfo',
  'diagnostics.effects',
] as const

export type DeviceTargetedType = (typeof DEVICE_TARGETED_TYPES)[number]

export const KNOWN_TYPES = new Set<string>([
  ...DEVICE_TARGETED_TYPES,
  'session.hello',
  'session.welcome',
  'session.peerJoined',
  'session.peerLeft',
  'session.error',
  'ping',
  'pong',
  'state.snapshot',
  'state.changed',
  'calibrationSession.started',
  'calibrationSession.ended',
  'calibrationSession.loudness.started',
  'calibrationSession.loudness.stopped',
  'measurement.ready',
  'measurement.started',
  'measurement.finished',
  'measurement.error',
  'probe.status',
  'probe.result',
  'diagnostics.deviceInfo',
  'diagnostics.probe',
  'diagnostics.effects',
])
export const SESSION_ONLY_TYPES = new Set<string>([
  'session.hello',
  'session.welcome',
  'session.peerJoined',
  'session.peerLeft',
  'session.error',
])

export function isDeviceTargeted(type: string): type is DeviceTargetedType {
  return DEVICE_TARGETED_TYPES.some((candidate) => candidate === type)
}

export interface RoomSocketReadyMessage {
  kind: 'room.ready'
  role: Role
  deviceOnline: boolean
  messages: Envelope[]
}

export interface RoomSocketPresenceMessage {
  kind: 'room.presence'
  deviceOnline: boolean
}

export interface RoomSocketClientPresenceMessage {
  kind: 'room.clientPresence'
  clientOnline: boolean
}

export interface RoomSocketErrorMessage {
  kind: 'room.error'
  code: ErrorPayload['code'] | 'bad_json' | 'bad_message'
  message?: string
}

export type RoomSocketServerMessage =
  | RoomSocketReadyMessage
  | RoomSocketPresenceMessage
  | RoomSocketClientPresenceMessage
  | RoomSocketErrorMessage

export function isRoomSocketServerMessage(value: unknown): value is RoomSocketServerMessage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'room.ready') {
    return (value.role === 'client' || value.role === 'device')
      && typeof value.deviceOnline === 'boolean'
      && Array.isArray(value.messages)
      && value.messages.every(isEnvelope)
  }
  if (value.kind === 'room.presence') return typeof value.deviceOnline === 'boolean'
  if (value.kind === 'room.clientPresence') return typeof value.clientOnline === 'boolean'
  if (value.kind === 'room.error') {
    return typeof value.code === 'string'
      && ['bad_json', 'bad_message', 'bad_envelope', 'version_mismatch', 'unknown_type', 'payload_too_large', 'rate_limited', 'not_in_room', 'internal'].includes(value.code)
      && (value.message === undefined || typeof value.message === 'string')
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isSessionId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f\s]/.test(value)
}

function isCalibrationChannel(value: unknown): value is CalibrationChannel {
  return value === 'both' || value === 'left' || value === 'right'
}

function isCalibrationPositionId(value: unknown): value is CalibrationPositionId {
  return value === 'center'
    || value === 'left'
    || value === 'right'
    || value === 'forward'
    || value === 'backward'
}

function isMeasurementPhase(value: unknown): value is MeasurementPhase {
  return value === 'measurement' || value === 'validation'
}

function isCalibrationProgressStage(value: unknown): value is CalibrationProgressStage {
  return value === 'loudness'
    || value === 'preparing'
    || value === 'recording'
    || value === 'analyzing'
    || value === 'position-pause'
    || value === 'validation'
    || value === 'ending'
}

export function isMeasurementContext(value: unknown): value is MeasurementContext {
  if (!isRecord(value)) return false
  if (!isCalibrationPositionId(value.positionId)) return false
  if (!isInteger(value.positionIndex) || value.positionIndex < 0 || value.positionIndex >= 16) return false
  if (!isInteger(value.positionCount) || value.positionCount < 1 || value.positionCount > 16) return false
  if (value.positionIndex >= value.positionCount) return false
  if (!isCalibrationChannel(value.channel)) return false
  if (!isInteger(value.takeIndex) || value.takeIndex < 0 || value.takeIndex >= 16) return false
  if (!isInteger(value.takeCount) || value.takeCount < 1 || value.takeCount > 8) return false
  if (value.takeIndex >= value.takeCount) return false
  return isMeasurementPhase(value.phase)
}

function isCalibrationErrorCode(value: unknown): value is CalibrationErrorCode {
  return CALIBRATION_ERROR_CODES.some((code) => code === value)
}

function hasOptionalMessage(value: Record<string, unknown>): boolean {
  return value.message === undefined
    || (typeof value.message === 'string' && value.message.length <= 1024)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isLoudnessStartedPayload(value: unknown): value is Record<string, unknown> & CalibrationLoudnessStartedPayload {
  return isSessionPayload(value)
    && isFiniteNumber(value.sampleRate)
    && Number.isInteger(value.sampleRate)
    && value.sampleRate >= 8_000
    && value.sampleRate <= 192_000
    && isFiniteNumber(value.levelDbfs)
    && value.levelDbfs <= 0
    && value.levelDbfs >= -120
    && isFiniteNumber(value.loopDurationMs)
    && value.loopDurationMs > 0
    && value.loopDurationMs <= 60_000
}

function isProgressPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionProgressPayload {
  if (!isSessionPayload(value) || !isCalibrationProgressStage(value.stage)) return false
  const current = value.current
  const total = value.total
  const estimate = value.estimatedRemainingSeconds
  return isInteger(current)
    && current >= 0
    && isInteger(total)
    && total >= 1
    && total <= 256
    && current <= total
    && (estimate === undefined || (isFiniteNumber(estimate) && estimate >= 0 && estimate <= 3_600))
    && hasOptionalMessage(value)
}

function isFiniteRange(value: unknown): value is { min: number; max: number } {
  return isRecord(value)
    && isFiniteNumber(value.min)
    && isFiniteNumber(value.max)
    && value.min >= 0
    && value.max >= value.min
}

function isBooleanArray(value: unknown): value is boolean[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'boolean')
}

function isMeasurementCaptureMetadata(value: unknown): value is MeasurementCaptureMetadata {
  if (!isRecord(value)) return false
  return isNullableFiniteNumber(value.sampleRate)
    && (value.sampleRate === null || value.sampleRate > 0)
    && isNullableFiniteNumber(value.channelCount)
    && (value.channelCount === null || value.channelCount >= 1)
    && (value.sampleRateRange === null || isFiniteRange(value.sampleRateRange))
    && (value.channelCountRange === null || isFiniteRange(value.channelCountRange))
    && (value.echoCancellation === null || typeof value.echoCancellation === 'boolean')
    && (value.noiseSuppression === null || typeof value.noiseSuppression === 'boolean')
    && (value.autoGainControl === null || typeof value.autoGainControl === 'boolean')
    && isBooleanArray(value.echoCancellationCapabilities)
    && isBooleanArray(value.noiseSuppressionCapabilities)
    && isBooleanArray(value.autoGainControlCapabilities)
    && (value.browserUserAgent === undefined || (typeof value.browserUserAgent === 'string' && value.browserUserAgent.length <= 1_024))
    && (value.micProfileId === undefined || (typeof value.micProfileId === 'string' && value.micProfileId.length <= 128))
    && (value.micProfileSourceDate === undefined || (typeof value.micProfileSourceDate === 'string' && value.micProfileSourceDate.length <= 64))
    && (value.micProfileCapturePathStatus === undefined
      || value.micProfileCapturePathStatus === 'validated'
      || value.micProfileCapturePathStatus === 'provisional'
      || value.micProfileCapturePathStatus === 'unvalidated')
    && (value.trackSampleRate === undefined || isNullableFiniteNumber(value.trackSampleRate))
    && (value.trackChannelCount === undefined || isNullableFiniteNumber(value.trackChannelCount))
}

function isMeasurementDiagnosticsPayload(value: unknown): value is Record<string, unknown> & MeasurementDiagnosticsPayload {
  if (!isSessionPayload(value) || !isMeasurementContext(value.context)) return false
  const current = value.current
  const total = value.total
  if (!isInteger(current) || current < 0) return false
  if (!isInteger(total) || total < 1 || total > 256 || current > total) return false
  if (!isRecord(value.diagnostics)) return false
  const diagnostics = value.diagnostics
  return (diagnostics.analysisStatus === undefined
      || diagnostics.analysisStatus === 'ok'
      || diagnostics.analysisStatus === 'signal_too_low'
      || diagnostics.analysisStatus === 'sweep_not_found'
      || diagnostics.analysisStatus === 'sync_marker_not_found'
      || diagnostics.analysisStatus === 'clock_drift_unreliable'
      || diagnostics.analysisStatus === 'capture_too_short'
      || diagnostics.analysisStatus === 'capture_clipped')
    && (diagnostics.failureReason === undefined || diagnostics.failureReason === null || typeof diagnostics.failureReason === 'string')
    && isFiniteNumber(diagnostics.signalRms)
    && diagnostics.signalRms >= 0
    && isFiniteNumber(diagnostics.signalPeak)
    && diagnostics.signalPeak >= 0
    && isNullableFiniteNumber(diagnostics.snrEstimateDb)
    && isNullableFiniteNumber(diagnostics.detectionOffsetMs)
    && (diagnostics.detectionOffsetMs === null || diagnostics.detectionOffsetMs >= 0)
    && (!('envelopeOnlyOffsetMs' in diagnostics) || isNullableFiniteNumber(diagnostics.envelopeOnlyOffsetMs))
    && (diagnostics.captureMetadata === undefined || isMeasurementCaptureMetadata(diagnostics.captureMetadata))
    && isFiniteNumber(diagnostics.syncMarkerConfidence)
    && diagnostics.syncMarkerConfidence >= 0
    && diagnostics.syncMarkerConfidence <= 1
    && isFiniteNumber(diagnostics.endingMarkerConfidence)
    && diagnostics.endingMarkerConfidence >= 0
    && diagnostics.endingMarkerConfidence <= 1
    && isNullableFiniteNumber(diagnostics.clockDriftPpm)
    && typeof diagnostics.clipped === 'boolean'
    && isInteger(diagnostics.clippedSamples)
    && diagnostics.clippedSamples >= 0
    && isNullableFiniteNumber(diagnostics.directArrivalMs)
    && isNullableFiniteNumber(diagnostics.directToLateDb)
    && isNullableFiniteNumber(diagnostics.c50Db)
    && isNullableFiniteNumber(diagnostics.c80Db)
    && isNullableFiniteNumber(diagnostics.edtMs)
    && isNullableFiniteNumber(diagnostics.t20Ms)
    && isNullableFiniteNumber(diagnostics.t30Ms)
    && isInteger(diagnostics.earlyReflections)
    && diagnostics.earlyReflections >= 0
    && (diagnostics.decayConfidence === 'high'
      || diagnostics.decayConfidence === 'medium'
      || diagnostics.decayConfidence === 'low')
}

const MAX_RESPONSE_POINTS = 64

function isMeasurementResponseChannel(value: unknown): value is MeasurementResponseChannel {
  if (!isRecord(value)) return false
  const frequenciesHz = value.frequenciesHz
  const magnitudesDb = value.magnitudesDb
  if (!Array.isArray(frequenciesHz) || !Array.isArray(magnitudesDb)) return false
  if (frequenciesHz.length < 2 || frequenciesHz.length > MAX_RESPONSE_POINTS || frequenciesHz.length !== magnitudesDb.length) {
    return false
  }
  let previousFrequency = 0
  for (let index = 0; index < frequenciesHz.length; index++) {
    const frequency = frequenciesHz[index]
    const magnitude = magnitudesDb[index]
    if (!isFiniteNumber(frequency) || frequency <= 0 || frequency <= previousFrequency || !isFiniteNumber(magnitude)) {
      return false
    }
    previousFrequency = frequency
  }
  return true
}

function isMeasurementResponsePayload(value: unknown): value is Record<string, unknown> & MeasurementResponsePayload {
  if (!isSessionPayload(value)) return false
  if (!isInteger(value.current) || value.current < 0) return false
  if (!isInteger(value.total) || value.total < 1 || value.total > 256 || value.current > value.total) return false
  if (value.left === null && value.right === null) return false
  return (value.left === null || isMeasurementResponseChannel(value.left))
    && (value.right === null || isMeasurementResponseChannel(value.right))
}

function isDbArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 64
    && value.every(isFiniteNumber)
}

function isProbeDbArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 64
    && value.every((band) => isFiniteNumber(band) && band >= -18 && band <= 6)
}

function isUserBandsPayload(value: unknown): value is SetBandsPayload {
  return isRecord(value)
    && Array.isArray(value.bandsDb)
    && value.bandsDb.length === 24
    && value.bandsDb.every((band) => isFiniteNumber(band) && band >= -15 && band <= 15)
}

function isCalibrationApplyPayload(value: unknown): value is CalibrationApplyPayload {
  if (!isRecord(value) || !isDbArray(value.bandsDb)) return false
  const hasLeft = value.leftBandsDb !== undefined
  const hasRight = value.rightBandsDb !== undefined
  return hasLeft === hasRight
    && (!hasLeft || (isDbArray(value.leftBandsDb) && isDbArray(value.rightBandsDb)))
}

function isProbeCurveApplyPayload(value: unknown): value is ProbeCurveApplyPayload {
  if (!isRecord(value)) return false
  if (value.curve !== undefined) return value.curve === 'flat' || value.curve === 'hollow'
  if (!isProbeDbArray(value.bandsDb)) return false
  const hasLeft = value.leftBandsDb !== undefined
  const hasRight = value.rightBandsDb !== undefined
  return hasLeft === hasRight
    && (!hasLeft || (isProbeDbArray(value.leftBandsDb) && isProbeDbArray(value.rightBandsDb)))
}

function isProbeRunPayload(value: unknown): value is ProbeRunPayload {
  return isRecord(value)
    && isInteger(value.bands)
    && value.bands >= 1
    && value.bands <= 128
}

function isPersistentProbePayload(value: unknown): value is PersistentProbePayload {
  return isRecord(value)
    && isInteger(value.bands)
    && value.bands === 64
}

function isCandidateActionPayload(value: unknown): value is CalibrationCandidateActionPayload {
  return isRecord(value)
    && typeof value.candidateId === 'string'
    && value.candidateId.length > 0
    && value.candidateId.length <= 128
}

function isCalibrationValidationResultPayload(value: unknown): value is CalibrationValidationResultPayload {
  if (!isCandidateActionPayload(value)) return false
  if (value.status === 'passed' || value.status === 'worse') {
    return isFiniteNumber(value.beforeDb)
      && isFiniteNumber(value.afterDb)
      && value.beforeDb >= 0
      && value.beforeDb <= 120
      && value.afterDb >= 0
      && value.afterDb <= 120
  }
  return (value.status === 'inconclusive' || value.status === 'failed')
    && typeof value.reason === 'string'
    && value.reason.length > 0
    && value.reason.length <= 512
}

export function isMeasurementSweep(value: unknown): value is MeasurementSweep {
  if (!isRecord(value)) return false
  if (value.algorithm !== 'exponential-sine-v1') return false
  if (!isFiniteNumber(value.sampleRate) || !Number.isInteger(value.sampleRate)) return false
  if (value.sampleRate < 8_000 || value.sampleRate > 192_000) return false
  if (!isFiniteNumber(value.startHz) || value.startHz <= 0) return false
  if (!isFiniteNumber(value.endHz) || value.endHz <= value.startHz) return false
  if (value.endHz > value.sampleRate / 2) return false
  if (!isFiniteNumber(value.durationMs) || value.durationMs <= 0 || value.durationMs > 120_000) return false
  if (!isFiniteNumber(value.preRollMs) || value.preRollMs < 0 || value.preRollMs > 60_000) return false
  if (!isFiniteNumber(value.postRollMs) || value.postRollMs < 0 || value.postRollMs > 60_000) return false
  if (!isFiniteNumber(value.syncMarkerStartHz) || value.syncMarkerStartHz <= 0) return false
  if (!isFiniteNumber(value.syncMarkerEndHz) || value.syncMarkerEndHz <= value.syncMarkerStartHz) return false
  if (value.syncMarkerEndHz >= value.sampleRate / 2) return false
  if (!isFiniteNumber(value.syncMarkerDurationMs) || value.syncMarkerDurationMs <= 0 || value.syncMarkerDurationMs > 1_000) return false
  if (!isFiniteNumber(value.syncMarkerGapMs) || value.syncMarkerGapMs < 0 || value.syncMarkerGapMs > 1_000) return false
  if (value.preRollMs < value.syncMarkerDurationMs + value.syncMarkerGapMs) return false
  if (!isFiniteNumber(value.levelDbfs) || value.levelDbfs > 0 || value.levelDbfs < -120) return false
  if (!isFiniteNumber(value.fadeInMs) || value.fadeInMs < 0 || value.fadeInMs > value.durationMs) return false
  if (!isFiniteNumber(value.fadeOutMs) || value.fadeOutMs < 0 || value.fadeOutMs > value.durationMs) return false
  return value.fadeInMs + value.fadeOutMs <= value.durationMs
}

export function isEnvelope(value: unknown): value is Envelope<unknown> {
  if (!isRecord(value)) return false
  if (value.v !== PROTOCOL_VERSION) return false
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256) return false
  if (typeof value.type !== 'string' || value.type.length === 0) return false
  if (!isFiniteNumber(value.ts)) return false
  if (!Object.hasOwn(value, 'payload')) return false
  return (value.replyTo === undefined || (typeof value.replyTo === 'string' && value.replyTo.length <= 256))
    && (value.expiresAt === undefined
      || (isFiniteNumber(value.expiresAt) && value.expiresAt > value.ts && value.expiresAt <= value.ts + 120_000))
}

function isSessionPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionPayload {
  return isRecord(value)
    && isSessionId(value.sessionId)
    && (value.channel === undefined || isCalibrationChannel(value.channel))
    && (value.phase === undefined || isMeasurementPhase(value.phase))
}

function isCandidateId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}

function isSessionWithChannel(value: unknown): value is Record<string, unknown> & CalibrationSessionBeginPayload {
  if (!isSessionPayload(value) || !isCalibrationChannel(value.channel)) return false
  if (value.phase !== undefined && !isMeasurementPhase(value.phase)) return false
  if (value.candidateId !== undefined && !isCandidateId(value.candidateId)) return false
  return (value.phase ?? 'measurement') === 'measurement'
    ? value.candidateId === undefined
    : value.candidateId !== undefined
}

function isSessionWithSweep(value: unknown): value is Record<string, unknown> & MeasurementReadyPayload {
  return isSessionPayload(value)
    && isMeasurementSweep(value.sweep)
    && (value.context === undefined || isMeasurementContext(value.context))
}

function isSessionWithOptionalContext(value: unknown): value is Record<string, unknown> & MeasurementPlaySweepPayload {
  return isSessionPayload(value)
    && (value.context === undefined || isMeasurementContext(value.context))
}

export function isMeasurementReadyPayload(value: unknown): value is MeasurementReadyPayload {
  return isSessionWithSweep(value)
}

function isAbortPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionAbortPayload {
  return isSessionPayload(value)
    && (value.code === undefined || isCalibrationErrorCode(value.code))
    && hasOptionalMessage(value)
}

export function validatePayload(type: string, payload: unknown): string | null {
  switch (type) {
    case 'state.snapshot':
    case 'state.changed':
      return isStateSnapshot(payload) ? null : `${type} requires a valid state snapshot`
    case 'engine.setBands':
      return isUserBandsPayload(payload) ? null : `${type} requires 24 finite bands within ±15 dB`
    case 'calibrationSession.begin':
    case 'measurement.prepare':
      return isSessionWithChannel(payload) ? null : `${type} requires sessionId and channel`
    case 'probe.run':
      return isProbeRunPayload(payload) ? null : `${type} requires a band count from 1 to 128`
    case 'probe.persistent.start':
      return isPersistentProbePayload(payload) ? null : `${type} requires exactly 64 diagnostic bands`
    case 'probe.curve.apply':
      return isProbeCurveApplyPayload(payload) ? null : `${type} requires a named curve or 64 diagnostic bands within -18 to +6 dB`
    case 'calibrationSession.loudness.start':
    case 'calibrationSession.loudness.stop':
      return isSessionPayload(payload) ? null : `${type} requires sessionId`
    case 'calibrationSession.progress':
      return isProgressPayload(payload) ? null : `${type} requires a valid calibration progress payload`
    case 'calibrationSession.end':
    case 'measurement.abort':
    case 'calibrationSession.started':
    case 'calibrationSession.ended':
      return isSessionPayload(payload) ? null : `${type} requires sessionId`
    case 'measurement.playSweep':
    case 'measurement.finished':
      return isSessionWithOptionalContext(payload) ? null : `${type} requires sessionId and a valid optional context`
    case 'measurement.diagnostics':
      return isMeasurementDiagnosticsPayload(payload) ? null : `${type} requires compact diagnostics and a valid context`
    case 'measurement.response':
      return isMeasurementResponsePayload(payload) ? null : `${type} requires a compact finite response curve`
    case 'calibrationSession.abort':
      return isAbortPayload(payload) ? null : `${type} requires sessionId and a valid optional error`
    case 'calibration.applyCandidate':
      return isCalibrationApplyPayload(payload) ? null : `${type} requires 64 finite bands and optional paired channel curves`
    case 'calibration.acceptCandidate':
    case 'calibration.rollbackCandidate':
      return isCandidateActionPayload(payload) ? null : `${type} requires a candidateId`
    case 'calibration.validation.result':
      return isCalibrationValidationResultPayload(payload) ? null : `${type} requires a candidateId and a valid validation result`
    case 'measurement.ready':
    case 'measurement.started':
      return isSessionWithSweep(payload) ? null : `${type} requires sessionId and sweep`
    case 'calibrationSession.loudness.started':
      return isLoudnessStartedPayload(payload) ? null : `${type} requires a valid loudness descriptor`
    case 'calibrationSession.loudness.stopped':
      return isSessionPayload(payload) ? null : `${type} requires sessionId`
    case 'measurement.error':
      return isSessionPayload(payload)
        && isCalibrationErrorCode(payload.code)
        && hasOptionalMessage(payload)
        ? null
        : `${type} requires sessionId and a valid code`
    default:
      return null
  }
}

export function isValidPayload(type: string, payload: unknown): boolean {
  return validatePayload(type, payload) === null
}
