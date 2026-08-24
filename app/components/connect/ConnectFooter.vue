<script setup lang="ts">
defineProps<{
  version: string
}>()
</script>

<template>
  <footer class="colophon">
    <span>sweetspot-web</span>
    <span>{{ version }}</span>
  </footer>
</template>

<style scoped>
.colophon {
  display: flex;
  justify-content: space-between;
  padding-top: 1.25rem;
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  color: var(--faint);
}
</style>
