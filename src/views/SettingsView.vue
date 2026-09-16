<script setup>
import { Database, Moon, Palette, Sun, Trash2 } from "@lucide/vue";
import PageHeader from "../components/PageHeader.vue";
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
const themeOptions = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
];

/**
 * 切换外观主题：先乐观更新界面，再持久化到本地配置文件。
 * 持久化失败时 store.setTheme 会回滚主题，因此这里仅在成功时提示。
 *
 * @param {'light'|'dark'} theme - 目标主题
 * @returns {Promise<void>} 保存成功或回滚后结束
 */
async function selectTheme(theme) {
  if (store.theme === theme) return;
  const saved = await store.setTheme(theme);
  if (saved) store.notify("主题设置已保存");
}

/**
 * 清除本地数据：先二次确认，再调用服务端清理。
 * 服务端只删除仍可识别的「受管链接」，源文件与他人创建的内容一律保留。
 * 失败信息由 store 统一提示。
 */
async function clearData() {
  const accepted = await store.confirm({
    title: "清除本地数据",
    message:
      "这会清除 Skills 仓库路径、所有分组、Agent 配置、主题设置及本应用创建的链接。统一 Skills 仓库中的源文件不会被删除。",
    confirmText: "清除数据",
    tone: "danger",
  });
  if (!accepted) return;
  await store.clearData();
}
</script>

<template>
  <section
    class="mx-auto flex min-h-full w-[calc(100%-3rem)] max-w-260 flex-col py-7.5 pb-12 max-[760px]:w-[calc(100%-2rem)]"
  >
    <PageHeader
      eyebrow="个性设置"
      title="设置"
      description="调整界面显示偏好并管理本地数据。"
    />

    <div
      class="flex items-center gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm max-[560px]:flex-col max-[560px]:items-stretch"
    >
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <span
          class="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
          ><Palette :size="20" :stroke-width="1.8"
        /></span>
        <div>
          <h2 class="m-0 text-base font-semibold text-ink">外观主题</h2>
          <p class="mt-1 mb-0 text-xs text-ink-muted">
            选择适合当前使用环境的显示模式。
          </p>
        </div>
      </div>
      <div class="flex shrink-0 rounded-lg border border-border bg-canvas p-1">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          class="inline-flex h-9 items-center justify-center gap-2 rounded-md border-0 px-3 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="store.busy"
          :class="
            store.theme === option.value
              ? 'bg-surface text-primary shadow-sm'
              : 'bg-transparent text-ink-muted hover:text-ink'
          "
          :aria-pressed="store.theme === option.value"
          @click="selectTheme(option.value)"
        >
          <component :is="option.icon" :size="16" :stroke-width="1.8" />{{
            option.label
          }}
        </button>
      </div>
    </div>

    <div class="mt-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div class="flex items-center gap-4">
        <span
          class="grid size-10 shrink-0 place-items-center rounded-lg bg-danger-soft text-danger"
          ><Database :size="20" :stroke-width="1.8"
        /></span>
        <div class="min-w-0 flex-1">
          <h2 class="m-0 text-base font-semibold text-ink">数据管理</h2>
          <p class="mt-1 mb-0 text-xs leading-5 text-ink-muted">
            清除当前设备上 uTools 数据目录中的插件配置，并移除本应用创建的 Agent
            Skills 链接；数据不会在设备间同步。
          </p>
        </div>
        <button
          class="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-danger bg-danger-soft px-4 font-semibold text-danger hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="store.busy"
          @click="clearData"
        >
          <Trash2 :size="17" :stroke-width="1.8" />清除数据
        </button>
      </div>
    </div>
  </section>
</template>
