import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { MicrophoneCapture } from './microphone'
import { createPcmRecorder, type PcmRecorder, type PcmRecorderOptions } from './pcm-recorder'

const captureSettings = {
  sampleRate: 48_000,
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
}

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null
  readonly messages: unknown[] = []

  postMessage(message: unknown): void {
    this.messages.push(message)
  }

  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }
}

class TestAudioWorkletNode {
  static latest: TestAudioWorkletNode | null = null
  readonly port = new TestPort()

  constructor() {
    TestAudioWorkletNode.latest = this
  }

  connect(): void {}

  disconnect(): void {}
}

class TestAudioContext {
  readonly sampleRate = captureSettings.sampleRate
  readonly audioWorklet = {
    addModule: async (): Promise<void> => undefined,
  }
  readonly destination = {}

  async resume(): Promise<void> {}

  async close(): Promise<void> {}

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: () => undefined, disconnect: () => undefined }
  }

  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }
  }
}

const originalGlobals = {
  audioContext: Object.getOwnPropertyDescriptor(globalThis, 'AudioContext'),
  audioWorkletNode: Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode'),
  fetch: Object.getOwnPropertyDescriptor(globalThis, 'fetch'),
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: TestAudioContext,
  })
  Object.defineProperty(globalThis, 'AudioWorkletNode', {
    configurable: true,
    value: TestAudioWorkletNode,
  })
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async () => new Response('test worklet'),
  })
})

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  Object.defineProperty(globalThis, name, descriptor ?? {
    configurable: true,
    value: undefined,
  })
}

afterAll(() => {
  restoreGlobal('AudioContext', originalGlobals.audioContext)
  restoreGlobal('AudioWorkletNode', originalGlobals.audioWorkletNode)
  restoreGlobal('fetch', originalGlobals.fetch)
})

function createCapture(): MicrophoneCapture {
  const track = {
    readyState: 'live',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  const capture = {
    stream: { getTracks: () => [track] },
    track,
    settings: captureSettings,
    capabilities: {
      sampleRate: null,
      channelCount: null,
      echoCancellation: [],
      noiseSuppression: [],
      autoGainControl: [],
    },
  }
  // SAFETY: The fake supplies every runtime member used by PcmRecorder, while DOM stream types are not constructible in Bun tests.
  return capture as unknown as MicrophoneCapture
}

function latestNode(): TestAudioWorkletNode {
  const node = TestAudioWorkletNode.latest
  if (!node) throw new Error('The recorder did not create an AudioWorkletNode.')
  return node
}

function emitPcm(node: TestAudioWorkletNode, samples: Float32Array): void {
  node.port.emit({ type: 'pcm', buffer: samples.slice().buffer })
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for the recorder.')
}

async function startRecorder(options: PcmRecorderOptions): Promise<{ recorder: PcmRecorder; node: TestAudioWorkletNode }> {
  const recorder = createPcmRecorder(createCapture(), options)
  await recorder.start()
  return { recorder, node: latestNode() }
}

function messageTypes(node: TestAudioWorkletNode): string[] {
  return node.port.messages.flatMap((message) => {
    if (typeof message !== 'object' || message === null || !('type' in message) || typeof message.type !== 'string') return []
    return [message.type]
  })
}

describe('PCM recorder streaming continuity', () => {
  test('keeps acquisition running during a temporary transport stall', async () => {
    let releaseFirst: (() => void) | null = null
    const firstChunk = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const received: number[] = []
    const { recorder, node } = await startRecorder({
      maxCaptureChunkBytes: 8 * 1024,
      onChunk: async (samples) => {
        received.push(samples[0] ?? -1)
        if (received.length === 1) await firstChunk
      },
    })
    expect(node.port.messages).toContainEqual({ type: 'start', maxCaptureChunkBytes: 8 * 1024 })

    emitPcm(node, new Float32Array([0]))
    await waitFor(() => received.length === 1)
    for (let index = 1; index < 8; index++) emitPcm(node, new Float32Array([index]))

    expect(messageTypes(node)).not.toContain('pause')
    expect(messageTypes(node)).not.toContain('resume')
    releaseFirst?.()
    await waitFor(() => received.length === 8)
    expect(received).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    await recorder.dispose()
  })

  test('fails explicitly and stops acquisition when the stream queue overruns', async () => {
    let releaseFirst: (() => void) | null = null
    const firstChunk = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const errors: Error[] = []
    let received = 0
    const { recorder, node } = await startRecorder({
      onChunk: async () => {
        received++
        if (received === 1) await firstChunk
      },
      onStreamError: (error) => errors.push(error),
    })

    emitPcm(node, new Float32Array([0]))
    await waitFor(() => received === 1)
    for (let index = 1; index < 9; index++) emitPcm(node, new Float32Array([index]))

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('The capture transport could not keep up. Retry this measurement without moving the phone.')
    expect(messageTypes(node)).toContain('stop')
    expect(messageTypes(node)).not.toContain('pause')
    const stopPromise = recorder.stop()
    node.port.emit({ type: 'stopped' })
    releaseFirst?.()
    await expect(stopPromise).rejects.toThrow('The capture transport could not keep up')
    await recorder.dispose()
  })
})
