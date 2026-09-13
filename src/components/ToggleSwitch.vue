<!--
  ToggleSwitch —— 开关控件。

  用于「应用配置」页面开启/关闭某个分组，使用按钮实现（而非 checkbox），
  通过 aria-pressed 与 aria-label 提供给读屏软件；颜色随选中状态在
  bg-primary 与 bg-border-strong 之间切换，滑块用 justify-end/start 换位。

  使用方式（参考 ApplicationsView.vue）：
  <ToggleSwitch :model-value="active" :disabled="store.busy" label="分组开关" @update:model-value="setGroup(id, $event)" />
-->
<script setup>
// defineProps 声明：modelValue 控制开关状态，disabled 控制可用性，label 用于无障碍朗读。
defineProps({ modelValue: Boolean, disabled: Boolean, label: String });
// 抛出开关状态变化事件（值为取反后的新状态）。
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <!-- 轨道：w-11 h-6 圆角胶囊；选中时背景变主色，滑块靠右 -->
  <button
    type="button"
    class="flex h-6 w-11 shrink-0 items-center rounded-full border-0 p-0.5 outline-none ring-primary-soft focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
    :class="
      modelValue ? 'justify-end bg-primary' : 'justify-start bg-border-strong'
    "
    :aria-pressed="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="emit('update:modelValue', !modelValue)"
  >
    <!-- 滑块：纯白/浅灰圆形，带轻微阴影以体现层次 -->
    <span class="size-5 shrink-0 rounded-full bg-control-thumb shadow-sm" />
  </button>
</template>
