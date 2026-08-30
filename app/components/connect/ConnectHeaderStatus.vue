<script setup lang="ts">
import { computed } from 'vue'
import type { ConnectionState } from '~/composables/connectionState'

const props = defineProps<{
  status: ConnectionState
  toastMessage: string
}>()

const statusLabel = computed(() => {
  switch (props.status) {
    case 'connected': return 'Connected directly'
    case 'connecting': return 'Connecting to TV…'
    case 'reconnecting': return 'Connection interrupted. Reconnecting…'
    case 'offline': return 'TV offline'
    default: return 'Disconnected'
  }
})
</script>

<template>
  <header class="masthead">
    <div class="brand">
      <h1>SWEETSPOT</h1>
      <p class="sub">remote equalizer console</p>
    </div>
    <div class="conn" :data-state="status">
      <span class="conn-dot"></span>
      <span class="conn-label">{{ statusLabel }}</span>
    </div>
  </header>

  <Transition name="toast">
    <div v-if="toastMessage" class="toast" role="status" aria-live="assertive">
      {{ toastMessage }}
    </div>
  </Transition>
</template>

<style scoped>
.masthead {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--ink);
}
.brand h1 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.45em;
}
.sub {
  margin: 0.15rem 0 0;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--dim);
}
.conn {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: var(--dim);
  white-space: nowrap;
}
.conn-dot {
  width: 7px;
  height: 7px;
  background: var(--faint);
}
.conn[data-state='connected'] .conn-dot {
  background: var(--ink);
}
.conn[data-state='connected'] .conn-label {
  color: var(--ink);
}
.conn[data-state='offline'] .conn-dot {
  background: var(--ink);
}
.conn[data-state='offline'] .conn-label {
  color: var(--ink);
}
.toast {
  position: fixed;
  top: 1rem;
  left: 50%;
  z-index: 10;
  width: min(32rem, calc(100vw - 2rem));
  padding: 0.8rem 1rem;
  transform: translateX(-50%);
  border: 1px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  text-align: center;
  box-shadow: 0 0.5rem 2rem rgba(0, 0, 0, 0.35);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, -0.5rem);
}
</style>
