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
// ============ 一、依赖导入 ============
// 警示图标（对话框头部）与关闭图标。
import { AlertTriangle, X } from "@lucide/vue";
// 挂载/卸载时注册与注销全局键盘监听。
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

// ============ 二、组件接口 ============
// 单向数据流：dialog 由 appStore 持有，本组件只读；如果在子组件里改它会绕开 resolveDialog，导致 Promise 永远不结束。
// 对话框内容对象：{ open, title, message, confirmText, cancelText, tone }。
const props = defineProps({ dialog: { type: Object, required: true } });
// 用户选择结果事件：参数为布尔值，true 表示确认。
const emit = defineEmits(["resolve"]);
// 对话框容器用于收集可聚焦元素；关闭后恢复打开前的焦点。
const dialogPanel = ref(null);
const confirmButton = ref(null);
let previousActiveElement;

// ============ 三、键盘交互与生命周期 ============
/**
 * 全局键盘监听：对话框打开时按 Esc 视为取消。
 *
 * @param {KeyboardEvent} event - window 上的 keydown 事件对象
 * @returns {void}
 */
// 支持 Escape 取消，避免对话框只能依赖鼠标操作。
function handleKeydown(event) {
  if (!props.dialog.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("resolve", false);
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [
    ...(dialogPanel.value?.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) || []),
  ];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!dialogPanel.value?.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
// 使用 window 级别的 keydown 监听，保证焦点不在对话框内部时 Esc 依然生效。
onMounted(() => window.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", handleKeydown));
watch(
  () => props.dialog.open,
  async (open) => {
    if (open) {
      previousActiveElement = document.activeElement;
      await nextTick();
      confirmButton.value?.focus();
    } else if (previousActiveElement?.isConnected) {
      await nextTick();
      previousActiveElement.focus();
      previousActiveElement = undefined;
    }
  },
);
// 注意：Esc 只在 dialog.open 为真时处理，否则会拦截页面上其他依赖 Esc 的交互行为。
</script>

<template>
  <!-- 层级约定：遮罩 z-50 低于顶部进度条（z-60），确认期间仍能看到耗时操作的进度 -->
  <!-- Teleport 到 body：避免被父级容器的 overflow/transform 裁剪 -->
  <Teleport to="body">
    <!-- 遮罩使用 bg-overlay 主题令牌，浅色与深色模式共用同一语义变量，无需在此写死透明度 -->
    <!-- 遮罩层：click.self 保证只有点击遮罩本身（而非对话框内容）时才视为取消 -->
    <div
      v-if="dialog.open"
      class="fixed inset-0 z-50 grid place-items-center bg-overlay p-6"
      role="presentation"
      @click.self="emit('resolve', false)"
    >
      <!-- 对话框主体：alertdialog 语义 + aria-modal，便于读屏软件正确播报 -->
      <section
        ref="dialogPanel"
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
        <!-- 语义：取消在前、确认在后，与系统对话框的阅读顺序保持一致 -->
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
            ref="confirmButton"
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
