import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'

const workletSource = await Bun.file('public/calibration-capture-worklet.js').text()

class TestPort {
  onmessage = null
  messages = []

  postMessage(message) {
    this.messages.push(message)
  }

  emit(data) {
    this.onmessage?.({ data })
  }
}

class TestAudioWorkletProcessor {
  constructor() {
    this.port = new TestPort()
  }
}

let WorkletProcessor = null
runInNewContext(workletSource, {
  AudioWorkletProcessor: TestAudioWorkletProcessor,
  registerProcessor(_name, processor) {
    WorkletProcessor = processor
  },
})

function createProcessor() {
  if (!WorkletProcessor) throw new Error('The capture worklet did not register a processor.')
  return new WorkletProcessor()
}

function pcmMessages(processor) {
  return processor.port.messages.filter((message) => message.type === 'pcm')
}

describe('calibration capture worklet', () => {
  test('coalesces input into bounded Float32 payloads', () => {
    const processor = createProcessor()
    processor.port.emit({ type: 'start', maxCaptureChunkBytes: 8 * 1024 })
    processor.process([[Float32Array.from({ length: 1024 }, (_, index) => index)]], [])
    expect(pcmMessages(processor)).toHaveLength(0)

    processor.process([[Float32Array.from({ length: 1024 }, (_, index) => -index)]], [])
    const messages = pcmMessages(processor)

    expect(messages).toHaveLength(1)
    expect(messages[0].buffer.byteLength).toBe(8 * 1024)
    expect(messages[0].buffer.byteLength).toBeGreaterThanOrEqual(8 * 1024)
    expect(messages[0].buffer.byteLength).toBeLessThanOrEqual(16 * 1024)
    expect(Array.from(new Float32Array(messages[0].buffer).slice(0, 3))).toEqual([0, 1, 2])
  })

  test('flushes the final partial block before reporting stopped', () => {
    const processor = createProcessor()
    processor.port.emit({ type: 'start', maxCaptureChunkBytes: 16 * 1024 })
    const input = Float32Array.from({ length: 3 * 1024 }, (_, index) => index / 10)

    processor.process([[input]], [])
    processor.port.emit({ type: 'stop' })
    processor.process([], [])

    const messages = processor.port.messages
    expect(messages.map((message) => message.type)).toEqual(['pcm', 'stopped'])
    expect(messages[0].buffer.byteLength).toBe(input.byteLength)
    const samples = new Float32Array(messages[0].buffer)
    expect(samples[0]).toBe(0)
    expect(samples[1]).toBeCloseTo(0.1)
    expect(samples[2]).toBeCloseTo(0.2)
  })
})
