export function addNoIndexHeader(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('x-robots-tag', 'noindex')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
