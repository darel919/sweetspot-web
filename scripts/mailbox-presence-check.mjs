const base = (Bun.env.SWEETSPOT_MAILBOX_URL ?? 'https://sweetspot.darelisme.my.id').replace(/\/$/, '')
const room = `PRES${Date.now().toString(36).slice(-6).toUpperCase()}`
const sockets = []

function openSocket(role) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base}/api/room/${room}/ws?role=${role}`)
    const messages = []
    sockets.push(socket)
    socket.addEventListener('open', () => resolve({ socket, messages }))
    socket.addEventListener('message', (event) => {
      try {
        messages.push(JSON.parse(String(event.data)))
      } catch {
        reject(new Error(`${role} received malformed JSON`))
      }
    })
    socket.addEventListener('error', () => reject(new Error(`${role} WebSocket failed`)))
  })
}

async function waitForReady(connection) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const ready = connection.messages.find((message) => message.kind === 'room.ready')
    if (ready) return ready
    await Bun.sleep(25)
  }
  throw new Error('room.ready was not received')
}

try {
  await openSocket('device')
  const client = await openSocket('client')
  const ready = await waitForReady(client)
  if (ready.deviceOnline !== true) {
    throw new Error(`TV-first room.ready reported deviceOnline=${String(ready.deviceOnline)}`)
  }
  console.log(`PASS TV-first room.ready reported deviceOnline=true for ${room}`)
} finally {
  for (const socket of sockets) socket.close(1000, 'presence check complete')
}
