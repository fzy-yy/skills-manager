<!-- 新增 Agent 时的额外配置对话框：单选 Skills 同步方式（链接形式 / 直接复制）。 -->
<script setup>
import { Copy, Info, Link2, SlidersHorizontal, X } from "@lucide/vue";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  open: Boolean,
  agentName: { type: String, default: "" },
  agentDirectory: { type: String, default: "" },
  disabled: Boolean,
});

const emit = defineEmits(["cancel", "confirm"]);

const dialogPanel = ref(null);
const confirmButton = ref(null);
/** 当前选中的配置方式，默认「链接形式」。 */
const selectedMode = ref("symlink");
let previousActiveElement;

const modeOptions = [
  {
    value: "symlink",
    label: "链接形式",
    icon: Link2,
    description:
      "在 Agent 目录中创建指向仓库的符号链接。仓库修改后实时同步，不占额外磁盘空间。",
  },
  {
    value: "copy",
    label: "直接复制",
    icon: Copy,
    description:
      "开启时复制 Skill 源文件到 Agent 目录；若已有同名项则回退添加不覆盖。关闭或清理时先校验 SKILL.md 与原 Skill 一致再删除，防止误删。",
  },
];

/**
 * 全局键盘监听：对话框打开时支持 Esc 关闭与 Tab 焦点循环。
 *
 * @param {KeyboardEvent} event - window 上的 keydown 事件
 */
function handleKeydown(event) {
  if (!props.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (!props.disabled) emit("cancel");
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = [
    ...(dialogPanel.value?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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

onMounted(() => window.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", handleKeydown));

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      selectedMode.value = "symlink";
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

/** 提交所选配置方式。 */
function submit() {
  emit("confirm", selectedMode.value);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 grid place-items-center bg-overlay p-6"
      role="presentation"
      @click.self="!disabled && emit('cancel')"
    >
      <section
        ref="dialogPanel"
        class="w-full max-w-lg rounded-xl border border-border bg-surface-raised p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-config-dialog-title"
        aria-describedby="agent-config-dialog-desc"
      >
        <header class="flex items-start gap-3">
          <span
            class="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
          >
            <SlidersHorizontal :size="20" :stroke-width="1.8" />
          </span>
          <div class="min-w-0 flex-1">
            <h2
              id="agent-config-dialog-title"
              class="m-0 text-base font-semibold text-ink"
            >
              额外配置
            </h2>
            <p
              id="agent-config-dialog-desc"
              class="mt-1 mb-0 text-xs leading-5 text-ink-secondary"
            >
              为「{{ agentName }}」选择配置 Skills 的方式。
            </p>
          </div>
          <button
            class="grid size-8 shrink-0 place-items-center rounded-md border-0 bg-transparent text-ink-muted hover:bg-canvas hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            aria-label="关闭"
            :disabled="disabled"
            @click="emit('cancel')"
          >
            <X :size="18" />
          </button>
        </header>

        <p
          class="mt-3 mb-0 truncate rounded-md border border-border bg-canvas px-3 py-2 font-mono text-xs text-ink-muted"
          :title="agentDirectory"
        >
          {{ agentDirectory }}
        </p>

        <fieldset class="mt-4 m-0 grid gap-2.5 border-0 p-0">
          <legend class="mb-2 text-xs font-semibold text-ink-secondary">
            Skills 配置方式（单选）
          </legend>
          <label
            v-for="option in modeOptions"
            :key="option.value"
            class="flex cursor-pointer items-start gap-3 rounded-lg border p-3.5 transition-colors"
            :class="
              selectedMode === option.value
                ? 'border-primary bg-primary-soft'
                : 'border-border bg-surface hover:border-primary-border'
            "
          >
            <input
              v-model="selectedMode"
              type="radio"
              name="agent-sync-mode"
              :value="option.value"
              class="mt-1 shrink-0 accent-primary"
              :disabled="disabled"
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 font-semibold text-ink">
                <component
                  :is="option.icon"
                  :size="15"
                  :stroke-width="1.9"
                  class="text-primary"
                />
                <span>{{ option.label }}</span>
                <span
                  v-if="option.value === 'symlink'"
                  class="rounded bg-surface px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary"
                  >默认</span
                >
              </div>
              <p class="mt-1 mb-0 text-xs leading-5 text-ink-secondary">
                {{ option.description }}
              </p>
            </div>
          </label>
        </fieldset>

        <div
          class="mt-3.5 flex items-start gap-2 rounded-lg border border-primary-border bg-primary-soft px-3 py-2 text-xs text-primary"
        >
          <Info class="mt-0.5 shrink-0" :size="15" />
          <p class="m-0 leading-5">
            该配置只能在添加 Agent 时选择，创建后不可修改；如需更换方式，请删除后重新添加。
          </p>
        </div>

        <footer class="mt-5 flex justify-end gap-2">
          <button
            class="inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface px-4 font-semibold text-ink-secondary hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            :disabled="disabled"
            @click="emit('cancel')"
          >
            取消
          </button>
          <button
            ref="confirmButton"
            class="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            :disabled="disabled"
            @click="submit"
          >
            确认添加
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
