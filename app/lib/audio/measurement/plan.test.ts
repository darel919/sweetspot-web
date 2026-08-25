import { describe, expect, test } from 'bun:test'
import { createMeasurementPlan, createRetryContext, createThirdTakeContext, requiresRemoteContinue } from './plan'

describe('measurement position sequencing', () => {
  test('requires remote continuation only before the first take at a later position', () => {
    expect(requiresRemoteContinue({ positionIndex: 0, takeIndex: 0 })).toBe(false)
    expect(requiresRemoteContinue({ positionIndex: 1, takeIndex: 0 })).toBe(true)
    expect(requiresRemoteContinue({ positionIndex: 1, takeIndex: 1 })).toBe(false)
  })

  test('changes only attempt metadata when retrying a logical take', () => {
    const original = createMeasurementPlan(2)[0]
    if (!original) throw new Error('Expected a planned context.')
    const retry = createRetryContext(original)
    expect(retry).toMatchObject({
      positionId: original.positionId,
      channel: original.channel,
      takeIndex: original.takeIndex,
      takeCount: original.takeCount,
      attemptIndex: 1,
      attemptCount: 2,
    })
    if (!retry) throw new Error('Expected one bounded retry.')
    expect(createRetryContext(retry)).toBeNull()
  })

  test('adaptive third take starts a fresh attempt budget and never creates a fourth take', () => {
    const first = createMeasurementPlan(2)[0]
    if (!first) throw new Error('Expected a planned context.')
    const third = createThirdTakeContext(first)
    const thirdRetry = createRetryContext(third)

    expect(third).toMatchObject({ takeIndex: 2, takeCount: 3, attemptIndex: 0, attemptCount: 2 })
    expect(thirdRetry).toMatchObject({ takeIndex: 2, takeCount: 3, attemptIndex: 1, attemptCount: 2 })
    if (!thirdRetry) throw new Error('Expected one bounded retry for the adaptive take.')
    expect(createRetryContext(thirdRetry)).toBeNull()
    expect(createThirdTakeContext(third).takeIndex).toBe(2)
  })
})
