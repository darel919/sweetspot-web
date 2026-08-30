const DEFAULT_MAX_CAPTURE_CHUNK_BYTES = 16 * 1024
const FLOAT32_BYTES = Float32Array.BYTES_PER_ELEMENT

function validChunkBytes(value) {
  return Number.isInteger(value)
    && value > 0
    && value <= DEFAULT_MAX_CAPTURE_CHUNK_BYTES
    && value % FLOAT32_BYTES === 0
}

class SweetSpotPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false
    this.stopRequested = false
    this.chunkSamples = DEFAULT_MAX_CAPTURE_CHUNK_BYTES / FLOAT32_BYTES
    this.pending = new Float32Array(this.chunkSamples)
    this.pendingSamples = 0
    this.port.onmessage = (event) => {
      if (event.data?.type === 'start') {
        this.stopRequested = false
        this.recording = true
        const maxCaptureChunkBytes = validChunkBytes(event.data.maxCaptureChunkBytes)
          ? event.data.maxCaptureChunkBytes
          : DEFAULT_MAX_CAPTURE_CHUNK_BYTES
        this.chunkSamples = maxCaptureChunkBytes / FLOAT32_BYTES
        this.pending = new Float32Array(this.chunkSamples)
        this.pendingSamples = 0
      }
      if (event.data?.type === 'stop') this.stopRequested = true
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (input && this.recording) {
      let inputOffset = 0
      while (inputOffset < input.length) {
        const available = this.chunkSamples - this.pendingSamples
        const copyLength = Math.min(available, input.length - inputOffset)
        this.pending.set(input.subarray(inputOffset, inputOffset + copyLength), this.pendingSamples)
        this.pendingSamples += copyLength
        inputOffset += copyLength
        if (this.pendingSamples === this.chunkSamples) this.flush()
      }
    }
    if (output) output.fill(0)
    if (this.stopRequested) {
      this.flush()
      this.stopRequested = false
      this.recording = false
      this.port.postMessage({ type: 'stopped' })
    }
    return true
  }

  flush() {
    if (this.pendingSamples === 0) return
    const copy = this.pending.slice(0, this.pendingSamples)
    this.pendingSamples = 0
    this.port.postMessage({ type: 'pcm', buffer: copy.buffer }, [copy.buffer])
  }
}

registerProcessor('sweetspot-pcm-capture', SweetSpotPcmCaptureProcessor)
