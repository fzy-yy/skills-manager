<!--
  BaseSelect —— 无依赖的基础下拉选择组件。

  设计要点：
  1. 使用 v-model 双向绑定（modelValue + update:modelValue），可直接替代原生 select；
  2. 浮层由自身状态 open 控制，不使用原生 select，以便完全复用主题令牌与深色模式；
  3. 监听 document 的 mousedown 事件，点击组件外部时自动收起浮层。

  使用方式（参考 ApplicationsView.vue）：
  <BaseSelect v-model="selectedAgentId" :options="agentOptions" placeholder="选择 Agent" />
-->
<script setup>
// lucide 图标：下拉箭头（触发按钮）与勾选标记（当前选中项）。
import { Check, ChevronDown } from '@lucide/vue'
// computed 计算当前选中项；onMounted/onBeforeUnmount 注册与注销全局点击监听。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

// 组件属性定义。
const props = defineProps({
  // 当前选中值（v-model），支持字符串或数字，与 option.value 全等比较。
  modelValue: { type: [String, Number], default: '' },
  // 可选项列表，元素结构为 { label: string, value: string|number }。
  options: { type: Array, default: () => [] },
  // 未选中任何项时显示的占位文案。
  placeholder: { type: String, default: '请选择' },
  // 是否禁用（禁用时按钮置灰且不可展开）。
  disabled: Boolean
})
// 向外抛出 v-model 更新事件。
const emit = defineEmits(['update:modelValue'])
// 组件根元素引用，用于判断点击是否发生在组件内部。
const root = ref(null)
// 浮层展开状态。
const open = ref(false)
// 根据 modelValue 反查选项对象，用于展示选中项的 label。
const selected = computed(() => props.options.find(option => option.value === props.modelValue))

/**
 * 选中某个选项：同步给父组件并收起浮层。
 *
 * @param {{label: string, value: string|number}} option - 被点击的选项
 */
function select (option) {
  emit('update:modelValue', option.value)
  open.value = false
}

// 点击组件外部时关闭浮层，避免残留遮挡其他内容。
function handleOutsideClick (event) {
  if (root.value && !root.value.contains(event.target)) open.value = false
}
// 浮层是普通 DOM 节点而非 Portal，因此用全局 mousedown 判断“外部点击”。
onMounted(() => document.addEventListener('mousedown', handleOutsideClick))
// 组件卸载时必须移除监听，防止内存泄漏与已销毁组件被访问。
onBeforeUnmount(() => document.removeEventListener('mousedown', handleOutsideClick))
</script>

<template>
  <!-- 根容器：relative 为绝对定位的浮层提供定位参照 -->
  <div ref="root" class="relative w-full">
    <!-- 触发按钮：展示当前选中项或占位文案，并声明 listbox 语义 -->
    <button
      type="button"
      class="flex h-10 w-full items-center justify-between gap-3 rounded-md border border-border-strong bg-surface px-3 text-left text-ink outline-none hover:border-primary-border focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary-soft disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="open = !open"
    >
      <span class="truncate" :class="selected ? 'text-ink' : 'text-ink-muted'">{{ selected?.label || placeholder }}</span>
      <ChevronDown class="shrink-0 text-ink-muted" :size="17" :stroke-width="1.8" />
    </button>
    <!-- 选项浮层：z-30 高于页面内容，height 上限 240px 且超出可滚动 -->
    <div v-if="open" class="absolute z-30 mt-1.5 grid max-h-60 w-full gap-1 overflow-y-auto rounded-lg border border-border bg-surface-raised p-1.5 shadow-xl" role="listbox">
      <!-- 单个选项：选中项使用主色底强调，并显示勾选图标 -->
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        class="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border-0 px-2.5 text-left hover:bg-canvas"
        :class="option.value === modelValue ? 'bg-primary-soft font-semibold text-primary' : 'bg-transparent text-ink'"
        @click="select(option)"
      >
        <span class="truncate">{{ option.label }}</span><Check v-if="option.value === modelValue" :size="16" />
      </button>
    </div>
  </div>
</template>
