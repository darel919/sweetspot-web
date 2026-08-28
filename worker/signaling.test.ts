import { describe, expect, test } from 'bun:test'
import { isActiveGenerationAllowed, isRendezvousExpired } from './signaling-lifetime'

describe('signaling rendezvous lifetime', () => {
  test('expires unused credentials but keeps an authenticated peer generation alive', () => {
    expect(isRendezvousExpired(false, 1_000, 1_001)).toBe(true)
    expect(isRendezvousExpired(true, 1_000, 1_001)).toBe(false)
    expect(isRendezvousExpired(false, 2_000, 1_001)).toBe(false)
  })

  test('rejects a different generation while an active peer is fenced', () => {
    expect(isActiveGenerationAllowed(undefined, 'generation-1')).toBe(true)
    expect(isActiveGenerationAllowed('generation-1', 'generation-1')).toBe(true)
    expect(isActiveGenerationAllowed('generation-1', 'generation-2')).toBe(false)
  })
})
