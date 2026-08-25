import { describe, expect, test } from 'bun:test'
import { hasNewAcceptedEvidence } from './response-graph'

describe('measurement response graph emission', () => {
  test('emits only for captures that increase accepted evidence', () => {
    const captures = [
      { position: 'center', before: 0, after: 2 },
      { position: 'left', before: 2, after: 2 },
      { position: 'left retry', before: 2, after: 2 },
      { position: 'right', before: 2, after: 2 },
    ]

    const newGraphEvents = captures
      .filter((capture) => hasNewAcceptedEvidence(capture.before, capture.after))
      .map((capture) => capture.position)

    expect(newGraphEvents).toEqual(['center'])
  })
})
