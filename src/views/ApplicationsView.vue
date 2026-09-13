<!--
  ApplicationsView —— 应用配置页（Agent、分组与 Skills 的联动关系）。

  页面职责：选择目标 Agent，然后通过左侧分组批量选择或右侧开关单独选择 Skills。
  已启用的 Skill id 集合是唯一真值：分组中的 Skills 全部开启时分组自动显示开启，
  操作分组则批量增删该组 Skills，重叠分组也会根据最终覆盖情况自动更新。

  开关状态完全由 store.enabledSkills 决定（受控组件），
  store 负责乐观更新、请求合并和失败回滚，
  以保证连续操作流畅，同时让界面最终状态与磁盘上的真实链接一致。
-->
<script setup>
// 图标：Bot 表示 Agent，Layers3 表示分组，Puzzle 表示单个 Skill。
import { Bot, Layers3, Puzzle } from "@lucide/vue";
// computed 派生选中项与统计信息；ref 保存当前选中的 Agent；watch 保证选择始终有效。
import { computed, ref, watch } from "vue";
// 下拉选择组件。
import BaseSelect from "../components/BaseSelect.vue";
// 空状态占位组件。
import EmptyState from "../components/EmptyState.vue";
// 页面统一页头。
import PageHeader from "../components/PageHeader.vue";
// 开关组件。
import ToggleSwitch from "../components/ToggleSwitch.vue";
// 全局状态仓库。
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
// 当前选中的 Agent id。
const selectedAgentId = ref("");
// 把 Agent 列表转换为 BaseSelect 需要的 { label, value } 结构。
const agentOptions = computed(() =>
  store.agents.map((agent) => ({ label: agent.name, value: agent.id })),
);
// 派生：当前选中的 Agent 对象（用于展示其 Skills 目录路径）。
const selectedAgent = computed(() =>
  store.agents.find((agent) => agent.id === selectedAgentId.value),
);
// 派生：当前 Agent 已启用的 Skill id 数组，是左右两列联动的唯一数据源。
const activeSkillIds = computed(
  () => store.enabledSkills[selectedAgentId.value] || [],
);
const activeSkillSet = computed(() => new Set(activeSkillIds.value));
// 组内至少有一个 Skill，且所有 Skills 均已开启时，该分组自动显示为开启。
const activeGroups = computed(() =>
  store.groups.filter(
    (group) =>
      group.skillIds.length > 0 &&
      group.skillIds.every((skillId) => activeSkillSet.value.has(skillId)),
  ),
);
const activeGroupIdSet = computed(
  () => new Set(activeGroups.value.map((group) => group.id)),
);

// Agent 列表发生变化时保证选择值始终有效。
// immediate 让首次进入页面时自动选中第一个 Agent；deep 保证重命名等改动也能触发校验。
watch(
  () => store.agents,
  (agents) => {
    if (!agents.some((agent) => agent.id === selectedAgentId.value))
      selectedAgentId.value = agents[0]?.id || "";
  },
  { immediate: true, deep: true },
);

/**
 * 开启或关闭某个分组。
 *
 * @param {{id: string, skillIds: string[]}} group - 分组
 * @param {boolean} enabled - 开关的目标状态（true 为开启）
 */
async function setGroup(group, enabled) {
  const next = new Set(activeSkillIds.value);
  group.skillIds.forEach((skillId) =>
    enabled ? next.add(skillId) : next.delete(skillId),
  );
  try {
    await store.setAgentSkills(selectedAgentId.value, [...next]);
  } catch (_) {}
}

/** 单独开启或关闭一个 Skill；覆盖完整分组时，左侧分组会自动联动。 */
async function setSkill(skillId, enabled) {
  const next = new Set(activeSkillIds.value);
  if (enabled) next.add(skillId);
  else next.delete(skillId);
  try {
    await store.setAgentSkills(selectedAgentId.value, [...next]);
  } catch (_) {}
}
</script>

