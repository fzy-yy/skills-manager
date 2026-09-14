<script setup>
defineProps({
  eyebrow: String,
  title: { type: String, required: true },
  description: { type: String, required: true },
});
</script>

<template>
  <header class="mb-6 flex shrink-0 items-end justify-between gap-6">
    <div>
      <p class="m-0 text-[11px] font-bold tracking-[0.12em] text-primary">
        {{ eyebrow }}
      </p>
      <h1
        class="mt-0.5 mb-1 text-[23px] leading-tight font-bold tracking-tight text-ink"
      >
        {{ title }}
      </h1>
      <p class="m-0 text-ink-secondary">{{ description }}</p>
    </div>
    <slot />
  </header>
</template>
