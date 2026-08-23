// Relay end-to-end check: device joins, client joins, state.get round trip,
// room isolation, envelope validation, reconnect.
import WebSocket from 'ws'

const BASE = 'ws://localhost:3000/api/ws'
const results = []
const sockets = []

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    sockets.push(ws)
  })
}

function send(ws, type, payload = {}, extra = {}) {
  const env = { v: 1, id: `t_${Math.random().toString(36).slice(2)}`, type, ts: Date.now(), payload, ...extra }
  ws.send(JSON.stringify(env))
  return env.id
}

function next(ws, pred, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs)
    const onMsg = (data) => {
      let env
      try { env = JSON.parse(data.toString()) } catch { return }
      if (!pred(env)) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(env)
    }
    ws.on('message', onMsg)
  })
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
}

try {
  // 1. device hello + welcome
  const device = await connect()
  device.send(JSON.stringify({ v: 1, id: 'd0', type: 'session.hello', ts: Date.now(), payload: { role: 'device', room: 'TEST01' } }))
  const dWelcome = await next(device, (e) => e.type === 'session.welcome')
  check('device welcome', dWelcome.payload.peers.deviceOnline === true)

  // 2. client hello + sees device online
  const client = await connect()
  client.send(JSON.stringify({ v: 1, id: 'c0', type: 'session.hello', ts: Date.now(), payload: { role: 'client', room: 'test-01' } }))
  const cWelcome = await next(client, (e) => e.type === 'session.welcome')
  check('client welcome normalizes test-01 to TEST01 room', cWelcome.payload.room === 'pair:TEST01' && cWelcome.payload.peers.deviceOnline === true)

  // 3. device got peerJoined for the client
  const dJoin = await next(device, (e) => e.type === 'session.peerJoined')
  check('device notified of client join', dJoin.payload.role === 'client')

  // 4. state.get round trip
  const reqId = send(client, 'state.get')
  const atDevice = await next(device, (e) => e.type === 'state.get')
  check('state.get routed to device', !!atDevice && atDevice.id === reqId)
  send(device, 'state.snapshot', {
    device: { id: 'tv_abc', name: 'Living Room TV', appVersion: '0.2.0' },
    engine: { enabled: true, hasControl: true, activePreset: 1, presetName: 'Flat' },
    userEq: { bandsDb: [], frequenciesHz: [], minDb: -15, maxDb: 15 },
    calibration: { active: false, bandsDb: [], frequenciesHz: [] },
    profiles: [],
    capabilities: { channels: 2, calibrationBandCount: 64, userBandCount: 24, supportsSweep: true },
  }, { replyTo: atDevice.id })
  const snap = await next(client, (e) => e.type === 'state.snapshot' && e.replyTo === reqId)
  check('state.snapshot returned to client', snap.payload.capabilities.calibrationBandCount === 64)

  // 5. room isolation: second pair code sees nothing of TEST01
  const stranger = await connect()
  stranger.send(JSON.stringify({ v: 1, id: 's0', type: 'session.hello', ts: Date.now(), payload: { role: 'client', room: 'OTHER9' } }))
  const sWelcome = await next(stranger, (e) => e.type === 'session.welcome')
  check('room isolation', sWelcome.payload.peers.deviceOnline === false && sWelcome.payload.peers.clients === 1)

  // 6. unknown type rejected
  send(stranger, 'totally.bogus')
  const err = await next(stranger, (e) => e.type === 'session.error')
  check('unknown type rejected', err.payload.code === 'unknown_type')

  // 7. wrong version rejected
  stranger.send(JSON.stringify({ v: 99, id: 'x', type: 'state.get', ts: Date.now(), payload: {} }))
  const verr = await next(stranger, (e) => e.type === 'session.error')
  check('wrong version flagged bad_envelope', verr.payload.code === 'bad_envelope')

  // 8. malformed JSON does not crash relay
  stranger.send('this is not json{{{')
  const jerr = await next(stranger, (e) => e.type === 'session.error')
  check('malformed JSON answered with error', jerr.payload.code === 'bad_envelope')

  // 9. oversized payload closes connection
  send(stranger, 'diagnostics.probe', { blob: 'x'.repeat(20000) })
  const closed = await new Promise((resolve) => stranger.once('close', resolve))
  check('oversized payload connection closed', typeof closed === 'number')

  // 10. second device in same room refused
  const device2 = await connect()
  device2.send(JSON.stringify({ v: 1, id: 'd2', type: 'session.hello', ts: Date.now(), payload: { role: 'device', room: 'TEST01' } }))
  const dupErr = await next(device2, (e) => e.type === 'session.error')
  check('second device refused', dupErr.payload.code === 'bad_envelope')

  // 11. device disconnect -> peerLeft reaches client; reconnect restores
  device.close()
  const leave = await next(client, (e) => e.type === 'session.peerLeft')
  check('client sees device leave', leave.payload.role === 'device')

  const device3 = await connect()
  device3.send(JSON.stringify({ v: 1, id: 'd3', type: 'session.hello', ts: Date.now(), payload: { role: 'device', room: 'TEST01' } }))
  await next(device3, (e) => e.type === 'session.welcome')
  const rejoin = await next(client, (e) => e.type === 'session.peerJoined')
  check('reconnected device announced', rejoin.payload.role === 'device')

  // 12. ping/pong
  send(device3, 'ping')
  const pong = await next(device3, (e) => e.type === 'pong')
  check('ping answered with pong', !!pong.id)

  // 13. rate limiting: hammer messages until kicked
  const hammer = await connect()
  hammer.send(JSON.stringify({ v: 1, id: 'h', type: 'session.hello', ts: Date.now(), payload: { role: 'client', room: 'SPAM01' } }))
  await next(hammer, (e) => e.type === 'session.welcome')
  let sawRateLimit = false
  hammer.on('message', (d) => { try { if (JSON.parse(d.toString()).payload?.code === 'rate_limited') sawRateLimit = true } catch {} })
  for (let i = 0; i < 80; i++) send(hammer, 'state.get')
  await new Promise((r) => setTimeout(r, 1500))
  check('rate limiter fires', sawRateLimit)
} catch (e) {
  check('unexpected failure', false, String(e))
} finally {
  for (const s of sockets) { try { s.terminate() } catch {} }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
