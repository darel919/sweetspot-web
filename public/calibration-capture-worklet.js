class SweetSpotPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.recording = false
    this.stopRequested = false
    this.port.onmessage = (event) => {
      if (event.data?.type === 'start') {
        this.stopRequested = false
        this.recording = true
      }
      if (event.data?.type === 'stop') this.stopRequested = true
      if (event.data?.type === 'pause') this.recording = false
      if (event.data?.type === 'resume' && !this.stopRequested) this.recording = true
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
    if (this.stopRequested) {
      this.stopRequested = false
      this.recording = false
      this.port.postMessage({ type: 'stopped' })
    }
    return true
  }
}

registerProcessor('sweetspot-pcm-capture', SweetSpotPcmCaptureProcessor)
