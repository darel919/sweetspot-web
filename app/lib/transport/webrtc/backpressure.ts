export interface CaptureQueueOptions {
  maxFrames: number
  highWaterBytes: number
  send: (frame: ArrayBuffer) => number
}

interface PendingFrame {
  frame: ArrayBuffer
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abortListener?: () => void
}

/** Bounded FIFO for capture frames. Control traffic never enters this queue. */
export class BoundedCaptureQueue {
  private readonly options: CaptureQueueOptions
  private readonly pending: PendingFrame[] = []
  private bufferedAmount = 0
  private pumping = false

  constructor(options: CaptureQueueOptions) {
    if (!Number.isInteger(options.maxFrames) || options.maxFrames < 1) throw new RangeError('Capture queue capacity is invalid')
    if (!Number.isInteger(options.highWaterBytes) || options.highWaterBytes < 1) throw new RangeError('Capture queue high water mark is invalid')
    this.options = options
  }

  get pendingFrames(): number {
    return this.pending.length
  }

  enqueue(frame: ArrayBuffer, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.pending.length >= this.options.maxFrames) {
      return Promise.reject(new Error('The capture buffer is full.'))
    }
    if (options.signal?.aborted) return Promise.reject(new Error('The capture upload was cancelled.'))
    return new Promise((resolve, reject) => {
      let item: PendingFrame
      item = {
        frame,
        resolve,
        reject,
        timeout: setTimeout(() => this.expire(item), 15_000),
        signal: options.signal,
      }
      if (item.signal) {
        item.abortListener = () => this.remove(item, new Error('The capture upload was cancelled.'))
        item.signal.addEventListener('abort', item.abortListener, { once: true })
      }
      this.pending.push(item)
      this.pump()
    })
  }

  updateBufferedAmount(value: number): void {
    this.bufferedAmount = Math.max(0, value)
    this.pump()
  }

  reset(error = new Error('The direct capture channel closed during upload.')): void {
    const pending = this.pending.splice(0)
    for (const item of pending) {
      this.clearTimers(item)
      item.reject(error)
    }
    this.bufferedAmount = 0
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.pending.length > 0) {
        const next = this.pending[0]
        if (!next) return
        if (this.bufferedAmount + next.frame.byteLength > this.options.highWaterBytes) return
        this.pending.shift()
        try {
          this.bufferedAmount = Math.max(0, this.options.send(next.frame))
          this.clearTimers(next)
          next.resolve()
        } catch (error: unknown) {
          this.clearTimers(next)
          next.reject(error instanceof Error ? error : new Error('The direct capture channel rejected the chunk.'))
        }
      }
    } finally {
      this.pumping = false
    }
  }

  private expire(item: PendingFrame): void {
    const index = this.pending.indexOf(item)
    if (index < 0) return
    this.pending.splice(index, 1)
    this.clearTimers(item)
    item.reject(new Error('The direct capture channel did not drain.'))
    this.pump()
  }

  private remove(item: PendingFrame, error: Error): void {
    const index = this.pending.indexOf(item)
    if (index < 0) return
    this.pending.splice(index, 1)
    this.clearTimers(item)
    item.reject(error)
    this.pump()
  }

  private clearTimers(item: PendingFrame): void {
    clearTimeout(item.timeout)
    if (item.signal && item.abortListener) item.signal.removeEventListener('abort', item.abortListener)
    item.abortListener = undefined
  }
}
