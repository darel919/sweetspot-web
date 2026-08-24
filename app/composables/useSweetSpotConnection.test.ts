import { describe, expect, test } from 'bun:test'
import {
  connectionStateForDevice,
  shouldNotifyOffline,
} from './connectionState'

describe('TV connection state', () => {
  test('does not call a healthy mailbox an online TV', () => {
    expect(connectionStateForDevice(false)).toBe('offline')
    expect(connectionStateForDevice(true)).toBe('connected')
  })

  test('notifies only after a reachable TV becomes unavailable', () => {
    expect(shouldNotifyOffline(
      { status: 'disconnected', deviceOnline: false },
      { status: 'offline', deviceOnline: false },
    )).toBe(false)
    expect(shouldNotifyOffline(
      { status: 'connected', deviceOnline: true },
      { status: 'offline', deviceOnline: false },
    )).toBe(true)
    expect(shouldNotifyOffline(
      { status: 'connected', deviceOnline: true },
      { status: 'connecting', deviceOnline: true },
    )).toBe(true)
  })
})
