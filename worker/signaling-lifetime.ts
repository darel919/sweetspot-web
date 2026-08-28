export function isRendezvousExpired(active: boolean, expiresAt: number | undefined, now = Date.now()): boolean {
  return !active && typeof expiresAt === 'number' && expiresAt <= now
}

export function isActiveGenerationAllowed(activeGeneration: string | undefined, candidateGeneration: string): boolean {
  return typeof activeGeneration !== 'string' || activeGeneration === candidateGeneration
}
