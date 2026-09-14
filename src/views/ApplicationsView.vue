<!--
  ApplicationsView —— 应用配置页（Agent、分组与 Skills 的联动关系）。

  页面职责：选择目标 Agent，然后通过左侧分组批量选择或右侧开关单独选择 Skills。
  已启用的 Skill id 集合是唯一真值：分组中的 Skills 全部开启时分组自动显示开启，
  操作分组则批量增删该组 Skills，重叠分组也会根据最终覆盖情况自动更新。

  开关状态完全由 store.enabledSkills 决定（受控组件），
  store 负责乐观更新、请求合并和失败回滚，
  以保证连续操作流畅，同时让界面最终状态与磁盘上的真实链接一致。
-->

<!--
  联动规则与注意事项：
  - 分组没有独立的持久化状态：左侧分组开关是「group.skillIds 是否已被全部启用」的投影，
    因此重叠分组（两个分组包含同一个 Skill）会自动反映最终覆盖情况，无需人工同步；
  - 本页不做任何文件操作，只负责“选择”；Agent 目录下受管链接的增删由 preload 服务按差集完成；
  - 所有开关在 store.busy（有耗时操作进行中）时禁用，目的是避免上一轮同步没结束时又排入新请求，
    否则最终落库的状态会和用户看到的不一致。
-->
<script setup>
// 图标：Bot 表示 Agent，Layers3 表示分组，Puzzle 表示单个 Skill。
import { Bot, CircleAlert, Layers3, Puzzle } from "@lucide/vue";
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
// 页面状态全部由 store 派生，本页只保留「当前选中的 Agent」这一个交互态。
// 当前选中的 Agent id。
const selectedAgentId = ref("");
// 把 Agent 列表转换为 BaseSelect 需要的 { label, value } 结构。
// 不做缓存：Agent 数量很少，重命名后也能立即反映到下拉框。
const agentOptions = computed(() =>
  store.agents.map((agent) => ({ label: agent.name, value: agent.id })),
);
// 派生：当前选中的 Agent 对象（用于展示其 Skills 目录路径）。
// 选中项被其他窗口删除时，这里会变成 undefined，模板据此隐藏目录行。
const selectedAgent = computed(() =>
  store.agents.find((agent) => agent.id === selectedAgentId.value),
);
// 派生：当前 Agent 已启用的 Skill id 数组，是左右两列联动的唯一数据源。
const activeSkillIds = computed(
  () => store.enabledSkills[selectedAgentId.value] || [],
);
// 用 Set 支撑逐个 Skill 的开启判断：列表较长时避免每行都做一次数组线性查找。
const activeSkillSet = computed(() => new Set(activeSkillIds.value));
// 组内至少有一个 Skill，且所有 Skills 均已开启时，该分组自动显示为开启。
// 空分组恒判定为未开启，这样界面上的开关会被同时置灰，避免出现没有意义的操作。
const activeGroups = computed(() =>
  store.groups.filter(
    (group) =>
      group.skillIds.length > 0 &&
      group.skillIds.every((skillId) => activeSkillSet.value.has(skillId)),
  ),
);
// 模板里的分组开关是受控组件，用 Set 让判断保持 O(1)，避免每次渲染都遍历数组。
const activeGroupIdSet = computed(
  () => new Set(activeGroups.value.map((group) => group.id)),
);
// 高频开关产生的问题以内联摘要展示，不使用右下角逐 Skill 通知。
const syncIssues = computed(
  () => store.agentSyncIssues[selectedAgentId.value] || [],
);
const syncHasErrors = computed(() =>
  syncIssues.value.some((issue) => issue.type === "error"),
);

// Agent 列表发生变化时保证选择值始终有效。
// immediate 让首次进入页面时自动选中第一个 Agent；deep 保证重命名等改动也能触发校验。
// 注意：这里只「纠正」失效的选择，绝不写回 store；否则列表刷新会触发多余的数据库写入，
// 还可能打断正在进行的链接同步。
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
  // 以当前启用集合的副本为基准做批量增删：一次提交只包含最终集合，
  // 从而避免逐个 Skill 提交时读到尚未回写的过期响应式值。
  const next = new Set(activeSkillIds.value);
  group.skillIds.forEach((skillId) =>
    enabled ? next.add(skillId) : next.delete(skillId),
  );
  // 提交给 store 的防抖合并逻辑：连续点击多个分组只会触发一次链接同步。
  try {
    await store.setAgentSkills(selectedAgentId.value, [...next]);
  } catch (_) {}
  // 失败时 store 已给出全局提示并回滚乐观状态，这里静默即可，
  // 否则会在控制台留下未处理的 Promise 拒绝，也会造成重复提示。
}

