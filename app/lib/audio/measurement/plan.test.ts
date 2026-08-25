import { describe, expect, test } from 'bun:test'
import {
  createMeasurementPlan,
  createProbeMeasurementPlan,
  createRepairContext,
  createRetryContext,
  requiresRemoteContinue,
} from './plan'

describe('physical-position measurement sequencing', () => {
  test('plans three composite physical positions without duplicate takes', () => {
    const plan = createMeasurementPlan()

    expect(plan).toHaveLength(3)
    expect(plan.map((context) => context.positionId)).toEqual(['center', 'left', 'right'])
    expect(plan.every((context) => context.channel === 'both')).toBe(true)
    expect(plan.every((context) => context.captureKind === 'position-composite')).toBe(true)
    expect(plan.every((context) => context.repairChannel === 'both')).toBe(true)
    expect(plan.every((context) => context.attemptIndex === 0)).toBe(true)
  })

  test('requires TV continuation only when moving to a new full position', () => {
    const plan = createMeasurementPlan()

    expect(requiresRemoteContinue(plan[0]!)).toBe(false)
    expect(requiresRemoteContinue(plan[1]!)).toBe(true)
    expect(requiresRemoteContinue(createRepairContext(plan[1]!, 'right'))).toBe(false)
  })

  test('retries a position without changing its physical identity', () => {
    const original = createMeasurementPlan()[0]!
    const retry = createRetryContext(original)

    expect(retry).toMatchObject({
      positionId: 'center',
      captureKind: 'position-composite',
      repairChannel: 'both',
      attemptIndex: 1,
      attemptCount: 2,
    })
    expect(createRetryContext(retry!)).toBeNull()
  })

  test('probe plans remain composite and do not add duplicate takes', () => {
    expect(createProbeMeasurementPlan('transfer')).toHaveLength(1)
    expect(createProbeMeasurementPlan('routing').map((context) => context.positionId)).toEqual(['left', 'right'])
    expect(createProbeMeasurementPlan('routing').every((context) => context.channel === 'both')).toBe(true)
  })
})
