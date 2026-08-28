import type { MicrophoneCapture } from './microphone'

export interface CaptureSignalDiagnostics {
  sampleRate: number
  channelCount: number
  echoCancellation: boolean | null
  noiseSuppression: boolean | null
  autoGainControl: boolean | null
  rms: number
  peak: number
  clipped: boolean
  clippedSamples: number
  sampleCount: number
}

export interface PcmRecording {
  samples: Float32Array
  diagnostics: CaptureSignalDiagnostics
  startSample: number
  endSample: number
}

class PcmRecorderError extends Error {
  readonly code = 'capture_unavailable' as const

  constructor(message: string) {
    super(message)
    this.name = 'PcmRecorderError'
  }
}

interface PcmMessage {
  type: 'pcm'
  buffer: ArrayBuffer
}

interface StoppedMessage {
  type: 'stopped'
}

function isPcmMessage(value: unknown): value is PcmMessage {
  if (typeof value !== 'object' || value === null || !('type' in value) || !('buffer' in value)) return false
  return value.type === 'pcm' && value.buffer instanceof ArrayBuffer && value.buffer.byteLength % 4 === 0
}

function isStoppedMessage(value: unknown): value is StoppedMessage {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'stopped'
}

export interface PcmRecorderOptions {
  onTrackEnded?: () => void
  onChunk?: (samples: Float32Array) => Promise<void> | void
  retainSamples?: boolean
}

/**
 * One recorder owns one AudioContext/source/worklet graph for the session.
 * start/stop delimit windows in a sample-indexed local buffer; they do not
 * tear down the graph or reacquire the microphone.
 */
export interface PcmRecorder {
  start(): Promise<void>
  stop(): Promise<PcmRecording>
  dispose(): Promise<void>
  sampleRate(): number | null
}

interface PcmChunk {
  startSample: number
  samples: Float32Array
}

class PcmRecorderImpl implements PcmRecorder {
  private readonly capture: MicrophoneCapture
  private readonly options: PcmRecorderOptions
  private readonly chunks: PcmChunk[] = []
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private silence: GainNode | null = null
  private trackEndedHandler: (() => void) | null = null
  private stopResolve: ((drained: boolean) => void) | null = null
  private graphStarted = false
  private windowActive = false
  private stopPromise: Promise<PcmRecording> | null = null
  private streamSampleCount = 0
  private windowStartSample = 0
  private windowSampleCount = 0
  private windowSumSquares = 0
  private windowPeak = 0
  private windowClippedSamples = 0
  private streamError: Error | null = null
  private streamChain: Promise<void> = Promise.resolve()
  private streamInFlight = 0
  private streamPaused = false

  private static readonly MAX_PENDING_STREAM_CHUNKS = 8

  constructor(capture: MicrophoneCapture, options: PcmRecorderOptions) {
    this.capture = capture
    this.options = options
  }

  async start(): Promise<void> {
    if (this.windowActive) return
    if (this.capture.track.readyState === 'ended') {
      this.options.onTrackEnded?.()
      throw new PcmRecorderError('The microphone ended before capture could start.')
    }

    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      try {
        await this.context.audioWorklet.addModule('/calibration-capture-worklet.js')
      } catch (error: unknown) {
        await this.context.close()
        this.context = null
        const message = error instanceof Error ? error.message : 'The capture worklet could not be loaded.'
        throw new PcmRecorderError(message)
      }
    }

    await this.context.resume()
    if (!this.graphStarted) {
      this.source = this.context.createMediaStreamSource(this.capture.stream)
      this.node = new AudioWorkletNode(this.context, 'sweetspot-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      })
      this.silence = this.context.createGain()
      this.silence.gain.value = 0
      this.node.port.onmessage = (event: MessageEvent<unknown>) => this.onMessage(event.data)
      this.source.connect(this.node)
      this.node.connect(this.silence)
      this.silence.connect(this.context.destination)
      this.trackEndedHandler = () => this.options.onTrackEnded?.()
      this.capture.track.addEventListener('ended', this.trackEndedHandler)
      this.graphStarted = true
    }

    this.chunks.length = 0
    this.windowStartSample = this.streamSampleCount
    this.windowSampleCount = 0
    this.windowSumSquares = 0
    this.windowPeak = 0
    this.windowClippedSamples = 0
    this.streamError = null
    this.streamChain = Promise.resolve()
    this.streamInFlight = 0
    this.streamPaused = false
    this.windowActive = true
    this.node?.port.postMessage({ type: 'start' })
  }

  async stop(): Promise<PcmRecording> {
    if (!this.windowActive) return this.emptyRecording()
    if (this.stopPromise) return this.stopPromise
    const pending = this.finishStop()
    this.stopPromise = pending
    try {
      return await pending
    } finally {
      if (this.stopPromise === pending) this.stopPromise = null
    }
  }

  async dispose(): Promise<void> {
    const pendingStop = this.stopPromise
    if (pendingStop) {
      this.stopResolve?.(true)
      await pendingStop
    }
    this.windowActive = false
    this.chunks.length = 0
    this.stopResolve = null
    this.disconnectGraph()
    if (this.context) {
      await this.context.close()
      this.context = null
    }
    this.streamSampleCount = 0
    this.windowStartSample = 0
    this.windowSampleCount = 0
    this.windowSumSquares = 0
    this.windowPeak = 0
    this.windowClippedSamples = 0
    this.streamError = null
    this.streamChain = Promise.resolve()
    this.streamInFlight = 0
    this.streamPaused = false
  }