/** 单独开启或关闭一个 Skill；覆盖完整分组时，左侧分组会自动联动。 */
// 左侧分组没有自己的状态，它由最终启用集合推导，所以这里只要提交正确的集合，
// 分组开关与顶部统计就会自动保持一致，不需要额外的同步代码。
async function setSkill(skillId, enabled) {
  const next = new Set(activeSkillIds.value);
  if (enabled) next.add(skillId);
  else next.delete(skillId);
  try {
    await store.setAgentSkills(selectedAgentId.value, [...next]);
  } catch (_) {}
  // 失败处理与 setGroup 相同：store 已提示并回滚，这里静默。
}
</script>

<template>
  <!-- 页面容器：限宽居中 -->
  <section
    class="mx-auto flex min-h-full w-[calc(100%-3rem)] max-w-260 flex-col py-7.5 pb-12 max-[760px]:w-[calc(100%-2rem)]"
  >
    <!-- 页头：说明本页的配置目标 -->
    <PageHeader
      eyebrow="按需启用"
      title="应用配置"
      description="选择 Agent，通过分组批量配置或单独开启 Skills。"
    />

    <!-- 有 Agent 时才展示配置界面 -->
    <!-- 没有任何 Agent 时，下面的 EmptyState 会引导用户先去 Agents 页面添加 -->
    <template v-if="store.agents.length">
      <!-- 目标选择卡片：Agent 下拉框 + 右侧开启数量统计 + 下方目录路径 -->
      <!-- 统计与目录都属于「当前 Agent 的只读信息」，切换 Agent 时会自动重新派生 -->
      <div
        class="grid grid-cols-[minmax(0,420px)_minmax(0,1fr)] items-end gap-x-6 gap-y-2 rounded-xl border border-border bg-surface p-5 shadow-sm max-[760px]:grid-cols-1"
      >
        <!-- 左侧：目标 Agent 下拉选择（图标 + 下拉框） -->
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
        <!-- 两个数字都来自 store.enabledSkills 的派生结果，和右侧逐个开关始终一致 -->
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
        <!-- 当前 Agent 的 Skills 目录，便于确认配置是否指向预期位置 -->
        <!-- 用 v-if 兼容「Agent 被其他窗口删除」的瞬时状态，避免渲染 undefined -->
        <p
          v-if="selectedAgent"
          class="col-span-2 m-0 truncate pl-6.5 font-mono text-xs text-ink-muted max-[760px]:col-span-1"
        >
          {{ selectedAgent.directory || "当前设备尚未配置 Skills 目录" }}
        </p>
      </div>

      <!-- 只汇总最近一次同步异常；下一次成功同步会自动清空。 -->
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

      <!-- 双栏配置区：左侧分组批量开关，右侧全部 Skills 单项开关。 -->
      <!-- 窄窗口（<760px）自动折成单列，避免两列都被挤压到无法阅读 -->
      <div
        class="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-4 max-[760px]:grid-cols-1"
      >
        <section
          class="grid min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
        >
          <header
            class="flex min-h-14 items-center gap-2 border-b border-border px-4"
          >
            <!-- 左栏：分组批量开关，开启即把组内 Skills 全部加入启用集合 -->
            <Layers3 class="text-primary" :size="18" :stroke-width="1.8" />
            <h2 class="m-0 flex-1 text-sm font-bold text-ink">Skills 分组</h2>
            <span class="text-xs text-ink-muted"
              >{{ activeGroups.length }}/{{ store.groups.length }}</span
            >
          </header>

          <template v-if="store.groups.length">
            <!-- 逐个渲染分组；组内没有 Skills 时开关会被置灰（无内容可应用） -->
            <div
              v-for="group in store.groups"
              :key="group.id"
              class="grid min-h-16.5 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
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
              <!-- busy 期间禁用：避免上一轮链接同步未结束时又排入新请求；空分组也禁用 -->
              <ToggleSwitch
                class="justify-self-end"
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
          class="grid min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
        >
          <header
            class="flex min-h-14 items-center gap-2 border-b border-border px-4"
          >
            <!-- 右栏：全部 Skills 的单项开关，与左栏共享同一份启用集合 -->
            <Puzzle class="text-primary" :size="18" :stroke-width="1.8" />
            <h2 class="m-0 flex-1 text-sm font-bold text-ink">全部 Skills</h2>
            <span class="text-xs text-ink-muted"
              >{{ activeSkillIds.length }}/{{ store.skills.length }}</span
            >
          </header>

          <template v-if="store.skills.length">
            <!-- 逐项开关：开启后 preload 会在该 Agent 目录创建指向仓库源目录的受管链接 -->
            <div
              v-for="skill in store.skills"
              :key="skill.id"
              class="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
            >
              <div
                class="grid size-8.5 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
              >
                <Puzzle :size="16" :stroke-width="1.8" />
              </div>
              <strong class="min-w-0 flex-1 truncate text-sm">{{
                skill.name
              }}</strong>
              <!-- 受控开关：状态完全来自 store，开启/关闭由 setSkill 提交最终集合 -->
              <ToggleSwitch
                class="justify-self-end"
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
