/**
 * 全局界面反馈：自动关闭的提示列表与确认对话框。
 *
 * 与业务数据无关，独立成文件后 Pinia 主仓库只需引用，不必承担展示细节。
 */
import { ref } from "vue";

/** 提示同时最多保留的条数、默认展示时长与错误提示的最短展示时长（毫秒）。 */
const MAX_NOTICES = 20;
const DEFAULT_NOTICE_DURATION = 5000;
const ERROR_NOTICE_DURATION = 9000;

/**
 * 创建提示中心：支持自动关闭、同文案去重与批量上报 preload 返回的问题。
 *
 * @returns {{notices: object, dismissNotice: Function, notify: Function, reportIssues: Function}}
 */
export function createNoticeCenter() {
  const notices = ref([]);
  const timers = new Map();
  let sequence = 0;

  /** 关闭一条提示并释放它的定时器。 */
  function dismissNotice(id) {
    notices.value = notices.value.filter((notice) => notice.id !== id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  }

  /**
   * 展示一条提示；相同级别、相同文案不会重复堆积。
   *
   * @param {string} message - 提示文案
   * @param {'success'|'error'|'warning'|'info'} [type] - 提示级别
   * @param {number} [duration] - 展示时长（毫秒）
   */
  function notify(message, type = "success", duration = DEFAULT_NOTICE_DURATION) {
    if (!message) return;
    const text = String(message);
    if (
      notices.value.some(
        (notice) => notice.message === text && notice.type === type,
      )
    )
      return;

    while (notices.value.length >= MAX_NOTICES)
      dismissNotice(notices.value[0].id);

    const id = ++sequence;
    notices.value.push({ id, message: text, type });
    const timeout =
      type === "error" ? Math.max(duration, ERROR_NOTICE_DURATION) : duration;
    timers.set(
      id,
      setTimeout(() => dismissNotice(id), timeout),
    );
  }

  /**
   * 批量展示 preload 返回的问题列表。
   *
   * @param {Array<{type: string, message: string}>} issues - 问题列表
   */
  function reportIssues(issues) {
    (Array.isArray(issues) ? issues : []).forEach((issue) =>
      notify(issue?.message, issue?.type || "warning"),
    );
  }

  return { dismissNotice, notices, notify, reportIssues };
}

/**
 * 创建全局确认对话框控制器。
 * 同一时间只保留一个对话框，新请求会把旧请求按“取消”处理。
 *
 * @returns {{dialog: object, confirm: Function, resolveDialog: Function}}
 */
export function createConfirmDialog() {
  const dialog = ref({
    open: false,
    title: "",
    message: "",
    confirmText: "确定",
    cancelText: "取消",
    tone: "primary",
  });
  let resolver;

  /**
   * 打开确认框。
   *
   * @param {{title?: string, message?: string, confirmText?: string, cancelText?: string, tone?: 'primary'|'danger'}} [options] - 展示配置
   * @returns {Promise<boolean>} 用户是否确认
   */
  function confirm(options = {}) {
    resolver?.(false);
    dialog.value = {
      open: true,
      title: options.title || "请确认",
      message: options.message || "",
      confirmText: options.confirmText || "确定",
      cancelText: options.cancelText || "取消",
      tone: options.tone || "primary",
    };
    return new Promise((resolve) => {
      resolver = resolve;
    });
  }

  /** 关闭确认框并回传用户选择。 */
  function resolveDialog(accepted) {
    dialog.value.open = false;
    const currentResolver = resolver;
    resolver = undefined;
    currentResolver?.(accepted);
  }

  return { confirm, dialog, resolveDialog };
}
