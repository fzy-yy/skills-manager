import { describe, expect, it, vi } from "vitest";
import { createOperationRunner } from "../../src/stores/operation-runner";

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function noticeWith(runner, type, message) {
  return runner.notices.value.find(
    (notice) => notice.type === type && notice.message === message,
  );
}

describe("全局操作运行器", () => {
  it("成功时返回 ok outcome 并合并结果、提示成功", async () => {
    const runner = createOperationRunner();
    const applied = [];
    const outcome = await runner.execute(async () => ({ theme: "dark" }), {
      applyResult: (result) => applied.push(result),
      successMessage: "已保存",
    });

    expect(outcome).toEqual({
      ok: true,
      reason: "ok",
      value: { theme: "dark" },
      error: null,
    });
    expect(applied).toEqual([{ theme: "dark" }]);
    expect(noticeWith(runner, "success", "已保存")).toBeTruthy();
    expect(runner.busy.value).toBe(false);
    expect(runner.isInFlight()).toBe(false);
  });

  it("已有操作在途时返回 busy outcome，不执行新操作", async () => {
    const runner = createOperationRunner();
    const gate = createDeferred();
    const operation = vi.fn(async () => {
      await gate.promise;
      return { value: 1 };
    });

    const first = runner.execute(operation);
    const secondOperation = vi.fn(async () => ({ value: 2 }));
    const second = await runner.execute(secondOperation);

    expect(second).toEqual({
      ok: false,
      reason: "busy",
      value: null,
      error: null,
    });
    // 被拒的操作根本没有执行
    expect(secondOperation).not.toHaveBeenCalled();

    gate.resolve();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("notifyBusy:false 时静默返回 busy outcome", async () => {
    const runner = createOperationRunner();
    const gate = createDeferred();
    const first = runner.execute(async () => {
      await gate.promise;
      return {};
    });
    await runner.execute(async () => ({}), { notifyBusy: false });
    expect(
      noticeWith(runner, "warning", "已有操作正在进行，请等待完成后再试"),
    ).toBeUndefined();
    gate.resolve();
    await first;
  });

  it("操作抛错时返回 error outcome 并携带原始错误", async () => {
    const runner = createOperationRunner();
    const error = new Error("磁盘失败");
    const outcome = await runner.execute(async () => {
      throw error;
    });

    expect(outcome).toEqual({
      ok: false,
      reason: "error",
      value: null,
      error,
    });
    expect(noticeWith(runner, "error", "磁盘失败")).toBeTruthy();
    expect(runner.busy.value).toBe(false);
    expect(runner.isInFlight()).toBe(false);
  });

  it("waitUntilIdle 空闲时立即完成，在操作进行中等待其结束", async () => {
    const runner = createOperationRunner();
    await expect(runner.waitUntilIdle()).resolves.toBeUndefined();

    const gate = createDeferred();
    const first = runner.execute(async () => {
      await gate.promise;
      return {};
    });
    let idle = false;
    const waiting = runner.waitUntilIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(runner.isInFlight()).toBe(true);
    expect(idle).toBe(false);

    gate.resolve();
    await Promise.all([first, waiting]);
    expect(idle).toBe(true);
    expect(runner.isInFlight()).toBe(false);
  });
});
