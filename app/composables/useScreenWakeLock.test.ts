import { describe, expect, test } from 'bun:test'
import {
  createScreenWakeLockController,
  type ScreenWakeLock,
  type ScreenWakeLockEnvironment,
  type ScreenWakeLockSentinel,
} from './useScreenWakeLock'

class FakeSentinel implements ScreenWakeLockSentinel {
  released = false
  releaseCalls = 0
  private readonly releaseListeners = new Set<() => void>()

  release(): Promise<void> {
    this.releaseCalls++
    this.released = true
    for (const listener of this.releaseListeners) listener()
    return Promise.resolve()
  }

  addEventListener(_type: 'release', listener: () => void): void {
    this.releaseListeners.add(listener)
  }

  removeEventListener(_type: 'release', listener: () => void): void {
    this.releaseListeners.delete(listener)
  }

  revoke(): void {
    this.released = true
    for (const listener of this.releaseListeners) listener()
  }
}

class FakeWakeLock implements ScreenWakeLock {
  requests: string[] = []
  private resolveRequest: ((sentinel: ScreenWakeLockSentinel) => void) | null = null
  private rejectRequest: ((reason?: unknown) => void) | null = null

  request(type: 'screen'): Promise<ScreenWakeLockSentinel> {
    this.requests.push(type)
    return new Promise<ScreenWakeLockSentinel>((resolve, reject) => {
      this.resolveRequest = resolve
      this.rejectRequest = reject
    })
  }

  resolve(sentinel: ScreenWakeLockSentinel): void {
    const resolveRequest = this.resolveRequest
    this.resolveRequest = null
    this.rejectRequest = null
    resolveRequest?.(sentinel)
  }

  reject(reason: unknown = new Error('wake lock rejected')): void {
    const rejectRequest = this.rejectRequest
    this.resolveRequest = null
    this.rejectRequest = null
    rejectRequest?.(reason)
  }
}

class FakeEnvironment implements ScreenWakeLockEnvironment {
  readonly wakeLock: FakeWakeLock | undefined
  visible = true
  private readonly visibilityListeners = new Set<() => void>()

  constructor(wakeLock?: FakeWakeLock) {
    this.wakeLock = wakeLock
  }

  isVisible(): boolean {
    return this.visible
  }

  subscribeToVisibilityChange(listener: () => void): () => void {
    this.visibilityListeners.add(listener)
    return () => this.visibilityListeners.delete(listener)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      for (const listener of this.visibilityListeners) listener()
    }
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('screen wake lock controller', () => {
  test('acquires at most one lock while calibration stays active', async () => {
    const wakeLock = new FakeWakeLock()
    const controller = createScreenWakeLockController(new FakeEnvironment(wakeLock))
    const sentinel = new FakeSentinel()

    controller.setActive(true)
    wakeLock.resolve(sentinel)
    await flushPromises()
    controller.setActive(true)

    expect(wakeLock.requests).toEqual(['screen'])
    expect(sentinel.releaseCalls).toBe(0)
  })

  test('releases the held lock when calibration becomes inactive', async () => {
    const wakeLock = new FakeWakeLock()
    const controller = createScreenWakeLockController(new FakeEnvironment(wakeLock))
    const sentinel = new FakeSentinel()

    controller.setActive(true)
    wakeLock.resolve(sentinel)
    await flushPromises()
    controller.setActive(false)

    expect(sentinel.releaseCalls).toBe(1)
  })

  test('releases the held lock when the page disposes the controller', async () => {
    const wakeLock = new FakeWakeLock()
    const controller = createScreenWakeLockController(new FakeEnvironment(wakeLock))
    const sentinel = new FakeSentinel()

    controller.setActive(true)
    wakeLock.resolve(sentinel)
    await flushPromises()
    controller.dispose()
    controller.setActive(true)

    expect(sentinel.releaseCalls).toBe(1)
    expect(wakeLock.requests).toEqual(['screen'])
  })

  test('treats unsupported and rejected wake locks as optional', async () => {
    const unsupported = createScreenWakeLockController(new FakeEnvironment())
    unsupported.setActive(true)

    const wakeLock = new FakeWakeLock()
    const rejected = createScreenWakeLockController(new FakeEnvironment(wakeLock))
    rejected.setActive(true)
    wakeLock.reject()
    await flushPromises()

    expect(wakeLock.requests).toEqual(['screen'])
  })

  test('waits for visibility before retrying an acquisition', async () => {
    const wakeLock = new FakeWakeLock()
    const environment = new FakeEnvironment(wakeLock)
    environment.visible = false
    const controller = createScreenWakeLockController(environment)

    controller.setActive(true)
    expect(wakeLock.requests).toHaveLength(0)
    environment.setVisible(true)

    expect(wakeLock.requests).toEqual(['screen'])
  })

  test('reacquires after the browser revokes the sentinel', async () => {
    const wakeLock = new FakeWakeLock()
    const controller = createScreenWakeLockController(new FakeEnvironment(wakeLock))
    const first = new FakeSentinel()
    const second = new FakeSentinel()

    controller.setActive(true)
    wakeLock.resolve(first)
    await flushPromises()
    first.revoke()

    expect(wakeLock.requests).toEqual(['screen', 'screen'])
    wakeLock.resolve(second)
    await flushPromises()
    expect(second.releaseCalls).toBe(0)
  })

  test('releases a stale request and retries when reactivated', async () => {
    const wakeLock = new FakeWakeLock()
    const controller = createScreenWakeLockController(new FakeEnvironment(wakeLock))
    const stale = new FakeSentinel()
    const current = new FakeSentinel()

    controller.setActive(true)
    controller.setActive(false)
    controller.setActive(true)
    wakeLock.resolve(stale)
    await flushPromises()

    expect(stale.releaseCalls).toBe(1)
    expect(wakeLock.requests).toEqual(['screen', 'screen'])
    wakeLock.resolve(current)
    await flushPromises()
    expect(current.releaseCalls).toBe(0)
  })
})
