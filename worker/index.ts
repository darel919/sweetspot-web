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
      return env.ASSETS.fetch(request)
    }

    const m = path.match(/^\/api\/room\/([A-Za-z0-9-]{6,14})\/(register|commands|device|client|state)$/)
    if (!m) return json('{"error":"not_found"}', 404)
    const [, rawCode, action] = m
    if (!isValidPairCode(rawCode)) return invalidCode()

    const id = env.ROOM.idFromName(rawCode.replace(/-/g, '').toUpperCase())
    const stub = env.ROOM.get(id)
    return stub.fetch(new Request(`https://room/${action}${url.search}`, request))
  },
}
