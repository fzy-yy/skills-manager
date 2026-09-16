// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThemeController } from "../../src/stores/theme";

const busyOutcome = () => ({
  ok: false,
  reason: "busy",
  value: null,
  error: null,
});

function okOutcome(theme, options) {
  options?.applyResult?.({ theme });
  return { ok: true, reason: "ok", value: { theme }, error: null };
}

afterEach(() => {
  delete window.skillsManager;
  document.documentElement.classList.remove("dark");
});

describe("外观主题控制器", () => {
  it("浏览器预览下只改界面并返回 true", async () => {
    const execute = vi.fn();
    const controller = createThemeController({ execute });

    await expect(controller.setTheme("dark")).resolves.toBe(true);
    expect(controller.theme.value).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("无效主题直接返回 false，不触碰界面", async () => {
    const execute = vi.fn();
    const controller = createThemeController({ execute });
    await expect(controller.setTheme("blue")).resolves.toBe(false);
    expect(controller.theme.value).toBe("light");
    expect(execute).not.toHaveBeenCalled();
  });

  it("成功时消费 ok outcome 并保留服务端主题", async () => {
    window.skillsManager = {};
    const execute = vi.fn(async (_op, options) => okOutcome("dark", options));
    const controller = createThemeController({ execute });

    await expect(controller.setTheme("dark")).resolves.toBe(true);
    expect(controller.theme.value).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("真实失败才回滚，并返回 false", async () => {
    window.skillsManager = {};
    const execute = vi.fn(async () => ({
      ok: false,
      reason: "error",
      value: null,
      error: new Error("磁盘失败"),
    }));
    const controller = createThemeController({ execute });

    await expect(controller.setTheme("dark")).resolves.toBe(false);
    expect(controller.theme.value).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("真实失败回滚到最近一次成功持久化的主题", async () => {
    window.skillsManager = {};
    let shouldFail = false;
    const execute = vi.fn(async (_op, options) => {
      if (shouldFail)
        return {
          ok: false,
          reason: "error",
          value: null,
          error: new Error("磁盘失败"),
        };
      return okOutcome("dark", options);
    });
    const controller = createThemeController({ execute });

    await expect(controller.setTheme("dark")).resolves.toBe(true);
    shouldFail = true;
    await expect(controller.setTheme("light")).resolves.toBe(false);
    // 回到已持久化的 dark，而不是初始 light
    expect(controller.theme.value).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("busy 时等待空闲后重试最新主题，而不是回滚", async () => {
    window.skillsManager = {};
    const execute = vi
      .fn()
      .mockResolvedValueOnce(busyOutcome())
      .mockImplementationOnce(async (_op, options) =>
        okOutcome("dark", options),
      );
    const waitUntilIdle = vi.fn(async () => {});
    const controller = createThemeController({ execute, waitUntilIdle });

    await expect(controller.setTheme("dark")).resolves.toBe(true);
    expect(waitUntilIdle).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    // busy 由 theme 自行消化，不额外弹警告
    expect(execute.mock.calls[0][1]).toMatchObject({ notifyBusy: false });
    expect(controller.theme.value).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("等待空闲期间被更新请求取代时不再重复提交旧主题", async () => {
    window.skillsManager = {};
    let releaseIdle;
    const waitUntilIdle = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseIdle = resolve;
        }),
    );
    let calls = 0;
    const execute = vi.fn(async (_op, options) => {
      calls += 1;
      if (calls === 1) return busyOutcome();
      return okOutcome("light", options);
    });
    const controller = createThemeController({ execute, waitUntilIdle });

    const first = controller.setTheme("dark");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(waitUntilIdle).toHaveBeenCalledTimes(1);

    const second = controller.setTheme("light");
    await expect(second).resolves.toBe(true);
    releaseIdle();
    await expect(first).resolves.toBe(false);

    // 旧主题已被取代：只提交了一次重试（最新主题），没有为 dark 再试
    expect(execute).toHaveBeenCalledTimes(2);
    expect(controller.theme.value).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
