import { isRendezvousId } from '../shared/transport/signaling'
import { SignalingDO } from './signaling'
export { SignalingDO }
import { addNoIndexHeader } from './asset-response'
import { healthResponse } from './health'

export interface Env {
  SIGNALING: DurableObjectNamespace
  ASSETS: Fetcher
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }
function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: JSON_HEADERS })
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

    const match = path.match(/^\/api\/signaling\/([a-f0-9]{32})\/ws$/)
    if (!match || !match[1] || !isRendezvousId(match[1])) return json('{"error":"not_found"}', 404)
    const id = env.SIGNALING.idFromName(match[1])
    const stub = env.SIGNALING.get(id)
    const target = new URL(request.url)
    target.pathname = '/ws'
    return stub.fetch(new Request(target, request))
  },
}
