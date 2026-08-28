<script setup lang="ts">
import type { PresetOption, StateSnapshot } from '#shared/types/protocol'

defineProps<{
  snapshot: StateSnapshot
  presets: readonly PresetOption[]
  eqDraft: readonly number[]
  eqDirty: boolean
  profileName: string
  locked: boolean
}>()

const emit = defineEmits<{
  (event: 'band-input', index: number, value: Event): void
  (event: 'commit-bands'): void
  (event: 'reset-bands'): void
  (event: 'set-engine', enabled: boolean): void
  (event: 'apply-preset', preset: number): void
  (event: 'update-profile-name', value: string): void
  (event: 'save-profile'): void
  (event: 'load-profile', name: string): void
  (event: 'delete-profile', name: string): void
}>()

function hzLabel(hz?: number): string {
  if (hz == null) return ''
  return hz >= 1000 ? `${Math.round(hz / 100) / 10}k` : String(hz)
}

function updateProfileName(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return
  emit('update-profile-name', event.target.value)
}
</script>

<template>
  <section class="block">
    <h2 class="label">02 · Equalizer</h2>

    <div class="actions">
      <button @click="emit('set-engine', true)" :disabled="locked || snapshot.engine.enabled">Enable</button>
      <button :disabled="locked || !snapshot.engine.enabled" @click="emit('set-engine', false)">Bypass</button>
    </div>

    <div v-if="presets.length" class="actions">
      <span class="mini-label">preset</span>
      <button
        v-for="p in presets"
        :key="p.id"
        :class="{ active: snapshot.engine.activePreset === p.id }"
        :disabled="locked"
        @click="emit('apply-preset', p.id)"
      >
        {{ p.name }}
      </button>
    </div>

    <div class="band-scroll">
      <div v-for="(lvl, i) in eqDraft" :key="i" class="band">
        <span class="band-val">{{ lvl.toFixed(1) }}</span>
        <input
          type="range"
          :min="snapshot.userEq.minDb"
          :max="snapshot.userEq.maxDb"
          step="0.5"
          :value="lvl"
          :disabled="locked"
          @input="emit('band-input', i, $event)"
          @change="emit('commit-bands')"
        />
        <span class="band-hz">{{ hzLabel(snapshot.userEq.frequenciesHz[i]) }}</span>
      </div>
    </div>

    <div class="actions">
      <button :disabled="locked || !eqDirty" @click="emit('reset-bands')">Discard changes</button>
    </div>

    <form class="inline-form" @submit.prevent="emit('save-profile')">
      <input
        :value="profileName"
        type="text"
        placeholder="new profile name"
        :disabled="locked"
        @input="updateProfileName"
      />
      <button type="submit" :disabled="locked || !profileName.trim()">Save</button>
    </form>

    <ul v-if="snapshot.profiles.length" class="list">
      <li v-for="p in snapshot.profiles" :key="p.id">
        <span>{{ p.name }}</span>
        <span class="list-actions">
          <button :disabled="locked" @click="emit('load-profile', p.name)">Load</button>
          <button :disabled="locked" @click="emit('delete-profile', p.name)">Delete</button>
        </span>
      </li>
    </ul>
    <p v-else class="note">No saved profiles.</p>
  </section>
</template>

<style scoped>
.band-scroll {
  display: flex;
  gap: 0.35rem;
  overflow-x: auto;
  padding: 1rem 0 0.5rem;
}
.band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  min-width: 2.6rem;
}
.band-val {
  font-size: 0.62rem;
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
.band-hz {
  font-size: 0.6rem;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
input[type='range'] {
  writing-mode: vertical-lr;
  direction: rtl;
  width: 18px;
  height: 120px;
  appearance: none;
  background: transparent;
  padding: 0;
}
input[type='range']::-webkit-slider-runnable-track {
  width: 1px;
  background: var(--line-strong);
}
input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 11px;
  height: 5px;
  margin-left: -5px;
  background: var(--ink);
  border: none;
  border-radius: 0;
  cursor: ns-resize;
}
input[type='range']::-moz-range-track {
  width: 1px;
  background: var(--line-strong);
}
input[type='range']::-moz-range-thumb {
  width: 11px;
  height: 5px;
  background: var(--ink);
  border: none;
  border-radius: 0;
  cursor: ns-resize;
}
</style>
