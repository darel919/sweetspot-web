import { describe, expect, test } from 'bun:test'
import { addNoIndexHeader } from './asset-response'

describe('asset response boundary', () => {
  test('preserves a missing asset status while adding the robots header', async () => {
    const response = addNoIndexHeader(new Response('missing', { status: 404, statusText: 'Not Found' }))
    expect(response.status).toBe(404)
    expect(response.statusText).toBe('Not Found')
    expect(response.headers.get('x-robots-tag')).toBe('noindex')
    expect(await response.text()).toBe('missing')
  })
})
