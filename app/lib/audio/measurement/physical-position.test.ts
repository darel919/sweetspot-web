import { describe, expect, test } from 'bun:test'
import { CALIBRATION_POSITION_TARGETS } from '../../../../shared/types/protocol'
import { DEFAULT_POSITION_SPECS } from './physical-position'

describe('physical position instructions', () => {
  test('describe every target from the original center point', () => {
    const instructions = Object.fromEntries(DEFAULT_POSITION_SPECS.map((spec) => [spec.id, spec.instruction]))
    const normalized = Object.fromEntries(Object.entries(instructions).map(([id, text]) => [id, text.toLowerCase()]))

    expect(normalized.left).toContain('original center')
    expect(normalized.right).toContain('original center')
    expect(normalized.right).toContain('70 cm')
    expect(normalized.forward).toContain('toward the tv')
    expect(normalized.forward).toContain('10 cm')
    expect(normalized.backward).toContain('away from the tv')
    expect(normalized.backward).toContain('10 cm')
  })

  test('keeps the planner geometry in the shared target table', () => {
    expect(DEFAULT_POSITION_SPECS.map((spec) => spec.target)).toEqual([
      CALIBRATION_POSITION_TARGETS.center,
      CALIBRATION_POSITION_TARGETS.left,
      CALIBRATION_POSITION_TARGETS.right,
      CALIBRATION_POSITION_TARGETS.forward,
      CALIBRATION_POSITION_TARGETS.backward,
    ])
  })

  test('retry copy tells the user to stay at the same target', () => {
    const right = DEFAULT_POSITION_SPECS.find((spec) => spec.id === 'right')!

    expect(right.retryInstruction.toLowerCase()).toContain('same right-side position')
    expect(right.retryInstruction).toContain('Do not move')
  })
})
