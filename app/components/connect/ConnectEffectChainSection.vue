<script setup lang="ts">
import type { EffectsDiagnostics } from '#shared/types/protocol'

defineProps<{
  effectsDiagnostics: EffectsDiagnostics
}>()
</script>

<template>
  <section class="block">
    <h2 class="label">05 · Effect chain</h2>
    <p v-if="effectsDiagnostics.error" class="error">{{ effectsDiagnostics.error }}</p>
    <template v-else>
      <table v-if="effectsDiagnostics.inventory.length" class="grid">
        <thead>
          <tr><th>type</th><th>name</th><th>mode</th><th>vendor</th></tr>
        </thead>
        <tbody>
          <tr v-for="(e, i) in effectsDiagnostics.inventory" :key="i">
            <td>{{ e.typeName }}<span v-if="e.isVendor" class="mark">*</span></td>
            <td>{{ e.name }}</td>
            <td>{{ e.connectMode }}</td>
            <td>{{ e.isVendor ? 'yes' : '' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="note">No effects reported.</p>

      <dl class="spec wide">
        <template v-for="p in effectsDiagnostics.sessionProbes" :key="p.effectType">
          <dt>{{ p.effectType }}</dt>
          <dd>
            <template v-if="!p.constructed">failed: {{ p.exception }}</template>
            <template v-else>
              constructed · control {{ p.hasControl }} · enabled {{ p.enabled }}
              <code>{{ p.parameters }}</code>
            </template>
          </dd>
        </template>
      </dl>
      <details class="fold">
        <summary>Raw JSON</summary>
        <pre class="log">{{ JSON.stringify(effectsDiagnostics, null, 2) }}</pre>
      </details>
    </template>
  </section>
</template>
