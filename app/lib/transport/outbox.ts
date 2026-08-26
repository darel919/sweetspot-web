export interface ExpiringEnvelope {
  expiresAt?: number
}

export const MAX_PENDING_ENVELOPES = 128

export function enqueuePendingEnvelope<T extends ExpiringEnvelope & { type?: string }>(
  pending: readonly T[],
  envelope: T,
  now: number,
  options: { max?: number; coalesceTypes?: readonly string[] } = {},
): T[] {
  if (envelope.expiresAt !== undefined && envelope.expiresAt <= now) return [...pending].filter((item) => item.expiresAt === undefined || item.expiresAt > now)
  const coalesceTypes = options.coalesceTypes ?? []
  const filtered = pending.filter((item) => item.expiresAt === undefined || item.expiresAt > now)
  const withoutCoalesced = envelope.type !== undefined && coalesceTypes.includes(envelope.type)
    ? filtered.filter((item) => item.type !== envelope.type)
    : filtered
  const max = options.max ?? MAX_PENDING_ENVELOPES
  return [...withoutCoalesced, envelope].slice(-Math.max(1, max))
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
