<script setup>
import { Bot, Moon, Pencil, Sun, Trash2 } from '@lucide/vue'
import { ref } from 'vue'
import EmptyState from '../components/EmptyState.vue'
import PageHeader from '../components/PageHeader.vue'
import PathPicker from '../components/PathPicker.vue'
import { useAppStore } from '../stores/appStore'

const store = useAppStore()
const editingId = ref('')
const name = ref('')
const directory = ref('')

function reset () {
  editingId.value = ''
  name.value = ''
  directory.value = ''
}

function edit (agent) {
  editingId.value = agent.id
  name.value = agent.name
  directory.value = agent.directory
}

async function browse () {
  try {
    const selected = await store.chooseDirectory(directory.value)
    if (selected) directory.value = selected
  } catch (error) {
    store.notify(error.message, 'error')
  }
}

async function save () {
  if (!name.value.trim() || !directory.value.trim()) return store.notify('请完整填写 Agent 名称和 Skills 目录', 'error')
  try {
    await store.upsertAgent({ id: editingId.value || undefined, name: name.value, directory: directory.value })
    reset()
  } catch (_) {}
}

async function remove (agent) {
  const accepted = await store.confirm({
    title: '删除 Agent',
    message: `确定删除“${agent.name}”吗？本应用在其目录创建的链接也会被安全移除。`,
    confirmText: '删除',
    tone: 'danger'
  })
  if (!accepted) return
  try {
    await store.deleteAgent(agent.id)
    if (editingId.value === agent.id) reset()
  } catch (_) {}
}
</script>

<template>
  <section class="mx-auto flex min-h-full w-[calc(100%_-_3rem)] max-w-[1040px] flex-col py-[30px] pb-12 max-[760px]:w-[calc(100%_-_2rem)]">
    <PageHeader eyebrow="目标管理" title="Agents" description="保存 Agent 名称及其 Skills 目录，供应用配置使用。">
      <button class="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 font-semibold text-ink-secondary hover:border-primary-border hover:bg-primary-soft hover:text-primary" type="button" :aria-label="store.theme === 'dark' ? '切换浅色主题' : '切换深色主题'" @click="store.toggleTheme">
        <Sun v-if="store.theme === 'dark'" :size="18" :stroke-width="1.8" />
        <Moon v-else :size="18" :stroke-width="1.8" />
        <span>{{ store.theme === 'dark' ? '浅色主题' : '深色主题' }}</span>
      </button>
    </PageHeader>

    <div class="grid grid-cols-[190px_minmax(0,1fr)_auto] items-end gap-3 rounded-xl border border-border bg-surface p-5 shadow-sm max-[760px]:grid-cols-1">
      <div><label class="mb-1.5 block text-xs font-semibold text-ink-secondary" for="agent-name">Agent 名称</label><input id="agent-name" v-model="name" class="h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-ink outline-none placeholder:text-ink-muted focus:border-primary focus:ring-2 focus:ring-primary-soft" placeholder="例如：Codex" /></div>
      <div><label class="mb-1.5 block text-xs font-semibold text-ink-secondary" for="agent-directory">Skills 目录</label><PathPicker v-model="directory" input-id="agent-directory" placeholder="选择 Agent 的 Skills 目录" :disabled="store.busy" @browse="browse" /></div>
      <div class="flex justify-end gap-2">
        <button v-if="editingId" class="inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface px-4 font-semibold text-ink-secondary hover:bg-canvas" type="button" @click="reset">取消</button>
        <button class="inline-flex h-10 items-center justify-center rounded-md border border-primary bg-primary px-4 font-semibold whitespace-nowrap text-on-primary hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50" type="button" :disabled="store.busy || !name.trim() || !directory.trim()" @click="save">{{ editingId ? '保存修改' : '添加 Agent' }}</button>
      </div>
    </div>

    <div v-if="store.agents.length" class="mt-4 grid gap-2">
      <article v-for="agent in store.agents" :key="agent.id" class="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm">
        <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><Bot :size="21" :stroke-width="1.8" /></span>
        <div class="flex min-w-0 flex-1 flex-col gap-1"><strong class="truncate">{{ agent.name }}</strong><span class="truncate font-mono text-xs text-ink-muted">{{ agent.directory }}</span></div>
        <span class="rounded-full border border-primary-border bg-primary-soft px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap text-primary">{{ agent.linkedCount }} 个链接</span>
        <button class="grid size-9 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-ink-secondary hover:border-primary-border hover:bg-primary-soft hover:text-primary" type="button" title="编辑" @click="edit(agent)"><Pencil :size="17" :stroke-width="1.8" /></button>
        <button class="grid size-9 shrink-0 place-items-center rounded-md border border-transparent bg-transparent text-ink-secondary hover:border-danger hover:bg-danger-soft hover:text-danger" type="button" title="删除" @click="remove(agent)"><Trash2 :size="17" :stroke-width="1.8" /></button>
      </article>
    </div>
    <EmptyState v-else :icon="Bot" title="还没有 Agent" description="填写名称与 Skills 目录，保存后即可配置分组。" />
  </section>
</template>
