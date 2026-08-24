export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'offline'

export interface ConnectionSnapshot {
  status: ConnectionState
  deviceOnline: boolean
}

export function connectionStateForDevice(deviceOnline: boolean): ConnectionState {
  return deviceOnline ? 'connected' : 'offline'
}

export function shouldNotifyOffline(previous: ConnectionSnapshot, next: ConnectionSnapshot): boolean {
  const wasReachable = previous.deviceOnline || previous.status === 'connected'
  const isUnavailable = !next.deviceOnline || next.status !== 'connected'
  return wasReachable && isUnavailable
}
