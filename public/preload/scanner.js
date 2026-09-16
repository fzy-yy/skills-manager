/**
 * Skills 仓库扫描器：受限遍历、空仓库防护与定向缓存校验。
 *
 * SKILL.md 的元数据解析在 skill-metadata.js；本文件只负责"怎么遍历、怎么判定完整、
 * 以及什么时候必须停下清理动作"。
 */
const fsp = require("node:fs").promises;
const path = require("node:path");
const {
  createIssue,
  errorMessage,
  mapWithConcurrency,
  uniqueIssues,
  withReadTimeout,
} = require("./runtime");
const {
  hasValidSkillFile,
  readSkillNameDetailed,
} = require("./skill-metadata");
const {
  assertNotDiskRoot,
  canonicalDirectory,
  isInsideDirectoryLexical,
  normalizeDirectory,
} = require("./path-safety");

const MAX_SCAN_DIRECTORIES = 20_000;
const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_DURATION_MS = 30_000;
const MAX_SCAN_ISSUES = 50;
const READ_VALIDATION_CONCURRENCY = 8;

function createScanner({ normalizeCachedSkills }) {
  /**
   * 递归扫描仓库目录，找出所有包含 SKILL.md 的 Skill 目录。
   *
   * 规则：
   *  - 某个目录中存在 SKILL.md（大小写不敏感）时，该目录即视为一个 Skill，且不再向下递归；
   *  - 跳过符号链接、node_modules 与 .git 目录，避免死循环与无关内容；
   *  - 只要有一处无法确认（目录读不到、SKILL.md 解析不出 name、达到上限），
   *    就把 complete 置为 false，用于阻止后续清理动作。
   *
   * @param {string} repositoryPath - 仓库根目录绝对路径
   * @returns {{skills: Array, issues: Array, complete: boolean}} 扫描结果、问题列表与扫描是否完整
   */
  async function scanSkills(repositoryPath) {
    if (!repositoryPath)
      return {
        skills: [],
        issues: [createIssue("error", "Skills 仓库路径为空，未执行扫描。")],
        complete: false,
      };
    const root = await normalizeDirectory(repositoryPath, "Skills 仓库目录");
    // 二次防线：即使调用方漏检，扫描器也拒绝对磁盘根目录（含伪装的 junction）执行扫描。
    // normalizeDirectory 已把 junction / 符号链接解析为 canonical 路径，因此这里能识别真实根目录。
    assertNotDiskRoot(root, "Skills 仓库");
    const skills = [];
    const issues = [];
    let complete = true;
    let omittedIssueCount = 0;
    let visitedDirectoryCount = 0;
    const scanStartedAt = Date.now();
    const pendingDirectories = [{ directory: root, depth: 0 }];
    const pushIssue = (issue) => {
      if (issues.length < MAX_SCAN_ISSUES) issues.push(issue);
      else omittedIssueCount += 1;
    };

    while (pendingDirectories.length) {
      if (Date.now() - scanStartedAt > MAX_SCAN_DURATION_MS) {
        complete = false;
        pushIssue(
          createIssue(
            "error",
            `仓库扫描超过 ${MAX_SCAN_DURATION_MS / 1000} 秒，已停止扫描。请检查目录范围、磁盘或网络连接。`,
          ),
        );
        break;
      }
      const { directory, depth } = pendingDirectories.pop();
      visitedDirectoryCount += 1;
      if (visitedDirectoryCount > MAX_SCAN_DIRECTORIES) {
        complete = false;
        pushIssue(
          createIssue(
            "error",
            `仓库目录超过 ${MAX_SCAN_DIRECTORIES} 个子目录，已停止扫描。请只选择专用的 Skills 仓库目录。`,
          ),
        );
        break;
      }
      let entries;
      try {
        entries = await withReadTimeout(
          fsp.readdir(directory, { withFileTypes: true }),
          `扫描目录 ${directory}`,
        );
      } catch (error) {
        complete = false;
        pushIssue(
          createIssue(
            "error",
            `无法扫描目录 ${directory}：${errorMessage(error)}。为防止误删，本次不会清理缺失项。`,
          ),
        );
        continue;
      }
      const skillEntry = entries.find(
        (entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md",
      );
      if (skillEntry) {
        const skillFile = path.join(directory, skillEntry.name);
        const result = await readSkillNameDetailed(skillFile);
        if (result.name) {
          const relativePath =
            path.relative(root, directory).split(path.sep).join("/") || ".";
          skills.push({
            id: relativePath,
            name: result.name,
            relativePath,
            folderName: path.basename(directory),
            sourcePath: directory,
          });
          continue;
        }
        if (result.blocksCleanup) complete = false;
        pushIssue(
          createIssue(
            "error",
            `${result.error}，该目录已忽略。为防止误删，本次不会清理缺失项。`,
          ),
        );
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        const lowerName = entry.name.toLowerCase();
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          lowerName === "node_modules" ||
          lowerName.startsWith(".git")
        )
          continue;
        if (depth >= MAX_SCAN_DEPTH) {
          complete = false;
          pushIssue(
            createIssue(
              "error",
              `目录层级超过 ${MAX_SCAN_DEPTH} 层，已跳过 ${path.join(directory, entry.name)}。`,
            ),
          );
          continue;
        }
        pendingDirectories.push({
          directory: path.join(directory, entry.name),
          depth: depth + 1,
        });
      }
    }
    if (omittedIssueCount) {
      issues.push(
        createIssue(
          "warning",
          `另有 ${omittedIssueCount} 条扫描问题未逐条展示，请检查仓库目录权限与结构。`,
        ),
      );
    }
    skills.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    return { skills, issues: uniqueIssues(issues), complete };
  }

  /**
   * 扫描当前配置指向的仓库目录，并把「配置异常」转换为可展示的问题。
   *
   * @param {object} config - 当前配置（可能带 _syncLocked 标记）
   * @param {{allowEmptyRepository?: boolean}} [options] - allowEmptyRepository 为用户已二次确认
   *        "仓库确实已清空"时使用，此时允许按空仓库收敛并清理失效引用与链接
   * @returns {{skills: Array, issues: Array, complete: boolean, locked?: boolean, emptyRepository?: boolean}}
   *          扫描结果；emptyRepository 表示本次因"仓库为空"而被拦下
   */
  async function scanConfiguredRepository(config, options = {}) {
    const allowEmptyRepository = options.allowEmptyRepository === true;
    const hasDependentData =
      config.groups.some((group) => group.skillIds.length) ||
      config.agents.some(
        (agent) =>
          Object.keys(agent.managedLinks).length ||
          (config.enabledSkills[agent.id] || []).length,
      );
    if (!config.repositoryPath) {
      return {
        skills: [],
        complete: false,
        locked: Boolean(config._syncLocked),
        issues: [
          createIssue(
            "error",
            hasDependentData
              ? "Skills 仓库路径缺失，但仍存在分组或链接记录。为防止误删，现有配置和链接已保留。"
              : "尚未配置 Skills 仓库目录，无法扫描。",
          ),
        ],
      };
    }
    try {
      const scan = await scanSkills(config.repositoryPath);
      if (
        scan.complete &&
        !allowEmptyRepository &&
        normalizeCachedSkills(config._cachedSkills).length > 0 &&
        scan.skills.length === 0
      ) {
        scan.complete = false;
        scan.emptyRepository = true;
        scan.issues.push(
          createIssue(
            "error",
            "仓库本次未检测到任何 Skill。为防止临时空目录导致误删，现有分组、选择和链接已保留；若确认仓库已清空，可使用页面上的“确认仓库已清空”按钮清理失效记录。",
          ),
        );
      }
      if (config._syncLocked) scan.locked = true;
      return scan;
    } catch (error) {
      return {
        skills: [],
        complete: false,
        locked: Boolean(config._syncLocked),
        issues: [
          createIssue(
            "error",
            `${error.message}。现有配置和链接已保留，请恢复目录后重新扫描。`,
          ),
        ],
      };
    }
  }

  /**
   * 为单个 Agent 的开关变更核验实际涉及的缓存 Skills。
   * 不递归扫描整个仓库；任一源目录不可用时标记为不完整，从而保留已有受管链接并停止危险清理。
   */
  async function inspectEnabledCachedSkills(
    config,
    agent,
    previousSkillIds = [],
  ) {
    const desiredSkillIds = new Set(config.enabledSkills[agent.id] || []);
    const previousIds = new Set(previousSkillIds);
    const cachedById = new Map(
      normalizeCachedSkills(config._cachedSkills).map((skill) => [
        skill.id,
        skill,
      ]),
    );
    const skills = [];
    const issues = [];
    let complete = true;

    const inspections = await mapWithConcurrency(
      [...desiredSkillIds],
      READ_VALIDATION_CONCURRENCY,
      async (skillId) => {
        const skill = cachedById.get(skillId);
        if (!skill) {
          return {
            complete: false,
            issue: createIssue(
              "warning",
              `Skill“${skillId}”不在最近一次完整扫描缓存中，已跳过创建。请重新扫描仓库后再试。`,
            ),
          };
        }
        let insideRepository = false;
        if (config.repositoryPath) {
          try {
            const [repositoryReal, sourceReal] = await Promise.all([
              canonicalDirectory(config.repositoryPath, "Skills 仓库目录"),
              canonicalDirectory(skill.sourcePath, "Skill 源目录"),
            ]);
            insideRepository = isInsideDirectoryLexical(
              repositoryReal,
              sourceReal,
            );
          } catch (_) {
            // 无法把仓库或源目录解析到真实路径时，不能证明源目录仍在仓库内，
            // 按“不在仓库内”处理并停止创建（fail closed）。
            insideRepository = false;
          }
        }
        const validSkill =
          insideRepository &&
          (previousIds.has(skillId) ||
            (await hasValidSkillFile(skill.sourcePath)));
        if (!validSkill) {
          return {
            complete: false,
            issue: createIssue(
              "warning",
              `Skill“${skill.name}”的源目录不可用或已不是有效 Skill，已跳过创建并保留现有链接。`,
            ),
          };
        }
        return { complete: true, skill };
      },
    );
    inspections.forEach((inspection) => {
      if (!inspection.complete) complete = false;
      if (inspection.issue) issues.push(inspection.issue);
      if (inspection.skill) skills.push(inspection.skill);
    });

    return { skills, issues: uniqueIssues(issues), complete };
  }

  return {
    inspectEnabledCachedSkills,
    scanConfiguredRepository,
  };
}

module.exports = { createScanner };
