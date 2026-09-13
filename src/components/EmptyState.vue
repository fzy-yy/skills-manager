<script setup>
import { CircleHelp } from '@lucide/vue'

defineProps({
  icon: { type: [Object, Function], default: () => CircleHelp },
  title: { type: String, required: true },
  description: { type: String, required: true }
})
</script>

<template>
  <div class="flex min-h-64 flex-col items-center justify-center px-8 py-10 text-center text-ink-secondary">
    <span class="mb-3 grid size-12 place-items-center rounded-xl border border-primary-border bg-primary-soft text-primary">
      <component :is="icon" :size="24" :stroke-width="1.8" />
    </span>
    <h3 class="mb-1.5 text-base font-semibold text-ink">{{ title }}</h3>
    <p class="m-0 max-w-md leading-6">{{ description }}</p>
    <slot />
  </div>
</template>
