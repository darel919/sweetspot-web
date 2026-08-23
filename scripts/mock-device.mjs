import WebSocket from 'ws'
const ws = new WebSocket('ws://localhost:3000/api/ws')
ws.on('open', () => ws.send(JSON.stringify({ v: 1, id: 'p1', type: 'session.hello', ts: Date.now(), payload: { role: 'device', room: 'TEST01' } })))
ws.on('message', (d) => {
  const env = JSON.parse(d.toString())
  if (env.type === 'state.get') {
    ws.send(JSON.stringify({
      v: 1, id: 'snap1', type: 'state.snapshot', ts: Date.now(), replyTo: env.id,
      payload: {
        device: { id: 'tv_4a61e8f1b90c', name: 'Living Room TV', appVersion: '0.2.0' },
        engine: { enabled: true, hasControl: true, activePreset: 1, presetName: 'Flat' },
        userEq: { bandsDb: [0, 0, 0], frequenciesHz: [20, 27, 36], minDb: -15, maxDb: 15 },
        calibration: { active: false, bandsDb: [], frequenciesHz: [] },
        profiles: [],
        capabilities: { channels: 2, calibrationBandCount: 64, userBandCount: 24, supportsSweep: true },
      },
    }))
    console.log('answered state.get')
  }
})
setTimeout(() => process.exit(0), 45000)
