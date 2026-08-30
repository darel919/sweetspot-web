import { describe, expect, test } from 'bun:test'
import { addNoIndexHeader } from './asset-response'
import { healthResponse } from './health'

describe('asset response boundary', () => {
  test('preserves a missing asset status while adding the robots header', async () => {
    const response = addNoIndexHeader(new Response('missing', { status: 404, statusText: 'Not Found' }))
    expect(response.status).toBe(404)
    expect(response.statusText).toBe('Not Found')
    expect(response.headers.get('x-robots-tag')).toBe('noindex')
    expect(await response.text()).toBe('missing')
  })
})

describe('worker readiness boundary', () => {
  test('exposes a non-authenticated health response', async () => {
    const response = healthResponse()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, signalingOnly: true })
  })
})
