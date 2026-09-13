<!--
  ConfirmDialog —— 全局确认对话框。

  由 appStore 的 dialog 状态驱动（见 src/stores/appStore.js 的 confirm/resolveDialog），
  App.vue 中只挂载一次，因此无需在每个页面重复实现确认弹窗。

  交互约定：
  - 点击遮罩空白处、右上角关闭按钮、取消按钮、按 Esc 都返回 false；
  - 点击确认按钮返回 true；
  - 结果通过 resolve 事件交给 appStore.resolveDialog 收尾。
-->
<script setup>
// 警示图标（对话框头部）与关闭图标。
import { AlertTriangle, X } from "@lucide/vue";
// 挂载/卸载时注册与注销全局键盘监听。
import { onBeforeUnmount, onMounted } from "vue";

// 对话框内容对象：{ open, title, message, confirmText, cancelText, tone }。
const props = defineProps({ dialog: { type: Object, required: true } });
// 用户选择结果事件：参数为布尔值，true 表示确认。
const emit = defineEmits(["resolve"]);

// 支持 Escape 取消，避免对话框只能依赖鼠标操作。
function handleKeydown(event) {
  if (props.dialog.open && event.key === "Escape") emit("resolve", false);
}
// 使用 window 级别的 keydown 监听，保证焦点不在对话框内部时 Esc 依然生效。
onMounted(() => window.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", handleKeydown));
</script>

<template>
  <!-- Teleport 到 body：避免被父级容器的 overflow/transform 裁剪 -->
  <Teleport to="body">
    <!-- 遮罩层：click.self 保证只有点击遮罩本身（而非对话框内容）时才视为取消 -->
    <div
      v-if="dialog.open"
      class="fixed inset-0 z-50 grid place-items-center bg-overlay p-6"
      role="presentation"
      @click.self="emit('resolve', false)"
    >
      <!-- 对话框主体：alertdialog 语义 + aria-modal，便于读屏软件正确播报 -->
      <section
        class="w-full max-w-md rounded-xl border border-border bg-surface-raised p-5 shadow-2xl"
        role="alertdialog"
        aria-modal="true"
        :aria-labelledby="'dialog-title'"
        :aria-describedby="'dialog-message'"
      >
        <!-- 头部：图标 + 标题 + 描述 + 关闭按钮，tone 为 danger 时使用危险色 -->
        <header class="flex items-start gap-3">
          <span
            class="grid size-10 shrink-0 place-items-center rounded-lg"
            :class="
              dialog.tone === 'danger'
                ? 'bg-danger-soft text-danger'
                : 'bg-primary-soft text-primary'
            "
          >
            <AlertTriangle :size="20" :stroke-width="1.8" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 id="dialog-title" class="m-0 text-base font-semibold text-ink">
              {{ dialog.title }}
            </h2>
            <p
              id="dialog-message"
              class="mt-2 mb-0 leading-6 text-ink-secondary"
            >
              {{ dialog.message }}
            </p>
          </div>
          <button
            class="grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent text-ink-muted hover:bg-canvas hover:text-ink"
            type="button"
            aria-label="关闭"
            @click="emit('resolve', false)"
          >
            <X :size="18" />
          </button>
        </header>
        <!-- 底部按钮：取消返回 false，确认返回 true；确认按钮默认聚焦以支持回车操作 -->
        <footer class="mt-6 flex justify-end gap-2">
          <button
            class="inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface px-4 font-semibold text-ink-secondary hover:bg-canvas"
            type="button"
            @click="emit('resolve', false)"
          >
            {{ dialog.cancelText }}
          </button>
          <button
            class="inline-flex h-10 items-center justify-center rounded-md border px-4 font-semibold text-on-primary"
            :class="
              dialog.tone === 'danger'
                ? 'border-danger bg-danger'
                : 'border-primary bg-primary hover:bg-primary-hover'
            "
            type="button"
            autofocus
            @click="emit('resolve', true)"
          >
            {{ dialog.confirmText }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
