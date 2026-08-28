const SESSION_KEY_PREFIX = 'sweetspot:transport-session:'
const WINDOW_NAME_PREFIX = 'sweetspot:transport-sessions:'
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const MAX_WINDOW_NAME_SESSIONS = 8

function createSessionId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Keep one browser-tab generation stable across reloads of one pairing link. */
export function sessionIdForPairing(rendezvousId: string): string {
  const fallback = createSessionId()
  if (typeof window === 'undefined') return fallback
  const key = `${SESSION_KEY_PREFIX}${rendezvousId}`
  try {
    const store = window.sessionStorage
    const existing = store.getItem(key)
    if (existing && SESSION_ID_PATTERN.test(existing)) return existing
    store.setItem(key, fallback)
    return fallback
  } catch {
    return sessionIdFromWindowName(rendezvousId, fallback)
  }
}

function sessionIdFromWindowName(rendezvousId: string, fallback: string): string {
  try {
    const current = window.name
    if (current && !current.startsWith(WINDOW_NAME_PREFIX)) return fallback
    const encoded = current.slice(WINDOW_NAME_PREFIX.length)
    const parsed = encoded ? JSON.parse(encoded) as unknown : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
    const sessions = Object.fromEntries(Object.entries(parsed)
      .filter(([key, value]) => key.length <= 128 && SESSION_ID_PATTERN.test(String(value)))
      .map(([key, value]) => [key, String(value)]))
    const existing = sessions[rendezvousId]
    if (existing) return existing
    sessions[rendezvousId] = fallback
    const limited = Object.fromEntries(Object.entries(sessions).slice(-MAX_WINDOW_NAME_SESSIONS))
    window.name = `${WINDOW_NAME_PREFIX}${JSON.stringify(limited)}`
  } catch {
    return fallback
  }
  return fallback
}
