<!--
  SkillsView —— Skills 仓库页（插件首页）。

  页面职责：
  1. 选择/填写统一 Skills 仓库目录（本应用唯一的“来源”目录）；
  2. 点击“扫描目录”后由 preload 服务递归查找包含 SKILL.md 的子目录，
     并读取元数据中的 name 字段作为展示名称；
  3. 以卡片形式列出扫描到的 Skills，供分组管理页勾选使用。

  数据流：directory 只是本地草稿值，只有扫描成功（store.setRepository）后
  才会被写入 uTools 本地数据库，因此输入过程不会影响已有配置。
-->
<script setup>
// 图标：Database 用于空状态，RefreshCw 用于“重新扫描”按钮。
import { Database, RefreshCw } from "@lucide/vue";
// ref 保存目录草稿值；watch 在外部配置变化（如清除数据）时同步草稿值。
import { ref, watch } from "vue";
// 空状态占位组件。
import EmptyState from "../components/EmptyState.vue";
// 页面统一页头。
import PageHeader from "../components/PageHeader.vue";
// 目录输入 + 浏览按钮组件。
import PathPicker from "../components/PathPicker.vue";
// 全局状态仓库（包含仓库路径、Skills 列表与所有动作方法）。
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
// 目录输入框的草稿值，初始值取自已保存的仓库路径。
const directory = ref(store.repositoryPath);

// 已保存的仓库路径变化时（初始化完成、清除数据、其他窗口修改）同步到输入框。
watch(
  () => store.repositoryPath,
  (value) => {
    directory.value = value;
  },
);

// 目录选择和手动输入共用同一个草稿值，扫描成功后再持久化。
async function browse() {
  try {
    // chooseDirectory 仅在 uTools 环境中可用（调用 utools.showOpenDialog 打开系统目录选择框）。
    const selected = await store.chooseDirectory(directory.value);
    if (selected) directory.value = selected;
  } catch (error) {
    store.notify(error.message, "error");
  }
}

/**
 * 保存仓库目录并触发首次扫描。
 * 失败信息已由 store.setRepository 内部统一提示，这里仅吞掉异常避免重复报错。
 */
async function scan() {
  if (!directory.value.trim())
    return store.notify("请先填写 Skills 仓库目录", "error");
  try {
    await store.setRepository(directory.value);
  } catch (_) {}
}

/**
 * 按已保存的仓库路径重新扫描（用于仓库内容变动后手动刷新）。
 */
async function refresh() {
  try {
    await store.refreshSkills();
  } catch (_) {}
}
</script>

<template>
  <!-- 页面容器：限宽居中，窄窗口（<760px）时收窄左右留白 -->
  <section
    class="mx-auto flex min-h-full w-[calc(100%-3rem)] max-w-260 flex-col py-7.5 pb-12 max-[760px]:w-[calc(100%-2rem)]"
  >
    <!-- 页头：右上角徽标仅在已配置仓库时展示 Skills 总数 -->
    <PageHeader
      eyebrow="统一来源"
      title="Skills 仓库"
      description="扫描目录中的 SKILL.md，并读取元数据名称。"
    >
      <div
        v-if="store.repositoryPath"
        class="rounded-full border border-primary-border bg-primary-soft px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-primary"
      >
        {{ store.skills.length }} 个 Skills
      </div>
    </PageHeader>

    <!-- 仓库配置卡片：目录输入 + 扫描按钮 + 重新扫描按钮 -->
    <div class="rounded-xl border border-border bg-surface p-5 shadow-sm">
      <label
        class="mb-1.5 block text-xs font-semibold text-ink-secondary"
        for="repository-path"
        >仓库目录</label
      >
      <div class="flex items-center gap-2">
        <!-- v-model 绑定草稿值；browse 事件由本页打开系统目录选择框 -->
        <PathPicker
          v-model="directory"
          input-id="repository-path"
          placeholder="选择统一 Skills 仓库目录"
          :disabled="store.busy"
          @browse="browse"
        />
        <!-- 扫描按钮：目录为空或正在执行其他操作时禁用 -->
        <button
          class="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 font-semibold whitespace-nowrap text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="store.busy || !directory.trim()"
          @click="scan"
        >
          扫描目录
        </button>
        <!-- 重新扫描：路径未配置时禁用，图标按钮以节省横向空间 -->
        <button
          class="grid size-10 shrink-0 place-items-center rounded-md border border-border-strong bg-surface text-ink-secondary hover:border-primary-border hover:bg-primary-soft hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          title="重新扫描"
          :disabled="store.busy || !store.repositoryPath"
          @click="refresh"
        >
          <RefreshCw :size="18" :stroke-width="1.8" />
        </button>
      </div>
      <p class="mt-2 mb-0 text-xs text-ink-muted">
        会递归查找包含 SKILL.md 的目录；这里只读取文件，不会修改仓库内容。
      </p>
    </div>

    <!-- 扫描结果：三列卡片（窄窗口两列），名称过长时省略号截断 -->
    <div
      v-if="store.skills.length"
      class="mt-5 grid grid-cols-3 gap-2 max-[760px]:grid-cols-2"
      aria-label="Skills 列表"
    >
      <div
        v-for="skill in store.skills"
        :key="skill.id"
        class="truncate rounded-lg border border-border bg-surface px-4 py-3 font-medium"
      >
        {{ skill.name }}
      </div>
    </div>
    <!-- 空状态：未扫描或目录中没有有效 Skill 时展示操作指引 -->
    <EmptyState
      v-else
      :icon="Database"
      title="还没有检测到 Skills"
      description="选择仓库目录后，所有有效的 Skill 名称会简洁地列在这里。"
    />
  </section>
</template>
