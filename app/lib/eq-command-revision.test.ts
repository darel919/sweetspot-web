import { describe, expect, test } from 'bun:test'
import { EqCommandRevisionGate } from './eq-command-revision'

describe('EQ command snapshot ordering', () => {
  test('ignores an older reply after the newest EQ command has been sent', () => {
    const gate = new EqCommandRevisionGate()
    gate.track('eq-1')
    gate.track('eq-2')

    expect(gate.shouldApply('eq-1')).toBe(false)
    expect(gate.shouldApply('eq-2')).toBe(true)

    gate.settle('eq-2')
    expect(gate.shouldApply('eq-1')).toBe(false)
  })

  test('does not apply an unrelated snapshot while an EQ command is pending', () => {
    const gate = new EqCommandRevisionGate()
    gate.track('eq-1')

    expect(gate.shouldApply('state-1')).toBe(false)

    gate.abandonPending()
    expect(gate.shouldApply('state-2')).toBe(true)
  })
})
