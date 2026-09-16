/**
 * Agent Skills 提交队列：把连续的开关点击合并成一次磁盘同步。
 *
 * 背景：每个开关点击都会触发“创建 / 删除链接”的同步操作，快速连点若逐次提交，
 * 会产生大量重复的目录扫描与写入。这里采用「乐观更新 + 防抖合并 + 失败回滚」：
 *  1. 点击后立即更新界面（乐观），300ms 内的多次点击只提交最后一次选择；
 *  2. 提交成功后以服务端返回的选择为准（若期间又有新选择则继续保留新选择）；
 *  3. 提交失败时回滚到上一次已确认的状态，并把错误交给 onError 提示。
 */
const DEBOUNCE_MS = 300;

/**
 * 规范化选择：去重、转字符串并排序，保证同一组选择得到相同表示。
 *
 * @param {string[]} skillIds - 原始选择
 * @returns {string[]} 规范化后的选择
 */
function normalizeSkillIds(skillIds) {
  return [...new Set((Array.isArray(skillIds) ? skillIds : []).map(String))].sort();
}

/**
 * 创建提交队列。
 *
 * @param {object} options - 依赖注入
 * @param {(agentId: string) => string[]} options.getSelection - 读取界面当前选择（失败回滚的兜底值）
 * @param {(agentId: string, skillIds: string[]) => void} options.applySelection - 写入界面选择
 * @param {(agentId: string, skillIds: string[]) => Promise<object>} options.submit - 真实提交（调用 preload）
 * @param {(agentId: string, issues: Array) => void} options.onIssues - 提交返回的该 Agent 问题
 * @param {(error: Error) => void} options.onError - 提交失败时的提示入口
 * @returns {{setSkills: Function, cancel: Function, cancelAll: Function, flushNow: Function, pendingEntries: Function}}
 */
export function createSkillQueue({
  getSelection,
  applySelection,
  submit,
  onIssues,
  onError,
}) {
  /** 尚未提交的最新目标：agentId → skillIds */
  const pending = new Map();
  /** 服务端已确认的选择：agentId → skillIds（失败回滚的唯一依据） */
  const committed = new Map();
  let timer;
  let flushing = false;

  /** 安排一次延迟提交；重复调用会重置计时（防抖）。 */
  function schedule(delay = DEBOUNCE_MS) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  }

  /** 依次提交所有待提交的选择，直至队列为空。 */
  async function flush() {
    if (flushing || !pending.size) return;
    flushing = true;
    try {
      while (pending.size) {
        const [agentId, skillIds] = pending.entries().next().value;
        pending.delete(agentId);
        try {
          const result = await submit(agentId, skillIds);
          const serverIds = normalizeSkillIds(
            result?.enabledSkills?.[agentId] ?? skillIds,
          );
          committed.set(agentId, serverIds);
          onIssues(agentId, result?.agentIssues?.[agentId] || []);
          // 提交期间用户又改了选择时不覆盖界面，交给下一轮提交。
          if (!pending.has(agentId)) applySelection(agentId, serverIds);
        } catch (error) {
          // 已有更新选择时不回滚，等待新选择提交；否则回滚到已确认状态。
          if (!pending.has(agentId)) {
            applySelection(agentId, committed.get(agentId) ?? getSelection(agentId));
            onError(error);
          }
        }
      }
    } finally {
      flushing = false;
    }
  }

  /**
   * 更新某个 Agent 的选择：立即反映到界面，并排队提交。
   *
   * @param {string} agentId - Agent id
   * @param {string[]} skillIds - 新的完整选择列表
   */
  function setSkills(agentId, skillIds) {
    const normalized = normalizeSkillIds(skillIds);
    if (!committed.has(agentId)) committed.set(agentId, normalizeSkillIds(getSelection(agentId)));
    pending.set(agentId, normalized);
    applySelection(agentId, normalized);
    schedule();
  }

  /** 取消某个 Agent 尚未提交的选择（例如该 Agent 即将被删除）。 */
  function cancel(agentId) {
    pending.delete(agentId);
    committed.delete(agentId);
  }

  /** 取消全部待提交选择（例如清除数据）。 */
  function cancelAll() {
    pending.clear();
    committed.clear();
  }

  /** 立即提交所有待提交选择（插件隐藏时调用，不等待完成）。 */
  function flushNow() {
    clearTimeout(timer);
    timer = undefined;
    void flush();
  }

  /**
   * 返回仍在等待提交的乐观选择（供状态合并时保留界面上的最新值）。
   *
   * @returns {Array<[string, string[]]>} agentId 与选择列表的条目
   */
  function pendingEntries() {
    return [...pending.entries()];
  }

  return { cancel, cancelAll, flushNow, pendingEntries, setSkills };
}
