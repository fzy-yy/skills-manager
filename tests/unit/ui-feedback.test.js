import { describe, expect, it, vi } from "vitest";
import {
  createConfirmDialog,
  createNoticeCenter,
} from "../../src/stores/ui-feedback";

describe("全局反馈状态", () => {
  it("提示去重并在到期后移除", () => {
    vi.useFakeTimers();
    const center = createNoticeCenter();
    center.notify("保存成功", "success", 100);
    center.notify("保存成功", "success", 100);
    expect(center.notices.value).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(center.notices.value).toEqual([]);
    vi.useRealTimers();
  });

  it("新确认请求会取消尚未处理的旧请求", async () => {
    const dialog = createConfirmDialog();
    const first = dialog.confirm({ title: "第一次" });
    const second = dialog.confirm({ title: "第二次", tone: "danger" });
    await expect(first).resolves.toBe(false);
    expect(dialog.dialog.value).toMatchObject({
      open: true,
      title: "第二次",
      tone: "danger",
    });
    dialog.resolveDialog(true);
    await expect(second).resolves.toBe(true);
    expect(dialog.dialog.value.open).toBe(false);
  });
});
