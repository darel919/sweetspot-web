import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const webRoot = resolve(import.meta.dirname, '..')
const androidRoot = resolve(webRoot, '../sweetspot')

const sources = new Map([
  ['web connection', resolve(webRoot, 'app/composables/useSweetSpotConnection.ts')],
  ['Worker router', resolve(webRoot, 'worker/index.ts')],
  ['room Durable Object', resolve(webRoot, 'worker/room.ts')],
  ['protocol types', resolve(webRoot, 'shared/types/protocol.ts')],
  ['Android mailbox', resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/MailboxClient.kt')],
])

const forbidden = [
  'HTTP fallback',
  'legacyHeartbeat',
  'fallbackPolling',
  'startPolling',
  'startHttpFallback',
  'pollLoop',
  'room.ping',
  "'/register'",
  "'/commands'",
  "'/device'",
  "'/client'",
  "'/state'",
]

for (const [name, path] of sources) {
  const source = await readFile(path, 'utf8')
  for (const token of forbidden) {
    if (source.includes(token)) throw new Error(`${name} contains obsolete transport token ${token}`)
  }
}

const protocol = await readFile(sources.get('protocol types'), 'utf8')
if (!protocol.includes('role: Role')) throw new Error('room.ready must require a role')
if (protocol.includes('role?: Role')) throw new Error('room.ready still accepts an unlabeled role')

console.log('WebSocket-only transport contract verified')
