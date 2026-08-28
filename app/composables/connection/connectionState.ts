import type { DirectConnectionState, TransportError } from '~/lib/transport/types'

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'offline'

export interface ConnectionSnapshot {
  status: ConnectionState
  deviceOnline: boolean
}

export function connectionStateForDevice(deviceOnline: boolean): ConnectionState {
  return deviceOnline ? 'connected' : 'offline'
}

export function connectionStateForTransport(state: DirectConnectionState): ConnectionState {
  switch (state) {
    case 'direct':
      return 'connected'
    case 'reconnecting':
      return 'reconnecting'
    case 'failed':
      return 'offline'
    case 'closed':
      return 'disconnected'
    case 'idle':
      return 'disconnected'
    case 'pairing':
    case 'signaling':
    case 'connecting':
      return 'connecting'
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

export function transportErrorMessage(error: TransportError | null): string | null {
  if (!error) return null
  if (error.code === 'peer_in_use') return 'This TV already has a dashboard connection. Close it before scanning the QR code again.'
  switch (error.kind) {
    case 'signaling':
      return error.code === 'pairing_expired'
        ? 'This pairing link expired before the connection finished. Scan the current QR code on the TV and try again.'
        : 'Could not reach this TV. Make sure the code is still shown on the TV and try again.'
    case 'p2p':
      return 'TV and phone cannot reach each other directly. Make sure both devices are on the same home network and disable Guest Wi-Fi, client isolation, or VPN.'
    case 'protocol':
      return 'This dashboard and TV need matching versions. Update both, then scan the current QR code.'
    case 'microphone':
      return 'Microphone access is unavailable. Allow microphone access in Safari, then retry the capture.'
    case 'acoustic':
      return 'The microphone recording was not usable. Follow the TV placement instruction and retry this capture.'
    case 'tv_audio':
      return 'The TV could not complete the audio test safely. Retry the current calibration action.'
    case 'cancelled':
      return null
    default: {
      const exhaustive: never = error.kind
      return exhaustive
    }
  }
}

export function shouldNotifyOffline(previous: ConnectionSnapshot, next: ConnectionSnapshot): boolean {
  const wasReachable = previous.deviceOnline || previous.status === 'connected'
  const isUnavailable = !next.deviceOnline || next.status !== 'connected'
  return wasReachable && isUnavailable
}
