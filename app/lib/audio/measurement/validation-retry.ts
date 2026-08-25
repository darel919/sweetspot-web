export type ValidationRepairChannel = 'left' | 'right' | 'both'

export function validationRepairChannel(failedChannels: readonly ('left' | 'right')[]): ValidationRepairChannel | null {
  if (failedChannels.length === 0) return null
  if (failedChannels.includes('left') && failedChannels.includes('right')) return 'both'
  return failedChannels[0] ?? null
}
