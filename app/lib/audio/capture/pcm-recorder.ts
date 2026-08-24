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
}

export class PcmRecorderError extends Error {
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

interface FlushedMessage {
  type: 'flushed'
}

function isPcmMessage(value: unknown): value is PcmMessage {
  if (typeof value !== 'object' || value === null || !('type' in value) || !('buffer' in value)) return false
  return value.type === 'pcm' && value.buffer instanceof ArrayBuffer && value.buffer.byteLength % 4 === 0
}

function isFlushedMessage(value: unknown): value is FlushedMessage {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'flushed'
}

function waitForTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export interface PcmRecorderOptions {
  onTrackEnded?: () => void
}

export interface PcmRecorder {
  start(): Promise<void>
  stop(): Promise<PcmRecording>
  dispose(): Promise<void>
}

class PcmRecorderImpl implements PcmRecorder {
  private readonly chunks: Float32Array[] = []
  private readonly capture: MicrophoneCapture
  private readonly options: PcmRecorderOptions
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private node: AudioWorkletNode | null = null
  private silence: GainNode | null = null
  private trackEndedHandler: (() => void) | null = null
  private flushResolve: (() => void) | null = null
  private started = false
  private sampleCount = 0
  private sumSquares = 0
  private peak = 0
  private clippedSamples = 0

  constructor(capture: MicrophoneCapture, options: PcmRecorderOptions) {
    this.capture = capture
    this.options = options
  }

  async start(): Promise<void> {
    if (this.started) return
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
    this.chunks.length = 0
    this.sampleCount = 0
    this.sumSquares = 0
    this.peak = 0
    this.clippedSamples = 0
    await this.context.resume()
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
    this.node.port.postMessage({ type: 'start' })
    this.trackEndedHandler = () => this.options.onTrackEnded?.()
    this.capture.track.addEventListener('ended', this.trackEndedHandler)
    this.started = true
  }

  async stop(): Promise<PcmRecording> {
    if (!this.started) {
      return {
        samples: new Float32Array(0),
        diagnostics: this.diagnostics(),
      }
    }
    await this.flush()
    await waitForTurn()
    this.started = false
    this.disconnectGraph()
    const samples = this.combineChunks()
    const diagnostics = this.diagnostics()
    this.chunks.length = 0
    return { samples, diagnostics: { ...diagnostics, sampleCount: samples.length } }
  }

  async dispose(): Promise<void> {
    this.started = false
    this.disconnectGraph()
    this.chunks.length = 0
    this.flushResolve?.()
    this.flushResolve = null
    if (this.context) {
      await this.context.close()
      this.context = null
    }
  }

  private onMessage(data: unknown): void {
    if (isPcmMessage(data)) {
      const samples = new Float32Array(data.buffer)
      this.chunks.push(samples)
      for (const sample of samples) {
        const absolute = Math.abs(sample)
        this.sumSquares += sample * sample
        this.peak = Math.max(this.peak, absolute)
        if (absolute >= 0.999) this.clippedSamples++
      }
      this.sampleCount += samples.length
      return
    }
    if (isFlushedMessage(data)) {
      const resolve = this.flushResolve
      this.flushResolve = null
      resolve?.()
    }
  }

  private flush(): Promise<void> {
    if (!this.node) return Promise.resolve()
    return new Promise((resolve) => {
      this.flushResolve = resolve
      this.node?.port.postMessage({ type: 'flush' })
      setTimeout(() => {
        if (this.flushResolve === resolve) {
          this.flushResolve = null
          resolve()
        }
      }, 250)
    })
  }

  private disconnectGraph(): void {
    this.capture.track.removeEventListener('ended', this.trackEndedHandler ?? (() => undefined))
    this.trackEndedHandler = null
    this.source?.disconnect()
    this.node?.disconnect()
    this.silence?.disconnect()
    this.source = null
    this.node = null
    this.silence = null
  }

  private combineChunks(): Float32Array {
    const samples = new Float32Array(this.sampleCount)
    let offset = 0
    for (const chunk of this.chunks) {
      samples.set(chunk, offset)
      offset += chunk.length
    }
    return samples
  }

  private diagnostics(): CaptureSignalDiagnostics {
    return {
      // The worklet receives PCM at the AudioContext rate. The track's
      // reported rate may differ when the browser resamples the stream.
      sampleRate: this.context?.sampleRate ?? this.capture.settings.sampleRate ?? 0,
      channelCount: this.capture.settings.channelCount ?? 1,
      echoCancellation: this.capture.settings.echoCancellation,
      noiseSuppression: this.capture.settings.noiseSuppression,
      autoGainControl: this.capture.settings.autoGainControl,
      rms: this.sampleCount > 0 ? Math.sqrt(this.sumSquares / this.sampleCount) : 0,
      peak: this.peak,
      clipped: this.clippedSamples > 0,
      clippedSamples: this.clippedSamples,
      sampleCount: this.sampleCount,
    }
  }
}

export function createPcmRecorder(capture: MicrophoneCapture, options: PcmRecorderOptions = {}): PcmRecorder {
  return new PcmRecorderImpl(capture, options)
}
