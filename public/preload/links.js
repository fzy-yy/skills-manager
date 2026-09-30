/**
 * Agent Skills 链接管理：在 Agent 目录中创建 / 删除指向仓库的目录符号链接。
 *
 * 设计前提（与产品约定一致）：Agent 目录允许包含其他内容，插件只管理「指向仓库」
 * 的链接，因此同步时以「磁盘现状 + 期望启用集合」为唯一依据，不依赖额外的受管记录：
 *  - 期望状态：每个已启用 Skill 对应 <Agent 目录>/<Skill 目录名> 的一个符号链接；
 *  - 清理范围：目录第一层中「目标位于仓库内」的符号链接（含路径在仓库内但已悬空的）；
 *  - 保护范围：普通文件、普通目录以及指向仓库外部的链接（无论是否悬空）一律不触碰。
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  comparablePath,
  createIssue,
  errorMessage,
  isInsideDirectoryLexical,
  pathExists,
  uniqueIssues,
  withTimeout,
} = require("./utils");

/**
 * 检查一个路径的当前状态（不跟随符号链接）。
 *
 * @param {string} targetPath - 待检查的路径
 * @returns {Promise<{kind: 'missing'|'symlink'|'directory'|'file'|'error', targetPath?: string, error?: Error}>}
 *          symlink 时附带解析后的绝对目标路径
 */
async function inspectEntry(targetPath) {
  let stat;
  try {
    stat = await withTimeout(
      fs.promises.lstat(targetPath),
      `检查路径 ${targetPath}`,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error };
  }
  if (!stat.isSymbolicLink())
    return { kind: stat.isDirectory() ? "directory" : "file" };
  try {
    const rawTarget = await withTimeout(
      fs.promises.readlink(targetPath),
      `读取链接 ${targetPath}`,
    );
    return {
      kind: "symlink",
      targetPath: path.isAbsolute(rawTarget)
        ? rawTarget
        : path.resolve(path.dirname(targetPath), rawTarget),
    };
  } catch (error) {
    return { kind: "error", error };
  }
}

/**
 * 删除一个符号链接。
 * Windows 上 junction / 目录符号链接的删除方式与文件链接不同，unlink 失败时回退 rmdir。
 *
 * @param {string} linkPath - 链接路径
 * @returns {Promise<void>}
 */
async function removeSymlink(linkPath) {
  try {
    await fs.promises.unlink(linkPath);
  } catch (error) {
    if (["EPERM", "EACCES", "EISDIR"].includes(error?.code)) {
      await fs.promises.rmdir(linkPath);
      return;
    }
    throw error;
  }
}

/**
 * 判断一个符号链接是否由本插件管理：目标位于仓库内（含已悬空但路径仍在仓库内的）。
 * 指向仓库外部的链接无法证明与本插件有关，即使已悬空也保留，避免误删用户内容。
 *
 * @param {object} inspected - inspectEntry 的结果（kind 必须为 symlink）
 * @param {string} repositoryPath - 统一 Skills 仓库目录
 * @returns {boolean} true 表示可以清理
 */
function isManagedLink(inspected, repositoryPath) {
  if (inspected.kind !== "symlink") return false;
  return isInsideDirectoryLexical(repositoryPath, inspected.targetPath);
}

/**
 * 同步一个 Agent 目录中的链接，使其与「已启用 Skills」一致。
 *
 * @param {object} options - 同步参数
 * @param {string} options.repositoryPath - 统一 Skills 仓库目录
 * @param {Array<{id: string, name: string, sourcePath: string}>} options.skills - 最近一次完整扫描结果
 * @param {{id: string, name: string, directory: string}} options.agent - 目标 Agent
 * @param {string[]} options.enabledSkillIds - 该 Agent 已启用的 Skill id 列表
 * @returns {Promise<{issues: Array}>} 本次同步产生的问题（错误与提示）
 */
