export type SweetSpotRequestErrorKind = 'timeout' | 'aborted' | 'connection' | 'disposed' | 'protocol'

export class SweetSpotRequestError extends Error {
  readonly kind: SweetSpotRequestErrorKind
  readonly commandType: string

  constructor(kind: SweetSpotRequestErrorKind, commandType: string) {
    super(`Request ${kind}: ${commandType}`)
    this.name = 'SweetSpotRequestError'
    this.kind = kind
    this.commandType = commandType
  }
}
