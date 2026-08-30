import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const webRoot = resolve(import.meta.dirname, '..')
const androidRoot = resolve(webRoot, '../sweetspot')

const sources = new Map([
  ['web connection', resolve(webRoot, 'app/composables/connection/useSweetSpotConnection.ts')],
  ['browser WebRTC transport', resolve(webRoot, 'app/lib/transport/webrtc/peer.ts')],
  ['signaling router', resolve(webRoot, 'worker/index.ts')],
  ['signaling Durable Object', resolve(webRoot, 'worker/signaling.ts')],
  ['capture stream', resolve(webRoot, 'shared/transport/captureStream.ts')],
  ['Android peer transport', resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/transport/webrtc/WebRtcPeerTransport.kt')],
  ['Android signaling client', resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/transport/signaling/SignalingClient.kt')],
])

for (const [name, path] of sources) {
  const source = await readFile(path, 'utf8')
  if (source.includes('/api/room/') || source.includes('RoomDO') || source.includes('MailboxClient')) {
    throw new Error(`${name} contains a forbidden production relay path`)
  }
}

const browserTransport = await readFile(sources.get('browser WebRTC transport'), 'utf8')
for (const token of ['createDataChannel(CONTROL_CHANNEL', 'createDataChannel(CAPTURE_CHANNEL', 'bufferedAmount', 'bufferedamountlow']) {
  if (!browserTransport.includes(token)) throw new Error(`browser transport is missing ${token}`)
}

const worker = await readFile(sources.get('signaling Durable Object'), 'utf8')
if (worker.includes('Envelope') || worker.includes('ws.send(data)')) throw new Error('signaling worker must not carry application data')
if (!worker.includes('typeof message !== \'string\'')) throw new Error('signaling worker must reject binary application data')
if (!worker.includes('signal.offer') || !worker.includes('signal.answer') || !worker.includes('signal.ice')) {
  throw new Error('signaling worker is missing SDP/ICE forwarding')
}

const webFixture = await readFile(resolve(webRoot, 'test-vectors/calibration-capture-stream.json'), 'utf8')
const androidFixture = await readFile(resolve(androidRoot, 'app/src/test/resources/calibration-capture-stream.json'), 'utf8')
if (webFixture !== androidFixture) throw new Error('cross-repository capture fixture is out of sync')

for (const removed of [
  resolve(webRoot, 'worker/room.ts'),
  resolve(webRoot, 'scripts/mailbox-presence-check.mjs'),
  resolve(androidRoot, 'app/src/main/java/com/darelisme/sweetspot/MailboxClient.kt'),
]) {
  try {
    await access(removed)
    throw new Error(`forbidden relay artifact still exists: ${removed}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

console.log('Direct WebRTC transport contract verified')
