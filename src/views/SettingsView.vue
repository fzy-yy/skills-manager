<script setup>
import { Check, Database, Moon, Palette, Sun, Trash2 } from '@lucide/vue'
import PageHeader from '../components/PageHeader.vue'
import { useAppStore } from '../stores/appStore'

const store = useAppStore()
const themeOptions = [
  { value: 'light', label: '浅色模式', description: '使用明亮背景，适合光线充足的环境。', icon: Sun },
  { value: 'dark', label: '深色模式', description: '降低界面亮度，适合夜间或弱光环境。', icon: Moon }
]

// 主题选择立即生效，并由 preload 服务写入本地配置文件。
async function selectTheme (theme) {
  if (store.theme === theme) return
  const saved = await store.setTheme(theme)
  if (saved) store.notify('主题设置已保存')
}

async function clearData () {
  const accepted = await store.confirm({
    title: '清除本地数据',
    message: '这会清除 Skills 仓库路径、所有分组、Agent 配置、主题设置及本应用创建的链接。统一 Skills 仓库中的源文件不会被删除。',
    confirmText: '清除数据',
    tone: 'danger'
  })
  if (!accepted) return
  try { await store.clearData() } catch (_) {}
}
</script>

<template>
  <section class="mx-auto flex min-h-full w-[calc(100%_-_3rem)] max-w-[1040px] flex-col py-[30px] pb-12 max-[760px]:w-[calc(100%_-_2rem)]">
    <PageHeader eyebrow="个性设置" title="设置" description="调整插件的界面显示偏好。" />

    <div class="rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div class="mb-4 flex items-center gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><Palette :size="20" :stroke-width="1.8" /></span>
        <div><h2 class="m-0 text-base font-semibold text-ink">外观主题</h2><p class="mt-1 mb-0 text-xs text-ink-muted">选择适合当前使用环境的显示模式。</p></div>
      </div>

      <div class="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          class="flex min-h-24 items-center gap-4 rounded-lg border p-4 text-left"
          :class="store.theme === option.value ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-ink hover:border-primary-border hover:bg-canvas'"
          :aria-pressed="store.theme === option.value"
          @click="selectTheme(option.value)"
        >
          <span class="grid size-11 shrink-0 place-items-center rounded-lg border" :class="store.theme === option.value ? 'border-primary-border bg-surface text-primary' : 'border-border bg-canvas text-ink-secondary'">
            <component :is="option.icon" :size="22" :stroke-width="1.8" />
          </span>
          <span class="min-w-0 flex-1"><strong class="block font-bold">{{ option.label }}</strong><small class="mt-1 block leading-5 text-ink-muted">{{ option.description }}</small></span>
          <span class="grid size-6 shrink-0 place-items-center rounded-full border" :class="store.theme === option.value ? 'border-primary bg-primary text-on-primary' : 'border-border-strong text-transparent'"><Check :size="15" :stroke-width="2.2" /></span>
        </button>
      </div>
    </div>

    <div class="mt-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div class="flex items-center gap-4">
        <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-danger-soft text-danger"><Database :size="20" :stroke-width="1.8" /></span>
        <div class="min-w-0 flex-1"><h2 class="m-0 text-base font-semibold text-ink">数据管理</h2><p class="mt-1 mb-0 text-xs leading-5 text-ink-muted">清除 uTools 本地数据库中的插件配置，并移除本应用创建的 Agent Skills 链接。</p></div>
        <button class="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-danger bg-danger-soft px-4 font-semibold text-danger hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50" type="button" :disabled="store.busy" @click="clearData"><Trash2 :size="17" :stroke-width="1.8" />清除数据</button>
      </div>
    </div>
  </section>
</template>
