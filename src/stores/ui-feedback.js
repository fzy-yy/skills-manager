/**
 * 全局界面反馈状态。
 *
 * 提示和确认框不依赖业务数据，独立后可避免 Pinia 主仓库同时承担展示细节。
 */
import { ref } from "vue";

const MAX_NOTICES = 20;
const DEFAULT_NOTICE_DURATION = 5200;
const ERROR_NOTICE_DURATION = 9000;

/** 创建可自动关闭、支持去重的全局提示中心。 */
export function createNoticeCenter() {
  const notices = ref([]);
  const timers = new Map();
  let sequence = 0;

  /** 关闭提示并释放对应定时器。 */
  function dismissNotice(id) {
    notices.value = notices.value.filter((notice) => notice.id !== id);
    clearTimeout(timers.get(id));
    timers.delete(id);
  }

  /** 展示一条提示；相同类型和文案不会重复堆积。 */
  function notify(
    message,
    type = "success",
    duration = DEFAULT_NOTICE_DURATION,
  ) {
    if (!message) return;
    const normalizedMessage = String(message);
    if (
      notices.value.some(
        (notice) =>
          notice.message === normalizedMessage && notice.type === type,
      )
    )
      return;

    while (notices.value.length >= MAX_NOTICES)
      dismissNotice(notices.value[0].id);

    const id = ++sequence;
    notices.value.push({ id, message: normalizedMessage, type });
    const timeout =
      type === "error" ? Math.max(duration, ERROR_NOTICE_DURATION) : duration;
    timers.set(
      id,
      setTimeout(() => dismissNotice(id), timeout),
    );
  }

  /** 批量展示预加载服务返回的问题。 */
  function reportIssues(issues) {
    const safeIssues = Array.isArray(issues) ? issues : [];
    safeIssues.forEach((issue) =>
      notify(issue?.message, issue?.type || "warning"),
    );
    return safeIssues;
  }

  return { notices, dismissNotice, notify, reportIssues };
}

/** 创建全局确认对话框控制器。 */
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

  /** 打开确认框；若已有确认框，则先将旧请求按取消处理。 */
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

  /** 关闭确认框并返回用户选择。 */
  function resolveDialog(accepted) {
    dialog.value.open = false;
    const currentResolver = resolver;
    resolver = undefined;
    currentResolver?.(accepted);
  }

  return { dialog, confirm, resolveDialog };
}
