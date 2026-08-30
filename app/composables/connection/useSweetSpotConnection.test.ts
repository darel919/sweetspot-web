import { describe, expect, test } from 'bun:test'
import {
  connectionStateForDevice,
  connectionStateForTransport,
  shouldNotifyOffline,
  transportErrorMessage,
} from './connectionState'
import { SweetSpotRequestError } from '../../lib/transport/errors'

describe('TV connection state', () => {
  test('does not call an available signaling service an online TV', () => {
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

  test('maps direct transport states to product states', () => {
    expect(connectionStateForTransport('idle')).toBe('disconnected')
    expect(connectionStateForTransport('pairing')).toBe('connecting')
    expect(connectionStateForTransport('signaling')).toBe('connecting')
    expect(connectionStateForTransport('connecting')).toBe('connecting')
    expect(connectionStateForTransport('direct')).toBe('connected')
    expect(connectionStateForTransport('reconnecting')).toBe('reconnecting')
    expect(connectionStateForTransport('failed')).toBe('offline')
    expect(connectionStateForTransport('closed')).toBe('disconnected')
  })

  test('turns transport failures into actionable product text', () => {
    expect(transportErrorMessage({ kind: 'p2p', code: 'ice_failed', message: 'internal', retryable: true }))
      .toContain('same home network')
    expect(transportErrorMessage({ kind: 'signaling', code: 'pairing_expired', message: 'internal', retryable: false }))
      .toContain('expired')
    expect(transportErrorMessage({ kind: 'protocol', code: 'version_mismatch', message: 'internal', retryable: false }))
      .toContain('matching versions')
  })
})

describe('SweetSpot request failures', () => {
  test('keeps timeout failures distinguishable from transport interruptions', () => {
    const timeout = new SweetSpotRequestError('timeout', 'state.get')
    const interrupted = new SweetSpotRequestError('connection', 'state.get')

    expect(timeout.kind).toBe('timeout')
    expect(timeout.commandType).toBe('state.get')
    expect(interrupted.kind).toBe('connection')
    expect(interrupted).not.toEqual(timeout)
  })
})
