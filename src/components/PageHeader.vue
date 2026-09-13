<!--
  PageHeader —— 各业务页面统一的页头。

  结构固定为「小标签（eyebrow）+ 主标题 + 描述」，右侧通过默认插槽放置页面级操作
  （例如 Skills 页面的 Skills 数量徽标、分组页面的“新建分组”按钮）。
-->
<script setup>
// ============ 一、组件接口 ============
// defineProps 声明：eyebrow 为可选的小标签，title 为必填主标题，description 为必填说明文案。
defineProps({
  eyebrow: String,
  title: { type: String, required: true },
  description: { type: String, required: true },
});
// 为什么右侧操作区用插槽而不是 props：各页面的操作区结构差异很大（数量徽标、按钮组、开关等），
// 用插槽可以让调用方自由组合，页头本身不必了解具体业务。
</script>

<template>
  <!-- 复用约束：所有业务页面共用该页头，新增页面只应改 title/description 与插槽内容，不要另行实现页头 -->
  <!-- items-end 让右侧插槽内容与标题基线对齐，shrink-0 避免在可滚动页面中被压缩 -->
  <header class="mb-6 flex shrink-0 items-end justify-between gap-6">
    <div>
      <!-- 注意：未传 eyebrow 时这里仍会渲染一个空段落并占据一行高度，需要紧凑布局时应显式传入内容 -->
      <!-- eyebrow：小字号 + 加宽字距，作为视觉引导而非正文内容 -->
      <p class="m-0 text-[11px] font-bold tracking-[0.12em] text-primary">
        {{ eyebrow }}
      </p>
      <h1
        class="mt-0.5 mb-1 text-[23px] leading-tight font-bold tracking-tight text-ink"
      >
        {{ title }}
      </h1>
      <p class="m-0 text-ink-secondary">{{ description }}</p>
    </div>
    <!-- 插槽内容会成为 header 的直接子元素，因此多个按钮之间也会应用 gap-6 间距 -->
    <!-- 右侧操作区插槽 -->
    <slot />
  </header>
</template>
