<script setup>
// 列表行：左侧图标 + 中间标题/说明 + 右侧开关，供"分组开关"和"Skill 开关"两处复用。
import ToggleSwitch from "./ToggleSwitch.vue";

defineProps({
  icon: { type: [Object, Function], required: true },
  title: { type: String, required: true },
  subtitle: { type: String, default: "" },
  modelValue: Boolean,
  disabled: Boolean,
  label: { type: String, required: true },
});
defineEmits(["update:modelValue"]);
</script>

<template>
  <div
    class="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
  >
    <div
      class="grid size-8.5 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
    >
      <component :is="icon" :size="16" :stroke-width="1.8" />
    </div>
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <strong class="truncate text-sm">{{ title }}</strong>
      <span v-if="subtitle" class="text-xs text-ink-muted">{{ subtitle }}</span>
    </div>
    <ToggleSwitch
      class="justify-self-end"
      :model-value="modelValue"
      :disabled="disabled"
      :label="label"
      @update:model-value="$emit('update:modelValue', $event)"
    />
  </div>
</template>
