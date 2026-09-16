/**
 * preload 通用工具：错误文案、问题列表、读取超时与路径处理。
 *
 * 本文件只放与业务无关的纯工具，供 config / scanner / links / api 复用。
 */
const fs = require("node:fs");
const path = require("node:path");

/** 单次文件读取的兜底超时：防止网络盘、休眠磁盘等异常让操作永久挂起。 */
const READ_TIMEOUT_MS = 15_000;

/**
 * 把任意异常转成便于展示的文案（带错误码前缀）。
 *
 * @param {unknown} error - 捕获到的异常
 * @returns {string} 中文错误描述
 */
function errorMessage(error) {
  if (!error) return "未知错误";
  const code = error?.code ? `${error.code}：` : "";
  return `${code}${error?.message || String(error)}`;
}

/**
 * 创建一条界面问题记录。
 *
 * @param {'error'|'warning'|'info'} type - 问题级别
 * @param {string} message - 展示给用户的中文说明
 * @returns {{type: string, message: string}}
 */
function createIssue(type, message) {
  return {
    type: type === "error" ? "error" : type === "info" ? "info" : "warning",
    message,
  };
}

/**
 * 按「级别 + 文案」去重问题列表，保持原顺序。
 *
 * @param {Array<{type: string, message: string}>} issues - 问题列表
 * @returns {Array} 去重后的问题列表
 */
function uniqueIssues(issues) {
  const seen = new Set();
  return (issues || []).filter((issue) => {
    if (!issue?.message) return false;
    const key = `${issue.type}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 给 Promise 增加超时保护：超时后以 ETIMEDOUT 拒绝，原操作仍会在后台自然结束。
 *
 * @param {Promise<any>} operation - 待保护的异步操作
 * @param {string} label - 超时提示中使用的操作名称
 * @param {number} [timeoutMs] - 超时毫秒数
 * @returns {Promise<any>} 原操作结果
 */
function withTimeout(operation, label, timeoutMs = READ_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}超时（${timeoutMs / 1000} 秒）`);
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 判断路径是否存在（跟随符号链接，因此可用来判断链接目标是否失效）。
 *
 * @param {string} target - 目标路径
 * @returns {Promise<boolean>} 是否存在
 */
async function pathExists(target) {
  try {
    await withTimeout(fs.promises.stat(target), `访问路径 ${target}`);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 词法规范化路径：统一为绝对路径、去掉 Windows \\?\ 前缀、统一大小写与尾随分隔符。
 * 只做字符串处理、不访问文件系统，因此对已失效（悬空）的链接同样可用。
 *
 * @param {string} target - 待规范化的路径
 * @returns {string} 可比较的路径字符串
 */
function comparablePath(target) {
  let normalized = path.normalize(
    path.resolve(String(target ?? "").replace(/^\\\\\?\\/, "")),
  );
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/, "");
}

/**
 * 纯词法比较两个路径是否等价（大小写、分隔符、尾随分隔符、\\?\ 前缀均归一化）。
 * 不访问文件系统，适合用于链接目标与记录路径的比较。
 *
 * @param {string} left - 左路径
 * @param {string} right - 右路径
 * @returns {boolean} 词法上是否等价
 */
function pathsEqualLexical(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (!left.trim() || !right.trim()) return false;
  return comparablePath(left) === comparablePath(right);
}

/**
 * 纯词法判断 child 是否位于 parent 之内（含二者相等）。
 *
 * @param {string} parent - 父目录
 * @param {string} child - 子路径
 * @returns {boolean} 是否被 parent 包含
 */
function isInsideDirectoryLexical(parent, child) {
  if (typeof parent !== "string" || typeof child !== "string") return false;
  if (!parent.trim() || !child.trim()) return false;
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * 纯词法判断两个目录是否存在重叠（相同或互相包含）。
 * 用于拦截“仓库与 Agent 目录互相嵌套”的危险配置，避免扫描与链接相互影响。
 *
 * @param {string} left - 左路径
 * @param {string} right - 右路径
 * @returns {boolean} 两者相同或被任一方包含
 */
function pathsOverlapLexical(left, right) {
  return (
    isInsideDirectoryLexical(left, right) ||
    isInsideDirectoryLexical(right, left)
  );
}

/**
 * 判断目标是不是磁盘根目录（盘符根 C:\ 或 UNC 共享根）。
 *
 * @param {string} target - 待判断路径
 * @returns {boolean} 是否为磁盘根目录
 */
function isDiskRoot(target) {
  if (typeof target !== "string" || !target.trim()) return false;
  const resolved = path.normalize(
    path.resolve(String(target).replace(/^\\\\\?\\/, "")),
  );
  if (!path.isAbsolute(resolved)) return false;
  const root = path.parse(resolved).root;
  return root !== "" && comparablePath(root) === comparablePath(resolved);
}

/**
 * 校验并规范化目录：必须存在、是文件夹，并返回解析后的真实路径（realpath）。
 *
 * 返回值始终是真实路径，符号链接 / junction 会被解析到真实目标，
 * 保存与后续的所有路径比较都基于该规范化结果。
 *
 * @param {string} directory - 用户选择的目录
 * @param {string} [label] - 错误文案中的目录名称
 * @returns {Promise<string>} 规范化后的绝对路径
 * @throws {Error} 目录为空、不存在、不是文件夹或是磁盘根目录时抛出
 */
async function normalizeDirectory(directory, label = "目录") {
  if (typeof directory !== "string" || !directory.trim())
    throw new Error(`请选择有效的${label}`);
  const resolved = path.resolve(directory.trim());
  if (isDiskRoot(resolved))
    throw new Error(`${label}不能是磁盘根目录，请选择专用的文件夹`);
  let stat;
  try {
    stat = await withTimeout(fs.promises.stat(resolved), `检查${label}`);
  } catch (error) {
    throw new Error(`${label}不存在或无法访问：${errorMessage(error)}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label}不是文件夹：${resolved}`);
  let canonical;
  try {
    canonical = await withTimeout(fs.promises.realpath(resolved), `解析${label}`);
  } catch (error) {
    throw new Error(`无法解析${label}的真实路径：${errorMessage(error)}`);
  }
  // 真实路径同样检查磁盘根：拦下“指向磁盘根的 junction / 符号链接”。
  if (isDiskRoot(canonical))
    throw new Error(`${label}不能是磁盘根目录，请选择专用的文件夹`);
  return canonical;
}

module.exports = {
  comparablePath,
  createIssue,
  errorMessage,
  isInsideDirectoryLexical,
  normalizeDirectory,
  pathExists,
  pathsEqualLexical,
  pathsOverlapLexical,
  uniqueIssues,
  withTimeout,
};
