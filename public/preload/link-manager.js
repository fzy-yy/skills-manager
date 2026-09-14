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
const { pathsEqual } = require("./path-safety");
const {
  identitiesEqual,
  inspectLink,
  isDirectChild,
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
    const nextLinks = {};
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
        if (
          inspected.kind === "link" &&
          inspected.sameTarget &&
          identitiesEqual(link.identity, inspected.identity)
        )
          linked.push(skillId);
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
      const shouldKeep =
        desiredSkillIds.has(skillId) && (skill || !scan.complete);
      const currentSource = skill?.sourcePath || link.sourcePath;
      const inspected = await inspectLink(link.linkPath, link.sourcePath);
      const stillOwned =
        inspected.kind === "link" &&
        inspected.sameTarget &&
        identitiesEqual(link.identity, inspected.identity);
      if (
        shouldKeep &&
        stillOwned &&
        (await pathsEqual(link.sourcePath, currentSource))
      ) {
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
      if (shouldKeep && !scan.complete && stillOwned) {
        nextLinks[skillId] = link;
        linked.push(skillId);
        continue;
      }
      const removal = await removeOwnedLink(
        link,
        `Agent“${agent.name}”中的受管链接 ${link.linkPath}`,
        agent.directory,
      );
      issues.push(...removal.issues);
      if (!removal.relinquished) nextLinks[skillId] = link;
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

  return { removeOwnedLink, syncAgent, syncAllAgents };
}

module.exports = { createLinkManager };
