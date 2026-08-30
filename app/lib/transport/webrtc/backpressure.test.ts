import { describe, expect, test } from 'bun:test'
import { BoundedCaptureQueue } from './backpressure'

describe('bounded capture backpressure', () => {
  test('stops accepting frames at the queue limit and resumes at low water', async () => {
    let buffered = 8
    const sent: ArrayBuffer[] = []
    const queue = new BoundedCaptureQueue({
      maxFrames: 3,
      highWaterBytes: 10,
      send: (frame) => {
        sent.push(frame)
        buffered += frame.byteLength
        return buffered
      },
    })
    queue.updateBufferedAmount(buffered)
    const first = queue.enqueue(new ArrayBuffer(4))
    const second = queue.enqueue(new ArrayBuffer(4))
    const third = queue.enqueue(new ArrayBuffer(4))
    const fourth = queue.enqueue(new ArrayBuffer(4))

    expect(queue.pendingFrames).toBe(3)
    await expect(fourth).rejects.toThrow('buffer is full')
    expect(sent).toHaveLength(0)

    buffered = 0
    queue.updateBufferedAmount(buffered)
    await first
    await second
    expect(sent).toHaveLength(2)
    expect(queue.pendingFrames).toBe(1)

    buffered = 0
    queue.updateBufferedAmount(buffered)
    await third
    expect(queue.pendingFrames).toBe(0)
  })

  test('rejects pending frames when the peer closes', async () => {
    const queue = new BoundedCaptureQueue({
      maxFrames: 2,
      highWaterBytes: 4,
      send: () => 4,
    })
    queue.updateBufferedAmount(4)
    const pending = queue.enqueue(new ArrayBuffer(4))
    queue.reset()
    await expect(pending).rejects.toThrow('closed during upload')
    expect(queue.pendingFrames).toBe(0)
  })

  test('cancels a pending frame without waiting for the drain timeout', async () => {
    const queue = new BoundedCaptureQueue({
      maxFrames: 2,
      highWaterBytes: 4,
      send: () => 4,
    })
    queue.updateBufferedAmount(4)
    const controller = new AbortController()
    const pending = queue.enqueue(new ArrayBuffer(4), { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('upload was cancelled')
    expect(queue.pendingFrames).toBe(0)
  })
})