async function syncAgentLinks({
  repositoryPath,
  skills,
  agent,
  enabledSkillIds,
}) {
  const issues = [];
  const directory = agent.directory;

  try {
    const stat = await withTimeout(
      fs.promises.stat(directory),
      `检查 Agent“${agent.name}”目录`,
    );
    if (!stat.isDirectory()) throw new Error("该路径不是文件夹");
  } catch (error) {
    return {
      issues: [
        createIssue(
          "error",
          `Agent“${agent.name}”的 Skills 目录不可用：${errorMessage(error)}。未创建或删除任何链接。`,
        ),
      ],
    };
  }

  const desiredIds = new Set(enabledSkillIds);
  // 期望链接：Skill id 即链接目录名（同一仓库内天然唯一；缓存中不存在的无效 id 直接忽略）。
  const desiredSkills = skills.filter((skill) => desiredIds.has(skill.id));

  let entries;
  try {
    entries = await withTimeout(
      fs.promises.readdir(directory, { withFileTypes: true }),
      `读取 Agent“${agent.name}”目录`,
    );
  } catch (error) {
    return {
      issues: [
        createIssue(
          "error",
          `无法读取 Agent“${agent.name}”的 Skills 目录：${errorMessage(error)}。未创建或删除任何链接。`,
        ),
      ],
    };
  }

  // 第一轮：处理目录中已有的符号链接（保留或清理）。
  // 注意：这里不依赖 readdir 的 Dirent 类型，统一用 lstat 复核，确保 junction 也能识别。
  const skillBySource = new Map(
    skills.map((skill) => [comparablePath(skill.sourcePath), skill]),
  );
  const keptPaths = new Set();
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const inspected = await inspectEntry(entryPath);
    if (inspected.kind !== "symlink") continue;

    const skill = skillBySource.get(comparablePath(inspected.targetPath));
    const shouldKeep =
      skill &&
      desiredIds.has(skill.id) &&
      entry.name === skill.id &&
      (await pathExists(skill.sourcePath));

    if (shouldKeep) {
      keptPaths.add(comparablePath(entryPath));
      continue;
    }
    if (skill || isManagedLink(inspected, repositoryPath)) {
      try {
        await removeSymlink(entryPath);
      } catch (error) {
        issues.push(
          createIssue(
            "warning",
            `无法删除 Agent“${agent.name}”目录中的旧链接 ${entryPath}：${errorMessage(error)}`,
          ),
        );
      }
    }
  }

  // 第二轮：为缺失的期望链接创建符号链接。
  for (const skill of desiredSkills) {
    const linkPath = path.join(directory, skill.id);
    if (keptPaths.has(comparablePath(linkPath))) continue;
    const inspected = await inspectEntry(linkPath);
    if (inspected.kind === "missing") {
      // Windows junction / 符号链接允许指向不存在的目标，因此先确认源目录仍存在，
      // 避免缓存过期时创建出无意义的悬空链接。
      if (!(await pathExists(skill.sourcePath))) {
        issues.push(
          createIssue(
            "error",
            `“${skill.name}”无法链接：源目录不存在 ${skill.sourcePath}，请重新扫描仓库后再试。`,
          ),
        );
        continue;
      }
      try {
        await fs.promises.symlink(
          skill.sourcePath,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch (error) {
        issues.push(
          createIssue(
            "error",
            `创建“${skill.name}”链接失败：${errorMessage(error)}`,
          ),
        );
      }
      continue;
    }
    if (inspected.kind === "symlink") {
      issues.push(
        createIssue(
          "warning",
          `“${skill.name}”无法链接：目标位置已被其他链接占用 ${linkPath}，未做改动。`,
        ),
      );
      continue;
    }
    if (inspected.kind === "error") {
      issues.push(
        createIssue(
          "error",
          `无法检查“${skill.name}”的目标位置 ${linkPath}：${errorMessage(inspected.error)}`,
        ),
      );
      continue;
    }
    issues.push(
      createIssue(
        "warning",
        `“${skill.name}”无法链接：目标位置已有同名的${inspected.kind === "directory" ? "目录" : "文件"} ${linkPath}，已保留原内容。`,
      ),
    );
  }

  return { issues: uniqueIssues(issues) };
}

/**
 * 清理 Agent 目录中由本插件管理的链接（目标位于仓库内）。
 * 用于删除 Agent、更换目录与清除数据；失败的条目会提示用户但不阻断流程。
 * 仓库路径为空时无法识别受管链接，此时不删除任何内容（目录中的链接一律保留）。
 *
 * @param {{id: string, name: string, directory: string}} agent - 目标 Agent
 * @param {{repositoryPath?: string}} [options] - 统一 Skills 仓库目录
 * @returns {Promise<{issues: Array}>} 清理过程中产生的问题
 */
async function removeManagedLinks(agent, { repositoryPath = "" } = {}) {
  const issues = [];
  if (!repositoryPath) return { issues };
  let entries;
  try {
    entries = await withTimeout(
      fs.promises.readdir(agent.directory, { withFileTypes: true }),
      `读取 Agent“${agent.name}”目录`,
    );
  } catch (error) {
    // 目录已不存在时视为清理完成；其他错误提示用户。
    if (error?.code === "ENOENT") return { issues: [] };
    return {
      issues: [
        createIssue(
          "error",
          `无法读取 Agent“${agent.name}”的 Skills 目录：${errorMessage(error)}，其链接未清理。`,
        ),
      ],
    };
  }

  for (const entry of entries) {
    const entryPath = path.join(agent.directory, entry.name);
    const inspected = await inspectEntry(entryPath);
    if (inspected.kind !== "symlink") continue;
    const managed = isManagedLink(inspected, repositoryPath);
    if (!managed) continue;
    try {
      await removeSymlink(entryPath);
    } catch (error) {
      issues.push(
        createIssue(
          "warning",
          `无法删除 Agent“${agent.name}”目录中的链接 ${entryPath}：${errorMessage(error)}`,
        ),
      );
    }
  }
  return { issues: uniqueIssues(issues) };
}

module.exports = { removeManagedLinks, syncAgentLinks };
