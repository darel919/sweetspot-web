import { DurableObject } from 'cloudflare:workers'
import {
  MAX_PAYLOAD_BYTES,
  KNOWN_TYPES,
  SESSION_ONLY_TYPES,
  isDeviceTargeted,
  isValidPairCode,
  type Envelope,
  type ErrorPayload,
} from '../shared/types/protocol'

const DEVICE_TTL_MS = 15_000
const MAX_QUEUE = 32
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 60

interface Waiter {
  resolve: (v: string) => void
  timer: number
}

interface ConnState {
  role: 'device' | 'client'
  stamps: number[]
}

export class RoomDO {
  state: DurableObjectState
  deviceSeenAt = 0
  commands: Envelope[] = []
  forClients: Array<{ env: Envelope; at: number }> = []
  waiters = new Set<Waiter>()
  connStates = new Map<string, ConnState>()

  constructor(state: DurableObjectState) {
    this.state = state
  }

  rateLimited(key: string): boolean {
    const now = Date.now()
    let cs = this.connStates.get(key)
    if (!cs) {
      cs = { role: 'client', stamps: [] }
      this.connStates.set(key, cs)
    }
    cs.stamps = cs.stamps.filter((t) => now - t < RATE_WINDOW_MS)
    cs.stamps.push(now)
    return cs.stamps.length > RATE_MAX
  }

  validate(env: unknown): { ok: true; env: Envelope } | { ok: false; code: ErrorPayload['code']; message: string } {
    const e = env as Partial<Envelope>
    if (!e || e.v !== 1 || typeof e.id !== 'string' || typeof e.type !== 'string') {
      return { ok: false, code: 'bad_envelope', message: 'envelope requires v=1, id and type strings' }
    }
    if (!KNOWN_TYPES.has(e.type)) {
      return { ok: false, code: 'unknown_type', message: `unsupported message type "${e.type}"` }
    }
    if (SESSION_ONLY_TYPES.has(e.type)) {
      return { ok: false, code: 'bad_envelope', message: `"${e.type}" is session-scoped and not routed` }
    }
    return { ok: true, env: e as Envelope }
  }

  deviceOnline(): boolean {
    return Date.now() - this.deviceSeenAt < DEVICE_TTL_MS
  }

  wake() {
    for (const w of this.waiters) {
      clearTimeout(w.timer)
      w.resolve('')
    }
    this.waiters.clear()
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/register' && request.method === 'POST') {
      this.deviceSeenAt = Date.now()
      return Response.json({ ok: true })
    }

    if (path === '/commands' && request.method === 'GET') {
      this.deviceSeenAt = Date.now()
      const waitS = Math.min(parseFloat(url.searchParams.get('wait') ?? '9') || 9, 25)
      if (this.commands.length > 0) {
        const out = this.commands
        this.commands = []
        return Response.json({ commands: out })
      }
      if (waitS <= 0) return Response.json({ commands: [] })
      const result = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(w)
          resolve('')
        }, waitS * 1000)
        const w: Waiter = { resolve, timer }
        this.waiters.add(w)
      })
      if (result) return Response.json(result)
      return Response.json({ commands: this.commands.splice(0, this.commands.length) })
    }

    if (path === '/device' && request.method === 'POST') {
      const body = await request.text()
      if (body.length > MAX_PAYLOAD_BYTES) {
        return Response.json({ error: 'payload_too_large' }, { status: 413 })
      }
      let env: unknown
      try {
        env = JSON.parse(body)
      } catch {
        return Response.json({ error: 'bad_json' }, { status: 400 })
      }
      const v = this.validate(env)
      if (!v.ok) return Response.json({ error: v.code, message: v.message }, { status: 400 })
      this.forClients.push({ env: v.env, at: Date.now() })
      if (this.forClients.length > MAX_QUEUE) this.forClients.splice(0, this.forClients.length - MAX_QUEUE)
      return Response.json({ ok: true })
    }

    if (path === '/client' && request.method === 'POST') {
      const body = await request.text()
      if (body.length > MAX_PAYLOAD_BYTES) {
        return Response.json({ error: 'payload_too_large' }, { status: 413 })
      }
      let env: unknown
      try {
        env = JSON.parse(body)
      } catch {
        return Response.json({ error: 'bad_json' }, { status: 400 })
      }
      const v = this.validate(env)
      if (!v.ok) return Response.json({ error: v.code, message: v.message }, { status: 400 })
      if (!isDeviceTargeted(v.env.type)) {
        return Response.json({ error: 'unknown_type', message: `clients may only send device-targeted types` }, { status: 400 })
      }
      this.commands.push(v.env)
      if (this.commands.length > MAX_QUEUE) this.commands.splice(0, this.commands.length - MAX_QUEUE)
      this.wake()
      return Response.json({ ok: true })
    }

    if (path === '/state' && request.method === 'GET') {
      const since = parseInt(url.searchParams.get('since') ?? '0') || 0
      const messages = this.forClients.filter((m) => m.at > since).map((m) => m.env)
      return Response.json({ deviceOnline: this.deviceOnline(), messages })
    }

    return new Response('not found', { status: 404 })
  }
}
