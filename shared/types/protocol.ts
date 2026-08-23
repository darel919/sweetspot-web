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

export interface DeviceCapabilities {
  channels: number
  calibrationBandCount: number
  userBandCount: number
  supportsSweep: boolean
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
  'measurement.prepare',
  'measurement.playSweep',
  'measurement.abort',
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
  'measurement.ready',
  'measurement.started',
  'measurement.finished',
  'measurement.error',
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
  return (DEVICE_TARGETED_TYPES as readonly string[]).includes(type)
}