  sampleRate(): number | null {
    const value = this.context?.sampleRate ?? this.capture.settings.sampleRate ?? null
    return value !== null && Number.isFinite(value) && value > 0 ? value : null
  }

  private async finishStop(): Promise<PcmRecording> {
    const drained = await this.requestStop()
    if (!drained) {
      this.windowActive = false
      this.chunks.length = 0
      throw new PcmRecorderError('The capture worklet did not finish draining the recording.')
    }
    await this.streamChain
    if (this.streamError) {
      this.windowActive = false
      this.chunks.length = 0
      throw this.streamError
    }
    this.windowActive = false
    const samples = this.combineChunks()
    const startSample = this.windowStartSample
    this.chunks.length = 0
    const diagnostics = this.diagnostics(samples)
    const endSample = startSample + this.windowSampleCount
    this.windowSampleCount = 0
    this.windowSumSquares = 0
    this.windowPeak = 0
    this.windowClippedSamples = 0
    return {
      samples,
      startSample,
      endSample,
      diagnostics,
    }
  }

  private onMessage(data: unknown): void {
    if (isPcmMessage(data)) {
      const samples = new Float32Array(data.buffer)
      const startSample = this.streamSampleCount
      this.streamSampleCount += samples.length
      if (!this.windowActive) return
      this.windowSampleCount += samples.length
      for (const sample of samples) {
        const absolute = Math.abs(sample)
        this.windowSumSquares += sample * sample
        this.windowPeak = Math.max(this.windowPeak, absolute)
        if (absolute >= 0.999) this.windowClippedSamples++
      }
      if (this.options.retainSamples !== false) this.chunks.push({ startSample, samples })
      if (!this.options.onChunk || this.streamError) return
      if (this.streamInFlight >= PcmRecorderImpl.MAX_PENDING_STREAM_CHUNKS) {
        this.streamPaused = true
        this.node?.port.postMessage({ type: 'pause' })
        this.streamError = new PcmRecorderError('The capture transport could not keep up. Retry this capture.')
        return
      }
      this.streamInFlight++
      if (this.streamInFlight >= PcmRecorderImpl.MAX_PENDING_STREAM_CHUNKS) {
        this.streamPaused = true
        this.node?.port.postMessage({ type: 'pause' })
      }
      this.streamChain = this.streamChain
        .then(() => this.options.onChunk?.(samples))
        .catch((error: unknown) => {
          this.streamError = error instanceof Error ? error : new PcmRecorderError('The capture transport failed.')
          this.node?.port.postMessage({ type: 'pause' })
        })
        .finally(() => {
          this.streamInFlight--
          if (this.streamPaused && !this.streamError && this.streamInFlight <= 2 && this.windowActive) {
            this.streamPaused = false
            this.node?.port.postMessage({ type: 'resume' })
          }
        })
      return
    }
    if (isStoppedMessage(data)) {
      const resolve = this.stopResolve
      this.stopResolve = null
      resolve?.(true)
    }
  }

  private requestStop(): Promise<boolean> {
    if (!this.node) return Promise.resolve(true)
    return new Promise((resolve) => {
      this.stopResolve = resolve
      this.node?.port.postMessage({ type: 'stop' })
      setTimeout(() => {
        if (this.stopResolve === resolve) {
          this.stopResolve = null
          resolve(false)
        }
      }, 250)
    })
  }

  private disconnectGraph(): void {
    if (this.trackEndedHandler) this.capture.track.removeEventListener('ended', this.trackEndedHandler)
    this.trackEndedHandler = null
    this.node?.port.postMessage({ type: 'pause' })
    this.streamPaused = false
    this.source?.disconnect()
    this.node?.disconnect()
    this.silence?.disconnect()
    this.source = null
    this.node = null
    this.silence = null
    this.graphStarted = false
  }

  private combineChunks(): Float32Array {
    const sampleCount = this.chunks.reduce((total, chunk) => total + chunk.samples.length, 0)
    const samples = new Float32Array(sampleCount)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk.samples, offset)
      offset += chunk.samples.length
    }
    return samples
  }

  private emptyRecording(): PcmRecording {
    const samples = new Float32Array(0)
    return {
      samples,
      startSample: this.streamSampleCount,
      endSample: this.streamSampleCount,
      diagnostics: this.diagnostics(samples),
    }
  }

  private diagnostics(samples: Float32Array): CaptureSignalDiagnostics {
    let sumSquares = 0
    let peak = 0
    let clippedSamples = 0
    if (samples.length > 0) {
      for (const sample of samples) {
        const absolute = Math.abs(sample)
        sumSquares += sample * sample
        peak = Math.max(peak, absolute)
        if (absolute >= 0.999) clippedSamples++
      }
    } else {
      sumSquares = this.windowSumSquares
      peak = this.windowPeak
      clippedSamples = this.windowClippedSamples
    }
    return {
      sampleRate: this.context?.sampleRate ?? this.capture.settings.sampleRate ?? 0,
      channelCount: this.capture.settings.channelCount ?? 1,
      echoCancellation: this.capture.settings.echoCancellation,
      noiseSuppression: this.capture.settings.noiseSuppression,
      autoGainControl: this.capture.settings.autoGainControl,
      rms: this.windowSampleCount > 0 ? Math.sqrt(sumSquares / this.windowSampleCount) : 0,
      peak,
      clipped: clippedSamples > 0,
      clippedSamples,
      sampleCount: samples.length > 0 ? samples.length : this.windowSampleCount,
    }
  }
}

export function createPcmRecorder(capture: MicrophoneCapture, options: PcmRecorderOptions = {}): PcmRecorder {
  return new PcmRecorderImpl(capture, options)
}
