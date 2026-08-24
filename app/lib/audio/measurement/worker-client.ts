import type { MeasurementSweep } from '#shared/types/protocol'
import type { MeasurementAnalysis } from './response'
import type { MicCalibrationProfile } from '../mics/types'

interface MeasurementWorkerResponse {
  ok: boolean
  result?: MeasurementAnalysis
  error?: string
}

function isResponse(value: unknown): value is MeasurementWorkerResponse {
  if (typeof value !== 'object' || value === null || !('ok' in value)) return false
  if (value.ok === true) return 'result' in value && value.result !== undefined
  return value.ok === false && (!('error' in value) || typeof value.error === 'string')
}

export function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
  sweep: MeasurementSweep,
  micProfile: MicCalibrationProfile,
): Promise<MeasurementAnalysis> {
  return new Promise((resolve, reject) => {
    let worker: Worker
    try {
      worker = new Worker(new URL('../workers/measurement.worker.ts', import.meta.url), { type: 'module' })
    } catch (error: unknown) {
      reject(error instanceof Error ? error : new Error('Could not start the measurement worker.'))
      return
    }

    let settled = false
    const close = () => {
      worker.onmessage = null
      worker.onmessageerror = null
      worker.onerror = null
      worker.terminate()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      close()
      reject(error)
    }
    const succeed = (result: MeasurementAnalysis) => {
      if (settled) return
      settled = true
      close()
      resolve(result)
    }

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const response = event.data
      if (!isResponse(response)) {
        fail(new Error('Measurement worker returned an invalid response.'))
        return
      }
      if (response.ok && response.result) {
        succeed(response.result)
      } else {
        fail(new Error(response.error ?? 'Measurement analysis failed.'))
      }
    }
    worker.onerror = (event: ErrorEvent) => {
      const detail = typeof event.message === 'string' && event.message.trim().length > 0
        ? `: ${event.message.trim()}`
        : ''
      fail(new Error(`Measurement worker failed${detail}.`))
    }
    worker.onmessageerror = () => {
      fail(new Error('Measurement worker could not transfer its result.'))
    }

    try {
      const transferableSamples = samples.byteOffset === 0 && samples.byteLength === samples.buffer.byteLength
        ? samples
        : samples.slice()
      worker.postMessage({
        samples: transferableSamples.buffer,
        sampleRate,
        sweep,
        micProfile,
      }, [transferableSamples.buffer])
    } catch (error: unknown) {
      fail(error instanceof Error ? error : new Error('Could not send samples to the measurement worker.'))
    }
  })
}
