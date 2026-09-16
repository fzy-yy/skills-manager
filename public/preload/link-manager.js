/** Agent 链接管理器：检查归属、创建/删除受管链接，并审计外部链接。 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const {
  createIssue,
  errorMessage,
  uniqueIssues,
  withReadTimeout,
} = require("./runtime");
const { pathsEqual, pathsEqualLexical } = require("./path-safety");
const {
  inspectLink,
  isDirectChild,
  isOwnedLink,
  removeOwnedLink,
} = require("./link-ownership");

function createLinkManager({ normalizeManagedLinks, writeConfig }) {
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
   * @returns {{linked: Array, createdLinks: Array, issues: Array}} 本次同步结果
   */
  async function syncAgent(config, agent, scan) {
    const issues = [];
    const desiredSkillIds = new Set(config.enabledSkills[agent.id] || []);
    const skillById = new Map(scan.skills.map((skill) => [skill.id, skill]));
    const previousLinks = normalizeManagedLinks(agent.managedLinks);
    // 使用无原型对象：skillId 取自仓库相对路径，理论上可能是 __proto__ 等特殊键名，
    // 普通对象赋值会改写原型而不是新增记录，导致链接记录静默丢失。
    const nextLinks = Object.create(null);
    const linked = [];
    const createdLinks = [];
    const finish = () => {
      return {
        linked,
        createdLinks,
        issues: uniqueIssues(issues),
      };
    };

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

    let targetUsable = true;
    try {
      const stat = await withReadTimeout(
        fsp.stat(agent.directory),
        `检查 Agent“${agent.name}”目录`,
      );
      if (!stat.isDirectory()) throw new Error("该路径不是文件夹");
    } catch (error) {
      targetUsable = false;
      issues.push(
        createIssue(
          "error",
          `Agent“${agent.name}”的 Skills 目录不可用：${errorMessage(error)}。未创建或删除任何链接。`,
        ),
      );
    }
    if (!targetUsable) {
      agent.managedLinks = previousLinks;
      return finish();
    }
    if (scan.locked) {
      for (const [skillId, link] of Object.entries(previousLinks)) {
        if (!(await isDirectChild(agent.directory, link.linkPath))) continue;
        const inspected = await inspectLink(link.linkPath, link.sourcePath);
        if (isOwnedLink(link, inspected)) linked.push(skillId);
      }
      agent.managedLinks = previousLinks;
      return finish();
    }

    for (const [skillId, link] of Object.entries(previousLinks)) {
      const skill = skillById.get(skillId);
      if (!(await isDirectChild(agent.directory, link.linkPath))) {
        issues.push(
          createIssue(
            "warning",
            `Agent“${agent.name}”存在超出其 Skills 目录的异常受管记录，已停止管理且不会删除该路径：${link.linkPath}`,
          ),
        );
        continue;
      }
      const inspected = await inspectLink(link.linkPath, link.sourcePath);
      // pending 记录是本应用在创建链接之前写入的检查点，路径仍是同源链接即可确认归属；
      // 其他记录必须文件标识完全一致，才能证明仍是本应用创建的那条链接。
      const stillOwned = isOwnedLink(link, inspected);
      const expectedLinkPath = skill
        ? path.join(agent.directory, skill.folderName)
        : "";
      // 保留条件：仍然启用、链接仍归本应用，且扫描结果足以支持保留——
      //  - 扫描完整时，Skill 必须仍在仓库中且源路径未变（变了就重建指向新路径的链接）；
      //  - 扫描不完整时，不冒险重建，直接保留现有链接与指向。
      const keep =
        desiredSkillIds.has(skillId) &&
        stillOwned &&
        (!skill || pathsEqualLexical(link.linkPath, expectedLinkPath)) &&
        (skill || !scan.complete) &&
        (scan.complete
          ? await pathsEqual(link.sourcePath, skill.sourcePath)
          : true);
      if (keep) {
        // pending 记录在这里补记文件标识，避免长期停留在「归属待确认」状态。
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
      const removal = await removeOwnedLink(
        link,
        `Agent“${agent.name}”中的受管链接 ${link.linkPath}`,
        agent.directory,
      );
      issues.push(...removal.issues);
      // 未放弃管理时保留记录；若链接已被隔离到随机路径，则改用隔离路径继续追踪。
      if (!removal.relinquished)
        nextLinks[skillId] = removal.remainingLink || link;
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
    const folderCounts = desiredSkills.reduce(
      (counts, skill) =>
        counts.set(skill.folderName, (counts.get(skill.folderName) || 0) + 1),
      new Map(),
    );
    const pendingCreations = [];
    for (const skill of desiredSkills) {
      if (nextLinks[skill.id]) continue;
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
      if (inspected.kind !== "missing") {
        if (inspected.kind === "link" && inspected.sameTarget) {
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
        await writeConfig(config);
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
        pendingCreations.length = 0;
      }
    }

    for (const { skill, linkPath } of pendingCreations) {
      try {
        await fsp.symlink(
          skill.sourcePath,
          linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        let identity;
        try {
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
          issues.push(
            createIssue(
              "warning",
              `“${skill.name}”链接已创建，但暂时无法记录文件标识：${errorMessage(error)}。已保留创建检查点，下次同步会自动补记。`,
            ),
          );
        }
        nextLinks[skill.id] = {
          linkPath,
          sourcePath: skill.sourcePath,
          // 读不到文件标识时保留 pending 检查点：下次同步凭「检查点 + 同源链接」补记标识，
          // 而不是把这条由本应用创建的链接当成外部链接放弃管理。
          ...(identity ? { identity } : { pending: true }),
        };
        createdLinks.push({ skillId: skill.id, ...nextLinks[skill.id] });
        linked.push(skill.id);
      } catch (error) {
        delete nextLinks[skill.id];
        issues.push(
          createIssue(
            "error",
            `创建“${skill.name}”链接失败：${errorMessage(error)}`,
          ),
        );
      }
    }

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
    for (const agent of config.agents) {
      results[agent.id] = await syncAgent(config, agent, scan);
    }
    return results;
  }

  return { syncAgent, syncAllAgents };
}

module.exports = { createLinkManager };
