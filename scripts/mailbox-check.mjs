// Long-poll wake test: device blocks on /commands; a client post must wake it instantly.
const base = 'http://localhost:8787/api/room/TEST01'

async function j(url, opts) {
  const t0 = Date.now()
  const res = await fetch(url, opts)
  const body = await res.json()
  return { ms: Date.now() - t0, status: res.status, body }
}

// Start device long-poll in parallel (8s wait)
const lpPromise = j(`${base}/commands?wait=8`)
await new Promise((r) => setTimeout(r, 500))
const post = await j(`${base}/client`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ v: 1, id: 'c2', type: 'state.get', ts: Date.now(), payload: {} }),
})
console.log('post:', post.status, `${post.ms}ms`)
const lp = await lpPromise
console.log('long-poll returned after', lp.ms, 'ms:', JSON.stringify(lp.body).slice(0, 160))
if (lp.body.commands?.[0]?.id === 'c2' && lp.ms < 2000) {
  console.log('PASS long-poll wakes instantly')
} else {
  console.log('FAIL'); process.exit(1)
}
