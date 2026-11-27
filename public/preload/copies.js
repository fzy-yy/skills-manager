/**
 * Agent Skills 直接复制模式管理：在 Agent 目录中复制 / 校验 / 删除 Skill 副本。
 *
 * 与 links.js（符号链接模式）的关键差异：直接复制会在 Agent 目录写入真实文件，
 * 删除时可能造成用户数据丢失，因此遵循更严格的安全边界：
 *  - 跟踪范围：仅管理本地配置 copiedSkills 中记录的、由本插件复制的副本；
 *    未由本插件记录的目录即使同名同内容，也绝不自动删除；
 *  - 启用冲突回退：启用 Skill 时若目标位置已有同名文件 / 目录 / 符号链接，
 *    绝不覆盖，按单个 Skill 粒度回退启用状态并提示；
 *  - 删前双重校验：删除或覆盖更新副本前，必须确认目标为真实目录、顶层含常规文件
 *    SKILL.md（大小写不敏感）、目录内无符号链接，且完整目录树内容与「复制时指纹」
 *    或「当前仓库源 Skill」完全一致（自动忽略 Thumbs.db / desktop.ini / .DS_Store）；
 *  - 原子写入：复制先写入同目录临时文件夹并计算指纹，成功后再重命名为目标目录名。
 */
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  createIssue,
  errorMessage,
  uniqueIssues,
  withTimeout,
} = require("./utils");

/** 比对与复制时自动忽略的常见系统元数据文件（全小写匹配）。 */
const IGNORED_OS_FILES = new Set(["thumbs.db", "desktop.ini", ".ds_store"]);

/** 临时暂存目录前缀（与目标位于同一 Agent 目录下，保证 rename 为同盘原子操作）。 */
const STAGING_PREFIX = ".skills-manager-tmp-";

/**
 * 判断文件名是否属于系统自动生成的元数据文件。
 *
 * @param {string} name - 文件名
 * @returns {boolean} 是否应忽略
 */
function isIgnoredOsFile(name) {
  return IGNORED_OS_FILES.has(String(name || "").toLowerCase());
}

/**
 * 检查单个路径的条目类型（不跟随符号链接）。
 *
 * @param {string} targetPath - 待检查路径
 * @returns {Promise<{kind: 'missing'|'symlink'|'directory'|'file'|'error', error?: Error}>}
 */
async function inspectEntryKind(targetPath) {
  try {
    const stat = await withTimeout(
      fs.promises.lstat(targetPath),
      `检查路径 ${targetPath}`,
    );
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    return { kind: stat.isDirectory() ? "directory" : "file" };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error };
  }
}

/**
 * 计算单个常规文件的 SHA-256 摘要。
 *
 * @param {string} filePath - 文件绝对路径
 * @returns {Promise<string>} 十六进制 SHA-256
 */
