<!--
  PageHeader —— 各业务页面统一的页头。

  结构固定为「小标签（eyebrow）+ 主标题 + 描述」，右侧通过默认插槽放置页面级操作
  （例如 Skills 页面的 Skills 数量徽标、分组页面的“新建分组”按钮）。
-->
<script setup>
// defineProps 声明：eyebrow 为可选的小标签，title 为必填主标题，description 为必填说明文案。
defineProps({
  eyebrow: String,
  title: { type: String, required: true },
  description: { type: String, required: true },
});
</script>

<template>
  <!-- items-end 让右侧插槽内容与标题基线对齐，shrink-0 避免在可滚动页面中被压缩 -->
  <header class="mb-6 flex shrink-0 items-end justify-between gap-6">
    <div>
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
    <!-- 右侧操作区插槽 -->
    <slot />
  </header>
</template>
