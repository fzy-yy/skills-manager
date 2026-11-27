<!-- Agent 同步方式徽标：在 Agents 页与应用配置页统一展示「链接形式」或「直接复制」。 -->
<script setup>
import { Copy, Link2 } from "@lucide/vue";
import { computed } from "vue";

const props = defineProps({
  /** 配置方式：symlink（链接形式）或 copy（直接复制） */
  mode: { type: String, default: "symlink" },
});

const isCopy = computed(() => props.mode === "copy");
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
    :class="
      isCopy
        ? 'border-warning bg-warning-soft text-warning'
        : 'border-primary-border bg-primary-soft text-primary'
    "
  >
    <Copy v-if="isCopy" :size="12" :stroke-width="2" />
    <Link2 v-else :size="12" :stroke-width="2" />
    <span>{{ isCopy ? "直接复制" : "链接形式" }}</span>
  </span>
</template>
