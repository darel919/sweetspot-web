import { describe, expect, test } from 'bun:test'
import { decodeSignalingMessage, encodeSignalingMessage, isSignalingMessage } from './signaling'

const generation = 'browser-generation-1'
const attemptId = 'peer-attempt-1'

describe('signaling contract', () => {
  test('accepts only the SDP and ICE bootstrap messages', () => {
    expect(isSignalingMessage({ v: 1, type: 'signal.hello', generation })).toBe(true)
    expect(isSignalingMessage({
      v: 1,
      type: 'signal.offer',
      generation,
      attemptId,
      description: { type: 'offer', sdp: 'v=0' },
    })).toBe(true)
    expect(isSignalingMessage({ v: 1, type: 'signal.ready', role: 'client', peerOnline: true })).toBe(true)
    expect(isSignalingMessage({ v: 1, type: 'signal.ready', role: 'client', online: true })).toBe(false)
    expect(isSignalingMessage({ v: 1, type: 'signal.peer', role: 'device', online: true })).toBe(true)
    expect(isSignalingMessage({ v: 1, type: 'signal.peer', role: 'device', peerOnline: true })).toBe(false)
  })

  test('round trips a candidate and rejects oversized signaling data', () => {
    const encoded = encodeSignalingMessage({
      v: 1,
      type: 'signal.ice',
      generation,
      attemptId,
      candidate: { candidate: 'candidate:1 1 UDP 1 192.0.2.1 1234 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    })
    expect(decodeSignalingMessage(encoded)).toEqual(JSON.parse(encoded))
    expect(decodeSignalingMessage(JSON.stringify({
      v: 1,
      type: 'signal.offer',
      generation,
      attemptId,
      description: { type: 'offer', sdp: 'x'.repeat(64 * 1024) },
    }))).toBeNull()
  })
})
