/** Agent 链接管理器：检查归属、创建/删除受管链接，并审计外部链接。 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const {
  createIssue,
  errorMessage,
  mapWithConcurrency,
  pathExists,
  uniqueIssues,
  withReadTimeout,
} = require("./runtime");
const { comparablePath, pathsEqual } = require("./path-safety");

const READ_VALIDATION_CONCURRENCY = 8;
const MAX_LINK_AUDIT_ENTRIES = 500;
const MAX_LINK_AUDIT_DURATION_MS = 10_000;

function createLinkManager({
  hasValidSkillFile,
  normalizeManagedLinks,
  writeConfig,
}) {
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
      // 路径不存在属于正常情况（尚未创建链接）。
      if (error.code === "ENOENT") return { kind: "missing" };
      return { kind: "error", error };
    }
    // 不是符号链接：可能是用户自己创建的目录或文件，必须保留。
    if (!stat.isSymbolicLink())
      return { kind: stat.isDirectory() ? "directory" : "file" };
    try {
      const rawTarget = await withReadTimeout(
        fsp.readlink(linkPath),
        `读取链接 ${linkPath}`,
      );
      // 相对目标的链接需要基于链接所在目录解析成绝对路径。
      const targetPath = path.isAbsolute(rawTarget)
        ? rawTarget
        : path.resolve(path.dirname(linkPath), rawTarget);
      return {
        kind: "link",
        targetPath,
        // 目标是否与期望的仓库源目录一致（不一致说明链接已被外部改写）。
        sameTarget: expectedSource
          ? await pathsEqual(targetPath, expectedSource)
          : false,
        // 目标不存在说明该链接已失效。
        dangling: !(await pathExists(targetPath)),
        // 文件标识：用于确认链接未被「删除后重建」。
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
   * @returns {boolean} 是否仍归本应用管理（无历史记录时按兼容处理返回 true）
   */
  // 只有路径、目标和创建时文件标识都匹配，才认定链接仍归本应用管理。
  function identitiesEqual(stored, current) {
    if (!stored) return true;
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
    // 记录不完整视作放弃管理，不做任何文件操作。
    if (!link?.linkPath || !link?.sourcePath)
      return { removed: false, relinquished: true, issues: [] };
    // 路径不在允许目录内：仅提示，绝不删除。
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
    // 已经不存在：视为管理结束，无需提示。
    if (inspected.kind === "missing")
      return { removed: false, relinquished: true, issues: [] };
    // 检查失败（权限等）：保留记录，下次再试。
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
    // 不是链接、目标被改写或文件标识不符 → 已非本应用创建，停止管理并保留现场。
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
      // 仅删除链接本身，不会影响链接指向的源目录内容。
      await fsp.unlink(link.linkPath);
      return { removed: true, relinquished: true, issues: [] };
    } catch (error) {
      // 删除失败（如被占用）：保留记录，返回可重试状态。
      return {
        removed: false,
        relinquished: false,
        issues: [
          createIssue("error", `无法移除${label}：${errorMessage(error)}`),
        ],
      };
    }
  }

  /**
   * 为「目标位置已被占用」的冲突生成用户可读的说明文案。
   *
   * @param {{name: string}} skill - Skill 信息
   * @param {string} linkPath - 期望创建的链接路径
   * @param {{kind: string, dangling?: boolean}} inspected - inspectLink 的检查结果
   * @returns {string} 冲突说明
   */
  function describeConflict(skill, linkPath, inspected) {
    if (inspected.kind === "directory")
      return `“${skill.name}”无法链接：目标位置已有普通目录 ${linkPath}，已保留原目录。`;
    if (inspected.kind === "file")
      return `“${skill.name}”无法链接：目标位置已有文件 ${linkPath}，已保留原文件。`;
    if (inspected.kind === "error")
      return `“${skill.name}”无法检查目标位置 ${linkPath}：${errorMessage(inspected.error)}`;
    if (inspected.kind === "link" && inspected.dangling)
      return `“${skill.name}”无法链接：目标位置已有失效的手动链接 ${linkPath}，请手动处理后重试。`;
    return `“${skill.name}”无法链接：目标位置已有指向其他位置的手动链接 ${linkPath}，已保留原链接。`;
  }

  /**
   * 审计 Agent 目录中「不受本应用管理」的符号链接，仅生成提示、不修改文件。
   * 这样既能让用户知道目录里存在的异常链接，也不会误删他人创建的内容。
   *
   * @param {{name: string, directory: string}} agent - Agent 信息
   * @param {Set<string>} knownPaths - 本应用已知的链接路径（comparablePath 形式）
   * @returns {Array} 问题列表
   */
  async function auditUnmanagedLinks(agent, knownPaths) {
    const issues = [];
    let entries;
    try {
      entries = await withReadTimeout(
        fsp.readdir(agent.directory, { withFileTypes: true }),
        `检查 Agent“${agent.name}”目录`,
      );
    } catch (error) {
      return [
        createIssue(
          "error",
          `无法检查 Agent“${agent.name}”目录：${errorMessage(error)}`,
        ),
      ];
    }
    const externalLinks = entries
      .filter((item) => item.isSymbolicLink())
      .filter(
        (entry) =>
          !knownPaths.has(
            comparablePath(path.join(agent.directory, entry.name)),
          ),
      );
    if (externalLinks.length > MAX_LINK_AUDIT_ENTRIES) {
      issues.push(
        createIssue(
          "warning",
          `Agent“${agent.name}”中的手动链接超过 ${MAX_LINK_AUDIT_ENTRIES} 个，本轮只检查前 ${MAX_LINK_AUDIT_ENTRIES} 个。`,
        ),
      );
    }
    try {
      const results = await withReadTimeout(
        mapWithConcurrency(
          externalLinks.slice(0, MAX_LINK_AUDIT_ENTRIES),
          READ_VALIDATION_CONCURRENCY,
          async (entry) => {
            const linkPath = path.join(agent.directory, entry.name);
            const inspected = await inspectLink(linkPath);
            if (
              inspected.kind !== "link" ||
              inspected.dangling ||
              !(await hasValidSkillFile(inspected.targetPath))
            )
              return createIssue(
                "warning",
                `Agent“${agent.name}”中发现非 Skill 或失效的手动链接 ${linkPath}，已忽略并保留。`,
              );
            return null;
          },
        ),
        `审计 Agent“${agent.name}”的手动链接`,
        MAX_LINK_AUDIT_DURATION_MS,
      );
      issues.push(...results.filter(Boolean));
    } catch (error) {
      issues.push(
        createIssue(
          "warning",
          `Agent“${agent.name}”的手动链接审计未完成：${errorMessage(error)}。本轮未处理这些外部链接。`,
        ),
      );
    }
    return issues;
  }

  // ============================================================================
  // 五、单个 Agent 的链接同步
  // ============================================================================

  /**
   * 同步一个 Agent 目录下的 Skills 链接，使其与「已启用 Skills」一致。
   *
   * 执行顺序：
   *  1. 读取该 Agent 已启用的 Skill 集合；
   *  2. 检查目标目录是否可用，不可用则直接返回且不改动任何文件；
   *  3. 只读保护（scan.locked）时仅观察现有链接，不做任何增删；
   *  4. 逐条处理历史受管链接：仍需要且仍然有效的保留，否则安全移除；
   *  5. 为缺失的 Skill 创建链接；目标已存在时按冲突处理（提示并保留）；
   *  6. 审计不受管的外部链接并汇总问题。
   *
   * @param {object} config - 当前配置（会就地更新该 Agent 的 managedLinks）
   * @param {{id: string, name: string, directory: string, managedLinks: object}} agent - 目标 Agent
   * @param {{skills: Array, complete: boolean, locked?: boolean}} scan - 仓库扫描结果
   * @returns {{linked: Array, external: Array, createdLinks: Array, issues: Array}} 本次同步结果
   */
  // 同步遵循“只删除自己创建的链接”原则，任何手动文件、目录和链接都只提示不改动。
  async function syncAgent(
    config,
    agent,
    scan,
    { auditExternalLinks = true } = {},
  ) {
    const issues = [];
    // 单个 Skill 集合是唯一同步依据；分组仅作为界面上的批量选择器。
    const desiredSkillIds = new Set(config.enabledSkills[agent.id] || []);
    // 用 id 索引扫描结果，便于判断某个 skillId 是否仍然存在。
    const skillById = new Map(scan.skills.map((skill) => [skill.id, skill]));
    // 历史受管链接（已规范化）。
    const previousLinks = normalizeManagedLinks(agent.managedLinks);
    // 下一轮要写入数据库的受管链接。
    const nextLinks = {};
    // 已确认存在、可用的链接对应 Skill id。
    const linked = [];
    // 由外部预先存在、被直接沿用的同源链接对应 Skill id（本应用不删除它们）。
    const external = [];
    // 本次新建的链接记录，数据库保存失败时用于回滚。
    const createdLinks = [];
    // 所有返回分支都走 finish()：统一刷新本机外部链接计数并去重问题列表，避免遗漏或重复提示。
    const finish = () => {
      agent.externalLinkedCount = external.length;
      return {
        linked,
        external,
        createdLinks,
        issues: uniqueIssues(issues),
      };
    };

    // 同步配置可能先于本机路径同步到新设备；未配置目录时保持只读，不猜测其他设备的路径。
    if (!agent.directory) {
      issues.push(
        createIssue(
          "warning",
          `Agent“${agent.name}”尚未在当前设备配置 Skills 目录，已跳过链接同步。`,
        ),
      );
      agent.managedLinks = previousLinks;
      return finish();
    }

    // 先确认目标目录真的可用（存在且为目录）：不可用时直接返回且不改动任何文件，
    // 避免在错误位置创建链接，或把已拔掉的移动硬盘当成“Agent 目录被删除”。
    let targetUsable = true;
    try {
      const stat = await withReadTimeout(
        fsp.stat(agent.directory),
        `检查 Agent“${agent.name}”目录`,
      );
      if (!stat.isDirectory()) throw new Error("该路径不是文件夹");
    } catch (error) {
      // 目录不可用（被删除、无权限、不是目录）：不改动任何文件，直接返回。
      targetUsable = false;
      issues.push(
        createIssue(
          "error",
          `Agent“${agent.name}”的 Skills 目录不可用：${errorMessage(error)}。未创建或删除任何链接。`,
        ),
      );
    }
    if (!targetUsable) {
      // 保持原记录不变，等待目录恢复后继续管理。
      agent.managedLinks = previousLinks;
      return finish();
    }
    // 数据库关键结构异常时只做观察，不根据兜底后的空值改动任何文件。
    if (scan.locked) {
      for (const [skillId, link] of Object.entries(previousLinks)) {
        // 仅统计确实仍指向原目标、且文件标识一致的链接。
        if (!(await isDirectChild(agent.directory, link.linkPath))) continue;
        const inspected = await inspectLink(link.linkPath, link.sourcePath);
        if (
          inspected.kind === "link" &&
          inspected.sameTarget &&
          identitiesEqual(link.identity, inspected.identity)
        )
          linked.push(skillId);
      }
      agent.managedLinks = previousLinks;
      // 已知路径用于排除自身管理的链接，避免误报。
      const knownPaths = new Set(
        Object.values(previousLinks).map((link) =>
          comparablePath(link.linkPath),
        ),
      );
      issues.push(...(await auditUnmanagedLinks(agent, knownPaths)));
      return finish();
    }

    // 处理历史受管链接：保留仍然需要的，安全移除不再需要的。
    for (const [skillId, link] of Object.entries(previousLinks)) {
      const skill = skillById.get(skillId);
      // 记录位置异常（不在 Agent 目录第一层）：仅提示，绝不删除。
      if (!(await isDirectChild(agent.directory, link.linkPath))) {
        issues.push(
          createIssue(
            "warning",
            `Agent“${agent.name}”存在超出其 Skills 目录的异常受管记录，已停止管理且不会删除该路径：${link.linkPath}`,
          ),
        );
        continue;
      }
      // 扫描不完整时，无法确认 Skill 是否真的被删除，因此保留仍被启用的受管链接。
      const shouldKeep =
        desiredSkillIds.has(skillId) && (skill || !scan.complete);
      // 源目录以当前扫描结果为准，扫描不到时回退到历史记录。
      const currentSource = skill?.sourcePath || link.sourcePath;
      const inspected = await inspectLink(link.linkPath, link.sourcePath);
      // 仍是同一链接（类型、目标、文件标识都匹配）才算「仍归本应用所有」。
      const stillOwned =
        inspected.kind === "link" &&
        inspected.sameTarget &&
        identitiesEqual(link.identity, inspected.identity);
      // 需要保留且源目录未变化：直接沿用，无需改动。
      if (
        shouldKeep &&
        stillOwned &&
        (await pathsEqual(link.sourcePath, currentSource))
      ) {
        // “待创建”记录说明上次可能在创建后中断；确认链接存在后补齐身份并转为正式记录。
        nextLinks[skillId] = link.pending
          ? {
              linkPath: link.linkPath,
              sourcePath: link.sourcePath,
              identity: inspected.identity,
            }
          : link;
        linked.push(skillId);
        continue;
      }
      // 扫描不完整且链接仍归本应用所有：宁可保留，等下次完整扫描再处理。
      if (shouldKeep && !scan.complete && stillOwned) {
        nextLinks[skillId] = link;
        linked.push(skillId);
        continue;
      }
      // 其余情况执行安全移除（内部会再次校验，只有确认归本应用所有才会真正删除）。
      const removal = await removeOwnedLink(
        link,
        `Agent“${agent.name}”中的受管链接 ${link.linkPath}`,
        agent.directory,
      );
      issues.push(...removal.issues);
      // 未放弃管理的记录需要保留，便于下次重试。
      if (!removal.relinquished) nextLinks[skillId] = link;
      // 扫描完整且 Skill 确实已不存在，且链接已被删除 → 提示信息级通知。
      if (scan.complete && !skill && removal.removed) {
        issues.push(
          createIssue(
            "info",
            `Skill“${skillId}”已不在主仓库中，对应的受管链接已移除。`,
          ),
        );
      }
    }

    const desiredSkills = [...desiredSkillIds]
      .map((skillId) => skillById.get(skillId))
      .filter(Boolean);
    // 统计同名目录数量：链接名使用目录名，同名会互相覆盖，需要提前拦截。
    const folderCounts = desiredSkills.reduce(
      (counts, skill) =>
        counts.set(skill.folderName, (counts.get(skill.folderName) || 0) + 1),
      new Map(),
    );
    // 先完成只读冲突检查，再把本轮全部待创建记录一次性落库，避免每个 Skill 重写整份配置。
    const pendingCreations = [];
    for (const skill of desiredSkills) {
      // 已在上一步保留的链接无需重复创建。
      if (nextLinks[skill.id]) continue;
      // 多个启用 Skill 目录名相同：跳过创建，避免覆盖，并提示用户改名。
      if (folderCounts.get(skill.folderName) > 1) {
        issues.push(
          createIssue(
            "error",
            `多个已启用 Skills 使用同一目录名“${skill.folderName}”，为避免覆盖，Agent“${agent.name}”未创建这些链接。`,
          ),
        );
        continue;
      }
      const linkPath = path.join(agent.directory, skill.folderName);
      const inspected = await inspectLink(linkPath, skill.sourcePath);
      // 目标位置已被占用：区分「同源手动链接」「普通文件/目录」「其他链接」分别提示。
      if (inspected.kind !== "missing") {
        if (inspected.kind === "link" && inspected.sameTarget) {
          // 用户自己创建的、指向同一源目录的链接：直接沿用，但不纳入受管（不会被本应用删除）。
          external.push(skill.id);
          issues.push(
            createIssue(
              "info",
              `Agent“${agent.name}”已存在“${skill.name}”的手动同源链接，已直接使用但不会由本应用删除。`,
            ),
          );
        } else {
          issues.push(
            createIssue(
              inspected.kind === "error" ? "error" : "warning",
              describeConflict(skill, linkPath, inspected),
            ),
          );
        }
        continue;
      }
      pendingCreations.push({ skill, linkPath });
    }

    // 批量安全检查点：先把本轮所有待创建链接以 pending 状态写入数据库，再真正创建文件，
    // 即使中途崩溃，下次启动也能根据 pending 记录补齐身份或安全回滚，不产生无法追踪的链接。
    if (pendingCreations.length) {
      pendingCreations.forEach(({ skill, linkPath }) => {
        nextLinks[skill.id] = {
          linkPath,
          sourcePath: skill.sourcePath,
          pending: true,
        };
      });
      agent.managedLinks = nextLinks;
      try {
        // 一次批量安全检查点覆盖本轮所有待创建链接，兼顾崩溃恢复与写入性能。
        writeConfig(config);
      } catch (error) {
        pendingCreations.forEach(({ skill }) => {
          delete nextLinks[skill.id];
        });
        issues.push(
          createIssue(
            "error",
            `创建链接前无法保存批量安全检查点：${error.message}。本轮 ${pendingCreations.length} 个链接均未创建。`,
          ),
        );
        // 清空待创建列表：接下来的创建循环不会再执行，本轮不会创建任何链接。
        pendingCreations.length = 0;
      }
    }

    // 逐个创建链接：单个失败不影响其他 Skill，失败项会先从受管记录里移除后再统一保存。
    for (const { skill, linkPath } of pendingCreations) {
      try {
        // Windows 使用 junction（目录联接，无需管理员权限），其他平台使用目录符号链接。
        await fsp.symlink(
          skill.sourcePath,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        let identity;
        try {
          // 记录文件标识，用于后续判断链接是否被外部替换。
          const created = await withReadTimeout(
            fsp.lstat(linkPath),
            `记录链接标识 ${linkPath}`,
          );
          identity = {
            dev: Number(created.dev),
            ino: Number(created.ino),
            birthtimeMs: Number(created.birthtimeMs),
          };
        } catch (error) {
          // 记录不到标识也不影响使用：后续按「目标一致」继续管理。
          issues.push(
            createIssue(
              "warning",
              `“${skill.name}”链接已创建，但无法记录文件标识：${errorMessage(error)}。后续仍会按链接目标安全管理。`,
            ),
          );
        }
        nextLinks[skill.id] = {
          linkPath,
          sourcePath: skill.sourcePath,
          ...(identity ? { identity } : {}),
        };
        createdLinks.push({ skillId: skill.id, ...nextLinks[skill.id] });
        linked.push(skill.id);
      } catch (error) {
        // 创建失败时从内存移除待创建项；数据库中的检查点会由最终写入清理。
        delete nextLinks[skill.id];
        // 创建失败（权限、占用等）：提示并继续处理其他 Skill。
        issues.push(
          createIssue(
            "error",
            `创建“${skill.name}”链接失败：${errorMessage(error)}`,
          ),
        );
      }
    }

    // 已知路径 = 本轮受管链接 + 期望的链接位置，用于审计外部链接时排除自身。
    const knownPaths = new Set([
      ...Object.values(nextLinks).map((link) => comparablePath(link.linkPath)),
      ...desiredSkills.map((skill) =>
        comparablePath(path.join(agent.directory, skill.folderName)),
      ),
    ]);
    if (auditExternalLinks)
      issues.push(...(await auditUnmanagedLinks(agent, knownPaths)));
    // 就地更新受管链接记录，由调用方统一写回数据库。
    agent.managedLinks = nextLinks;
    return finish();
  }

  /**
   * 依次同步所有 Agent。
   *
   * @param {object} config - 当前配置
   * @param {object} scan - 仓库扫描结果
   * @returns {object} { [agentId]: syncAgent 的返回值 }
   */
  async function syncAllAgents(config, scan) {
    const results = {};
    // 顺序执行可避免多个 Agent 同时冲击磁盘，也让每个批量检查点保持可恢复。
    for (const agent of config.agents) {
      results[agent.id] = await syncAgent(config, agent, scan);
    }
    return results;
  }

  return { removeOwnedLink, syncAgent, syncAllAgents };
}

module.exports = { createLinkManager };
