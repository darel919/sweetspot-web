import {
  isTransportCapabilityMessage,
  type TransportCapabilityMessage,
} from '../../../../shared/transport/capabilities'
import {
  MAX_PAYLOAD_BYTES,
  isDeviceToClient,
  isEnvelope,
  utf8ByteLength,
  validatePayload,
  type Envelope,
} from '../../../../shared/types/protocol'

export type ControlMessage =
  | { kind: 'ignored' }
  | { kind: 'capability'; value: TransportCapabilityMessage }
  | { kind: 'envelope'; value: Envelope }
  | { kind: 'error'; code: string; message: string }

export function parseControlMessage(data: unknown): ControlMessage {
  if (typeof data !== 'string') return { kind: 'ignored' }
  if (utf8ByteLength(data) > MAX_PAYLOAD_BYTES) {
    return { kind: 'error', code: 'control_too_large', message: 'The TV sent an oversized control message.' }
  }
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return { kind: 'error', code: 'invalid_control', message: 'The TV sent invalid control data.' }
  }
  if (isTransportCapabilityMessage(value)) return { kind: 'capability', value }
  if (!isEnvelope(value)) return { kind: 'error', code: 'invalid_envelope', message: 'The TV sent an invalid control envelope.' }
  if (!isDeviceToClient(value.type)) {
    return { kind: 'error', code: 'unexpected_message', message: 'The TV sent an unexpected control message.' }
  }
  if (validatePayload(value.type, value.payload)) {
    return { kind: 'error', code: 'invalid_payload', message: 'The TV sent invalid control payload.' }
  }
  return { kind: 'envelope', value }
}

export interface ControlChannelHandlers {
  onMessage: (event: MessageEvent<unknown>) => void
  onOpen: () => void
  onClose: () => void
  onError: () => void
  onBufferedAmountLow: () => void
}

export function bindControlChannel(
  channel: RTCDataChannel,
  isCurrent: () => boolean,
  handlers: ControlChannelHandlers,
): void {
  channel.binaryType = 'arraybuffer'
  channel.onmessage = (event) => { if (isCurrent()) handlers.onMessage(event) }
  channel.onopen = () => { if (isCurrent()) handlers.onOpen() }
  channel.onclose = () => { if (isCurrent()) handlers.onClose() }
  channel.onerror = () => { if (isCurrent()) handlers.onError() }
  channel.onbufferedamountlow = () => { if (isCurrent()) handlers.onBufferedAmountLow() }
  if (!isCurrent()) channel.close()
}
