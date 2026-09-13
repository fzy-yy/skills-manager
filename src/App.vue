<script setup>
import { Bot, Database, Layers3, Link2, Settings2, X, Check, CircleAlert } from '@lucide/vue'
import { onMounted } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { useAppStore } from './stores/appStore'

const store = useAppStore()
const router = useRouter()
const tabs = [
  { path: '/skills', label: 'Skills 仓库', icon: Database },
  { path: '/groups', label: '分组管理', icon: Layers3 },
  { path: '/applications', label: '应用配置', icon: Link2 },
  { path: '/agents', label: 'Agents', icon: Bot },
  { path: '/settings', label: '设置', icon: Settings2 }
]

onMounted(() => {
  store.initialize()
  // 每次从 uTools 搜索入口进入时回到仓库首页。
  window.utools?.onPluginEnter(() => router.push('/skills'))
})
</script>

<template>
  <div class="flex h-full flex-col bg-canvas text-ink">
    <header class="flex h-16 shrink-0 items-center justify-center border-b border-border bg-surface px-6 max-[760px]:px-4">
      <nav class="flex h-full items-stretch justify-center gap-1" aria-label="主导航">
        <RouterLink
          v-for="tab in tabs"
          :key="tab.path"
          :to="tab.path"
          class="relative flex min-w-[108px] items-center justify-center gap-2 px-3 font-bold text-ink-secondary hover:bg-canvas hover:text-ink max-[760px]:min-w-0 max-[760px]:px-2"
          active-class="text-primary after:absolute after:right-3 after:bottom-0 after:left-3 after:h-0.5 after:bg-primary"
        ><component :is="tab.icon" :size="17" :stroke-width="1.8" /><span>{{ tab.label }}</span></RouterLink>
      </nav>
    </header>

    <main class="min-h-0 flex-1 overflow-auto"><RouterView /></main>

    <div v-if="store.notice" class="fixed right-5 bottom-5 z-40 flex min-h-11 max-w-[min(440px,calc(100vw-40px))] items-center gap-2.5 rounded-lg px-3 py-2.5 shadow-xl" :class="store.notice.type === 'error' ? 'bg-danger text-on-primary' : store.notice.type === 'warning' ? 'border border-warning bg-warning-soft text-warning' : 'bg-ink text-surface'" role="status">
      <CircleAlert v-if="store.notice.type === 'error'" class="shrink-0" :size="17" />
      <Check v-else class="shrink-0" :size="17" />
      <span>{{ store.notice.message }}</span>
      <button class="ml-2 grid size-6 place-items-center rounded border-0 bg-transparent text-current hover:bg-surface/10" type="button" aria-label="关闭提示" @click="store.dismissNotice"><X :size="16" /></button>
    </div>

    <div v-if="store.busy" class="fixed top-0 left-0 z-[60] h-0.5 w-full bg-primary" aria-label="处理中" />
    <ConfirmDialog :dialog="store.dialog" @resolve="store.resolveDialog" />
  </div>
</template>
