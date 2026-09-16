/**
 * Agent Skills 高频开关提交队列。
 *
 * 将连续选择合并为最终状态，并在真实失败时回滚乐观更新，避免页面与磁盘链接失配。
 *
 * 一致性基线：每个 Agent 维护一份 `committed`（最后一次确认落盘的 Skill 集合）。
 * 回滚一律回到 committed，**绝不使用"创建 pending 时的界面值"**——那可能是尚未落盘的乐观值。
 * committed 有两个来源：`syncCommitted(serverEnabledSkills)` 合并的服务端状态，
 * 以及每次提交成功后返回的 `result.enabledSkills[agentId]`。
 *
 * 对外约定：提交结果通过 Promise 返回，**失败时也 resolve(null)** 而不是 reject——
 * 失败原因由 submit 侧统一提示，队列负责回滚界面状态并写入该 Agent 的问题列表。
 */
const DEFAULT_DEBOUNCE_MS = 300;
const BUSY_RETRY_MS = 100;

function normalizeSkillIds(skillIds) {
  return [
    ...new Set(Array.isArray(skillIds) ? skillIds.map(String) : []),
  ].sort();
}

function skillIdsEqual(left, right) {
  const normalizedLeft = normalizeSkillIds(left);
  const normalizedRight = normalizeSkillIds(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((id, index) => id === normalizedRight[index])
  );
}

/**
 * 判定提交失败是否只是"暂时不可用"（busy / 可重试）。
 *
 * submit 侧遇到全局操作在途或磁盘忙时，抛出的 error 需带 `code: "busy"`、
 * `reason: "busy"` 或 `retryable: true`，队列据此重排而不是回滚。
 */
function isRetryableSubmitError(error) {
  if (!error) return false;
  if (error.retryable === true) return true;
  const code = error.code ?? error.reason;
  return code === "busy" || code === "EBUSY" || error.name === "BusyError";
}

/**
 * 创建串行防抖队列。
 *
 * 调用方负责真实状态的读取/写入与服务提交，队列仅管理操作顺序。
 *
 * @param {object} options
 * @param {(agentId: string) => string[]} options.getEnabledSkills - 读取界面当前选择
 * @param {(agentId: string, skillIds: string[]) => void} options.setEnabledSkills - 写入界面选择
 * @param {() => boolean} options.isOperationInFlight - 全局操作是否在途
 * @param {(agentId: string, skillIds: string[]) => Promise<object>} options.submit - 真实提交
 * @param {(agentId: string, issues: Array) => void} options.setIssues - 写入该 Agent 的同步问题
 * @param {(agentId: string, skillIds: string[], token: string) => void} [options.recordPending]
 *        在乐观更新前记录"待落盘意图"，用于崩溃后恢复；不注入时退化为纯内存队列
 * @param {(agentId: string, token: string) => void} [options.clearPending]
 *        按 token 比较清除意图：仅当持久化记录仍是该 token 时才删除
 * @param {number} [options.debounceMs]
 */
