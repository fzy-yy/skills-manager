<!--
  EmptyState —— 空状态占位组件。

  在没有 Skills、没有分组、没有 Agent 等“列表为空”的场景统一使用，
  通过图标 + 标题 + 描述给出下一步操作指引，并预留默认插槽放置操作按钮。

  使用方式（参考 AgentsView.vue）：
  <EmptyState :icon="Bot" title="还没有 Agent" description="填写名称与 Skills 目录。" />
-->
<script setup>
// ============ 一、依赖导入 ============
// 默认图标：问号圆圈，调用方未传 icon 时使用。
import { CircleHelp } from "@lucide/vue";

// ============ 二、组件接口 ============
// 三个 props 仅在模板中使用，因此 defineProps 不必赋值给变量，避免引入未使用的变量告警。
// 组件属性定义。
defineProps({
  // 展示在顶部的图标组件（lucide 组件对象），默认使用 CircleHelp。
  icon: { type: [Object, Function], default: () => CircleHelp },
  // 空状态标题，必填。
  title: { type: String, required: true },
  // 补充说明文案，用于告诉用户下一步该做什么，必填。
  description: { type: String, required: true },
});
// 说明：默认值写成 () => CircleHelp 是因为 icon 属于对象/函数类型，
// 直接写 CircleHelp 会让多个实例共享同一份默认引用，也不符合 Vue 对复合类型默认值的约定。
</script>

<template>
  <!-- 用途约定：列表为空或搜索无结果时展示，引导用户完成下一步操作而不是只留一片空白 -->
  <!-- 居中容器：min-h-64 保证即使内容很少也有足够的视觉留白 -->
  <div
    class="flex min-h-64 flex-col items-center justify-center px-8 py-10 text-center text-ink-secondary"
  >
    <!-- icon 通过 <component :is> 动态渲染，所以 props 声明为 Object/Function 两种类型 -->
    <!-- 图标容器：主色浅底 + 描边，强化视觉焦点 -->
    <span
      class="mb-3 grid size-12 place-items-center rounded-xl border border-primary-border bg-primary-soft text-primary"
    >
      <component :is="icon" :size="24" :stroke-width="1.8" />
    </span>
    <!-- 语义层级：使用 h3 而非 h1，页面主标题由 PageHeader 的 h1 唯一承担，避免出现多个一级标题 -->
    <!-- 标题与描述：描述限宽 max-w-md，避免长文案折行过于零散 -->
    <h3 class="mb-1.5 text-base font-semibold text-ink">{{ title }}</h3>
    <p class="m-0 max-w-md leading-6">{{ description }}</p>
    <!-- 默认插槽：调用方直接放按钮即可；不提供具名插槽是为了保持组件极简 -->
    <!-- 默认插槽：供调用方放置“新建分组”等引导按钮 -->
    <slot />
  </div>
</template>
