<script setup>
import { AlertTriangle, X } from '@lucide/vue'
import { onBeforeUnmount, onMounted } from 'vue'

const props = defineProps({ dialog: { type: Object, required: true } })
const emit = defineEmits(['resolve'])

// 支持 Escape 取消，避免对话框只能依赖鼠标操作。
function handleKeydown (event) {
  if (props.dialog.open && event.key === 'Escape') emit('resolve', false)
}
onMounted(() => window.addEventListener('keydown', handleKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', handleKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="dialog.open" class="fixed inset-0 z-50 grid place-items-center bg-overlay p-6" role="presentation" @click.self="emit('resolve', false)">
      <section class="w-full max-w-md rounded-xl border border-border bg-surface-raised p-5 shadow-2xl" role="alertdialog" aria-modal="true" :aria-labelledby="'dialog-title'" :aria-describedby="'dialog-message'">
        <header class="flex items-start gap-3">
          <span class="grid size-10 shrink-0 place-items-center rounded-lg" :class="dialog.tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-primary-soft text-primary'">
            <AlertTriangle :size="20" :stroke-width="1.8" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 id="dialog-title" class="m-0 text-base font-semibold text-ink">{{ dialog.title }}</h2>
            <p id="dialog-message" class="mt-2 mb-0 leading-6 text-ink-secondary">{{ dialog.message }}</p>
          </div>
          <button class="grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent text-ink-muted hover:bg-canvas hover:text-ink" type="button" aria-label="关闭" @click="emit('resolve', false)"><X :size="18" /></button>
        </header>
        <footer class="mt-6 flex justify-end gap-2">
          <button class="inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface px-4 font-semibold text-ink-secondary hover:bg-canvas" type="button" @click="emit('resolve', false)">{{ dialog.cancelText }}</button>
          <button class="inline-flex h-10 items-center justify-center rounded-md border px-4 font-semibold text-on-primary" :class="dialog.tone === 'danger' ? 'border-danger bg-danger' : 'border-primary bg-primary hover:bg-primary-hover'" type="button" autofocus @click="emit('resolve', true)">{{ dialog.confirmText }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
