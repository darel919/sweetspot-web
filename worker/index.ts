import { isValidPairCode } from '../shared/types/protocol'
export { RoomDO } from './room'

export interface Env {
  ROOM: DurableObjectNamespace
  ASSETS: Fetcher
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: JSON_HEADERS })
}

function invalidCode(): Response {
  return json('{"error":"invalid_code"}', 400)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (!path.startsWith('/api/')) {
      const res = await env.ASSETS.fetch(request)
      const headers = new Headers(res.headers)
      headers.set('x-robots-tag', 'noindex')
      return new Response(res.body, { ...res, headers })
    }

    const m = path.match(/^\/api\/room\/([A-Za-z0-9-]{6,14})\/ws$/)
    if (!m) return json('{"error":"not_found"}', 404)
    const [, rawCode] = m
    if (!isValidPairCode(rawCode)) return invalidCode()

    const id = env.ROOM.idFromName(rawCode.replace(/-/g, '').toUpperCase())
    const stub = env.ROOM.get(id)
    const target = `https://room/ws${url.search}`
    const body = request.method === 'GET' ? undefined : await request.text()
    const forwarded = new Request(target, {
      method: request.method,
      headers: request.headers,
      body,
    })
    return stub.fetch(forwarded)
  },
}
