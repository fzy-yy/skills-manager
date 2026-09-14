<script setup>
import { Check, ChevronDown } from "@lucide/vue";
import {
  computed,
  nextTick,
  onBeforeUpdate,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
} from "vue";

const props = defineProps({
  modelValue: { type: [String, Number], default: "" },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: "请选择" },
  disabled: Boolean,
});
const emit = defineEmits(["update:modelValue"]);
const root = ref(null);
const trigger = ref(null);
const optionButtons = ref([]);
const listboxId = useId();
const open = ref(false);
const selected = computed(() =>
  props.options.find((option) => option.value === props.modelValue),
);

/**
 * 选中某个选项：同步给父组件并收起浮层。
 *
 * @param {{label: string, value: string|number}} option - 被点击的选项
 */
function select(option) {
  emit("update:modelValue", option.value);
  open.value = false;
  nextTick(() => trigger.value?.focus());
}

/** 展开菜单并聚焦当前选中项；未选择时聚焦首项或末项。 */
async function openAndFocus(position = "selected") {
  if (props.disabled || !props.options.length) return;
  open.value = true;
  await nextTick();
  const selectedIndex = props.options.findIndex(
    (option) => option.value === props.modelValue,
  );
  const index =
    position === "last"
      ? props.options.length - 1
      : position === "first"
        ? 0
        : Math.max(selectedIndex, 0);
  optionButtons.value[index]?.focus();
}

/** 在选项之间循环移动焦点。 */
function moveOptionFocus(event, offset) {
  event.preventDefault();
  const currentIndex = optionButtons.value.indexOf(document.activeElement);
  const nextIndex =
    (Math.max(currentIndex, 0) + offset + optionButtons.value.length) %
    optionButtons.value.length;
  optionButtons.value[nextIndex]?.focus();
}

/** 按渲染下标保存选项元素，避免函数 ref 在重复渲染时累积旧节点。 */
function setOptionRef(element, index) {
  if (element) optionButtons.value[index] = element;
  else optionButtons.value[index] = undefined;
}

/** 收起菜单并把焦点交还触发按钮。 */
function closeAndRestoreFocus() {
  open.value = false;
  nextTick(() => trigger.value?.focus());
}

/** 根据输入字符跳转到下一个匹配项，提供基础 typeahead 能力。 */
async function focusByTypeahead(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1)
    return;
  const query = event.key.toLocaleLowerCase();
  const currentIndex = optionButtons.value.indexOf(document.activeElement);
  const ordered = props.options.map((option, index) => ({ option, index }));
  const match = [...ordered.slice(currentIndex + 1), ...ordered].find(
    ({ option }) => String(option.label).toLocaleLowerCase().startsWith(query),
  );
  if (!match) return;
  event.preventDefault();
  if (!open.value) {
    open.value = true;
    await nextTick();
  }
  optionButtons.value[match.index]?.focus();
}

/**
 * 判断点击是否发生在组件外部，是则收起浮层。
 *
 * @param {MouseEvent} event - document 上的 mousedown 事件对象
 */
function handleOutsideClick(event) {
  if (root.value && !root.value.contains(event.target)) open.value = false;
}
onMounted(() => document.addEventListener("mousedown", handleOutsideClick));
onBeforeUpdate(() => {
  optionButtons.value = [];
});
onBeforeUnmount(() =>
  document.removeEventListener("mousedown", handleOutsideClick),
);
</script>

<template>
  <div ref="root" class="relative w-full">
    <button
      ref="trigger"
      type="button"
      class="flex h-10 w-full items-center justify-between gap-3 rounded-md border border-border-strong bg-surface px-3 text-left text-ink outline-none hover:border-primary-border focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary-soft disabled:cursor-not-allowed disabled:opacity-50"
      :disabled="disabled"
      :aria-expanded="open"
      :aria-controls="listboxId"
      aria-haspopup="listbox"
      @click="open ? closeAndRestoreFocus() : openAndFocus()"
      @keydown.down.prevent="openAndFocus('first')"
      @keydown.up.prevent="openAndFocus('last')"
      @keydown.home.prevent="openAndFocus('first')"
      @keydown.end.prevent="openAndFocus('last')"
      @keydown.esc.prevent="closeAndRestoreFocus"
      @keydown="focusByTypeahead"
    >
      <span
        class="truncate"
        :class="selected ? 'text-ink' : 'text-ink-muted'"
        >{{ selected?.label || placeholder }}</span
      >
      <ChevronDown
        class="shrink-0 text-ink-muted"
        :size="17"
        :stroke-width="1.8"
      />
    </button>
    <div
      v-if="open"
      :id="listboxId"
      class="absolute z-30 mt-1.5 grid max-h-60 w-full gap-1 overflow-y-auto rounded-lg border border-border bg-surface-raised p-1.5 shadow-xl"
      role="listbox"
    >
      <button
        v-for="(option, index) in options"
        :ref="(element) => setOptionRef(element, index)"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        class="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border-0 px-2.5 text-left hover:bg-canvas"
        :class="
          option.value === modelValue
            ? 'bg-primary-soft font-semibold text-primary'
            : 'bg-transparent text-ink'
        "
        @click="select(option)"
        @keydown.down="moveOptionFocus($event, 1)"
        @keydown.up="moveOptionFocus($event, -1)"
        @keydown.home.prevent="optionButtons[0]?.focus()"
        @keydown.end.prevent="optionButtons[optionButtons.length - 1]?.focus()"
        @keydown.esc.prevent="closeAndRestoreFocus"
        @keydown.tab="open = false"
        @keydown="focusByTypeahead"
      >
        <span class="truncate">{{ option.label }}</span
        ><Check v-if="option.value === modelValue" :size="16" />
      </button>
    </div>
  </div>
</template>
