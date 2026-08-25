export interface ExpiringEnvelope {
  expiresAt?: number
}

export function flushPendingEnvelopes<T extends ExpiringEnvelope>(
  pending: readonly T[],
  dispatch: (envelope: T) => boolean,
  now: number,
): T[] {
  const remaining: T[] = []
  let dispatchBlocked = false

  for (const envelope of pending) {
    if (envelope.expiresAt !== undefined && envelope.expiresAt <= now) continue

    if (dispatchBlocked) {
      remaining.push(envelope)
      continue
    }

    if (!dispatch(envelope)) {
      remaining.push(envelope)
      dispatchBlocked = true
    }
  }

  return remaining
}
