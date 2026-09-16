/**
 * 渲染层访问 preload 能力的唯一入口。
 *
 * window.skillsManager 只会在 uTools 中加载了 public/preload/services.js 后存在；
 * 浏览器里直接预览时会走降级分支，因此这里集中处理“有没有、能不能用”。
 */

/**
 * 判断 preload 能力是否可用（用于启动时的降级与提示）。
 *
 * @returns {boolean} 是否运行在 uTools preload 环境中
 */
export function hasBackend() {
  return Boolean(window.skillsManager);
}

/**
 * 获取 preload 暴露的本地能力对象。
 *
 * @returns {object} window.skillsManager 实例
 * @throws {Error} 未在 uTools 环境运行时抛出可读错误
 */
export function backend() {
  if (!window.skillsManager)
    throw new Error("请在 uTools 中运行插件以使用本地目录功能");
  return window.skillsManager;
}
