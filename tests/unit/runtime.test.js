import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createIssue,
  errorMessage,
  mapWithConcurrency,
  uniqueIssues,
  withReadTimeout,
} = require("../../public/preload/runtime.js");

describe("preload 运行时工具", () => {
  it("统一错误和问题结构并去重", () => {
    expect(errorMessage({ code: "EACCES", message: "denied" })).toBe(
      "EACCES：denied",
    );
    expect(errorMessage()).toBe("未知错误");
    expect(createIssue("unknown", "提示")).toEqual({
      type: "warning",
      message: "提示",
    });
    expect(
      uniqueIssues([
        createIssue("error", "重复"),
        createIssue("error", "重复"),
        createIssue("warning", "重复"),
      ]),
    ).toHaveLength(2);
  });

  it("按输入顺序返回受控并发结果", async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapWithConcurrency([30, 5, 15, 1], 2, async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, item));
      active -= 1;
      return item * 2;
    });
    expect(result).toEqual([60, 10, 30, 2]);
    expect(maximum).toBe(2);
  });

  it("读取超时会抛出带上下文的错误", async () => {
    vi.useFakeTimers();
    const pending = withReadTimeout(new Promise(() => {}), "读取配置", 100);
    const assertion = expect(pending).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "读取配置超时（0.1 秒）",
    });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    vi.useRealTimers();
  });
});
