const SESSION_KEY_PREFIX = 'sweetspot:transport-session:'
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Keep a browser-tab generation stable across reloads of one pairing link. */
export function sessionIdForPairing(rendezvousId: string): string {
  const fallback = createSessionId()
  if (typeof window === 'undefined') return fallback
  try {
    const key = `${SESSION_KEY_PREFIX}${rendezvousId}`
    const existing = window.sessionStorage.getItem(key)
    if (existing && SESSION_ID_PATTERN.test(existing)) return existing
    window.sessionStorage.setItem(key, fallback)
  } catch {
    // Private browsing and embedded contexts may deny session storage.
  }
  return fallback
}
