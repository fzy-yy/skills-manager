<script setup>
import { Folder } from "@lucide/vue";

defineProps({
  modelValue: { type: String, default: "" },
  placeholder: { type: String, default: "" },
  disabled: Boolean,
  inputId: { type: String, default: "" },
});
const emit = defineEmits(["update:modelValue", "browse"]);
</script>

<template>
  <div
    class="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-border-strong bg-surface py-0.75 pr-1 pl-2.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary-soft"
  >
    <Folder class="shrink-0 text-ink-muted" :size="18" :stroke-width="1.8" />
    <input
      :id="inputId"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      class="h-7.5 min-w-0 flex-1 border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed"
      spellcheck="false"
      @input="emit('update:modelValue', $event.target.value)"
    />
    <button
      class="inline-flex h-8 items-center justify-center rounded-md border border-primary-border bg-primary-soft px-4 font-semibold whitespace-nowrap text-primary hover:bg-primary-border disabled:cursor-not-allowed disabled:opacity-50"
      type="button"
      :disabled="disabled"
      @click="emit('browse')"
    >
      浏览
    </button>
  </div>
</template>
