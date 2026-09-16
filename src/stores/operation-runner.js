/**
 * 全局操作运行器：忙碌标记、串行守卫与统一反馈。
 *
 * 全项目只有这里实现"同一时刻只允许一个文件操作"这一约束，各业务控制器共用同一份实例，
 * 因此链接同步不会与其他写操作交叉，页面也不必各自实现"操作中"状态。
 */
import { ref } from "vue";
import { createConfirmDialog, createNoticeCenter } from "./ui-feedback";

const BUSY_MESSAGE = "已有操作正在进行，请等待完成后再试";

/** 让出一个宏任务，使 Vue 有机会先绘制忙碌状态和进度条。 */
function waitForRender() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function createOperationRunner() {
  const { notices, dismissNotice, notify, reportIssues } = createNoticeCenter();
  const { dialog, confirm, resolveDialog } = createConfirmDialog();
  const busy = ref(false);
  let inFlight = false;
  let idleWaiters = [];

  function isInFlight() {
    return inFlight;
  }

  /**
   * 等待运行器空闲（当前没有操作在途）。
   *
   * 已经空闲时立即 resolve，因此调用方无需先判断 isInFlight；
   * 供主题切换等"遇到 busy 后等一会再重试"的场景使用。
   *
   * @returns {Promise<void>}
   */
  function waitUntilIdle() {
    if (!inFlight) return Promise.resolve();
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  /** 在操作结束后唤醒所有等待空闲的调用方。 */
  function releaseIdleWaiters() {
    if (inFlight || !idleWaiters.length) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /**
   * 执行一次"可能改动本地状态"的业务操作。
   *
   * 约定：**永不 reject**。返回判别式 outcome，调用方用 `ok` 判断成败：
   *  - 成功：`{ ok: true, reason: "ok", value, error: null }`
   *  - 并发被拒：`{ ok: false, reason: "busy", value: null, error: null }`
   *  - 真实失败：`{ ok: false, reason: "error", value: null, error }`
   *
   * `busy` 不代表操作失败——调用方可以等待 `waitUntilIdle()` 后重试；
   * 供页面直接使用的场景仍可只看 `outcome.value`。
   *
   * @param {() => Promise<object>} operation - 实际调用 preload 服务的函数
   * @param {{successMessage?: string, applyResult?: (result: object) => void, reportResultIssues?: boolean, notifyBusy?: boolean}} [options]
   *        applyResult 用于把服务返回的状态合并进对应业务控制器；
   *        notifyBusy 为 false 时并发被拒不再弹全局警告（由调用方自行重试）
   * @returns {Promise<{ok: boolean, reason: "ok"|"busy"|"error", value: object|null, error: Error|null}>}
   */
  async function execute(operation, options = {}) {
    const {
      successMessage,
      applyResult,
      reportResultIssues = true,
      notifyBusy = true,
    } = options;
    if (inFlight) {
      if (notifyBusy) notify(BUSY_MESSAGE, "warning");
      return { ok: false, reason: "busy", value: null, error: null };
    }
    inFlight = true;
    busy.value = true;
    try {
      await waitForRender();
      const result = await operation();
      if (result) applyResult?.(result);
      const issues = Array.isArray(result?.issues) ? result.issues : [];
      if (reportResultIssues) reportIssues(issues);
      if (successMessage && !issues.some((issue) => issue?.type === "error"))
        notify(successMessage);
      return { ok: true, reason: "ok", value: result ?? null, error: null };
    } catch (error) {
      notify(error?.message || "操作失败，请重试", "error");
      return { ok: false, reason: "error", value: null, error };
    } finally {
      inFlight = false;
      busy.value = false;
      releaseIdleWaiters();
    }
  }

  return {
    busy,
    confirm,
    dialog,
    dismissNotice,
    execute,
    isInFlight,
    notices,
    notify,
    reportIssues,
    resolveDialog,
    waitUntilIdle,
  };
}
