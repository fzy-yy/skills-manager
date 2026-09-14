<script setup>
import { Database, RefreshCw } from "@lucide/vue";
import { ref, watch } from "vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
import PathPicker from "../components/PathPicker.vue";
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
const directory = ref(store.repositoryPath);

watch(
  () => store.repositoryPath,
  (value) => {
    directory.value = value;
  },
);

/**
 * 打开系统目录选择框，把结果写入草稿值。
 * 注意：这里不落库、不扫描，用户仍需点击“扫描目录”才会生效。
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
  <section
    class="mx-auto flex min-h-full w-[calc(100%-3rem)] max-w-260 flex-col py-7.5 pb-12 max-[760px]:w-[calc(100%-2rem)]"
  >
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

    <div class="rounded-xl border border-border bg-surface p-5 shadow-sm">
      <label
        class="mb-1.5 block text-xs font-semibold text-ink-secondary"
        for="repository-path"
        >仓库目录</label
      >
      <div class="flex items-center gap-2">
        <PathPicker
          v-model="directory"
          input-id="repository-path"
          placeholder="选择统一 Skills 仓库目录"
          :disabled="store.busy"
          @browse="browse"
        />
        <button
          class="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 font-semibold whitespace-nowrap text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          type="button"
          :disabled="store.busy || !directory.trim()"
          @click="scan"
        >
          扫描目录
        </button>
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
    <EmptyState
      v-else
      :icon="Database"
      title="还没有检测到 Skills"
      description="选择仓库目录后，所有有效的 Skill 名称会简洁地列在这里。"
    />
  </section>
</template>
