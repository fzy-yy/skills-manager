import { describe, expect, it, vi } from "vitest";
import { createSkillSyncQueue } from "../../src/stores/skill-sync-queue";

function createHarness(submit = vi.fn(async (_, skillIds) => ({ skillIds }))) {
  const state = { agent: ["base"] };
  const issues = {};
  const queue = createSkillSyncQueue({
    getEnabledSkills: (id) => state[id] || [],
    setEnabledSkills: (id, skillIds) => (state[id] = [...skillIds]),
    isOperationInFlight: () => false,
    submit,
    setIssues: (id, value) => (issues[id] = value),
    debounceMs: 50,
  });
  return { issues, queue, state, submit };
}

describe("Agent Skills 防抖队列", () => {
  it("合并连续操作，只提交最终选择", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const first = harness.queue.setSkills("agent", ["base", "one"]);
    const second = harness.queue.setSkills("agent", ["base", "two"]);
    expect(harness.state.agent).toEqual(["base", "two"]);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledWith("agent", ["base", "two"]);
    vi.useRealTimers();
  });

  it("提交失败时恢复入队前状态并记录错误", async () => {
    vi.useFakeTimers();
    const harness = createHarness(vi.fn().mockRejectedValue(new Error("磁盘失败")));
    const completion = harness.queue.setSkills("agent", ["next"]);
    const assertion = expect(completion).rejects.toThrow("磁盘失败");
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(harness.state.agent).toEqual(["base"]);
    expect(harness.issues.agent[0]).toMatchObject({
      type: "error",
      message: "磁盘失败",
    });
    vi.useRealTimers();
  });

  it("取消排队操作并在服务端状态合并时保留乐观选择", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const completion = harness.queue.setSkills("agent", ["pending"]);
    expect(harness.queue.mergePending({ agent: ["server"] })).toEqual({
      agent: ["pending"],
    });
    harness.queue.cancelAgent("agent");
    await expect(completion).resolves.toBeNull();
    expect(harness.state.agent).toEqual(["base"]);
    expect(harness.submit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
