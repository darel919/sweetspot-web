<script setup lang="ts">
import type { ConnectDebugLogEntry } from './types'

const props = defineProps<{
  entries: readonly ConnectDebugLogEntry[]
}>()

function formatEntries(entries: readonly ConnectDebugLogEntry[]): string {
  return entries.map((entry) =>
    new Date(entry.at).toISOString() + ' ' + entry.direction.toUpperCase() + ' ' + entry.text,
  ).join('\n')
}
</script>

<template>
  <details class="block fold">
    <summary>Debug log · {{ props.entries.length }}</summary>
    <pre class="log">{{ formatEntries(props.entries) }}</pre>
  </details>
</template>
