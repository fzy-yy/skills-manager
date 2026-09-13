<!--
  GroupsView —— 分组管理页。

  页面职责：把仓库中的 Skills 组合成可复用的「分组」，供「应用配置」页为 Agent 开启。
  左侧是分组列表，右侧是选中分组的编辑器（名称 + Skills 勾选）。

  数据流：
  - selectedId 指向当前分组；新建分组时使用临时 id（group-new-*），
    保存时由 save() 去掉前缀换成正式 id，从而复用同一个编辑界面；
  - draftName / draftSkills 是编辑草稿，只有点击“保存分组”才会写回 store.groups；
  - selectedGroup 为 undefined 表示“正在新建分组”。

  注意：删除分组只影响配置，不会删除仓库源文件；已启用该分组的 Agent
  会在服务端同步移除对应的受管链接（链接同步逻辑见 public/preload/services.js）。
-->
<script setup>
// 图标：Check 勾选框、Layers3 分组标识/空状态、Plus 新建、Trash2 删除。
import { Check, Layers3, Plus, Trash2 } from "@lucide/vue";
// computed 派生当前分组，ref 保存编辑草稿，watch 同步草稿值。
import { computed, ref, watch } from "vue";
// 空状态占位组件。
import EmptyState from "../components/EmptyState.vue";
// 页面统一页头。
import PageHeader from "../components/PageHeader.vue";
// 全局状态仓库。
import { useAppStore } from "../stores/appStore";

// 全局状态仓库：分组读写、忙碌标记、全局提示与确认对话框均由此提供。
const store = useAppStore();
// 当前选中的分组 id；新建时是临时 id（group-new-*）。
const selectedId = ref("");
// 分组名称草稿。
const draftName = ref("");
// 已勾选的 Skill id 草稿数组。
const draftSkills = ref([]);
// 派生：当前选中的分组对象；新建状态下为 undefined。
const selectedGroup = computed(() =>
  store.groups.find((group) => group.id === selectedId.value),
);

// 异步加载配置后自动选择第一个分组，同时保持当前有效选择。
// immediate 保证首次渲染时就有默认选中项；deep 保证分组内容变化也能重新校验。
watch(
  () => store.groups,
  (groups) => {
    // 仅当原选中项已不存在、且当前不在“新建分组”状态时才回退到第一个分组。
    if (
      !groups.some((group) => group.id === selectedId.value) &&
      !selectedId.value.startsWith("group-new-")
    ) {
      selectedId.value = groups[0]?.id || "";
    }
  },
  { immediate: true, deep: true },
);

// 切换选中分组时，把该分组的数据复制到草稿，避免直接编辑 store 中的状态。
// 注意：skillIds 是原样复制，即使其中含有仓库中已不存在的 Skill id 也会保留，
// 这样不会因为仓库临时缺少文件而静默丢弃用户既有的分组配置。
watch(
  selectedGroup,
  (group) => {
    if (!group) return;
    draftName.value = group.name;
    draftSkills.value = [...(group.skillIds || [])];
  },
  { immediate: true },
);

/**
 * 进入“新建分组”状态：生成临时 id，并清空名称与勾选项。
 * 临时 id 前缀是 group-new-，保存时会被替换为正式的 group- 前缀。
 */
