/**
 * 渲染层访问 preload 能力的唯一入口。
 *
 * window.skillsManager 只在 uTools 中加载了 public/preload/services.js 时才存在，
 * 浏览器预览（含 E2E）下会走各自的降级分支，因此这里集中处理"有没有、能不能用"。
 */
export function hasPreloadApi() {
  return Boolean(window.skillsManager);
}

/**
 * 获取 preload 暴露的本地能力对象。
 *
 * @returns {object} window.skillsManager 实例
 * @throws {Error} 未在 uTools 环境运行时抛出可读错误，由调用方提示用户
 */
export function preloadApi() {
  if (!window.skillsManager)
    throw new Error("请在 uTools 开发环境中运行插件以使用本地目录功能");
  return window.skillsManager;
}
