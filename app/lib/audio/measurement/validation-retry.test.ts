import { describe, expect, test } from 'bun:test'
import { validationRepairChannel } from './validation-retry'

describe('validation repair channel selection', () => {
  test('retries both routed channels when both fail', () => {
    expect(validationRepairChannel(['left', 'right'])).toBe('both')
  })

  test('repairs only the failed channel when its sibling passed', () => {
    expect(validationRepairChannel(['left'])).toBe('left')
    expect(validationRepairChannel(['right'])).toBe('right')
  })

  test('does not schedule a repair when no channel failed', () => {
    expect(validationRepairChannel([])).toBeNull()
  })
})