/**
 * Agent Skills 高频开关提交队列。
 *
 * 将连续选择合并为最终状态，并在失败时回滚乐观更新，避免页面与磁盘链接失配。
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
 * 创建串行防抖队列。
 *
 * 调用方负责真实状态的读取/写入与服务提交，队列仅管理操作顺序。
 */
export function createSkillSyncQueue({
  getEnabledSkills,
  setEnabledSkills,
  isOperationInFlight,
  submit,
  setIssues,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}) {
  const pendingByAgent = new Map();
  let timer;
  let flushing = false;

  function schedule(delay = debounceMs) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  }

  async function flush() {
    if (!pendingByAgent.size) return;
    if (flushing || isOperationInFlight()) {
      schedule(BUSY_RETRY_MS);
      return;
    }

    const [agentId, pending] = pendingByAgent.entries().next().value;
    pendingByAgent.delete(agentId);
    flushing = true;
    try {
      const result = await submit(agentId, pending.skillIds);
      setIssues(agentId, result?.issues);
      pending.waiters.forEach(({ resolve }) => resolve(result));
    } catch (error) {
      if (!pendingByAgent.has(agentId))
        setEnabledSkills(agentId, pending.baseSkillIds);
      setIssues(agentId, [
        { type: "error", message: error?.message || "链接同步失败，请重试" },
      ]);
      pending.waiters.forEach(({ reject }) => reject(error));
    } finally {
      flushing = false;
      if (pendingByAgent.size) schedule(0);
    }
  }

  /** 乐观更新选择，并返回本轮最终提交完成的 Promise。 */
  function setSkills(agentId, skillIds) {
    const normalizedIds = normalizeSkillIds(skillIds);
    let pending = pendingByAgent.get(agentId);
    if (!pending) {
      pending = {
        baseSkillIds: normalizeSkillIds(getEnabledSkills(agentId)),
        skillIds: normalizedIds,
        waiters: [],
      };
      pendingByAgent.set(agentId, pending);
    } else {
      pending.skillIds = normalizedIds;
    }

    setEnabledSkills(agentId, normalizedIds);
    const completion = new Promise((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
    });

    if (skillIdsEqual(pending.baseSkillIds, normalizedIds)) {
      pendingByAgent.delete(agentId);
      pending.waiters.forEach(({ resolve }) => resolve(null));
      if (!pendingByAgent.size) clearTimeout(timer);
      else schedule();
    } else {
      schedule();
    }
    return completion;
  }

  /** 取消一个 Agent 未提交的选择并恢复入队前状态。 */
  function cancelAgent(agentId) {
    const pending = pendingByAgent.get(agentId);
    if (!pending) return;
    setEnabledSkills(agentId, pending.baseSkillIds);
    pendingByAgent.delete(agentId);
    pending.waiters.forEach(({ resolve }) => resolve(null));
    if (!pendingByAgent.size) clearTimeout(timer);
  }

  function cancelAll() {
    [...pendingByAgent.keys()].forEach(cancelAgent);
  }

  /** 合并服务端状态时保留仍在排队的乐观选择。 */
  function mergePending(serverState) {
    const merged = { ...serverState };
    pendingByAgent.forEach((pending, agentId) => {
      merged[agentId] = [...pending.skillIds];
    });
    return merged;
  }

  return { cancelAgent, cancelAll, mergePending, setSkills };
}