<template>
  <!-- 页面容器：限宽居中 -->
  <section
    class="mx-auto flex min-h-full w-[calc(100%-3rem)] max-w-260 flex-col py-7.5 pb-12 max-[760px]:w-[calc(100%-2rem)]"
  >
    <PageHeader
      eyebrow="按需启用"
      title="应用配置"
      description="选择 Agent，通过分组批量配置或单独开启 Skills。"
    />

    <!-- 有 Agent 时才展示配置界面 -->
    <template v-if="store.agents.length">
      <!-- 目标选择卡片：Agent 下拉框 + 右侧开启数量统计 + 下方目录路径 -->
      <div
        class="grid grid-cols-[minmax(0,420px)_1fr] items-end gap-x-6 gap-y-2 rounded-xl border border-border bg-surface p-5 shadow-sm"
      >
        <div>
          <label class="mb-1.5 block text-xs font-semibold text-ink-secondary"
            >目标 Agent</label
          >
          <div class="flex items-center gap-2">
            <Bot class="shrink-0 text-primary" :size="18" /><BaseSelect
              v-model="selectedAgentId"
              :options="agentOptions"
              placeholder="选择 Agent"
            />
          </div>
        </div>
        <!-- 统计信息：已开启分组数与实际链接的 Skills 数 -->
        <div class="flex justify-end gap-6 text-xs text-ink-secondary">
          <span
            ><strong class="mr-1 text-lg text-primary">{{
              activeGroups.length
            }}</strong
            >个分组已开启</span
          >
          <span
            ><strong class="mr-1 text-lg text-primary">{{
              activeSkillIds.length
            }}</strong
            >个 Skills 已开启</span
          >
        </div>
        <!-- 当前 Agent 的 Skills 目录，便于确认配置是否指向预期位置 -->
        <p
          v-if="selectedAgent"
          class="col-span-2 m-0 truncate pl-6.5 font-mono text-xs text-ink-muted"
        >
          {{ selectedAgent.directory || "当前设备尚未配置 Skills 目录" }}
        </p>
      </div>

      <!-- 双栏配置区：左侧分组批量开关，右侧全部 Skills 单项开关。 -->
      <div
        class="mt-4 grid grid-cols-2 items-start gap-4 max-[760px]:grid-cols-1"
      >
        <section
          class="grid overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
        >
          <header
            class="flex min-h-14 items-center gap-2 border-b border-border px-4"
          >
            <Layers3 class="text-primary" :size="18" :stroke-width="1.8" />
            <h2 class="m-0 flex-1 text-sm font-bold text-ink">Skills 分组</h2>
            <span class="text-xs text-ink-muted"
              >{{ activeGroups.length }}/{{ store.groups.length }}</span
            >
          </header>

          <template v-if="store.groups.length">
            <div
              v-for="group in store.groups"
              :key="group.id"
              class="flex min-h-16.5 items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
            >
              <div
                class="grid size-9.5 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
              >
                <Layers3 :size="18" :stroke-width="1.8" />
              </div>
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <strong class="truncate">{{ group.name }}</strong>
                <span class="text-xs text-ink-muted"
                  >{{ group.skillIds.length }} 个 Skills</span
                >
              </div>
              <!-- 开启时批量加入组内 Skills；关闭时批量移除。 -->
              <ToggleSwitch
                :model-value="activeGroupIdSet.has(group.id)"
                :disabled="store.busy || !group.skillIds.length"
                :label="`${group.name} 分组开关`"
                @update:model-value="setGroup(group, $event)"
              />
            </div>
          </template>
          <EmptyState
            v-else
            :icon="Layers3"
            title="没有可应用的分组"
            description="先在分组管理页面创建至少一个分组。"
          />
        </section>

        <section
          class="grid overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
        >
          <header
            class="flex min-h-14 items-center gap-2 border-b border-border px-4"
          >
            <Puzzle class="text-primary" :size="18" :stroke-width="1.8" />
            <h2 class="m-0 flex-1 text-sm font-bold text-ink">全部 Skills</h2>
            <span class="text-xs text-ink-muted"
              >{{ activeSkillIds.length }}/{{ store.skills.length }}</span
            >
          </header>

          <template v-if="store.skills.length">
            <div
              v-for="skill in store.skills"
              :key="skill.id"
              class="flex min-h-14 items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
            >
              <div
                class="grid size-8.5 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
              >
                <Puzzle :size="16" :stroke-width="1.8" />
              </div>
              <strong class="min-w-0 flex-1 truncate text-sm">{{
                skill.name
              }}</strong>
              <ToggleSwitch
                :model-value="activeSkillSet.has(skill.id)"
                :disabled="store.busy"
                :label="`${skill.name} Skill 开关`"
                @update:model-value="setSkill(skill.id, $event)"
              />
            </div>
          </template>
          <EmptyState
            v-else
            :icon="Puzzle"
            title="没有可应用的 Skill"
            description="请先在 Skills 仓库页面配置并扫描仓库。"
          />
        </section>
      </div>
    </template>
    <!-- 还没有任何 Agent：引导先去 Agents 页面添加 -->
    <EmptyState
      v-else
      :icon="Bot"
      title="还没有 Agent"
      description="先在 Agents 页面添加名称和 Skills 目录。"
    />
  </section>
</template>
