// @vitest-environment jsdom
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BaseSelect from "../../src/components/BaseSelect.vue";
import ToggleSwitch from "../../src/components/ToggleSwitch.vue";

describe("基础交互组件", () => {
  it("开关具备可访问名称并抛出取反值", async () => {
    const wrapper = mount(ToggleSwitch, {
      props: { modelValue: false, label: "Alpha Skill 开关" },
    });
    const button = wrapper.get("button");
    expect(button.attributes("aria-pressed")).toBe("false");
    await button.trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[true]]);
  });

  it("自定义下拉框支持键盘打开、选择和关闭", async () => {
    const wrapper = mount(BaseSelect, {
      attachTo: document.body,
      props: {
        modelValue: "",
        options: [
          { label: "Codex", value: "codex" },
          { label: "Claude", value: "claude" },
        ],
      },
    });
    await wrapper.get("button").trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true);
    const options = wrapper.findAll('[role="option"]');
    await options[1].trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["claude"]]);
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
