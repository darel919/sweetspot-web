import { describe, expect, test } from 'bun:test'
import { requiresRemoteContinue } from './plan'

describe('measurement position sequencing', () => {
  test('requires remote continuation only before the first take at a later position', () => {
    expect(requiresRemoteContinue({ positionIndex: 0, takeIndex: 0 })).toBe(false)
    expect(requiresRemoteContinue({ positionIndex: 1, takeIndex: 0 })).toBe(true)
    expect(requiresRemoteContinue({ positionIndex: 1, takeIndex: 1 })).toBe(false)
  })
})
