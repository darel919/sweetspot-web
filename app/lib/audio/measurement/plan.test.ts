import { describe, expect, test } from 'bun:test'
import { isMeasurementContext } from '../../../../shared/types/protocol'
import {
  createMeasurementPlan,
  createMeasurementPlanForGroups,
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

  test('emits a complete TV measurement context for every planned position', () => {
    expect(createMeasurementPlan().every((context) => isMeasurementContext(context))).toBe(true)
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

  test('keeps absolute geometry when adaptive order skips from right to backward', () => {
    const plan = createMeasurementPlanForGroups([
      { positionId: 'center', positionIndex: 0, positionCount: 3, channel: 'both' },
      { positionId: 'right', positionIndex: 1, positionCount: 3, channel: 'both' },
      { positionId: 'backward', positionIndex: 2, positionCount: 3, channel: 'both' },
    ])

    expect(plan.map((context) => context.positionId)).toEqual(['center', 'right', 'backward'])
    expect(plan[2]).toMatchObject({ reference: 'center', xCm: 0, yCm: -10, zCm: -35 })
  })

  test('uses the center target for validation', () => {
    const [validation] = createMeasurementPlanForGroups([
      { positionId: 'center', positionIndex: 0, positionCount: 1, channel: 'both' },
    ], 'validation')

    expect(validation).toMatchObject({ phase: 'validation', reference: 'center', xCm: 0, yCm: 0, zCm: 0 })
  })

  test('probe plans keep composite transfer and routing separate from marker-only captures', () => {
    expect(createProbeMeasurementPlan('transfer')).toHaveLength(1)
    expect(createProbeMeasurementPlan('routing').map((context) => context.positionId)).toEqual(['left', 'right'])
    expect(createProbeMeasurementPlan('routing').every((context) => context.channel === 'both')).toBe(true)
    const markerPlan = createProbeMeasurementPlan('marker-only')
    expect(markerPlan.map((context) => context.positionId)).toEqual(['center', 'left', 'right', 'forward', 'backward'])
    expect(markerPlan.every((context) => context.captureKind === 'marker-only')).toBe(true)
    expect(markerPlan.every((context) => isMeasurementContext(context))).toBe(true)
    const productionSpacingPlan = createProbeMeasurementPlan('marker-production-spacing')
    expect(productionSpacingPlan).toHaveLength(5)
    expect(productionSpacingPlan.every((context) => context.captureKind === 'marker-production-spacing')).toBe(true)
  })
})
