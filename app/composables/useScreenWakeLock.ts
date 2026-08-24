export interface ScreenWakeLockSentinel {
  readonly released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
  removeEventListener(type: 'release', listener: () => void): void
}

export interface ScreenWakeLock {
  request(type: 'screen'): Promise<ScreenWakeLockSentinel>
}

export interface ScreenWakeLockEnvironment {
  readonly wakeLock: ScreenWakeLock | undefined
  isVisible(): boolean
  subscribeToVisibilityChange(listener: () => void): () => void
}

export interface ScreenWakeLockController {
  setActive(active: boolean): void
  dispose(): void
}

interface HeldScreenWakeLock {
  sentinel: ScreenWakeLockSentinel
  onRelease: () => void
}

function releaseSentinel(sentinel: ScreenWakeLockSentinel): void {
  if (!sentinel.released) void sentinel.release().catch(() => undefined)
}

export function createScreenWakeLockController(
  environment: ScreenWakeLockEnvironment | null,
): ScreenWakeLockController {
  let active = false
  let disposed = false
  let pendingRequest = false
  let requestGeneration = 0
  let held: HeldScreenWakeLock | null = null
  let unsubscribeFromVisibility: (() => void) | null = null

  function releaseHeld(): void {
    const current = held
    held = null
    if (!current) return
    current.sentinel.removeEventListener('release', current.onRelease)
    releaseSentinel(current.sentinel)
  }

  function requestWakeLock(): void {
    if (
      !environment
      || !active
      || disposed
      || pendingRequest
      || held
      || !environment.wakeLock
      || !environment.isVisible()
    ) return

    const generation = ++requestGeneration
    pendingRequest = true
    void environment.wakeLock.request('screen')
      .then((sentinel) => {
        pendingRequest = false
        const current = active
          && !disposed
          && generation === requestGeneration
          && environment.isVisible()
          && !sentinel.released
        if (!current) {
          if (active && !disposed && generation !== requestGeneration) requestWakeLock()
          releaseSentinel(sentinel)
          return
        }

        const onRelease = () => {
          if (held?.sentinel !== sentinel) return
          held = null
          sentinel.removeEventListener('release', onRelease)
          if (active && !disposed && environment.isVisible()) requestWakeLock()
        }
        held = { sentinel, onRelease }
        sentinel.addEventListener('release', onRelease)
      })
      .catch(() => {
        pendingRequest = false
        if (active && !disposed && generation !== requestGeneration) requestWakeLock()
      })
  }

  function onVisibilityChange(): void {
    if (active && !disposed && environment?.isVisible()) requestWakeLock()
  }

  function setActive(nextActive: boolean): void {
    if (disposed && nextActive) return
    if (!nextActive) {
      active = false
      requestGeneration++
      unsubscribeFromVisibility?.()
      unsubscribeFromVisibility = null
      releaseHeld()
      return
    }
    if (active) {
      requestWakeLock()
      return
    }
    active = true
    requestGeneration++
    if (environment?.wakeLock && unsubscribeFromVisibility === null) {
      unsubscribeFromVisibility = environment.subscribeToVisibilityChange(onVisibilityChange)
    }
    requestWakeLock()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    active = false
    requestGeneration++
    unsubscribeFromVisibility?.()
    unsubscribeFromVisibility = null
    releaseHeld()
  }

  return { setActive, dispose }
}

export function useScreenWakeLock(): ScreenWakeLockController {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') {
    return createScreenWakeLockController(null)
  }

  const wakeLock = 'wakeLock' in navigator ? navigator.wakeLock : undefined
  return createScreenWakeLockController({
    wakeLock,
    isVisible: () => document.visibilityState === 'visible',
    subscribeToVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
  })
}
