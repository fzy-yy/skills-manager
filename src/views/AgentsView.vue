<script setup>
import { Bot, Info, Trash2 } from "@lucide/vue";
import { ref } from "vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
import PathPicker from "../components/PathPicker.vue";
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
const name = ref("");
const directory = ref("");

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
 * 创建 Agent。
 * 服务端会校验：目录必须存在、不能是磁盘根目录、不能与仓库或已有 Agent 目录重合，
 * 且必须为空目录——保证目录中的 Skills 链接全部由本插件管理。
 * 创建后不可修改（避免目录迁移带来的链接清理风险），如需调整请删除后重新创建。
 * 失败时表单内容原样保留，便于用户修正后重试。
 */
async function save() {
  if (!name.value.trim() || !directory.value.trim())
    return store.notify("请完整填写 Agent 名称和 Skills 目录", "error");
  const saved = await store.createAgent({
    name: name.value,
    directory: directory.value,
  });
  if (saved) reset();
}

/**
 * 删除 Agent：确认后删除配置，并清理本应用在其目录创建的链接。
 *
 * @param {{id: string, name: string}} agent - 被删除的 Agent
 */
async function remove(agent) {
  const accepted = await store.confirm({
    title: "删除 Agent",
    message: `确定删除“${agent.name}”吗？本应用在其目录创建的链接也会被安全移除；如需重新使用，请重新创建 Agent。`,
    confirmText: "删除",
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteAgent(agent.id);
}
</script>

<template>
  <section
    class="mx-auto flex min-h-full w-[calc(100%-3rem)] max-w-260 flex-col py-7.5 pb-12 max-[760px]:w-[calc(100%-2rem)]"
  >
    <PageHeader
      eyebrow="目标管理"
      title="Agents"
      description="保存 Agent 名称及其 Skills 目录，供应用配置使用。"
    />

    <div
      class="grid grid-cols-[190px_minmax(0,1fr)_auto] items-end gap-3 rounded-xl border border-border bg-surface p-5 shadow-sm max-[760px]:grid-cols-1"
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
          placeholder="选择一个空目录"
          :disabled="store.busy"
          @browse="browse"
        />
      </div>
      <div class="flex justify-end gap-2">
        <button
          class="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 font-semibold whitespace-nowrap text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="store.busy || !name.trim() || !directory.trim()"
          @click="save"
        >
          添加 Agent
        </button>
      </div>
      <p class="col-span-3 m-0 text-xs text-ink-muted max-[760px]:col-span-1">
        Skills
        目录必须为空目录：其中的链接全部由本插件创建与管理，插件不会修改目录中的其他内容。
      </p>
    </div>

    <div
      class="mt-4 flex items-start gap-2 rounded-lg border border-primary-border bg-primary-soft px-3.5 py-2.5 text-sm text-primary"
      role="status"
    >
      <Info class="mt-0.5 shrink-0" :size="17" />
      <p class="m-0 leading-6">
        Agent
        创建后不可修改名称与目录，避免迁移链接造成意外。如需调整，请删除后重新创建。
      </p>
    </div>

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
          <strong class="truncate">{{ agent.name }}</strong
          ><span class="truncate font-mono text-xs text-ink-muted">{{
            agent.directory || "当前设备尚未配置目录"
          }}</span>
        </div>
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
      description="填写名称与空目录，保存后即可在应用配置中开启 Skills。"
    />
  </section>
</template>
