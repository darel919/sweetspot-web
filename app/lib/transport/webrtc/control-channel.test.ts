import { describe, expect, test } from 'bun:test'
import { parseControlMessage } from './control-channel'

describe('WebRTC control channel parsing', () => {
  test('accepts capability messages separately from application envelopes', () => {
    const capability = parseControlMessage(JSON.stringify({
      kind: 'sweetspot.transport',
      type: 'hello',
      sessionId: 'session-1',
      capabilities: {
        protocolVersion: 1,
        transportVersion: 1,
        captureStreamVersion: 1,
        buildId: 'tv',
        channels: ['control', 'capture'],
        maxCaptureChunkBytes: 16_384,
        sessionId: 'session-1',
      },
    }))
    expect(capability.kind).toBe('capability')

    const envelope = parseControlMessage(JSON.stringify({
      v: 1,
      id: 'message-1',
      type: 'pong',
      ts: 1,
      payload: {},
    }))
    expect(envelope.kind).toBe('envelope')
  })

  test('rejects malformed, wrong-direction, and invalid payload messages', () => {
    expect(parseControlMessage('{').kind).toBe('error')
    expect(parseControlMessage(JSON.stringify({ v: 1, id: 'm', type: 'eq.set', ts: 1, payload: {} })).kind).toBe('error')
    expect(parseControlMessage(JSON.stringify({ v: 1, id: 'm', type: 'state.snapshot', ts: 1, payload: null })).kind).toBe('error')
  })
})
