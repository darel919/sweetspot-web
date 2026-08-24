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
  leftBandsDb?: number[]
  rightBandsDb?: number[]
  independent?: boolean
  headroomDb?: number
  headroomVerified?: boolean
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
  'sweep_not_found',
  'signal_too_low',
  'measurement_unstable',
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
  signalRms: number
  signalPeak: number
  snrEstimateDb: number | null
  detectionOffsetMs: number | null
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
}

export interface MeasurementDiagnosticsPayload extends CalibrationSessionPayload {
  context: MeasurementContext
  current: number
  total: number
  diagnostics: MeasurementDiagnosticsValues
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
  supportsIndependentCalibration?: boolean
  supportsHeadroomCompensation?: boolean
  /** Available engine presets, reported by the device. Empty on older builds. */
  presets?: PresetOption[]
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

export interface ProbeRunPayload {
  bands: number
}

export interface PersistentProbePayload {
  bands: number
}

export interface CurveApplyPayload {
  curve: 'hollow' | 'flat'
}

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
  'calibration.apply',
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
  deviceOnline: boolean
  messages: Envelope[]
}

export interface RoomSocketPresenceMessage {
  kind: 'room.presence'
  deviceOnline: boolean
}

export interface RoomSocketErrorMessage {
  kind: 'room.error'
  code: ErrorPayload['code'] | 'bad_json' | 'bad_message'
  message?: string
}

export interface RoomSocketPingMessage {
  kind: 'room.ping'
}

export type RoomSocketServerMessage =
  | RoomSocketReadyMessage
  | RoomSocketPresenceMessage
  | RoomSocketErrorMessage

export function isRoomSocketPingMessage(value: unknown): value is RoomSocketPingMessage {
  return isRecord(value) && value.kind === 'room.ping'
}

export function isRoomSocketServerMessage(value: unknown): value is RoomSocketServerMessage {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'room.ready') {
    return typeof value.deviceOnline === 'boolean'
      && Array.isArray(value.messages)
      && value.messages.every(isEnvelope)
  }
  if (value.kind === 'room.presence') return typeof value.deviceOnline === 'boolean'
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

function isMeasurementDiagnosticsPayload(value: unknown): value is Record<string, unknown> & MeasurementDiagnosticsPayload {
  if (!isSessionPayload(value) || !isMeasurementContext(value.context)) return false
  const current = value.current
  const total = value.total
  if (!isInteger(current) || current < 0) return false
  if (!isInteger(total) || total < 1 || total > 256 || current > total) return false
  if (!isRecord(value.diagnostics)) return false
  const diagnostics = value.diagnostics
  return isFiniteNumber(diagnostics.signalRms)
    && diagnostics.signalRms >= 0
    && isFiniteNumber(diagnostics.signalPeak)
    && diagnostics.signalPeak >= 0
    && isNullableFiniteNumber(diagnostics.snrEstimateDb)
    && isNullableFiniteNumber(diagnostics.detectionOffsetMs)
    && (diagnostics.detectionOffsetMs === null || diagnostics.detectionOffsetMs >= 0)
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

function isDbArray(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length === 64
    && value.every(isFiniteNumber)
}

function isCalibrationApplyPayload(value: unknown): value is CalibrationApplyPayload {
  if (!isRecord(value) || !isDbArray(value.bandsDb)) return false
  const hasLeft = value.leftBandsDb !== undefined
  const hasRight = value.rightBandsDb !== undefined
  return hasLeft === hasRight
    && (!hasLeft || (isDbArray(value.leftBandsDb) && isDbArray(value.rightBandsDb)))
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
  return value.replyTo === undefined || (typeof value.replyTo === 'string' && value.replyTo.length <= 256)
}

function isSessionPayload(value: unknown): value is Record<string, unknown> & CalibrationSessionPayload {
  return isRecord(value)
    && isSessionId(value.sessionId)
    && (value.channel === undefined || isCalibrationChannel(value.channel))
    && (value.phase === undefined || isMeasurementPhase(value.phase))
}

function isSessionWithChannel(value: unknown): value is Record<string, unknown> & CalibrationSessionBeginPayload {
  return isSessionPayload(value)
    && isCalibrationChannel(value.channel)
    && (value.phase === undefined || isMeasurementPhase(value.phase))
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
    case 'calibrationSession.begin':
    case 'measurement.prepare':
      return isSessionWithChannel(payload) ? null : `${type} requires sessionId and channel`
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
    case 'calibrationSession.abort':
      return isAbortPayload(payload) ? null : `${type} requires sessionId and a valid optional error`
    case 'calibration.apply':
      return isCalibrationApplyPayload(payload) ? null : `${type} requires 64 finite bands and optional paired channel curves`
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
