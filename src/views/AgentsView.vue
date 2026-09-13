<!--
  AgentsView —— Agents 管理页。

  页面职责：维护「Agent 名称 + 其 Skills 目录」两组信息。这里的目录是各个
  AI Agent（如 Codex、Claude 等）实际读取 Skills 的位置，本应用会在这些目录
  下创建指向统一仓库的链接（见“应用配置”页面）。

  表单同时承担新增与编辑：
  - editingId 为空表示新增，点击“编辑”后填入该 Agent 的 id/名称/目录；
  - 保存时把 id 一并提交，preload 服务据此判断是更新还是新增；
  - 修改目录会先保存可恢复检查点，再安全清理旧目录链接并应用新目录。
-->
<script setup>
// 图标：Bot 表示 Agent，Pencil 编辑，Trash2 删除。
import { Bot, Pencil, Trash2 } from "@lucide/vue";
// ref 保存编辑态与被编辑 Agent 的表单字段。
import { ref } from "vue";
// 空状态占位组件。
import EmptyState from "../components/EmptyState.vue";
// 页面统一页头。
import PageHeader from "../components/PageHeader.vue";
// 目录输入 + 浏览按钮组件。
import PathPicker from "../components/PathPicker.vue";
// 全局状态仓库。
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
// 正在编辑的 Agent id；空字符串表示新增模式。
const editingId = ref("");
// 表单：Agent 名称。
const name = ref("");
// 表单：Agent 的 Skills 目录绝对路径。
const directory = ref("");

/**
 * 重置表单为“新增模式”。
 * 新增成功后、取消编辑时都会调用。
 */
function reset() {
  editingId.value = "";
  name.value = "";
  directory.value = "";
}

/**
 * 进入编辑模式：把该 Agent 的当前配置填入表单。
 *
 * @param {{id: string, name: string, directory: string}} agent - 被编辑的 Agent
 */
function edit(agent) {
  editingId.value = agent.id;
  name.value = agent.name;
  directory.value = agent.directory;
}

/**
 * 打开系统目录选择框并把结果写入表单。
 * 目录选择能力由 preload 服务的 chooseDirectory 提供。
 */
async function browse() {
  try {
    const selected = await store.chooseDirectory(directory.value);
    if (selected) directory.value = selected;
  } catch (error) {
    store.notify(error.message, "error");
  }
}

/**
 * 保存 Agent（新增或更新），成功后回到新增模式并清空表单。
 * 服务端会校验目录合法性（不能是磁盘根目录、不能与仓库目录互相包含、不能与其他 Agent 重复）。
 */
async function save() {
  if (!name.value.trim() || !directory.value.trim())
    return store.notify("请完整填写 Agent 名称和 Skills 目录", "error");
  try {
    await store.upsertAgent({
      id: editingId.value || undefined,
      name: name.value,
      directory: directory.value,
    });
    reset();
  } catch (_) {}
}

/**
 * 删除 Agent：确认后调用服务端删除，同时清理本应用在其目录创建的链接。
 * 若删除的正是当前编辑项，则同步重置表单。
 *
 * @param {{id: string, name: string}} agent - 被删除的 Agent
 */
async function remove(agent) {
  const accepted = await store.confirm({
    title: "删除 Agent",
    message: `确定删除“${agent.name}”吗？本应用在其目录创建的链接也会被安全移除。`,
    confirmText: "删除",
    tone: "danger",
  });
  if (!accepted) return;
  try {
    await store.deleteAgent(agent.id);
    if (editingId.value === agent.id) reset();
  } catch (_) {}
}
</script>

<template>
  <!-- 页面容器：限宽居中 -->
  <section
    class="mx-auto flex min-h-full w-[calc(100%-3rem)] max-w-260 flex-col py-7.5 pb-12 max-[760px]:w-[calc(100%-2rem)]"
  >
    <PageHeader
      eyebrow="目标管理"
      title="Agents"
      description="保存 Agent 名称及其 Skills 目录，供应用配置使用。"
    />

    <!-- 表单卡片：名称 + 目录 + 操作按钮；窄窗口（<760px）改为单列堆叠 -->
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
          placeholder="选择 Agent 的 Skills 目录"
          :disabled="store.busy"
          @browse="browse"
        />
      </div>
      <!-- 编辑模式下额外显示“取消”按钮；保存按钮文案随模式变化 -->
      <div class="flex justify-end gap-2">
        <button
          v-if="editingId"
          class="inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface px-4 font-semibold text-ink-secondary hover:bg-canvas"
          type="button"
          @click="reset"
        >
          取消
        </button>
        <button
          class="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 font-semibold whitespace-nowrap text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="store.busy || !name.trim() || !directory.trim()"
          @click="save"
        >
          {{ editingId ? "保存修改" : "添加 Agent" }}
        </button>
      </div>
    </div>

    <!-- Agent 列表：名称、目录、链接数量统计与编辑/删除按钮 -->
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
        <!-- 链接数量：受管链接 + 外部已存在的同源手动链接 -->
        <span
          class="rounded-full border border-primary-border bg-primary-soft px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-primary"
          >{{ agent.linkedCount }} 个链接</span
        >
        <button
          class="grid size-9 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-ink-secondary hover:border-primary-border hover:bg-primary-soft hover:text-primary"
          type="button"
          title="编辑"
          @click="edit(agent)"
        >
          <Pencil :size="17" :stroke-width="1.8" />
        </button>
        <button
          class="grid size-9 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-ink-secondary hover:border-danger hover:bg-danger-soft hover:text-danger"
          type="button"
          title="删除"
          @click="remove(agent)"
        >
          <Trash2 :size="17" :stroke-width="1.8" />
        </button>
      </article>
    </div>
    <!-- 空状态：还没有配置任何 Agent -->
    <EmptyState
      v-else
      :icon="Bot"
      title="还没有 Agent"
      description="填写名称与 Skills 目录，保存后即可配置分组。"
    />
  </section>
</template>
