<template>
  <div class="page">
    <h1>SweetSpot Dashboard</h1>
    <p>Open the dashboard by scanning the QR code shown on your TV, or enter a pair code.</p>
    <form @submit.prevent="go">
      <input
        v-model="code"
        class="code-input"
        placeholder="Pair code e.g. 7K4M-P2WX"
        autocomplete="off"
        autocapitalize="characters"
        spellcheck="false"
      >
      <button type="submit" :disabled="!isValid">
        Connect
      </button>
    </form>
    <p v-if="code && !isValid" class="error">
      Codes are 6-10 letters/digits, dashes optional.
    </p>
  </div>
</template>

<script setup lang="ts">
import { isValidPairCode, normalizePairCode } from '#shared/types/protocol'

const code = ref('')
const isValid = computed(() => isValidPairCode(code.value))

function go() {
  if (!isValid.value) return
  navigateTo(`/connect/${normalizePairCode(code.value)}`)
}
</script>

<style scoped>
.page {
  max-width: 480px;
  margin: 3rem auto;
  padding: 0 1rem;
  font-family: system-ui, sans-serif;
}
.code-input {
  width: 100%;
  padding: 0.75rem;
  font-size: 1.25rem;
  text-transform: uppercase;
  border: 1px solid #8884;
  border-radius: 8px;
}
button {
  margin-top: 0.75rem;
  width: 100%;
  padding: 0.75rem;
  font-size: 1.1rem;
  border-radius: 8px;
  border: none;
  background: #2563eb;
  color: white;
}
button:disabled {
  opacity: 0.5;
}
.error {
  color: #dc2626;
}
</style>
