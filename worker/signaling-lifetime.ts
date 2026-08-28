import type { SignalingMessage } from '../shared/transport/signaling'

export function isRendezvousExpired(active: boolean, expiresAt: number | undefined, now = Date.now()): boolean {
  return !active && typeof expiresAt === 'number' && expiresAt <= now
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