function createGroup() {
  selectedId.value = `group-new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  draftName.value = "新分组";
  draftSkills.value = [];
}

/**
 * 切换当前选中的分组（左侧列表点击）。
 *
 * @param {{id: string, name: string, skillIds: string[]}} group - 被点击的分组
 */
function selectGroup(group) {
  selectedId.value = group.id;
}

/**
 * 勾选/取消勾选一个 Skill（在草稿上操作，保存后生效）。
 *
 * @param {string} skillId - Skill 的仓库相对路径 id
 */
function toggleSkill(skillId) {
  draftSkills.value = draftSkills.value.includes(skillId)
    ? draftSkills.value.filter((id) => id !== skillId)
    : [...draftSkills.value, skillId];
}

/**
 * 保存分组：新建时追加到列表，编辑时替换对应项，然后整体提交给 store。
 * 保存成功后若原来处于新建状态，需要把选中项切换到刚创建的分组。
 *
 * @returns {Promise<void>} 校验不通过或保存完成后结束
 * @throws {never} 不向外抛出异常，失败提示统一由 store.execute 给出
 */
async function save() {
  const name = draftName.value.trim();
  if (!name) return store.notify("请输入分组名称", "error");
  // selectedGroup 存在表示编辑已有分组，否则为新建。
  const next = selectedGroup.value
    ? store.groups.map((group) =>
        group.id === selectedId.value
          ? { ...group, name, skillIds: [...draftSkills.value] }
          : group,
      )
    : [
        ...store.groups,
        {
          id: selectedId.value.replace("group-new-", "group-"),
          name,
          skillIds: [...draftSkills.value],
        },
      ];
  try {
    // 保存分组后服务端会按新分组重建受影响的 Agent 受管链接，前端无需再手动同步。
    await store.saveGroups(next);
    // 新建完成后把选中项指向该分组，界面从“空草稿”切换为真实分组。
    if (!selectedGroup.value) selectedId.value = next[next.length - 1].id;
  } catch (_) {}
}

/**
 * 删除分组：先弹确认框，确认后提交新列表并回退到剩余分组中的第一个。
 * 组内 Skills 的仓库源文件不会被删除，只会同步移除 Agent 目录下不再需要的链接。
 *
 * @returns {Promise<void>} 用户取消或删除完成后结束
 * @throws {never} 不向外抛出异常，失败提示统一由 store.execute 给出
 */
async function remove() {
  if (!selectedGroup.value) return;
  const accepted = await store.confirm({
    title: "删除分组",
    message: `确定删除“${selectedGroup.value.name}”吗？已应用该组的 Agent 会同步移除不再需要的链接。`,
    confirmText: "删除",
    tone: "danger",
  });
  if (!accepted) return;
  const next = store.groups.filter((group) => group.id !== selectedId.value);
  try {
    await store.saveGroups(next);
    selectedId.value = next[0]?.id || "";
  } catch (_) {}
}
</script>

<template>
  <!-- 固定页面可用高度，只有 Skills 勾选区滚动，避免内容撑高造成底部空白。 -->
  <section
    class="mx-auto flex h-full min-h-0 w-[calc(100%-3rem)] max-w-260 flex-col overflow-hidden py-7.5 max-[760px]:w-[calc(100%-2rem)]"
  >
    <!-- 页头：右上角“新建分组”按钮，仓库为空（无 Skills）时禁用 -->
    <PageHeader
      eyebrow="灵活组合"
      title="分组管理"
      description="将常用 Skills 组合为可重复应用的配置组。"
    >
      <button
        class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 font-semibold whitespace-nowrap text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        type="button"
        :disabled="!store.skills.length"
        @click="createGroup"
      >
        <Plus :size="18" />新建分组
      </button>
    </PageHeader>

    <!-- 主体两栏布局：左侧 230px 分组列表，右侧自适应编辑器 -->
    <div
      v-if="store.groups.length || selectedId"
      class="grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)] gap-4 pb-7.5"
    >
      <!-- 左侧：分组列表，每项显示名称与包含的 Skills 数量 -->
      <aside
        class="min-h-0 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-sm"
      >
        <button
          v-for="group in store.groups"
          :key="group.id"
          class="flex h-10 w-full items-center justify-between rounded-md border-0 px-3 text-left hover:bg-canvas"
          :class="
            selectedId === group.id
              ? 'bg-primary-soft font-semibold text-primary'
              : 'bg-transparent text-ink-secondary'
          "
          type="button"
          @click="selectGroup(group)"
        >
          <span class="truncate">{{ group.name }}</span
          ><small
            class="ml-2 min-w-6 rounded-full bg-primary-soft px-1.5 py-0.5 text-center text-primary"
            >{{ group.skillIds.length }}</small
          >
        </button>
        <p
          v-if="!store.groups.length"
          class="px-2 py-4 text-center text-xs text-ink-muted"
        >
          正在创建第一个分组
        </p>
      </aside>

      <!-- 右侧：分组编辑器（名称输入 + Skills 勾选面板 + 底部操作栏） -->
      <div
        class="flex min-h-0 min-w-0 flex-col rounded-xl border border-border bg-surface p-5 shadow-sm"
      >
        <!-- 编辑区头部：分组名称与已选数量徽标 -->
        <div class="flex shrink-0 items-end gap-5 border-b border-border pb-4">
          <div class="flex-1">
            <label
              class="mb-1.5 block text-xs font-semibold text-ink-secondary"
              for="group-name"
              >分组名称</label
            ><input
              id="group-name"
              v-model="draftName"
              class="h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink outline-none placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary-soft"
              placeholder="例如：前端开发"
            />
          </div>
          <span
            class="rounded-full border border-primary-border bg-primary-soft px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-primary"
            >已选 {{ draftSkills.length }} 项</span
          >
        </div>

        <!-- Skills 勾选区：两列网格，仅该区域滚动；点击整行即可切换勾选状态 -->
        <div
          class="grid min-h-0 flex-1 auto-rows-min grid-cols-2 content-start gap-2 overflow-y-auto py-4 pr-1"
        >
          <label
            v-for="skill in store.skills"
            :key="skill.id"
            class="flex h-10 min-w-0 cursor-pointer items-center gap-2.5 rounded-md border px-3"
            :class="
              draftSkills.includes(skill.id)
                ? 'border-primary-border bg-primary-soft text-primary'
                : 'border-border text-ink hover:border-primary-border'
            "
          >
            <!-- 原生 checkbox 视觉隐藏但保留语义，勾选样式由相邻的方块模拟 -->
            <span class="relative shrink-0"
              ><input
                class="peer absolute opacity-0"
                type="checkbox"
                :checked="draftSkills.includes(skill.id)"
                @change="toggleSkill(skill.id)" /><span
                class="grid size-4.5 place-items-center rounded border border-border-strong bg-surface text-transparent peer-checked:border-primary peer-checked:bg-primary peer-checked:text-on-primary"
                ><Check :size="14" /></span
            ></span>
            <span class="truncate">{{ skill.name }}</span>
          </label>
        </div>

        <!-- 底部操作栏：左侧删除（仅编辑已有分组时出现），右侧保存 -->
        <footer class="flex shrink-0 items-center border-t border-border pt-4">
          <button
            v-if="selectedGroup"
            class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-danger bg-danger-soft px-4 font-semibold text-danger hover:bg-canvas"
            type="button"
            :disabled="store.busy"
            @click="remove"
          >
            <Trash2 :size="17" />删除分组
          </button>
          <span class="flex-1" />
          <button
            class="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            :disabled="store.busy || !draftName.trim()"
            @click="save"
          >
            保存分组
          </button>
        </footer>
      </div>
    </div>

    <!-- 空状态：没有任何分组且未在新建时展示，并根据是否已扫描到 Skills 给出不同指引 -->
    <EmptyState
      v-else
      :icon="Layers3"
      title="还没有分组"
      :description="
        store.skills.length
          ? '创建分组，然后选择要包含的 Skills。'
          : '请先在 Skills 仓库页面完成目录扫描。'
      "
    >
      <button
        v-if="store.skills.length"
        class="mt-4 inline-flex h-10 items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 font-semibold text-on-primary hover:bg-primary-hover"
        type="button"
        @click="createGroup"
      >
        <Plus :size="18" />新建分组
      </button>
    </EmptyState>
  </section>
</template>
