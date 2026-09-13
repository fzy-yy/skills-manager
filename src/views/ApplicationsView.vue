<script setup>
import { Bot, Layers3 } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import BaseSelect from '../components/BaseSelect.vue'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
import ToggleSwitch from '../components/ToggleSwitch.vue'
import { useAppStore } from '../stores/appStore'

const store = useAppStore()
const selectedAgentId = ref('')
const agentOptions = computed(() => store.agents.map(agent => ({ label: agent.name, value: agent.id })))
const selectedAgent = computed(() => store.agents.find(agent => agent.id === selectedAgentId.value))
const activeGroups = computed(() => store.enabledGroups[selectedAgentId.value] || [])
const enabledSkillCount = computed(() => {
  const ids = new Set()
  store.groups.forEach(group => {
    if (activeGroups.value.includes(group.id)) group.skillIds.forEach(id => ids.add(id))
  })
  return ids.size
})

// Agent 列表发生变化时保证选择值始终有效。
watch(() => store.agents, agents => {
  if (!agents.some(agent => agent.id === selectedAgentId.value)) selectedAgentId.value = agents[0]?.id || ''
}, { immediate: true, deep: true })

async function setGroup (groupId, enabled) {
  const next = enabled ? [...activeGroups.value, groupId] : activeGroups.value.filter(id => id !== groupId)
  try {
    const result = await store.setAgentGroups(selectedAgentId.value, next)
    const conflicts = result?.syncResult?.conflicts || []
    store.notify(
      conflicts.length ? `配置已应用，但有 ${conflicts.length} 个同名目录未被替换` : '链接配置已同步',
      conflicts.length ? 'warning' : 'success'
    )
  } catch (_) {}
}
</script>

<template>
  <section class="mx-auto flex min-h-full w-[calc(100%_-_3rem)] max-w-[1040px] flex-col py-[30px] pb-12 max-[760px]:w-[calc(100%_-_2rem)]">
    <PageHeader eyebrow="按需启用" title="应用配置" description="选择 Agent，开启或关闭 Skills 分组。" />

    <template v-if="store.agents.length">
      <div class="grid grid-cols-[minmax(0,420px)_1fr] items-end gap-x-6 gap-y-2 rounded-xl border border-border bg-surface p-5 shadow-sm">
        <div>
          <label class="mb-1.5 block text-xs font-semibold text-ink-secondary">目标 Agent</label>
          <div class="flex items-center gap-2"><Bot class="shrink-0 text-primary" :size="18" /><BaseSelect v-model="selectedAgentId" :options="agentOptions" placeholder="选择 Agent" /></div>
        </div>
        <div class="flex justify-end gap-6 text-xs text-ink-secondary">
          <span><strong class="mr-1 text-lg text-primary">{{ activeGroups.length }}</strong>个分组已开启</span>
          <span><strong class="mr-1 text-lg text-primary">{{ enabledSkillCount }}</strong>个 Skills 已链接</span>
        </div>
        <p v-if="selectedAgent" class="col-span-2 m-0 truncate pl-[26px] font-mono text-xs text-ink-muted">{{ selectedAgent.directory }}</p>
      </div>

      <div v-if="store.groups.length" class="mt-4 grid overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        <div v-for="group in store.groups" :key="group.id" class="flex min-h-[66px] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
          <div class="grid size-[38px] shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><Layers3 :size="18" :stroke-width="1.8" /></div>
          <div class="flex min-w-0 flex-1 flex-col gap-1"><strong class="truncate">{{ group.name }}</strong><span class="text-xs text-ink-muted">{{ group.skillIds.length }} 个 Skills</span></div>
          <ToggleSwitch :model-value="activeGroups.includes(group.id)" :disabled="store.busy" :label="`${group.name} 开关`" @update:model-value="setGroup(group.id, $event)" />
        </div>
      </div>
      <EmptyState v-else :icon="Layers3" title="没有可应用的分组" description="先在分组管理页面创建至少一个分组。" />
    </template>
    <EmptyState v-else :icon="Bot" title="还没有 Agent" description="先在 Agents 页面添加名称和 Skills 目录。" />
  </section>
</template>
