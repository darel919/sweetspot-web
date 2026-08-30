import { describe, expect, test } from 'bun:test'
import { Sha256 } from './sha256'

describe('Sha256', () => {
  test('matches the empty digest', () => {
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('supports incremental updates with arbitrary boundaries', () => {
    const hash = new Sha256()
    hash.update(new TextEncoder().encode('a'))
    hash.update(new TextEncoder().encode('bc'))
    expect(hash.digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('matches the standard multi-block vector', () => {
    const hash = new Sha256()
    const block = new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
    hash.update(block)
    expect(hash.digestHex()).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })
})
