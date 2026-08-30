import { PROTOCOL_VERSION } from '../types/protocol'

export const TRANSPORT_VERSION = 1 as const
export const CAPTURE_STREAM_VERSION = 1 as const
export const MAX_CAPTURE_CHUNK_BYTES = 16 * 1024
export const MAX_CAPTURE_FRAME_BYTES = 32 * 1024

export interface TransportCapabilities {
  protocolVersion: typeof PROTOCOL_VERSION
  transportVersion: typeof TRANSPORT_VERSION
  captureStreamVersion: typeof CAPTURE_STREAM_VERSION
  buildId: string
  channels: ['control', 'capture']
  maxCaptureChunkBytes: number
}

export type TransportCapabilityMessage =
  | { kind: 'sweetspot.transport'; type: 'hello'; sessionId: string; capabilities: TransportCapabilities }
  | { kind: 'sweetspot.transport'; type: 'ready'; sessionId: string; capabilities: TransportCapabilities }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isCapabilities(value: unknown): value is TransportCapabilities {
  return isRecord(value)
    && value.protocolVersion === PROTOCOL_VERSION
    && value.transportVersion === TRANSPORT_VERSION
    && value.captureStreamVersion === CAPTURE_STREAM_VERSION
    && boundedText(value.buildId, 256)
    && Array.isArray(value.channels)
    && value.channels.length === 2
    && value.channels[0] === 'control'
    && value.channels[1] === 'capture'
    && typeof value.maxCaptureChunkBytes === 'number'
    && Number.isInteger(value.maxCaptureChunkBytes)
    && value.maxCaptureChunkBytes > 0
    && value.maxCaptureChunkBytes <= MAX_CAPTURE_CHUNK_BYTES
}

export function isTransportCapabilityMessage(value: unknown): value is TransportCapabilityMessage {
  if (!isRecord(value)
    || value.kind !== 'sweetspot.transport'
    || (value.type !== 'hello' && value.type !== 'ready')
    || !boundedText(value.sessionId, 128)) return false
  return isCapabilities(value.capabilities)
}

export function localTransportCapabilities(buildId: string): TransportCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    transportVersion: TRANSPORT_VERSION,
    captureStreamVersion: CAPTURE_STREAM_VERSION,
    buildId: buildId || 'web-local',
    channels: ['control', 'capture'],
    maxCaptureChunkBytes: MAX_CAPTURE_CHUNK_BYTES,
  }
}