async function hashFile(filePath) {
  const buffer = await withTimeout(
    fs.promises.readFile(filePath),
    `读取文件 ${filePath}`,
  );
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 递归检查目录树并计算规范化内容指纹。
 *
 * 规则：
 *  - 根目录必须是真实目录（非符号链接）；
 *  - 忽略系统元数据文件（Thumbs.db / desktop.ini / .DS_Store）；
 *  - allowSymlinks=true（读取源 Skill）时跳过内部符号链接，防止循环或越界读取；
 *  - allowSymlinks=false（校验 Agent 副本）时一旦发现内部符号链接或非常规文件即判定无效；
 *  - 汇总所有子目录与常规文件的相对路径和内容摘要，排序后求整体 SHA-256。
 *
 * @param {string} rootDir - 待检查的目录
 * @param {{allowSymlinks?: boolean}} [options]
 * @returns {Promise<{valid: boolean, hasSkillMd?: boolean, hash?: string, skippedSymlinks?: number, reason?: string}>}
 */
async function inspectDirectoryTree(rootDir, { allowSymlinks = false } = {}) {
  const rootStat = await withTimeout(
    fs.promises.lstat(rootDir),
    `检查目录 ${rootDir}`,
  );
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { valid: false, reason: "目标不是普通文件夹" };
  }

  const records = [];
  let hasSkillMd = false;
  let skippedSymlinks = 0;

  async function walk(currentDir, relativePrefix) {
    const names = await withTimeout(
      fs.promises.readdir(currentDir),
      `读取目录 ${currentDir}`,
    );
    for (const name of names) {
      const fullPath = path.join(currentDir, name);
      const stat = await withTimeout(
        fs.promises.lstat(fullPath),
        `检查条目 ${fullPath}`,
      );
      if (stat.isSymbolicLink()) {
        if (allowSymlinks) {
          skippedSymlinks += 1;
          continue;
        }
        return { valid: false, reason: "目录内包含符号链接" };
      }
      if (stat.isFile()) {
        if (isIgnoredOsFile(name)) continue;
        if (!relativePrefix && name.toLowerCase() === "skill.md")
          hasSkillMd = true;
        const relPath = relativePrefix ? `${relativePrefix}/${name}` : name;
        const digest = await hashFile(fullPath);
        records.push(`F:${relPath}:${digest}`);
        continue;
      }
      if (stat.isDirectory()) {
        const relPath = relativePrefix ? `${relativePrefix}/${name}` : name;
        records.push(`D:${relPath}`);
        const nested = await walk(fullPath, relPath);
        if (nested) return nested;
        continue;
      }
      if (!allowSymlinks) {
        return { valid: false, reason: "目录内包含非常规文件" };
      }
    }
    return null;
  }

  const invalid = await walk(rootDir, "");
  if (invalid) return invalid;

  records.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash("sha256").update(records.join("\n")).digest("hex");
  return { valid: true, hasSkillMd, hash, skippedSymlinks };
}

/**
 * 递归复制 Skill 目录到目标路径（仅复制真实子目录与常规文件，忽略系统元数据与符号链接）。
 *
 * @param {string} sourceDir - 仓库中的 Skill 源目录
 * @param {string} targetDir - 目标暂存目录
 * @returns {Promise<{skippedSymlinks: number}>}
 */
