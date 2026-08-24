<script setup lang="ts">
import type { StateSnapshot } from '#shared/types/protocol'

defineProps<{
  room: string
  deviceOnline: boolean
  snapshot: StateSnapshot | null
}>()
</script>

<template>
  <section class="block">
    <h2 class="label">01 · Device</h2>
    <dl class="spec">
      <dt>room</dt>
      <dd>{{ room }}</dd>
      <dt>television</dt>
      <dd>{{ deviceOnline ? 'online' : 'offline' }}</dd>
      <dt>engine</dt>
      <dd>
        <template v-if="snapshot">
          {{ snapshot.engine.enabled ? (snapshot.engine.hasControl ? 'active' : 'no control') : 'bypassed' }}
          <span class="dim">/</span> {{ snapshot.engine.presetName }}
        </template>
        <template v-else>unknown</template>
      </dd>
    </dl>
  </section>
</template>
