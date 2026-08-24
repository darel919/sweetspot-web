class SweetSpotPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false
    this.flushRequested = false
    this.port.onmessage = (event) => {
      if (event.data?.type === 'start') this.recording = true
      if (event.data?.type === 'flush') this.flushRequested = true
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (input && this.recording) {
      const copy = new Float32Array(input.length)
      copy.set(input)
      this.port.postMessage({ type: 'pcm', buffer: copy.buffer }, [copy.buffer])
    }
    if (output) output.fill(0)
    if (this.flushRequested) {
      this.flushRequested = false
      this.recording = false
      this.port.postMessage({ type: 'flushed' })
    }
    return true
  }
}

registerProcessor('sweetspot-pcm-capture', SweetSpotPcmCaptureProcessor)
