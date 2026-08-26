import { describe, expect, test } from 'bun:test'
import { enqueuePendingEnvelope, flushPendingEnvelopes } from './outbox'

type TestEnvelope = {
  id: string
  expiresAt?: number
}

describe('outbound envelope queue', () => {
  test('retains unsent envelopes until the socket accepts them', () => {
    const pending: TestEnvelope[] = [
      { id: 'prepare' },
      { id: 'play' },
    ]
    const attempted: string[] = []
    const sent: TestEnvelope[] = []
    let socketReady = false

    const dispatch = (envelope: TestEnvelope) => {
      attempted.push(envelope.id)
      if (!socketReady) return false
      sent.push(envelope)
      return true
    }

    const retained = flushPendingEnvelopes(pending, dispatch, 1_000)

    expect(sent).toEqual([])
    expect(attempted).toEqual(['prepare'])
    expect(retained).toEqual(pending)

    socketReady = true
    attempted.length = 0
    const remaining = flushPendingEnvelopes(retained, dispatch, 1_000)

    expect(sent).toEqual(pending)
    expect(attempted).toEqual(['prepare', 'play'])
    expect(remaining).toEqual([])
  })

  test('drops envelopes that expired while disconnected', () => {
    const pending: TestEnvelope[] = [
      { id: 'expired', expiresAt: 999 },
      { id: 'live', expiresAt: 1_001 },
    ]

    const remaining = flushPendingEnvelopes(pending, () => false, 1_000)

    expect(remaining).toEqual([{ id: 'live', expiresAt: 1_001 }])
  })

  test('bounds disconnected growth and coalesces state commands', () => {
    let pending: Array<TestEnvelope & { type: string }> = []
    for (let index = 0; index < 200; index++) {
      pending = enqueuePendingEnvelope(pending, { id: `message-${index}`, type: 'profile.save' }, 1_000, { max: 8 })
    }
    expect(pending).toHaveLength(8)
    expect(pending.at(-1)?.id).toBe('message-199')
    pending = enqueuePendingEnvelope(pending, { id: 'latest-bands', type: 'engine.setBands' }, 1_000, {
      max: 8,
      coalesceTypes: ['engine.setBands'],
    })
    pending = enqueuePendingEnvelope(pending, { id: 'newest-bands', type: 'engine.setBands' }, 1_000, {
      max: 8,
      coalesceTypes: ['engine.setBands'],
    })
    expect(pending.filter((item) => item.type === 'engine.setBands')).toEqual([{ id: 'newest-bands', type: 'engine.setBands' }])
  })
})
