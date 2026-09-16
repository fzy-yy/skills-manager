/** 检查并安全移除本应用创建的目录链接。 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  createIssue,
  errorMessage,
  pathExists,
  withReadTimeout,
} = require("./runtime");
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
 * 判断受管记录与磁盘现状是否仍指同一条由本应用创建的链接。
 *
 * 这是全项目唯一的归属判定入口：link-manager 的保留/删除、removeOwnedLink 的删除前校验
 * 都必须调用它，避免同一规则在多处各写一份而漂移。
 *
 * 判定条件（全部满足）：现状仍是符号链接、目标与记录的源路径一致，
 * 且记录是创建链接前写入的 pending 检查点，或文件标识与记录完全一致。
 *
 * @param {{identity?: object, pending?: boolean}} record - 受管链接记录
 * @param {{kind: string, sameTarget?: boolean, identity?: object}} inspected - inspectLink 的结果
 * @returns {boolean} 是否仍归本应用管理
 */
function isOwnedLink(record, inspected) {
  if (!record || !inspected) return false;
  if (inspected.kind !== "link" || inspected.sameTarget !== true) return false;
  return (
    record.pending === true ||
    identitiesEqual(record.identity, inspected.identity)
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
 * 尝试把隔离路径恢复回原位置，且不覆盖原位置上可能出现的任何内容。
 *
 * @param {string} quarantinePath - 隔离后的路径
 * @param {string} originalPath - 原路径
 * @returns {{ok: boolean, error?: Error}} 是否恢复成功
 */
async function restoreQuarantinedLink(quarantinePath, originalPath) {
  try {
    await withReadTimeout(
      fsp.lstat(originalPath),
      `检查恢复目标 ${originalPath}`,
    );
    return {
      ok: false,
      error: Object.assign(new Error("原位置已被其他内容占用，未覆盖"), {
        code: "EEXIST",
      }),
    };
  } catch (error) {
    if (error.code !== "ENOENT") return { ok: false, error };
  }
  try {
    await fsp.rename(quarantinePath, originalPath);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * 安全移除一条受管链接。
 *
 * 移除条件（必须全部满足）：路径位于允许目录内、仍是符号链接、目标未变，
 * 且能确认归属——文件标识与创建时一致，或记录本身是创建链接前写入的 pending 检查点。
 * 任一条件不满足都只提示不删除，并把 relinquished 置为 true（表示放弃管理该记录）。
 *
 * 删除采用「同目录随机隔离 → 再次校验 → unlink」：先把目录项原子重命名到同目录随机名，
 * 再对该临时名重新 lstat/readlink 校验归属，通过后才 unlink。
 * 这样即使存在“检查—执行”竞态，被替换后的普通文件也不会被直接删除。
 * 隔离后校验不通过时尝试不覆盖地恢复原位置，绝不 unlink 校验失败的内容。
 *
 * @param {{linkPath: string, sourcePath: string, identity?: object, pending?: boolean}} link - 受管链接记录
 * @param {string} label - 用于提示文案的名称
 * @param {string} [allowedDirectory] - 允许删除的目录（通常是 Agent 目录）
 * @returns {{removed: boolean, relinquished: boolean, issues: Array, remainingLink?: object}}
 *          removed 是否已删除；relinquished 是否已放弃管理（为 false 时调用方应保留记录以便下次重试）；
 *          remainingLink 仅在 relinquished 为 false 且链接已离开原路径时出现，
 *          其 linkPath 是隔离路径，调用方应以它替换记录后继续追踪（而非删除记录）。
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
  if (!isOwnedLink(link, inspected)) {
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

  // 同目录随机隔离：rename 是原子操作，避免“检查后、删除前”目录项被替换。
  const quarantinePath = path.join(
    path.dirname(link.linkPath),
    `.${path.basename(link.linkPath)}.quarantine-${randomUUID()}`,
  );
  try {
    await fsp.rename(link.linkPath, quarantinePath);
  } catch (error) {
    // 隔离失败时绝不直接 unlink 原路径，保留记录等待下次重试。
    return {
      removed: false,
      relinquished: false,
      issues: [
        createIssue(
          "error",
          `无法安全隔离${label}（已保留原内容）：${errorMessage(error)}`,
        ),
      ],
    };
  }

  const quarantined = await inspectLink(quarantinePath, link.sourcePath);
  if (quarantined.kind === "missing")
    return { removed: false, relinquished: true, issues: [] };

  if (quarantined.kind === "error") {
    const restore = await restoreQuarantinedLink(quarantinePath, link.linkPath);
    return {
      removed: false,
      relinquished: false,
      remainingLink: restore.ok ? link : { ...link, linkPath: quarantinePath },
      issues: [
        createIssue(
          "error",
          restore.ok
            ? `隔离后无法复核${label}，已恢复原链接并保留记录供下次重试：${errorMessage(quarantined.error)}`
            : `隔离后无法复核${label}，且无法恢复原位置；内容保留在 ${quarantinePath}：${errorMessage(quarantined.error)}；恢复失败：${errorMessage(restore.error)}`,
        ),
      ],
    };
  }

  if (!isOwnedLink(link, quarantined)) {
    // 隔离后复核发现已不是本应用的链接：尝试不覆盖地恢复，绝不删除复核失败的内容。
    const restore = await restoreQuarantinedLink(quarantinePath, link.linkPath);
    if (restore.ok) {
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
    return {
      removed: false,
      relinquished: false,
      remainingLink: {
        ...link,
        linkPath: quarantinePath,
        identity: quarantined.identity || link.identity,
      },
      issues: [
        createIssue(
          "error",
          `${label}已被外部替换且无法恢复原位置，内容已隔离在 ${quarantinePath}：${errorMessage(restore.error)}`,
        ),
      ],
    };
  }

  try {
    await fsp.unlink(quarantinePath);
    return { removed: true, relinquished: true, issues: [] };
  } catch (error) {
    const restore = await restoreQuarantinedLink(quarantinePath, link.linkPath);
    if (restore.ok) {
      return {
        removed: false,
        relinquished: false,
        remainingLink: link,
        issues: [
          createIssue(
            "error",
            `无法移除${label}，已恢复原链接并保留记录供下次重试：${errorMessage(error)}`,
          ),
        ],
      };
    }
    // 原位置被占用或恢复失败时保留隔离路径，调用方据此继续追踪。
    return {
      removed: false,
      relinquished: false,
      remainingLink: {
        ...link,
        linkPath: quarantinePath,
        identity: quarantined.identity || link.identity,
      },
      issues: [
        createIssue(
          "error",
          `无法移除${label}，且无法恢复原位置；链接已隔离在 ${quarantinePath}：${errorMessage(error)}；恢复失败：${errorMessage(restore.error)}`,
        ),
      ],
    };
  }
}

module.exports = {
  identitiesEqual,
  inspectLink,
  isDirectChild,
  isOwnedLink,
  removeOwnedLink,
};
