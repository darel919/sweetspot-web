import type { SignalingMessage } from '../shared/transport/signaling'

export const COMPLETED_RENDEZVOUS_RETENTION_MS = 60_000

export function isRendezvousExpired(active: boolean, expiresAt: number | undefined, now = Date.now()): boolean {
  return !active && typeof expiresAt === 'number' && expiresAt <= now
}

export function rendezvousCleanupAction(
  active: boolean,
  expiresAt: number | undefined,
  completedAt: number | undefined,
  now = Date.now(),
  retentionMs = COMPLETED_RENDEZVOUS_RETENTION_MS,
): 'wait' | 'cleanup' {
  if (isRendezvousExpired(active, expiresAt, now)) return 'cleanup'
  if (active && typeof completedAt === 'number' && completedAt + retentionMs <= now) return 'cleanup'
  return 'wait'
}

export function rendezvousNextAlarmAt(
  active: boolean,
  expiresAt: number | undefined,
  completedAt: number | undefined,
  retentionMs = COMPLETED_RENDEZVOUS_RETENTION_MS,
): number | undefined {
  if (active && typeof completedAt === 'number') return completedAt + retentionMs
  return expiresAt
}

export function rendezvousRecoveryAnchor(
  active: boolean,
  activeGeneration: string | undefined,
  candidateGeneration: string,
  now = Date.now(),
): number | undefined {
  return active && activeGeneration === candidateGeneration ? now : undefined
}

export function isActiveGenerationAllowed(activeGeneration: string | undefined, candidateGeneration: string): boolean {
  return typeof activeGeneration !== 'string' || activeGeneration === candidateGeneration
}

export function isConflictingSignalingGeneration(
  otherGeneration: string | undefined,
  candidateGeneration: string,
): boolean {
  return typeof otherGeneration === 'string' && otherGeneration !== candidateGeneration
}

export function shouldForwardSignalingMessage(message: SignalingMessage): boolean {
  return message.type === 'signal.offer'
    || message.type === 'signal.answer'
    || message.type === 'signal.ice'
}
