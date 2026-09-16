import { describe, expect, it, vi } from "vitest";
import { createSkillSyncQueue } from "../../src/stores/skill-sync-queue";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function createHarness(submit = vi.fn(async (_, skillIds) => ({ skillIds }))) {
  const state = { agent: ["base"] };
  const issues = {};
  const recorded = [];
  const cleared = [];
  const queueOptions = {
    getEnabledSkills: (id) => state[id] || [],
    setEnabledSkills: (id, skillIds) => (state[id] = [...skillIds]),
    isOperationInFlight: () => false,
    submit,
    setIssues: (id, value) => (issues[id] = value),
    recordPending: (id, skillIds, token) =>
      recorded.push({ agentId: id, skillIds, token }),
    clearPending: (id, token) => cleared.push({ agentId: id, token }),
    debounceMs: 50,
  };
  const queue = createSkillSyncQueue(queueOptions);
  return { cleared, issues, queue, recorded, state, submit };
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
    const harness = createHarness(
      vi.fn().mockRejectedValue(new Error("磁盘失败")),
    );
    const completion = harness.queue.setSkills("agent", ["next"]);
    await vi.advanceTimersByTimeAsync(50);
    // 失败不抛给调用方，而是回滚界面并把问题写进该 Agent 的问题列表
    await expect(completion).resolves.toBeNull();
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

  it("flushNow 跳过剩余防抖等待，立即提交排队选择", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const completion = harness.queue.setSkills("agent", ["base", "one"]);
    expect(harness.submit).not.toHaveBeenCalled();
    harness.queue.flushNow();
    await expect(completion).resolves.toBeDefined();
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledWith("agent", ["base", "one"]);
    vi.useRealTimers();
  });

  it("在途失败且后续提交也失败时，最终回滚到最后一次成功提交的基线", async () => {
    vi.useFakeTimers();
    const deferreds = [];
    const submit = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          deferreds.push({ reject, resolve });
        }),
    );
    const harness = createHarness(submit);
    // 服务端确认的磁盘基线是 base
    harness.queue.syncCommitted({ agent: ["base"] });

    const first = harness.queue.setSkills("agent", ["base", "b"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(submit).toHaveBeenCalledTimes(1);

    // B 仍在途时用户又选了 C：B 的基线不能是乐观值 B
    const second = harness.queue.setSkills("agent", ["base", "c"]);
    deferreds[0].reject(new Error("磁盘失败"));
    await expect(first).resolves.toBeNull();
    // C 还在排队，不能因为 B 失败就回滚到乐观的 B
    expect(harness.state.agent).toEqual(["base", "c"]);

    await vi.advanceTimersByTimeAsync(0);
    expect(submit).toHaveBeenCalledTimes(2);
    deferreds[1].reject(new Error("磁盘失败"));
    await expect(second).resolves.toBeNull();
    // 连续失败最终必须回到磁盘基线 base，而不是从未落盘的 B
    expect(harness.state.agent).toEqual(["base"]);
    vi.useRealTimers();
  });

  it("提交成功用 result.enabledSkills[agentId] 更新 committed 基线", async () => {
    vi.useFakeTimers();
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ enabledSkills: { agent: ["base", "x"] } })
      .mockRejectedValueOnce(new Error("磁盘失败"));
    const harness = createHarness(submit);

    const first = harness.queue.setSkills("agent", ["base", "x"]);
    await vi.advanceTimersByTimeAsync(50);
    await expect(first).resolves.toMatchObject({
      enabledSkills: { agent: ["base", "x"] },
    });

    // 失败后回滚基线应来自服务端返回的 enabledSkills，而不是本次乐观值
    const second = harness.queue.setSkills("agent", ["base", "y"]);
    await vi.advanceTimersByTimeAsync(50);
    await expect(second).resolves.toBeNull();
    expect(harness.state.agent).toEqual(["base", "x"]);
    vi.useRealTimers();
  });

  it("busy/retryable 失败重排而不是回滚", async () => {
    vi.useFakeTimers();
    const busy = Object.assign(new Error("已有操作正在进行"), {
      code: "busy",
    });
    const submit = vi
      .fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce({ enabledSkills: { agent: ["base", "one"] } });
    const harness = createHarness(submit);

    const completion = harness.queue.setSkills("agent", ["base", "one"]);
    await vi.advanceTimersByTimeAsync(50);
    expect(submit).toHaveBeenCalledTimes(1);
    // busy 不是真实失败：不回滚、不写问题
    expect(harness.state.agent).toEqual(["base", "one"]);
    expect(harness.issues.agent).toBeUndefined();

    await vi.advanceTimersByTimeAsync(100);
    await expect(completion).resolves.toMatchObject({
      enabledSkills: { agent: ["base", "one"] },
    });
    expect(submit).toHaveBeenCalledTimes(2);
    expect(harness.state.agent).toEqual(["base", "one"]);
    vi.useRealTimers();
  });

  it("取消 pending 回到 committed 基线并按 token 清除意图", async () => {
    vi.useFakeTimers();
    const submit = vi
      .fn()
      .mockResolvedValue({ enabledSkills: { agent: ["base", "x"] } });
    const harness = createHarness(submit);

    const committed = harness.queue.setSkills("agent", ["base", "x"]);
    await vi.advanceTimersByTimeAsync(50);
    await committed;

    const completion = harness.queue.setSkills("agent", ["base", "y"]);
    harness.queue.cancelAgent("agent");
    await expect(completion).resolves.toBeNull();
    // 回到已提交的 x，而不是取消时的乐观 y 或入队前的 base
    expect(harness.state.agent).toEqual(["base", "x"]);
    expect(harness.cleared.at(-1)).toEqual({
      agentId: "agent",
      token: harness.recorded.at(-1).token,
    });
    vi.useRealTimers();
  });

  it("乐观更新前记录意图，成功按 token 清除并透传 agentIssues", async () => {
    vi.useFakeTimers();
    const issues = {};
    const order = [];
    const state = { agent: ["base"] };
    const clearPending = vi.fn();
    const submit = vi.fn().mockResolvedValue({
      agentIssues: {
        agent: [{ type: "warning", message: "部分链接失效" }],
      },
      enabledSkills: { agent: ["base", "x"] },
    });
    const queue = createSkillSyncQueue({
      getEnabledSkills: (id) => state[id] || [],
      setEnabledSkills: (id, skillIds) => {
        order.push("set");
        state[id] = [...skillIds];
      },
      isOperationInFlight: () => false,
      submit,
      setIssues: (id, value) => (issues[id] = value),
      recordPending: (id, skillIds, token) =>
        order.push(`record:${token}:${skillIds.join(",")}`),
      clearPending,
      debounceMs: 50,
    });

    const completion = queue.setSkills("agent", ["base", "x"]);
    // 记录意图必须发生在乐观更新之前，避免界面已改而恢复记录未落盘
    expect(order[0]).toMatch(/^record:/);
    expect(order[1]).toBe("set");

    await vi.advanceTimersByTimeAsync(50);
    await completion;
    expect(issues.agent).toEqual([
      { type: "warning", message: "部分链接失效" },
    ]);
    expect(clearPending).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalledWith("agent", order[0].split(":")[1]);
    vi.useRealTimers();
  });

  it("普通失败保留持久化意图，不按 token 清除", async () => {
    vi.useFakeTimers();
    const submit = vi.fn().mockRejectedValue(new Error("磁盘失败"));
    const harness = createHarness(submit);

    const completion = harness.queue.setSkills("agent", ["base", "x"]);
    await vi.advanceTimersByTimeAsync(50);
    await expect(completion).resolves.toBeNull();
    expect(harness.recorded).toHaveLength(1);
    expect(harness.cleared).toHaveLength(0);
    vi.useRealTimers();
  });

  it("在途成功用旧 token 比较清除，持久化异常不打断队列", async () => {
    vi.useFakeTimers();
    const deferreds = [];
    const clearPending = vi.fn(() => Promise.reject(new Error("token 不匹配")));
    const submit = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          deferreds.push({ reject, resolve });
        }),
    );
    const state = { agent: ["base"] };
    const queue = createSkillSyncQueue({
      getEnabledSkills: (id) => state[id] || [],
      setEnabledSkills: (id, skillIds) => (state[id] = [...skillIds]),
      isOperationInFlight: () => false,
      submit,
      setIssues: vi.fn(),
      recordPending: vi.fn(),
      clearPending,
      debounceMs: 50,
    });

    const first = queue.setSkills("agent", ["base", "b"]);
    await vi.advanceTimersByTimeAsync(50);
    // B 在途时写入新的意图 C：B 成功后只能用旧 token 做比较清除
    const second = queue.setSkills("agent", ["base", "c"]);
    deferreds[0].resolve({ enabledSkills: { agent: ["base", "b"] } });
    await expect(first).resolves.toBeDefined();
    expect(clearPending).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(0);
    deferreds[1].resolve({ enabledSkills: { agent: ["base", "c"] } });
    await expect(second).resolves.toBeDefined();
    expect(state.agent).toEqual(["base", "c"]);
    vi.useRealTimers();
  });

  it("flushNow 返回排空 Promise，空队列立即完成", async () => {
    vi.useFakeTimers();
    const deferred = createDeferred();
    const submit = vi.fn(() => deferred.promise);
    const harness = createHarness(submit);

    await expect(harness.queue.flushNow()).resolves.toBeUndefined();

    const completion = harness.queue.setSkills("agent", ["base", "one"]);
    let drained = false;
    const drain = harness.queue.flushNow().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(submit).toHaveBeenCalledTimes(1);
    // 提交仍在途时排空 Promise 不能提前 resolve
    expect(drained).toBe(false);

    deferred.resolve({ enabledSkills: { agent: ["base", "one"] } });
    await Promise.all([completion, drain]);
    expect(drained).toBe(true);
    vi.useRealTimers();
  });

  it("flushNow 支持超时兜底，避免永久等待", async () => {
    vi.useFakeTimers();
    const submit = vi.fn(() => new Promise(() => {}));
    const harness = createHarness(submit);

    harness.queue.setSkills("agent", ["base", "one"]);
    let drained = false;
    const drain = harness.queue.flushNow({ timeout: 200 }).then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(drained).toBe(true);
    vi.useRealTimers();
  });
});
