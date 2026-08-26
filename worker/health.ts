const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

export function healthResponse(): Response {
  return new Response(JSON.stringify({ ok: true, websocketOnly: true }), {
    status: 200,
    headers: JSON_HEADERS,
  })
}
