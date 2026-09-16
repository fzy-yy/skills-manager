<script setup>
import { Bot, CircleAlert, Layers3, Puzzle } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import BaseSelect from "../components/BaseSelect.vue";
import EmptyState from "../components/EmptyState.vue";
import PageHeader from "../components/PageHeader.vue";
import ToggleRow from "../components/ToggleRow.vue";
import { useAppStore } from "../stores/appStore";

const store = useAppStore();
const selectedAgentId = ref("");
const agentOptions = computed(() =>
  store.agents.map((agent) => ({ label: agent.name, value: agent.id })),
);
const selectedAgent = computed(() =>
  store.agents.find((agent) => agent.id === selectedAgentId.value),
);
const activeSkillIds = computed(
  () => store.enabledSkills[selectedAgentId.value] || [],
);
const activeSkillSet = computed(() => new Set(activeSkillIds.value));
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
const syncIssues = computed(
  () => store.agentIssues[selectedAgentId.value] || [],
);
const syncHasErrors = computed(() =>
  syncIssues.value.some((issue) => issue.type === "error"),
);

watch(
  () => store.agents,
  (agents) => {
    if (!agents.some((agent) => agent.id === selectedAgentId.value))
      selectedAgentId.value = agents[0]?.id || "";
  },
  { immediate: true },
);

/**
 * 开启或关闭某个分组。
 * 提交由 store 内部合并防抖，界面上的开关状态立即生效。
 *
 * @param {{id: string, skillIds: string[]}} group - 分组
 * @param {boolean} enabled - 开关的目标状态（true 为开启）
 */
function setGroup(group, enabled) {
  const next = new Set(activeSkillIds.value);
  group.skillIds.forEach((skillId) =>
    enabled ? next.add(skillId) : next.delete(skillId),
  );
  store.setAgentSkills(selectedAgentId.value, [...next]);
}

/** 单独开启或关闭一个 Skill；覆盖完整分组时，左侧分组会自动联动。 */
function setSkill(skillId, enabled) {
  const next = new Set(activeSkillIds.value);
  if (enabled) next.add(skillId);
  else next.delete(skillId);
  store.setAgentSkills(selectedAgentId.value, [...next]);
}
</script>

<template>
  <section
    class="mx-auto flex min-h-full w-[calc(100%-3rem)] max-w-260 flex-col py-7.5 pb-12 max-[760px]:w-[calc(100%-2rem)]"
  >
    <PageHeader
      eyebrow="按需启用"
      title="应用配置"
      description="选择 Agent，通过分组批量配置或单独开启 Skills。"
    />

    <template v-if="store.agents.length">
      <div
        class="grid grid-cols-[minmax(0,420px)_minmax(0,1fr)] items-end gap-x-6 gap-y-2 rounded-xl border border-border bg-surface p-5 shadow-sm max-[760px]:grid-cols-1"
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
        <div
          class="flex flex-wrap justify-end gap-x-6 gap-y-1 text-xs text-ink-secondary max-[760px]:justify-start max-[760px]:pl-6.5"
        >
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
        <p
          v-if="selectedAgent"
          class="col-span-2 m-0 truncate pl-6.5 font-mono text-xs text-ink-muted max-[760px]:col-span-1"
        >
          {{ selectedAgent.directory || "当前设备尚未配置 Skills 目录" }}
        </p>
      </div>

      <div
        v-if="syncIssues.length"
        class="mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm"
        :class="
          syncHasErrors
            ? 'border-danger bg-danger-soft text-danger'
            : 'border-warning bg-warning-soft text-warning'
        "
        :role="syncHasErrors ? 'alert' : 'status'"
      >
        <CircleAlert class="mt-0.5 shrink-0" :size="17" />
        <div class="min-w-0">
          <strong class="block font-bold">链接同步存在问题</strong>
          <p
            v-for="issue in syncIssues.slice(0, 3)"
            :key="`${issue.type}:${issue.message}`"
            class="mt-1 mb-0 wrap-break-word"
          >
            {{ issue.message }}
          </p>
          <p v-if="syncIssues.length > 3" class="mt-1 mb-0">
            另有 {{ syncIssues.length - 3 }} 条问题，请修复目录后重新操作。
          </p>
        </div>
      </div>

      <div
        class="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-4 max-[760px]:grid-cols-1"
      >
        <section
          class="grid min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
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
            <ToggleRow
              v-for="group in store.groups"
              :key="group.id"
              :icon="Layers3"
              :title="group.name"
              :subtitle="`${group.skillIds.length} 个 Skills`"
              :model-value="activeGroupIdSet.has(group.id)"
              :disabled="store.busy || !group.skillIds.length"
              :label="`${group.name} 分组开关`"
              @update:model-value="setGroup(group, $event)"
            />
          </template>
          <EmptyState
            v-else
            :icon="Layers3"
            title="没有可应用的分组"
            description="先在分组管理页面创建至少一个分组。"
          />
        </section>

        <section
          class="grid min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
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
            <ToggleRow
              v-for="skill in store.skills"
              :key="skill.id"
              :icon="Puzzle"
              :title="skill.name"
              :model-value="activeSkillSet.has(skill.id)"
              :disabled="store.busy"
              :label="`${skill.name} Skill 开关`"
              @update:model-value="setSkill(skill.id, $event)"
            />
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
    <EmptyState
      v-else
      :icon="Bot"
      title="还没有 Agent"
      description="先在 Agents 页面添加名称和 Skills 目录。"
    />
  </section>
</template>