export function createSkillSyncQueue({
  getEnabledSkills,
  setEnabledSkills,
  isOperationInFlight,
  submit,
  setIssues,
  recordPending,
  clearPending,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
  const pendingByAgent = new Map();
  const committedByAgent = new Map();
  let timer;
  let flushing = false;
  let inFlightAgentId;
  const instanceToken =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let tokenSequence = 0;
  let drainWaiters = [];

  function committedFor(agentId) {
    return committedByAgent.get(agentId) || [];
  }

  function setCommitted(agentId, skillIds) {
    committedByAgent.set(agentId, normalizeSkillIds(skillIds));
  }

  function schedule(delay = debounceMs) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  }

  /**
   * 用服务端返回的 enabledSkills 刷新每个 Agent 的 committed 基线。
   * 这是磁盘真实状态，也是失败回滚的唯一依据。
   */
  function syncCommitted(serverEnabledSkills) {
    if (!serverEnabledSkills || typeof serverEnabledSkills !== "object") return;
    const serverAgentIds = new Set(Object.keys(serverEnabledSkills));
    for (const agentId of committedByAgent.keys()) {
      if (
        !serverAgentIds.has(agentId) &&
        !pendingByAgent.has(agentId) &&
        inFlightAgentId !== agentId
      )
        committedByAgent.delete(agentId);
    }
    Object.entries(serverEnabledSkills).forEach(([agentId, skillIds]) =>
      setCommitted(agentId, skillIds),
    );
  }

  /**
   * 尽力而为地执行一次意图持久化（recordPending / clearPending）。
   *
   * token 不匹配、磁盘写入失败等都不应打断队列主流程：
   * 同步抛错或返回 rejected Promise 都被就地吞掉。
   */
  function persistIntent(action) {
    try {
      const result = action();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {
      // 意图记录是恢复用的旁路能力，失败不影响本次提交
    }
  }

  /** 队列是否已经彻底排空（没有 pending，也没有在途提交）。 */
  function isDrained() {
    return !flushing && pendingByAgent.size === 0;
  }

  /** 排空后唤醒所有等待 flushNow 的调用方。 */
  function settleDrainWaiters() {
    if (!isDrained() || !drainWaiters.length) return;
    const waiters = drainWaiters;
    drainWaiters = [];
    waiters.forEach(({ resolve, timeoutTimer }) => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolve();
    });
  }

  /**
   * 立即提交排队中的选择，跳过剩余防抖等待。
   * 供插件隐藏/退出时调用，避免"界面已乐观显示、磁盘还没落库"的窗口期。
   *
   * @param {number|{timeout?: number}} [options] - 可选超时（毫秒）兜底，避免永久等待
   * @returns {Promise<void>} 队列排空（或在超时后）resolve；空队列立即 resolve
   */
  function flushNow(options = {}) {
    const timeout =
      typeof options === "number" ? options : Number(options?.timeout);
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (isDrained()) return Promise.resolve();

    const drained = new Promise((resolve) => {
      const waiter = { resolve, timeoutTimer: undefined };
      if (Number.isFinite(timeout) && timeout >= 0) {
        waiter.timeoutTimer = setTimeout(() => {
          const index = drainWaiters.indexOf(waiter);
          if (index >= 0) drainWaiters.splice(index, 1);
          resolve();
        }, timeout);
      }
      drainWaiters.push(waiter);
    });
    void flush();
    return drained;
  }

  async function flush() {
    if (!pendingByAgent.size) {
      settleDrainWaiters();
      return;
    }
    if (flushing || isOperationInFlight()) {
      schedule(BUSY_RETRY_MS);
      return;
    }

    const [agentId, pending] = pendingByAgent.entries().next().value;
    pendingByAgent.delete(agentId);
    flushing = true;
    inFlightAgentId = agentId;
    let nextDelay = 0;
    try {
      const result = await submit(agentId, pending.skillIds);
      const serverSkillIds = result?.enabledSkills?.[agentId];
      // 只有提交成功（以服务端返回为准）才能推进 committed 基线
      setCommitted(
        agentId,
        Array.isArray(serverSkillIds) ? serverSkillIds : pending.skillIds,
      );
      persistIntent(() => clearPending?.(agentId, pending.token));
      setIssues(agentId, result?.agentIssues?.[agentId] ?? []);
      pending.waiters.forEach(({ resolve }) => resolve(result));
    } catch (error) {
      const superseded = pendingByAgent.has(agentId);
      if (isRetryableSubmitError(error)) {
        if (superseded) {
          // 更新的选择已接管，旧批次作废：不回滚、不重排
          pending.waiters.forEach(({ resolve }) => resolve(null));
        } else {
          // 暂时不可用：保留意图与 token，等待空闲后重排
          pendingByAgent.set(agentId, pending);
          nextDelay = BUSY_RETRY_MS;
        }
      } else {
        // 真实失败：没有更新的选择时回滚到磁盘基线；持久化意图保留待下次恢复
        if (!superseded) setEnabledSkills(agentId, committedFor(agentId));
        setIssues(agentId, [
          { type: "error", message: error?.message || "链接同步失败，请重试" },
        ]);
        // 与 store 的对外约定一致：失败不向调用方抛异常，只回滚界面并记录问题。
        pending.waiters.forEach(({ resolve }) => resolve(null));
      }
    } finally {
      flushing = false;
      inFlightAgentId = undefined;
      if (pendingByAgent.size) schedule(nextDelay);
      settleDrainWaiters();
    }
  }

  /** 乐观更新选择，并返回本轮最终提交完成的 Promise。 */
  function setSkills(agentId, skillIds) {
    const normalizedIds = normalizeSkillIds(skillIds);
    if (!committedByAgent.has(agentId))
      committedByAgent.set(
        agentId,
        normalizeSkillIds(getEnabledSkills(agentId)),
      );

    let pending = pendingByAgent.get(agentId);
    const hasInFlightBatch = inFlightAgentId === agentId;

    // 目标与磁盘基线一致，且没有在途写入：无需提交，直接对齐界面
    if (
      !pending &&
      !hasInFlightBatch &&
      skillIdsEqual(committedFor(agentId), normalizedIds)
    ) {
      setEnabledSkills(agentId, normalizedIds);
      return Promise.resolve(null);
    }

    // 先记录恢复意图，再做乐观更新：中途崩溃也能据此重放
    const token = `${instanceToken}-${++tokenSequence}`;
    persistIntent(() => recordPending?.(agentId, normalizedIds, token));

    if (!pending) {
      pending = { skillIds: normalizedIds, token, waiters: [] };
      pendingByAgent.set(agentId, pending);
    } else {
      pending.skillIds = normalizedIds;
      pending.token = token;
    }

    setEnabledSkills(agentId, normalizedIds);
    const completion = new Promise((resolve) => {
      pending.waiters.push({ resolve });
    });
    schedule();
    return completion;
  }

  /** 取消一个 Agent 未提交的选择并恢复到 committed 基线。 */
  function cancelAgent(agentId, { clearIntent = true } = {}) {
    const pending = pendingByAgent.get(agentId);
    if (!pending) return;
    setEnabledSkills(agentId, committedFor(agentId));
    pendingByAgent.delete(agentId);
    // 删除 Agent / 清除数据需等服务端成功后再清日志，失败时仍可恢复用户意图。
    if (clearIntent)
      persistIntent(() => clearPending?.(agentId, pending.token));
    pending.waiters.forEach(({ resolve }) => resolve(null));
    if (!pendingByAgent.size) clearTimeout(timer);
    settleDrainWaiters();
  }

  function cancelAll(options) {
    [...pendingByAgent.keys()].forEach((agentId) =>
      cancelAgent(agentId, options),
    );
  }

  /** 合并服务端状态时保留仍在排队的乐观选择。 */
  function mergePending(serverState) {
    const merged = { ...serverState };
    pendingByAgent.forEach((pending, agentId) => {
      merged[agentId] = [...pending.skillIds];
    });
    return merged;
  }

  return {
    cancelAgent,
    cancelAll,
    flushNow,
    mergePending,
    setSkills,
    syncCommitted,
  };
}
