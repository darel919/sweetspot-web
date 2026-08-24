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
  'calibration_aborted',
] as const

export type CalibrationErrorCode = (typeof CALIBRATION_ERROR_CODES)[number]

export interface CalibrationSessionPayload {
  sessionId: string
}

export interface CalibrationSessionBeginPayload extends CalibrationSessionPayload {
  channel: CalibrationChannel
}

export interface CalibrationSessionEndPayload extends CalibrationSessionPayload {}

export interface CalibrationSessionAbortPayload extends CalibrationSessionPayload {
  code?: CalibrationErrorCode
  message?: string
}

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
}

export interface MeasurementPlaySweepPayload extends CalibrationSessionPayload {}

export interface MeasurementAbortPayload extends CalibrationSessionPayload {}

export interface MeasurementReadyPayload extends CalibrationSessionPayload {
  sweep: MeasurementSweep
}

export interface MeasurementStartedPayload extends CalibrationSessionPayload {
  sweep: MeasurementSweep
}

export interface MeasurementFinishedPayload extends CalibrationSessionPayload {}

export interface MeasurementErrorPayload extends CalibrationSessionPayload {
  code: CalibrationErrorCode
  message?: string
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
  'measurement.prepare',
  'measurement.playSweep',
  'measurement.abort',
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
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

function isCalibrationErrorCode(value: unknown): value is CalibrationErrorCode {
  return CALIBRATION_ERROR_CODES.some((code) => code === value)
}

function hasOptionalMessage(value: Record<string, unknown>): boolean {
  return value.message === undefined
    || (typeof value.message === 'string' && value.message.length <= 1024)
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

function isSessionPayload(value: unknown): value is CalibrationSessionPayload {
  return isRecord(value) && isSessionId(value.sessionId)
}

function isSessionWithChannel(value: unknown): value is CalibrationSessionBeginPayload {
  return isSessionPayload(value) && isCalibrationChannel(value.channel)
}

function isSessionWithSweep(value: unknown): value is MeasurementReadyPayload {
  return isSessionPayload(value) && isMeasurementSweep(value.sweep)
}

export function isMeasurementReadyPayload(value: unknown): value is MeasurementReadyPayload {
  return isSessionWithSweep(value)
}

function isAbortPayload(value: unknown): value is CalibrationSessionAbortPayload {
  return isSessionPayload(value)
    && (value.code === undefined || isCalibrationErrorCode(value.code))
    && hasOptionalMessage(value)
}

export function validatePayload(type: string, payload: unknown): string | null {
  switch (type) {
    case 'calibrationSession.begin':
    case 'measurement.prepare':
      return isSessionWithChannel(payload) ? null : `${type} requires sessionId and channel`
    case 'calibrationSession.end':
    case 'measurement.playSweep':
    case 'measurement.abort':
    case 'calibrationSession.started':
    case 'calibrationSession.ended':
    case 'measurement.finished':
      return isSessionPayload(payload) ? null : `${type} requires sessionId`
    case 'calibrationSession.abort':
      return isAbortPayload(payload) ? null : `${type} requires sessionId and a valid optional error`
    case 'measurement.ready':
    case 'measurement.started':
      return isSessionWithSweep(payload) ? null : `${type} requires sessionId and sweep`
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
