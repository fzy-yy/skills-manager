<!--
  ApplicationsView —— 应用配置页（Agent 与分组的关联关系）。

  页面职责：选择目标 Agent，然后逐个开启/关闭分组。
  开关先由 Pinia 乐观更新；短暂防抖后只把最终状态提交给 preload 服务做差量同步：
  - 新开启的分组内的 Skills，会在 Agent 目录下创建指向仓库源目录的链接；
  - 取消开启或被删除的分组，只会移除「本应用创建且仍指向原目标」的受管链接，
    手动创建的文件/目录/链接一律保留并给出提示。

  数据流：activeGroups 取自 store.enabledGroups[选中 Agent]，
  开关状态完全由 store 决定（受控组件），由 store 负责乐观更新、请求合并和失败回滚，
  以保证连续操作流畅，同时让界面最终状态与磁盘上的真实链接一致。
-->
<script setup>
// 图标：Bot 表示 Agent，Layers3 表示分组。
import { Bot, Layers3 } from "@lucide/vue";
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
// 派生：当前 Agent 已启用的分组 id 数组，直接驱动各分组开关的显示状态。
const activeGroups = computed(
  () => store.enabledGroups[selectedAgentId.value] || [],
);
// 使用服务端核验后的实际链接数量，冲突或创建失败的 Skill 不会被误计为已链接。
const actualLinkedCount = computed(() => selectedAgent.value?.linkedCount || 0);

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
 * @param {string} groupId - 分组 id
 * @param {boolean} enabled - 开关的目标状态（true 为开启）
 */
async function setGroup(groupId, enabled) {
  // 依据目标状态计算新的启用列表；Pinia 会合并连续切换，服务端只处理最终差集。
  const next = enabled
    ? [...activeGroups.value, groupId]
    : activeGroups.value.filter((id) => id !== groupId);
  try {
    await store.setAgentGroups(selectedAgentId.value, next);
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
      description="选择 Agent，开启或关闭 Skills 分组。"
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
              actualLinkedCount
            }}</strong
            >个 Skills 已链接</span
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

      <!-- 分组开关列表：每行展示分组名、包含的 Skills 数量与开关 -->
      <div
        v-if="store.groups.length"
        class="mt-4 grid overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
      >
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
            <strong class="truncate">{{ group.name }}</strong
            ><span class="text-xs text-ink-muted"
              >{{ group.skillIds.length }} 个 Skills</span
            >
          </div>
          <!-- 受控开关：状态来自 store，连续切换由 store 防抖合并后提交 -->
          <ToggleSwitch
            :model-value="activeGroups.includes(group.id)"
            :disabled="store.busy"
            :label="`${group.name} 开关`"
            @update:model-value="setGroup(group.id, $event)"
          />
        </div>
      </div>
      <!-- 已有 Agent 但还没有分组：引导先去创建分组 -->
      <EmptyState
        v-else
        :icon="Layers3"
        title="没有可应用的分组"
        description="先在分组管理页面创建至少一个分组。"
      />
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
