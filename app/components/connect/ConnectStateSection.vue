<script setup lang="ts">
import type { ConnectionState } from '~/composables/connectionState'

defineProps<{
  status: ConnectionState
}>()

const emit = defineEmits<{
  (event: 'request-state'): void
}>()
</script>

<template>
  <section class="block">
    <h2 class="label">05 · State</h2>
    <p v-if="status === 'offline'" class="note">The TV is offline. Open SweetSpot on the TV.</p>
    <div v-else-if="status === 'connected'" class="actions">
      <button @click="emit('request-state')">Request state</button>
    </div>
    <p v-else class="note">Connecting…</p>
  </section>
</template>
