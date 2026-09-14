/** 检查并安全移除本应用创建的目录链接。 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { createIssue, errorMessage, pathExists, withReadTimeout } = require("./runtime");
const { pathsEqual } = require("./path-safety");

/**
 * 检查某个路径的真实状态，用于判断它是否是「本应用创建的链接」。
 *
 * @param {string} linkPath - 待检查的路径
 * @param {string} [expectedSource] - 期望的链接目标（仓库源目录）
 * @returns {{kind: 'missing'|'directory'|'file'|'link'|'error', targetPath?: string, sameTarget?: boolean, dangling?: boolean, identity?: object, error?: Error}}
 *          kind 说明：missing 不存在；directory/file 是普通目录/文件（非链接）；
 *          link 是符号链接（附带目标、是否同源、是否失效、文件标识）；error 检查失败
 */
async function inspectLink(linkPath, expectedSource) {
  let stat;
  try {
    stat = await withReadTimeout(fsp.lstat(linkPath), `检查链接 ${linkPath}`);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error };
  }
  if (!stat.isSymbolicLink())
    return { kind: stat.isDirectory() ? "directory" : "file" };
  try {
    const rawTarget = await withReadTimeout(
      fsp.readlink(linkPath),
      `读取链接 ${linkPath}`,
    );
    const targetPath = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(path.dirname(linkPath), rawTarget);
    return {
      kind: "link",
      targetPath,
      sameTarget: expectedSource
        ? await pathsEqual(targetPath, expectedSource)
        : false,
      dangling: !(await pathExists(targetPath)),
      identity: {
        dev: Number(stat.dev),
        ino: Number(stat.ino),
        birthtimeMs: Number(stat.birthtimeMs),
      },
    };
  } catch (error) {
    return { kind: "error", error };
  }
}

/**
 * 比较创建链接时记录的文件标识与当前标识是否一致。
 * 三者任一不同，都说明该路径已不是本应用创建的那条链接。
 *
 * @param {object|undefined} stored - 创建时记录的 identity
 * @param {{dev: number, ino: number, birthtimeMs: number}} current - 当前读到的 identity
 * @returns {boolean} 是否仍归本应用管理
 */
function identitiesEqual(stored, current) {
  if (!stored || !current) return false;
  return (
    stored.dev === current.dev &&
    stored.ino === current.ino &&
    stored.birthtimeMs === current.birthtimeMs
  );
}

/**
 * 判断 child 是否是 parent 的直接子项（不跨层级）。
 * 用于确保受管链接只会出现在 Agent 目录的第一层。
 *
 * @param {string} parent - 父目录
 * @param {string} child - 待判断路径
 * @returns {boolean} 是否为直接子项
 */
async function isDirectChild(parent, child) {
  return pathsEqual(path.dirname(child), parent);
}

/**
 * 安全移除一条受管链接。
 *
 * 移除条件（必须全部满足）：路径位于允许目录内、仍是符号链接、目标未变、文件标识一致。
 * 任一条件不满足都只提示不删除，并把 relinquished 置为 true（表示放弃管理该记录）。
 *
 * @param {{linkPath: string, sourcePath: string, identity?: object, pending?: boolean}} link - 受管链接记录
 * @param {string} label - 用于提示文案的名称
 * @param {string} [allowedDirectory] - 允许删除的目录（通常是 Agent 目录）
 * @returns {{removed: boolean, relinquished: boolean, issues: Array}} removed 是否已删除；
 *          relinquished 是否已放弃管理（为 false 时调用方应保留该记录以便下次重试）
 */
async function removeOwnedLink(link, label, allowedDirectory) {
  if (!link?.linkPath || !link?.sourcePath)
    return { removed: false, relinquished: true, issues: [] };
  if (
    allowedDirectory &&
    !(await isDirectChild(allowedDirectory, link.linkPath))
  ) {
    return {
      removed: false,
      relinquished: true,
      issues: [
        createIssue(
          "warning",
          `${label}超出 Agent 目录，记录已忽略且不会删除该路径。`,
        ),
      ],
    };
  }
  const inspected = await inspectLink(link.linkPath, link.sourcePath);
  if (inspected.kind === "missing")
    return { removed: false, relinquished: true, issues: [] };
  if (inspected.kind === "error") {
    return {
      removed: false,
      relinquished: false,
      issues: [
        createIssue(
          "error",
          `无法检查${label}：${errorMessage(inspected.error)}`,
        ),
      ],
    };
  }
  if (
    inspected.kind !== "link" ||
    !inspected.sameTarget ||
    !identitiesEqual(link.identity, inspected.identity)
  ) {
    return {
      removed: false,
      relinquished: true,
      issues: [
        createIssue(
          "warning",
          `${label}已被外部替换，已停止管理并保留当前内容。`,
        ),
      ],
    };
  }
  try {
    await fsp.unlink(link.linkPath);
    return { removed: true, relinquished: true, issues: [] };
  } catch (error) {
    return {
      removed: false,
      relinquished: false,
      issues: [
        createIssue("error", `无法移除${label}：${errorMessage(error)}`),
      ],
    };
  }
}

module.exports = { identitiesEqual, inspectLink, isDirectChild, removeOwnedLink };
