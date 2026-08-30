import { describe, expect, test } from 'bun:test'
import {
  COMPLETED_RENDEZVOUS_RETENTION_MS,
  isConflictingSignalingGeneration,
  isActiveGenerationAllowed,
  isRendezvousExpired,
  rendezvousCleanupAction,
  rendezvousNextAlarmAt,
  rendezvousRecoveryAnchor,
  shouldForwardSignalingMessage,
} from './signaling-lifetime'

describe('signaling rendezvous lifetime', () => {
  test('does not forward the client completion acknowledgement to the TV', () => {
    expect(shouldForwardSignalingMessage({ v: 1, type: 'signal.complete', generation: 'generation-1', attemptId: 'attempt-1' })).toBe(false)
    expect(shouldForwardSignalingMessage({
      v: 1,
      type: 'signal.offer',
      generation: 'generation-1',
      attemptId: 'attempt-1',
      description: { type: 'offer', sdp: 'v=0' },
    })).toBe(true)
  })

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

  test('allows the client hello to bind a device that has no client generation yet', () => {
    expect(isConflictingSignalingGeneration(undefined, 'generation-1')).toBe(false)
    expect(isConflictingSignalingGeneration('generation-1', 'generation-1')).toBe(false)
    expect(isConflictingSignalingGeneration('generation-1', 'generation-2')).toBe(true)
  })

  test('cleans completed rendezvous after bounded retention without ending the peer session', () => {
    const completedAt = 10_000
    expect(rendezvousCleanupAction(true, undefined, completedAt, completedAt + COMPLETED_RENDEZVOUS_RETENTION_MS - 1)).toBe('wait')
    expect(rendezvousCleanupAction(true, undefined, completedAt, completedAt + COMPLETED_RENDEZVOUS_RETENTION_MS)).toBe('cleanup')
    expect(rendezvousNextAlarmAt(true, undefined, completedAt)).toBe(completedAt + COMPLETED_RENDEZVOUS_RETENTION_MS)
  })

  test('refreshes bounded retention for a legitimate same-generation recovery', () => {
    const completedAt = 10_000
    const recoveryAt = completedAt + COMPLETED_RENDEZVOUS_RETENTION_MS
    const refreshedAt = rendezvousRecoveryAnchor(true, 'generation-1', 'generation-1', recoveryAt)

    expect(refreshedAt).toBe(recoveryAt)
    expect(rendezvousCleanupAction(true, undefined, refreshedAt, recoveryAt)).toBe('wait')
    expect(rendezvousNextAlarmAt(true, undefined, refreshedAt)).toBe(recoveryAt + COMPLETED_RENDEZVOUS_RETENTION_MS)
    expect(rendezvousRecoveryAnchor(true, 'generation-1', 'generation-2', recoveryAt)).toBeUndefined()
  })
})
