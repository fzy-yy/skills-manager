<script setup>
import { Check, ChevronDown } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  disabled: Boolean
})
const emit = defineEmits(['update:modelValue'])
const root = ref(null)
const open = ref(false)
const selected = computed(() => props.options.find(option => option.value === props.modelValue))

function select (option) {
  emit('update:modelValue', option.value)
  open.value = false
}

// 点击组件外部时关闭浮层，避免残留遮挡其他内容。
function handleOutsideClick (event) {
  if (root.value && !root.value.contains(event.target)) open.value = false
}
onMounted(() => document.addEventListener('mousedown', handleOutsideClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', handleOutsideClick))
</script>

<template>
  <div ref="root" class="relative w-full">
    <button
      type="button"
      class="flex h-10 w-full items-center justify-between gap-3 rounded-md border border-border-strong bg-surface px-3 text-left text-ink outline-none hover:border-primary-border focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary-soft disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="open = !open"
    >
      <span class="truncate" :class="selected ? 'text-ink' : 'text-ink-muted'">{{ selected?.label || placeholder }}</span>
      <ChevronDown class="shrink-0 text-ink-muted" :size="17" :stroke-width="1.8" />
    </button>
    <div v-if="open" class="absolute z-30 mt-1.5 grid max-h-60 w-full gap-1 overflow-y-auto rounded-lg border border-border bg-surface-raised p-1.5 shadow-xl" role="listbox">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        class="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border-0 px-2.5 text-left hover:bg-canvas"
        :class="option.value === modelValue ? 'bg-primary-soft font-semibold text-primary' : 'bg-transparent text-ink'"
        @click="select(option)"
      >
        <span class="truncate">{{ option.label }}</span><Check v-if="option.value === modelValue" :size="16" />
      </button>
    </div>
  </div>
</template>
