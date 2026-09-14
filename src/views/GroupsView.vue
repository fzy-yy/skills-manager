<script setup>
import { Check, Layers3, Plus, Trash2 } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
const selectedId = ref("");
const draftName = ref("");
const draftSkills = ref([]);
const selectedGroup = computed(() =>
  store.groups.find((group) => group.id === selectedId.value),
);
const draftDirty = computed(() => {
  if (!selectedId.value) return false;
  if (!selectedGroup.value) return selectedId.value.startsWith("group-new-");
  const currentIds = [...(selectedGroup.value.skillIds || [])].sort();
  const draftIds = [...draftSkills.value].sort();
  return (
    draftName.value.trim() !== selectedGroup.value.name ||
    currentIds.length !== draftIds.length ||
    currentIds.some((id, index) => id !== draftIds[index])
  );
});

watch(
  () => store.groups,
  (groups) => {
    if (
      !groups.some((group) => group.id === selectedId.value) &&
      !selectedId.value.startsWith("group-new-")
    ) {
      selectedId.value = groups[0]?.id || "";
    }
  },
  { immediate: true },
);

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
async function createGroup() {
  if (!(await confirmDiscardDraft())) return;
  selectedId.value = `group-new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  draftName.value = "新分组";
  draftSkills.value = [];
}

/**
 * 切换当前选中的分组（左侧列表点击）。
 *
 * @param {{id: string, name: string, skillIds: string[]}} group - 被点击的分组
 */
async function selectGroup(group) {
  if (group.id === selectedId.value || !(await confirmDiscardDraft())) return;
  selectedId.value = group.id;
}

/** 草稿有改动时确认是否放弃，未改动则直接允许切换。 */
async function confirmDiscardDraft() {
  if (!draftDirty.value) return true;
  return store.confirm({
    title: "放弃未保存的修改？",
    message: "当前分组还有未保存的内容，切换后这些修改将丢失。",
    confirmText: "放弃修改",
    tone: "danger",
  });
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
    await store.saveGroups(next);
    if (!selectedGroup.value) selectedId.value = next[next.length - 1].id;
  } catch (_) {}
}

/**
 * 删除分组：先弹确认框，确认后提交新列表并回退到剩余分组中的第一个。
 * 组内 Skills 的仓库源文件和 Agent 当前启用状态都不会被删除。
 *
 * @returns {Promise<void>} 用户取消或删除完成后结束
 * @throws {never} 不向外抛出异常，失败提示统一由 store.execute 给出
 */
async function remove() {
  if (!selectedGroup.value) return;
  const accepted = await store.confirm({
    title: "删除分组",
    message: `确定删除“${selectedGroup.value.name}”吗？这不会关闭 Agent 已启用的 Skills。`,
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
  <section
    class="mx-auto flex h-full min-h-0 w-[calc(100%-3rem)] max-w-260 flex-col overflow-hidden py-7.5 max-[760px]:w-[calc(100%-2rem)]"
  >
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

    <div
      v-if="store.groups.length || selectedId"
      class="grid min-h-0 flex-1 grid-cols-[230px_minmax(0,1fr)] gap-4 pb-7.5 max-[760px]:grid-cols-1"
    >
      <aside
        class="min-h-0 overflow-y-auto rounded-xl border border-border bg-surface p-2 shadow-sm max-[760px]:max-h-48"
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

      <div
        class="flex min-h-0 min-w-0 flex-col rounded-xl border border-border bg-surface p-5 shadow-sm"
      >
        <div class="flex shrink-0 items-end gap-5 border-b border-border pb-4">
          <div class="flex-1">
            <label
              class="mb-1.5 block text-xs font-semibold text-ink-secondary"
              for="group-name"
              >分组名称</label
            ><input
              id="group-name"
              v-model="draftName"
              maxlength="120"
              class="h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink outline-none placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary-soft"
              placeholder="例如：前端开发"
            />
          </div>
          <span
            class="rounded-full border border-primary-border bg-primary-soft px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-primary"
            >已选 {{ draftSkills.length }} 项</span
          >
        </div>

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
