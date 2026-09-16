/**
 * 外观主题控制器：主题状态、<html> 类名同步与持久化。
 *
 * 主题也是配置的一部分，因此写入同样受 preload 的只读保护与并发校验约束。
 * operation-runner 的 execute 现在返回判别式 outcome，本控制器据此区分：
 *  - busy：全局有其他操作在途，不是失败——等运行器空闲后重试，界面不回滚；
 *  - error：真实失败——回滚到已持久化主题；
 *  - ok：采用服务端返回的主题。
 * 对外仍只返回 boolean，避免页面接线跟着变化。
 */
import { ref } from "vue";
import { hasPreloadApi, preloadApi } from "./preload-api";

export function createThemeController({ execute, waitUntilIdle }) {
  const theme = ref("light");
  /** 最后一次确认持久化（或来自服务端）的主题，真实失败时回滚到它。 */
  let committedTheme = "light";
  /** 最近一次请求的目标主题，busy 等待结束后只重试"最新"那一个。 */
  let requestedTheme;

  /** 应用主题值，并同步 <html> 上的 dark 类（所有 dark: 工具类都由它开关）。 */
  function applyTheme(value) {
    theme.value = value === "dark" ? "dark" : "light";
    document.documentElement.classList.toggle("dark", theme.value === "dark");
  }

  /** 合并 preload 返回状态中的主题字段；未出现该字段时保持当前值。 */
  function applyFromState(next) {
    if (Object.hasOwn(next, "theme")) {
      applyTheme(next.theme);
      committedTheme = theme.value;
    }
  }

  /** 等待全局操作空闲；未注入 waitUntilIdle 时退化为让出一个宏任务。 */
  function waitForIdle() {
    if (typeof waitUntilIdle === "function") return waitUntilIdle();
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** 通过运行器持久化主题；busy 由本控制器自行消化，不再弹全局警告。 */
  function persist(nextTheme) {
    return execute(() => preloadApi().setTheme(nextTheme), {
      applyResult: applyFromState,
      notifyBusy: false,
    });
  }

  /**
   * 切换主题：先乐观更新界面，再持久化到本地配置。
   *
   * 遇到 busy 会等待运行器空闲后重试最新主题；只有真实失败才回滚。
   *
   * @param {'light'|'dark'} nextTheme - 目标主题
   * @returns {Promise<boolean>} 是否保存成功（浏览器预览下只改界面，视为成功）
   */
  async function setTheme(nextTheme) {
    if (nextTheme !== "light" && nextTheme !== "dark") return false;
    applyTheme(nextTheme);
    requestedTheme = nextTheme;
    if (!hasPreloadApi()) {
      committedTheme = theme.value;
      return true;
    }

    let outcome = await persist(nextTheme);
    if (!outcome.ok && outcome.reason === "busy") {
      await waitForIdle();
      // 等待期间用户可能又切了主题：只重试最新那一个，旧请求直接让位
      if (requestedTheme !== nextTheme) return false;
      outcome = await persist(nextTheme);
    }

    if (outcome.ok) {
      applyFromState(outcome.value || {});
      committedTheme = theme.value;
      return true;
    }
    // busy 不是真实失败，不回滚；只有真实失败才回到已持久化主题
    if (outcome.reason !== "busy" && requestedTheme === nextTheme)
      applyTheme(committedTheme);
    return false;
  }

  return { applyFromState, applyTheme, setTheme, theme };
}
