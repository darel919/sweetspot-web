import type { MeasurementSweep } from '#shared/types/protocol'
import type { CompositeMeasurementAnalysis } from './response'
import type { MicCalibrationProfile } from '../mics/types'

interface MeasurementWorkerRequest {
  id: number
  samples: ArrayBuffer
  sampleRate: number
  sweep: MeasurementSweep
  micProfile: MicCalibrationProfile
}

interface MeasurementWorkerResponse {
  id: number
  ok: boolean
  result?: CompositeMeasurementAnalysis
  error?: string
}

interface PendingRequest {
  resolve: (result: CompositeMeasurementAnalysis) => void
  reject: (error: Error) => void
  cleanup?: () => void
}

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, PendingRequest>()

function isResponse(value: unknown): value is MeasurementWorkerResponse {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('ok' in value)) return false
  if (typeof value.id !== 'number' || !Number.isInteger(value.id) || value.id < 1) return false
  if (value.ok === true) return 'result' in value && value.result !== undefined
  return value.ok === false && (!('error' in value) || typeof value.error === 'string')
}

function rejectAll(error: Error) {
  for (const request of pending.values()) {
    request.cleanup?.()
    request.reject(error)
  }
  pending.clear()
}

function resetWorker(error: Error) {
  const current = worker
  worker = null
  if (current) {
    current.onmessage = null
    current.onerror = null
    current.onmessageerror = null
  }
  current?.terminate()
  rejectAll(error)
}

function getWorker(): Worker {
  if (worker) return worker
  const created = new Worker(new URL('../workers/measurement.worker.ts', import.meta.url), { type: 'module' })
  created.onmessage = (event: MessageEvent<unknown>) => {
    if (!isResponse(event.data)) {
      resetWorker(new Error('Measurement worker returned an invalid response.'))
      return
    }
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    request.cleanup?.()
    if (event.data.ok && event.data.result) request.resolve(event.data.result)
    else request.reject(new Error(event.data.error ?? 'Measurement analysis failed.'))
  }
  created.onerror = (event: ErrorEvent) => {
    const detail = typeof event.message === 'string' && event.message.trim().length > 0
      ? `: ${event.message.trim()}`
      : ''
    resetWorker(new Error(`Measurement worker failed${detail}.`))
  }
  created.onmessageerror = () => {
    resetWorker(new Error('Measurement worker could not transfer its result.'))
  }
  worker = created
  return created
}

/**
 * Keep one worker alive for the calibration session. The worker module caches
 * the generated sweep FFT, so sequential takes with the same sweep avoid
 * rebuilding and re-transforming that reference.
 */
export function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
  signal?: AbortSignal,
): Promise<CompositeMeasurementAnalysis> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Measurement analysis was cancelled.'))
      return
    }
    let currentWorker: Worker
    try {
      currentWorker = getWorker()
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error('Could not start the measurement worker.'))
      return
    }

    const id = nextRequestId++
    const abort = () => {
      resetWorker(new Error('Measurement analysis was cancelled.'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, {
      resolve,
      reject,
      cleanup: () => signal?.removeEventListener('abort', abort),
    })
    try {
      let sampleBuffer: ArrayBuffer
      if (samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength && samples.buffer instanceof ArrayBuffer) {
        sampleBuffer = samples.buffer
      } else {
        sampleBuffer = new ArrayBuffer(samples.byteLength)
        new Uint8Array(sampleBuffer).set(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
      }
      const request: MeasurementWorkerRequest = {
        id,
        samples: sampleBuffer,
        sampleRate,
        sweep,
        micProfile,
      }
      currentWorker.postMessage(request, [sampleBuffer])
    } catch (error: unknown) {
      pending.delete(id)
      signal?.removeEventListener('abort', abort)
      reject(error instanceof Error ? error : new Error('Could not send samples to the measurement worker.'))
    }
  })
}