async function copyDirectoryTree(sourceDir, targetDir) {
  await withTimeout(
    fs.promises.mkdir(targetDir, { recursive: true }),
    `创建目录 ${targetDir}`,
  );
  let skippedSymlinks = 0;

  async function copyLevel(currentSource, currentTarget) {
    const names = await withTimeout(
      fs.promises.readdir(currentSource),
      `读取目录 ${currentSource}`,
    );
    for (const name of names) {
      const srcPath = path.join(currentSource, name);
      const dstPath = path.join(currentTarget, name);
      const stat = await withTimeout(
        fs.promises.lstat(srcPath),
        `检查条目 ${srcPath}`,
      );
      if (stat.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (stat.isFile()) {
        if (isIgnoredOsFile(name)) continue;
        await withTimeout(
          fs.promises.copyFile(srcPath, dstPath),
          `复制文件 ${srcPath}`,
        );
        continue;
      }
      if (stat.isDirectory()) {
        await withTimeout(
          fs.promises.mkdir(dstPath, { recursive: true }),
          `创建目录 ${dstPath}`,
        );
        await copyLevel(srcPath, dstPath);
      }
    }
  }

  await copyLevel(sourceDir, targetDir);
  return { skippedSymlinks };
}

/**
 * 安全递归删除目录：基于 lstat 逐层清理，绝不跟随符号链接。
 * Windows 上复制只读文件会保留只读属性，unlink 报 EPERM / EACCES 时先放开写权限再重试。
 *
 * @param {string} targetPath - 待删除的路径
 * @returns {Promise<void>}
 */
async function removeDirectorySafe(targetPath) {
  let stat;
  try {
    stat = await withTimeout(
      fs.promises.lstat(targetPath),
      `检查待删除路径 ${targetPath}`,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    try {
      await fs.promises.unlink(targetPath);
    } catch (error) {
      if (["EPERM", "EACCES", "EISDIR"].includes(error?.code)) {
        await fs.promises.rmdir(targetPath);
        return;
      }
      throw error;
    }
    return;
  }
  if (!stat.isDirectory()) {
    try {
      await fs.promises.unlink(targetPath);
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        await fs.promises.chmod(targetPath, 0o666).catch(() => undefined);
        await fs.promises.unlink(targetPath);
        return;
      }
      throw error;
    }
    return;
  }
  const names = await withTimeout(
    fs.promises.readdir(targetPath),
    `读取待删除目录 ${targetPath}`,
  );
  for (const name of names) {
    await removeDirectorySafe(path.join(targetPath, name));
  }
  try {
    await fs.promises.rmdir(targetPath);
  } catch (error) {
    if (["EPERM", "EACCES"].includes(error?.code)) {
      await fs.promises.chmod(targetPath, 0o777).catch(() => undefined);
      await fs.promises.rmdir(targetPath);
      return;
    }
    throw error;
  }
}

/**
 * 校验 Agent 目录中的目标路径是否为可安全删除 / 替换的受管副本。
 *
 * 必须同时满足：
 *  1. 是真实目录（非文件、非符号链接）；
 *  2. 顶层包含常规文件 SKILL.md（大小写不敏感）且目录内无符号链接；
 *  3. 完整目录树指纹与「复制时快照指纹」或「当前仓库源 Skill」一致。
 *
 * @param {string} targetPath - Agent 目录中的 Skill 路径
 * @param {{storedHash?: string, sourcePath?: string}} [options]
 * @returns {Promise<{status: 'missing'|'match'|'not-directory'|'mismatch'|'error', hash?: string, reason?: string}>}
 */
async function verifyManagedCopy(
  targetPath,
  { storedHash = "", sourcePath = "" } = {},
) {
  const entry = await inspectEntryKind(targetPath);
  if (entry.kind === "missing") return { status: "missing" };
  if (entry.kind === "error") {
    return {
      status: "error",
      reason: `无法检查目录：${errorMessage(entry.error)}`,
    };
  }
  if (entry.kind === "symlink") {
    return {
      status: "not-directory",
      reason: "目标位置是符号链接而非复制的目录",
    };
  }
  if (entry.kind === "file") {
    return {
      status: "not-directory",
      reason: "目标位置是普通文件而非复制的目录",
    };
  }

  let copyTree;
  try {
    copyTree = await inspectDirectoryTree(targetPath, { allowSymlinks: false });
  } catch (error) {
    return {
      status: "error",
      reason: `无法读取目录内容：${errorMessage(error)}`,
    };
  }
  if (!copyTree.valid) {
    return { status: "mismatch", reason: copyTree.reason };
  }
  if (!copyTree.hasSkillMd) {
    return { status: "mismatch", reason: "目录中缺少 SKILL.md 文件" };
  }
  if (storedHash && copyTree.hash === storedHash) {
    return { status: "match", hash: copyTree.hash };
  }
  if (sourcePath) {
    try {
      const sourceTree = await inspectDirectoryTree(sourcePath, {
        allowSymlinks: true,
      });
      if (
        sourceTree.valid &&
        sourceTree.hasSkillMd &&
        copyTree.hash === sourceTree.hash
      ) {
        return { status: "match", hash: copyTree.hash };
      }
    } catch (_) {
      // 源目录不存在或无法读取时回退为不匹配，由上层保守保留副本。
    }
  }
  return {
    status: "mismatch",
    reason: "目录内容与原 Skill 不一致（可能已被修改）",
  };
}

/**
 * 将仓库中的 Skill 源目录先复制到 Agent 目录下的临时暂存目录并计算指纹。
 * 调用方负责在失败时清理或成功后重命名。
 *
 * @param {string} sourcePath - Skill 源目录
 * @param {string} agentDir - Agent 目标目录
 * @returns {Promise<{tempDir: string, hash: string, skippedSymlinks: number}>}
 */
async function stageSkillCopy(sourcePath, agentDir) {
  let sourceTree;
  try {
    sourceTree = await inspectDirectoryTree(sourcePath, { allowSymlinks: true });
  } catch (error) {
    throw new Error(`源目录不存在或无法访问 ${sourcePath}（${errorMessage(error)}）`);
  }
  if (!sourceTree.valid) {
    throw new Error(`源目录无效 ${sourcePath}（${sourceTree.reason}）`);
  }
  if (!sourceTree.hasSkillMd) {
    throw new Error(`源目录缺少 SKILL.md ${sourcePath}`);
  }

  const tempDir = path.join(agentDir, `${STAGING_PREFIX}${randomUUID()}`);
  try {
    const { skippedSymlinks } = await copyDirectoryTree(sourcePath, tempDir);
    const stagedTree = await inspectDirectoryTree(tempDir, {
      allowSymlinks: false,
    });
    if (!stagedTree.valid || !stagedTree.hasSkillMd) {
      throw new Error("复制结果校验未通过");
    }
    return { tempDir, hash: stagedTree.hash, skippedSymlinks };
  } catch (error) {
    await removeDirectorySafe(tempDir).catch(() => undefined);
    throw error;
  }
}

/**
 * 生成冲突条目的中文类型名。
 *
 * @param {'directory'|'file'|'symlink'|'error'} kind - 条目类型
 * @returns {string}
 */
function conflictKindLabel(kind) {
  if (kind === "directory") return "目录";
  if (kind === "file") return "文件";
  if (kind === "symlink") return "符号链接";
  return "内容";
}

/**
 * 同步一个「直接复制」模式 Agent 的 Skills 副本。
 *
 * @param {object} options - 同步参数
 * @param {Array<{id: string, name: string, sourcePath: string}>} options.skills - 当前可用 Skills
 * @param {{id: string, name: string, directory: string, syncMode: string}} options.agent - 目标 Agent
 * @param {string[]} options.enabledSkillIds - 期望启用的 Skill id 列表
 * @param {string[]} [options.previousEnabledSkillIds] - 操作前已启用的 Skill id 列表（目录不可用时用于回退）
 * @param {Record<string, string>} [options.copiedSkills] - 本插件记录的已复制指纹（skillId → hash）
 * @param {boolean} [options.updateExisting] - 为 true 时（刷新仓库），自动同步更新未被用户改动的副本
 * @returns {Promise<{enabledSkillIds: string[], copiedSkills: Record<string, string>, issues: Array}>}
 */
async function syncAgentCopies({
  skills,
  agent,
  enabledSkillIds,
  previousEnabledSkillIds = [],
  copiedSkills = {},
  updateExisting = false,
}) {
  const issues = [];
  const directory = agent.directory;

  try {
    const stat = await withTimeout(
      fs.promises.stat(directory),
      `检查 Agent“${agent.name}”目录`,
    );
    if (!stat.isDirectory()) throw new Error("该路径不是文件夹");
    await withTimeout(
      fs.promises.readdir(directory),
      `读取 Agent“${agent.name}”目录`,
    );
  } catch (error) {
    return {
      enabledSkillIds: [...previousEnabledSkillIds],
      copiedSkills: { ...copiedSkills },
      issues: [
        createIssue(
          "error",
          `Agent“${agent.name}”的 Skills 目录不可用：${errorMessage(error)}。未复制或删除任何内容。`,
        ),
      ],
    };
  }

  const desiredSet = new Set(enabledSkillIds);
  const nextEnabled = new Set(enabledSkillIds);
  const nextCopied = { ...copiedSkills };
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));

  // 第一轮：清理已取消启用（或已从仓库移除）的受管副本；仅处理 copiedSkills 中记录的项。
  for (const [skillId, storedHash] of Object.entries(copiedSkills)) {
    if (desiredSet.has(skillId)) continue;
    const targetPath = path.join(directory, skillId);
    const sourcePath = skillById.get(skillId)?.sourcePath || "";
    const check = await verifyManagedCopy(targetPath, {
      storedHash,
      sourcePath,
    });
    if (check.status === "missing") {
      delete nextCopied[skillId];
      continue;
    }
    if (check.status === "match") {
      try {
        await removeDirectorySafe(targetPath);
        delete nextCopied[skillId];
      } catch (error) {
        issues.push(
          createIssue(
            "warning",
            `无法删除 Agent“${agent.name}”目录中的 Skill 副本 ${targetPath}：${errorMessage(error)}`,
          ),
        );
      }
      continue;
    }
    // 校验不通过：保留磁盘内容不删除，并停止托管该副本。
    delete nextCopied[skillId];
    issues.push(
      createIssue(
        "warning",
        `已保留 Agent“${agent.name}”中的“${skillId}”：${check.reason}，未自动删除；若不再需要请手动清理。`,
      ),
    );
  }

  // 第二轮：处理期望启用的 Skills（新复制、冲突回退、以及刷新时的安全同步更新）。
  const desiredSkills = skills.filter((skill) => desiredSet.has(skill.id));
  for (const skill of desiredSkills) {
    const targetPath = path.join(directory, skill.id);
    const storedHash = nextCopied[skill.id] || "";
    const entry = await inspectEntryKind(targetPath);

    if (entry.kind === "error") {
      if (!storedHash) nextEnabled.delete(skill.id);
      issues.push(
        createIssue(
          "error",
          `无法检查“${skill.name}”的目标位置 ${targetPath}：${errorMessage(entry.error)}`,
        ),
      );
      continue;
    }

    if (entry.kind === "missing") {
      let staged;
      try {
        staged = await stageSkillCopy(skill.sourcePath, directory);
        await withTimeout(
          fs.promises.rename(staged.tempDir, targetPath),
          `写入 Skill 副本 ${targetPath}`,
        );
        nextCopied[skill.id] = staged.hash;
        if (staged.skippedSymlinks > 0) {
          issues.push(
            createIssue(
              "info",
              `“${skill.name}”源目录内包含 ${staged.skippedSymlinks} 个符号链接，复制时已跳过。`,
            ),
          );
        }
      } catch (error) {
        if (staged?.tempDir) {
          await removeDirectorySafe(staged.tempDir).catch(() => undefined);
        }
        nextEnabled.delete(skill.id);
        delete nextCopied[skill.id];
        issues.push(
          createIssue(
            "error",
            `“${skill.name}”无法复制，已回退添加：${errorMessage(error)}`,
          ),
        );
      }
      continue;
    }

    // 目标已存在且并非本插件记录的副本：同名冲突，绝不覆盖并回退添加该 Skill。
    if (!storedHash) {
      nextEnabled.delete(skill.id);
      issues.push(
        createIssue(
          "warning",
          `“${skill.name}”无法复制：目标位置已有同名的${conflictKindLabel(entry.kind)} ${targetPath}，已保留原内容并回退添加该 Skill。`,
        ),
      );
      continue;
    }

    // 已启用且已被跟踪的副本：常规开关操作不动它；仓库重新扫描时检查类型并按安全规则同步更新。
    if (!updateExisting) continue;

    if (entry.kind !== "directory") {
      issues.push(
        createIssue(
          "warning",
          `Agent“${agent.name}”中的“${skill.name}”副本已被替换为${conflictKindLabel(entry.kind)} ${targetPath}，已保留原内容未自动覆盖。`,
        ),
      );
      continue;
    }

    let sourceTree;
    try {
      sourceTree = await inspectDirectoryTree(skill.sourcePath, {
        allowSymlinks: true,
      });
    } catch (error) {
      issues.push(
        createIssue(
          "error",
          `无法读取“${skill.name}”源目录 ${skill.sourcePath}：${errorMessage(error)}`,
        ),
      );
      continue;
    }
    if (!sourceTree.valid || !sourceTree.hasSkillMd) continue;
    if (sourceTree.hash === storedHash) continue;

    // 仓库源 Skill 已更新：仅当副本仍含 SKILL.md 且与上次复制快照完全一致时才覆盖更新。
    const check = await verifyManagedCopy(targetPath, {
      storedHash,
      sourcePath: "",
    });
    if (check.status !== "match") {
      issues.push(
        createIssue(
          "warning",
          `Agent“${agent.name}”中的“${skill.name}”副本未自动覆盖更新（${check.reason}），已保留本地内容。`,
        ),
      );
      continue;
    }

    // 安全替换：先将旧副本改名为同目录备份，再将新暂存目录改名就位；
    // 若新副本就位失败立即恢复备份，确保不会出现“旧删新无”的丢失窗口。
    let staged;
    const backupDir = path.join(directory, `${STAGING_PREFIX}bak-${randomUUID()}`);
    let movedOldToBackup = false;
    try {
      staged = await stageSkillCopy(skill.sourcePath, directory);
      await withTimeout(
        fs.promises.rename(targetPath, backupDir),
        `备份旧 Skill 副本 ${targetPath}`,
      );
      movedOldToBackup = true;
      await withTimeout(
        fs.promises.rename(staged.tempDir, targetPath),
        `更新 Skill 副本 ${targetPath}`,
      );
      nextCopied[skill.id] = staged.hash;
      if (staged.skippedSymlinks > 0) {
        issues.push(
          createIssue(
            "info",
            `“${skill.name}”源目录内包含 ${staged.skippedSymlinks} 个符号链接，复制时已跳过。`,
          ),
        );
      }
      await removeDirectorySafe(backupDir).catch(() => undefined);
    } catch (error) {
      if (movedOldToBackup) {
        await fs.promises.rename(backupDir, targetPath).catch(() => undefined);
      }
      if (staged?.tempDir) {
        await removeDirectorySafe(staged.tempDir).catch(() => undefined);
      }
      issues.push(
        createIssue(
          "error",
          `更新 Agent“${agent.name}”中的“${skill.name}”副本失败：${errorMessage(error)}`,
        ),
      );
    }
  }

  return {
    enabledSkillIds: enabledSkillIds.filter((id) => nextEnabled.has(id)),
    copiedSkills: nextCopied,
    issues: uniqueIssues(issues),
  };
}

