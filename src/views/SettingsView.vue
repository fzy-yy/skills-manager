<!--
  SettingsView —— 设置页。

  包含两个功能：
  1. 外观主题：浅色 / 深色切换，立即生效并写入 uTools 本地数据库；
  2. 数据管理：清除 uTools 本地数据库中的插件配置，并移除本应用创建的
     Agent Skills 链接（统一仓库中的源文件不会被删除）。

  说明：清除数据是破坏性操作，必须先经过 appStore.confirm 二次确认。
-->
<script setup>
// 图标：Database 数据管理、Moon/Sun 主题选项、Palette 外观、Trash2 清除数据。
import { Database, Moon, Palette, Sun, Trash2 } from '@lucide/vue'
// 页面统一页头。
import PageHeader from '../components/PageHeader.vue'
// 全局状态仓库（主题状态与所有动作方法）。
import { useAppStore } from '../stores/appStore'

const store = useAppStore()
// 主题选项：value 与 store.theme 对应，icon 由模板动态渲染。
const themeOptions = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon }
]

// 主题选择立即生效，并由 preload 服务写入 uTools 本地数据库。
async function selectTheme (theme) {
  // 点击当前已选主题时不做任何处理，避免多余的数据库写入。
  if (store.theme === theme) return
  const saved = await store.setTheme(theme)
  // 仅在保存成功时提示，失败时 setTheme 内部已给出错误提示并回滚主题。
  if (saved) store.notify('主题设置已保存')
}

/**
 * 清除本地数据：先二次确认，再调用服务端清理。
 * 服务端只删除仍可识别的「受管链接」，源文件与他人创建的内容一律保留。
 */
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
  <!-- 页面容器：限宽居中 -->
  <section class="mx-auto flex min-h-full w-[calc(100%_-_3rem)] max-w-[1040px] flex-col py-[30px] pb-12 max-[760px]:w-[calc(100%_-_2rem)]">
    <PageHeader eyebrow="个性设置" title="设置" description="调整界面显示偏好并管理本地数据。" />

    <!-- 外观主题卡片：左侧说明，右侧分段按钮；窄窗口（<560px）改为纵向排列 -->
    <div class="flex items-center gap-4 rounded-xl border border-border bg-surface p-4 shadow-sm max-[560px]:flex-col max-[560px]:items-stretch">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"><Palette :size="20" :stroke-width="1.8" /></span>
        <div><h2 class="m-0 text-base font-semibold text-ink">外观主题</h2><p class="mt-1 mb-0 text-xs text-ink-muted">选择适合当前使用环境的显示模式。</p></div>
      </div>
      <!-- 主题分段按钮：选中项使用白色卡片底 + 主色文字；aria-pressed 反映当前状态 -->
      <div class="flex shrink-0 rounded-lg border border-border bg-canvas p-1">
        <button
          v-for="option in themeOptions"
          :key="option.value"
          type="button"
          class="inline-flex h-9 items-center justify-center gap-2 rounded-md border-0 px-3 font-semibold"
          :class="store.theme === option.value ? 'bg-surface text-primary shadow-sm' : 'bg-transparent text-ink-muted hover:text-ink'"
          :aria-pressed="store.theme === option.value"
          @click="selectTheme(option.value)"
        >
          <component :is="option.icon" :size="16" :stroke-width="1.8" />{{ option.label }}
        </button>
      </div>
    </div>

    <!-- 数据管理卡片：危险操作区，操作进行中（store.busy）时禁用按钮 -->
    <div class="mt-4 rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div class="flex items-center gap-4">
        <span class="grid size-10 shrink-0 place-items-center rounded-lg bg-danger-soft text-danger"><Database :size="20" :stroke-width="1.8" /></span>
        <div class="min-w-0 flex-1"><h2 class="m-0 text-base font-semibold text-ink">数据管理</h2><p class="mt-1 mb-0 text-xs leading-5 text-ink-muted">清除 uTools 本地数据库中的插件配置，并移除本应用创建的 Agent Skills 链接。</p></div>
        <button class="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-md border border-danger bg-danger-soft px-4 font-semibold text-danger hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50" type="button" :disabled="store.busy" @click="clearData"><Trash2 :size="17" :stroke-width="1.8" />清除数据</button>
      </div>
    </div>
  </section>
</template>
