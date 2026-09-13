<script setup>
defineProps({ modelValue: Boolean, disabled: Boolean, label: String })
const emit = defineEmits(['update:modelValue'])
</script>

<template>
  <button
    type="button"
    class="relative h-6 w-[42px] shrink-0 rounded-full border-0 bg-border-strong p-0 outline-none ring-primary-soft focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
    :class="modelValue ? 'bg-primary' : 'bg-border-strong'"
    :aria-pressed="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <span class="absolute top-[3px] size-[18px] rounded-full bg-control-thumb shadow-sm" :class="modelValue ? 'left-[21px]' : 'left-[3px]'" />
  </button>
</template>
