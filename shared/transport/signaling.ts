export const SIGNALING_VERSION = 1 as const
export const MAX_SIGNALING_MESSAGE_BYTES = 64 * 1024
export const MAX_SIGNALING_TEXT_BYTES = 48 * 1024
export const RENDEZVOUS_ID_PATTERN = /^[a-f0-9]{32}$/

export type SignalingRole = 'device' | 'client'

export interface PairingCredentials {
  displayCode: string
  rendezvousId: string
  pairSecret: string
}

export interface SignalDescription {
  type: 'offer' | 'answer'
  sdp: string
}

export interface SignalCandidate {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number
}

export type SignalingMessage =
  | { v: typeof SIGNALING_VERSION; type: 'signal.hello'; generation: string }
  | { v: typeof SIGNALING_VERSION; type: 'signal.offer'; generation: string; attemptId: string; description: SignalDescription }
  | { v: typeof SIGNALING_VERSION; type: 'signal.answer'; generation: string; attemptId: string; description: SignalDescription }
  | { v: typeof SIGNALING_VERSION; type: 'signal.ice'; generation: string; attemptId: string; candidate: SignalCandidate }
  | { v: typeof SIGNALING_VERSION; type: 'signal.complete'; generation: string; attemptId: string }
  | { v: typeof SIGNALING_VERSION; type: 'signal.complete.ack'; generation: string; attemptId: string }
  | { v: typeof SIGNALING_VERSION; type: 'signal.ready'; role: SignalingRole; peerOnline: boolean }
  | { v: typeof SIGNALING_VERSION; type: 'signal.peer'; role: SignalingRole; online: boolean }
  | { v: typeof SIGNALING_VERSION; type: 'signal.error'; code: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function boundedText(value: unknown, maxBytes = MAX_SIGNALING_TEXT_BYTES): value is string {
  return typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).byteLength <= maxBytes
}

function validGeneration(value: unknown): value is string {
  return boundedText(value, 128) && /^[A-Za-z0-9_-]+$/.test(value)
}

function validAttemptId(value: unknown): value is string {
  return boundedText(value, 128) && /^[A-Za-z0-9_-]+$/.test(value)
}

function isDescription(value: unknown): value is SignalDescription {
  return isRecord(value)
    && (value.type === 'offer' || value.type === 'answer')
    && boundedText(value.sdp)
}

function isCandidate(value: unknown): value is SignalCandidate {
  return isRecord(value)
    && boundedText(value.candidate, MAX_SIGNALING_TEXT_BYTES)
    && (value.sdpMid === null || typeof value.sdpMid === 'string' && value.sdpMid.length <= 128)
    && typeof value.sdpMLineIndex === 'number'
    && Number.isInteger(value.sdpMLineIndex)
    && value.sdpMLineIndex >= 0
    && value.sdpMLineIndex <= 32
}

export function isRendezvousId(value: string): boolean {
  return RENDEZVOUS_ID_PATTERN.test(value)
}

export function isSignalingMessage(value: unknown): value is SignalingMessage {
  if (!isRecord(value) || value.v !== SIGNALING_VERSION || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'signal.hello':
      return validGeneration(value.generation)
    case 'signal.offer':
    case 'signal.answer':
      return validGeneration(value.generation) && validAttemptId(value.attemptId) && isDescription(value.description)
    case 'signal.ice':
      return validGeneration(value.generation) && validAttemptId(value.attemptId) && isCandidate(value.candidate)
    case 'signal.complete':
      return validGeneration(value.generation) && validAttemptId(value.attemptId)
    case 'signal.complete.ack':
      return validGeneration(value.generation) && validAttemptId(value.attemptId)
    case 'signal.ready':
      return (value.role === 'device' || value.role === 'client') && typeof value.peerOnline === 'boolean'
    case 'signal.peer':
      return (value.role === 'device' || value.role === 'client') && typeof value.online === 'boolean'
    case 'signal.error':
      return boundedText(value.code, 128) && boundedText(value.message, 2_048)
    default: {
      const exhaustive: never = value.type
      return exhaustive
    }
  }
}

export function encodeSignalingMessage(message: SignalingMessage): string {
  const encoded = JSON.stringify(message)
  if (new TextEncoder().encode(encoded).byteLength > MAX_SIGNALING_MESSAGE_BYTES) {
    throw new RangeError('Signaling message exceeds the size limit')
  }
  return encoded
}

export function decodeSignalingMessage(text: string): SignalingMessage | null {
  if (new TextEncoder().encode(text).byteLength > MAX_SIGNALING_MESSAGE_BYTES) return null
  try {
    const value: unknown = JSON.parse(text)
    return isSignalingMessage(value) ? value : null
  } catch {
    return null
  }
}
