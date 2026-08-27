export function hasNewAcceptedEvidence(previous: number | string, current: number | string): boolean {
  if (typeof previous === 'string' && typeof current === 'string') return previous !== current
  if (typeof previous === 'number' && typeof current === 'number') return current > previous
  return true
}
