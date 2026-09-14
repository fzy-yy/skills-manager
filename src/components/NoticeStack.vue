<!-- 全局提示列表：负责提示的布局、语义与视觉，生命周期由 appStore 管理。 -->
<script setup>
import { Check, CircleAlert, X } from "@lucide/vue";

defineProps({
  notices: { type: Array, required: true },
});
defineEmits(["dismiss"]);

function noticeClass(type) {
  if (type === "error") return "bg-danger text-on-primary";
  if (type === "warning")
    return "border border-warning bg-warning-soft text-warning";
  if (type === "info")
    return "border border-primary-border bg-primary-soft text-primary";
  return "bg-ink text-surface";
}
</script>

<template>
  <div
    v-if="notices.length"
    class="fixed right-5 bottom-5 z-40 flex max-h-[min(70vh,520px)] w-[min(480px,calc(100vw-40px))] flex-col gap-2 overflow-y-auto"
    aria-live="polite"
  >
    <div
      v-for="notice in notices"
      :key="notice.id"
      class="flex min-h-11 items-start gap-2.5 rounded-lg px-3 py-2.5 shadow-xl"
      :class="noticeClass(notice.type)"
      :role="notice.type === 'error' ? 'alert' : 'status'"
    >
      <CircleAlert
        v-if="notice.type === 'error' || notice.type === 'warning'"
        class="mt-0.5 shrink-0"
        :size="17"
      />
      <Check v-else class="mt-0.5 shrink-0" :size="17" />
      <span class="min-w-0 flex-1 wrap-break-word leading-5">
        {{ notice.message }}
      </span>
      <button
        class="grid size-6 shrink-0 place-items-center rounded border-0 bg-transparent text-current hover:opacity-70"
        type="button"
        aria-label="关闭提示"
        @click="$emit('dismiss', notice.id)"
      >
        <X :size="16" />
      </button>
    </div>
  </div>
</template>
