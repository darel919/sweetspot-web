export class EqCommandRevisionGate {
  private nextRevision = 0
  private pendingRevision = 0
  private lastSettledRevision = 0
  private readonly revisions = new Map<string, number>()

  track(commandId: string): void {
    const revision = ++this.nextRevision
    this.pendingRevision = revision
    this.revisions.set(commandId, revision)
  }

  shouldApply(replyTo?: string): boolean {
    const revision = replyTo === undefined ? undefined : this.revisions.get(replyTo)
    if (revision === undefined) return this.pendingRevision === 0
    if (revision <= this.lastSettledRevision) return false
    return this.pendingRevision === 0 || revision >= this.pendingRevision
  }

  settle(replyTo: string): void {
    const revision = this.revisions.get(replyTo)
    if (revision === undefined) return
    this.lastSettledRevision = Math.max(this.lastSettledRevision, revision)
    if (revision >= this.pendingRevision) this.pendingRevision = 0
  }

  abandonPending(): void {
    this.lastSettledRevision = Math.max(this.lastSettledRevision, this.pendingRevision)
    this.pendingRevision = 0
  }
}
