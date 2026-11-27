<script setup>
import { Bot, FolderOpen, Info, Trash2 } from "@lucide/vue";
import { ref } from "vue";
import AgentConfigDialog from "../components/AgentConfigDialog.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
import PathPicker from "../components/PathPicker.vue";
import SyncModeBadge from "../components/SyncModeBadge.vue";
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
const name = ref("");
const directory = ref("");
/** 是否打开新增 Agent 的「额外配置」对话框。 */
const configDialogOpen = ref(false);

/** 清空表单，供新增成功后复用。 */
function reset() {
  name.value = "";
  directory.value = "";
}

/**
 * 打开系统目录选择框并把结果写入表单。
 * 选择能力由 preload 提供；失败时已统一提示，返回空串表示未选择。
 */
async function browse() {
  const selected = await store.chooseDirectory(directory.value);
  if (selected) directory.value = selected;
}

/**
 * 点击「添加 Agent」按钮：基础非空校验通过后弹出额外配置对话框，
 * 由用户单选「链接形式」或「直接复制」后再提交创建。
 */
function openCreateDialog() {
  if (!name.value.trim() || !directory.value.trim())
    return store.notify("请完整填写 Agent 名称和 Skills 目录", "error");
  configDialogOpen.value = true;
}

/**
 * 确认额外配置后创建 Agent。
 * 服务端会校验：目录必须存在、可读、不能是磁盘根目录、不能与仓库或已有 Agent 目录重合。
 * 创建后名称、目录与配置方式均不可修改；失败时关闭弹窗并保留表单内容，便于修正后重试。
 *
 * @param {'symlink'|'copy'} syncMode - 选中的 Skills 配置方式
 */
async function confirmCreate(syncMode) {
  const saved = await store.createAgent({
    name: name.value,
    directory: directory.value,
    syncMode,
  });
  configDialogOpen.value = false;
  if (saved) reset();
}

/**
 * 在系统文件管理器中打开该 Agent 的 Skills 目录。
 * 只读操作，失败信息已由 store 统一提示。
 *
 * @param {{id: string}} agent - 目标 Agent
 */
function openFolder(agent) {
  store.openAgentFolder(agent.id);
}

/**
 * 删除 Agent：确认后删除配置，并按该 Agent 的配置方式安全清理受管链接或副本。
 *
 * @param {{id: string, name: string, syncMode?: string}} agent - 被删除的 Agent
 */
async function remove(agent) {
  const isCopy = agent.syncMode === "copy";
  const accepted = await store.confirm({
    title: "删除 Agent",
    message: isCopy
      ? `确定删除“${agent.name}”吗？本应用复制到其目录中且校验与原 Skill 一致的副本会被安全移除（已修改或其他内容会保留）；如需重新使用，请重新创建 Agent。`
      : `确定删除“${agent.name}”吗？本应用在其目录创建的链接也会被安全移除；如需重新使用，请重新创建 Agent。`,
    confirmText: "删除",
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteAgent(agent.id);
}
</script>

<template>
  <section
    class="mx-auto flex h-full w-[calc(100%-3rem)] max-w-260 flex-col overflow-hidden pt-7.5 max-[760px]:w-[calc(100%-2rem)]"
  >
    <PageHeader
      eyebrow="目标管理"
      title="Agents"
      description="保存 Agent 名称及其 Skills 目录，供应用配置使用。"
    />

    <!-- 固定区：新增表单与说明 -->
    <div
      class="grid shrink-0 grid-cols-[190px_minmax(0,1fr)_auto] items-end gap-3 rounded-xl border border-border bg-surface p-5 shadow-sm max-[760px]:grid-cols-1"
    >
      <div>
        <label
          class="mb-1.5 block text-xs font-semibold text-ink-secondary"
          for="agent-name"
          >Agent 名称</label
        ><input
          id="agent-name"
          v-model="name"
          maxlength="120"
          class="h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink outline-none placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary-soft"
          placeholder="例如：Codex"
        />
      </div>
      <div>
        <label
          class="mb-1.5 block text-xs font-semibold text-ink-secondary"
          for="agent-directory"
          >Skills 目录</label
        ><PathPicker
          v-model="directory"
          input-id="agent-directory"
          placeholder="选择或输入 Skills 目录"
          :disabled="store.busy"
          @browse="browse"
        />
      </div>
      <div class="flex justify-end gap-2">
        <button
          class="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 font-semibold whitespace-nowrap text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="store.busy || !name.trim() || !directory.trim()"
          @click="openCreateDialog"
        >
          添加 Agent
        </button>
      </div>
      <p class="col-span-3 m-0 text-xs text-ink-muted max-[760px]:col-span-1">
        目录可包含其他文件：点击“添加 Agent”后可选择「链接形式」或「直接复制」，插件只管理自身创建的受管内容，其他文件一概不动。
      </p>
    </div>

    <div
      class="mt-4 flex shrink-0 items-start gap-2 rounded-lg border border-primary-border bg-primary-soft px-3.5 py-2.5 text-sm text-primary"
      role="status"
    >
      <Info class="mt-0.5 shrink-0" :size="17" />
      <p class="m-0 leading-6">
        Agent
        创建后不可修改名称、目录与配置方式，避免迁移或清理造成意外。如需调整，请删除后重新创建。
      </p>
    </div>

    <!-- 滚动区：Agent 卡片列表 -->
    <div class="min-h-0 flex-1 overflow-y-auto pb-12">
      <div v-if="store.agents.length" class="mt-4 grid gap-2">
        <article
          v-for="agent in store.agents"
          :key="agent.id"
          class="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm"
        >
          <span
            class="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
            ><Bot :size="21" :stroke-width="1.8"
          /></span>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="flex min-w-0 items-center gap-2">
              <strong class="truncate">{{ agent.name }}</strong>
              <SyncModeBadge :mode="agent.syncMode" />
            </div>
            <span class="truncate font-mono text-xs text-ink-muted">{{
              agent.directory || "当前设备尚未配置目录"
            }}</span>
          </div>
          <button
            class="grid size-9 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-ink-secondary hover:border-primary-border hover:bg-primary-soft hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            title="在文件管理器中打开该目录"
            :disabled="store.busy"
            @click="openFolder(agent)"
          >
            <FolderOpen :size="17" :stroke-width="1.8" />
          </button>
          <button
            class="grid size-9 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-ink-secondary hover:border-danger hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            title="删除"
            :disabled="store.busy"
            @click="remove(agent)"
          >
            <Trash2 :size="17" :stroke-width="1.8" />
          </button>
        </article>
      </div>
      <EmptyState
        v-else
        :icon="Bot"
        title="还没有 Agent"
        description="填写名称与 Skills 目录，保存后即可在应用配置中开启 Skills。"
      />
    </div>

    <AgentConfigDialog
      :open="configDialogOpen"
      :agent-name="name.trim()"
      :agent-directory="directory.trim()"
      :disabled="store.busy"
      @cancel="configDialogOpen = false"
      @confirm="confirmCreate"
    />
  </section>
</template>
