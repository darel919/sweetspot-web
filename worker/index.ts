import { isValidPairCode, normalizePairCode } from '../shared/types/protocol'
import { RoomDO } from './room'
export { RoomDO }
import { addNoIndexHeader } from './asset-response'
import { healthResponse } from './health'

export interface Env {
  ROOM: DurableObjectNamespace
  ASSETS: Fetcher
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
const ALLOWED_DEV_CLIENT_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
])

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: JSON_HEADERS })
}

function invalidCode(): Response {
  return json('{"error":"invalid_code"}', 400)
}

function clientOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('Origin')
  if (origin === null) return false
  return origin === new URL(request.url).origin || ALLOWED_DEV_CLIENT_ORIGINS.has(origin)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'GET' && path === '/api/health') return healthResponse()

    if (!path.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request)
      return addNoIndexHeader(res)
    }

    const m = path.match(/^\/api\/room\/([A-Za-z0-9-]{6,14})\/ws$/)
    if (!m) return json('{"error":"not_found"}', 404)
    const [, rawCode] = m
    if (!rawCode || !isValidPairCode(rawCode)) return invalidCode()

    const role = url.searchParams.get('role')
    if (role !== 'client' && role !== 'device') return json('{"error":"invalid_role"}', 400)
    if (role === 'client' && !clientOriginAllowed(request)) return json('{"error":"origin_rejected"}', 403)

    const pairCode = normalizePairCode(rawCode)
    const id = env.ROOM.idFromName(pairCode)
    const stub = env.ROOM.get(id)
    const headers = new Headers(request.headers)
    headers.set('X-SweetSpot-Remote-Address', request.headers.get('CF-Connecting-IP') ?? 'unknown')
    const target = `https://room/ws?role=${role}`
    const forwarded = new Request(target, {
      method: request.method,
      headers,
    })
    return stub.fetch(forwarded)
  },
}
