<script setup>
defineProps({ modelValue: Boolean, disabled: Boolean, label: String })
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <button
    type="button"
    class="flex h-6 w-11 shrink-0 items-center rounded-full border-0 p-0.5 outline-none ring-primary-soft focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
    :class="modelValue ? 'justify-end bg-primary' : 'justify-start bg-border-strong'"
    :aria-pressed="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="size-5 shrink-0 rounded-full bg-control-thumb shadow-sm" />
  </button>
</template>