/**
 * 清理「直接复制」模式 Agent 目录中由本插件复制且未被修改的副本。
 * 用于删除 Agent、切换仓库与清除数据；仅检查 copiedSkills 中的记录，
 * 通过 SKILL.md + 内容一致性校验才删除，其余保留并提示警告。
 *
 * @param {{id: string, name: string, directory: string}} agent - 目标 Agent
 * @param {{skills?: Array<{id: string, sourcePath: string}>, copiedSkills?: Record<string, string>}} [options]
 * @returns {Promise<{issues: Array}>}
 */
async function removeManagedCopies(
  agent,
  { skills = [], copiedSkills = {} } = {},
) {
  const issues = [];
  const entries = Object.entries(copiedSkills || {});
  if (!entries.length) return { remainingCopiedSkills: {}, issues };

  try {
    await withTimeout(
      fs.promises.readdir(agent.directory),
      `读取 Agent“${agent.name}”目录`,
    );
  } catch (error) {
    if (error?.code === "ENOENT") return { remainingCopiedSkills: {}, issues: [] };
    return {
      remainingCopiedSkills: { ...copiedSkills },
      issues: [
        createIssue(
          "error",
          `无法读取 Agent“${agent.name}”的 Skills 目录：${errorMessage(error)}，其副本未清理。`,
        ),
      ],
    };
  }

  const remainingCopiedSkills = {};
  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  for (const [skillId, storedHash] of entries) {
    const targetPath = path.join(agent.directory, skillId);
    const sourcePath = skillById.get(skillId)?.sourcePath || "";
    const check = await verifyManagedCopy(targetPath, {
      storedHash,
      sourcePath,
    });
    if (check.status === "missing") continue;
    if (check.status === "match") {
      try {
        await removeDirectorySafe(targetPath);
      } catch (error) {
        // 删除失败时保留该条指纹记录，便于切换仓库等场景后续重试清理。
        remainingCopiedSkills[skillId] = storedHash;
        issues.push(
          createIssue(
            "warning",
            `无法删除 Agent“${agent.name}”目录中的 Skill 副本 ${targetPath}：${errorMessage(error)}`,
          ),
        );
      }
      continue;
    }
    issues.push(
      createIssue(
        "warning",
        `已保留 Agent“${agent.name}”中的“${skillId}”：${check.reason}，未自动删除。`,
      ),
    );
  }

  return { remainingCopiedSkills, issues: uniqueIssues(issues) };
}

module.exports = { removeManagedCopies, syncAgentCopies };
