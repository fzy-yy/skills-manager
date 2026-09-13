<!--
  PathPicker —— 目录路径输入框。

  由「文件夹图标 + 可编辑输入框 + 浏览按钮」组成：
  - 输入框支持手动粘贴或修改路径（便于复用已有路径）；
  - 浏览按钮不自行调用 uTools API，而是抛出 browse 事件，
    由父组件通过 appStore.chooseDirectory 打开系统目录选择框，保持组件与业务解耦。

  使用方式（参考 SkillsView.vue）：
  <PathPicker v-model="directory" input-id="repository-path" placeholder="选择目录" :disabled="store.busy" @browse="browse" />
-->
<script setup>
// ============ 一、依赖导入 ============
// 文件夹图标。
import { Folder } from "@lucide/vue";

// ============ 二、组件接口（props / emits） ============
// 受控约定：输入框使用 :value + @input 手写 v-model，而不是维护内部 state，
// 这样父组件可以拒绝非法或不合时机的修改（例如忙碌中忽略编辑），界面始终与父级保持一致。
// 组件属性定义。
defineProps({
  // 当前路径（v-model 绑定）。
  modelValue: { type: String, default: "" },
  // 输入框占位文案。
  placeholder: { type: String, default: "" },
  // 是否禁用（操作进行中时禁止编辑与浏览）。
  disabled: Boolean,
  // 输入框 id，用于与外部 <label for> 关联，提升可访问性。
  inputId: { type: String, default: "" },
});
// 职责边界：本组件不做路径校验（目录是否存在、是否为磁盘根目录等），
// 这些都交给 preload 服务在处理时统一校验并通过全局提示反馈。
// 向外抛出：路径变化（v-model）与被点击“浏览”按钮。
const emit = defineEmits(["update:modelValue", "browse"]);
</script>

<template>
  <!-- 视觉约定：图标、输入框与按钮共用一个描边容器，聚焦高亮由 focus-within 统一负责 -->
  <!-- focus-within 让外层容器在输入框获得焦点时整体高亮，视觉上成为一个输入控件 -->
  <div
    class="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-md border border-border-strong bg-surface py-0.75 pr-1 pl-2.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary-soft"
  >
    <Folder class="shrink-0 text-ink-muted" :size="18" :stroke-width="1.8" />
    <!-- id 来自 inputId：外部用 <label for> 关联后可点击文字聚焦输入框，是路径类表单的可访问性要求 -->
    <!-- 路径输入框：spellcheck 关闭，避免路径被当作拼写错误标红 -->
    <input
      :id="inputId"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      class="h-7.5 min-w-0 flex-1 border-0 bg-transparent p-0 text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed"
      spellcheck="false"
      @input="emit('update:modelValue', $event.target.value)"
    />
    <!-- 禁用态与输入框同源：操作进行中禁止改路径，避免与后台的目录扫描结果互相覆盖 -->
    <!-- 浏览按钮：仅抛出 browse 事件，真正的目录选择交给父组件处理 -->
    <button
      class="inline-flex h-8 items-center justify-center rounded-md border border-primary-border bg-primary-soft px-4 font-semibold whitespace-nowrap text-primary hover:bg-primary-border disabled:cursor-not-allowed disabled:opacity-50"
      type="button"
      :disabled="disabled"
      @click="emit('browse')"
    >
      浏览
    </button>
  </div>
</template>
