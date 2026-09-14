/** Skills 仓库扫描器：负责元数据解析、受限遍历和定向缓存校验。 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const {
  createIssue,
  errorMessage,
  mapWithConcurrency,
  uniqueIssues,
  withReadTimeout,
} = require("./runtime");
const { isInsideDirectory, normalizeDirectory } = require("./path-safety");

const MAX_SCAN_DIRECTORIES = 20_000;
const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_DURATION_MS = 30_000;
const MAX_SCAN_ISSUES = 50;
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_NAME_LENGTH = 200;
const READ_VALIDATION_CONCURRENCY = 8;

function createScanner({ normalizeCachedSkills }) {
  /**
   * 读取并解析 SKILL.md 的 YAML 元数据中的 name 字段（不引入第三方 YAML 依赖）。
   * 支持单引号、双引号与裸值三种写法，并允许行尾注释。
   *
   * @param {string} skillFile - SKILL.md 的绝对路径
   * @returns {{name: string, error: string, incomplete?: boolean}} incomplete 表示文件暂时无法读取，不能据此清理 Skill
   */
  async function readSkillNameDetailed(skillFile) {
    let content;
    try {
      const stat = await withReadTimeout(
        fsp.stat(skillFile),
        `检查 Skill 文件 ${skillFile}`,
      );
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        return {
          name: "",
          error: `${skillFile} 超过 ${MAX_SKILL_FILE_BYTES / 1024 / 1024} MB，已拒绝读取`,
          incomplete: true,
        };
      }
      content = await withReadTimeout(
        fsp.readFile(skillFile, "utf8"),
        `读取 Skill 文件 ${skillFile}`,
      );
    } catch (error) {
      return {
        name: "",
        error: `无法读取 ${skillFile}：${errorMessage(error)}`,
        incomplete: true,
      };
    }
    const frontmatter = content.match(
      /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/,
    );
    if (!frontmatter)
      return {
        name: "",
        error: `${skillFile} 缺少有效的 YAML 元数据`,
        incomplete: true,
      };
    const nameLine = frontmatter[1]
      .split(/\r?\n/)
      .find((line) => /^\s*name\s*:/.test(line));
    if (!nameLine)
      return {
        name: "",
        error: `${skillFile} 的元数据缺少 name 字段`,
        incomplete: true,
      };
    const rawValue = nameLine.replace(/^\s*name\s*:\s*/, "").trim();
    let name = "";
    try {
      if (rawValue.startsWith('"')) {
        const quoted = rawValue.match(/^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/);
        if (!quoted) throw new Error("双引号未正确闭合");
        name = JSON.parse(quoted[1]);
      } else if (rawValue.startsWith("'")) {
        const quoted = rawValue.match(/^'((?:''|[^'])*)'\s*(?:#.*)?$/);
        if (!quoted) throw new Error("单引号未正确闭合");
        name = quoted[1].replace(/''/g, "'");
      } else {
        name = rawValue.replace(/\s+#.*$/, "").trim();
      }
    } catch (error) {
      return {
        name: "",
        error: `${skillFile} 的 name 字段无效：${errorMessage(error)}`,
        incomplete: true,
      };
    }
    name = String(name).trim();
    if (name.length > MAX_SKILL_NAME_LENGTH)
      return {
        name: "",
        error: `${skillFile} 的 name 字段超过 ${MAX_SKILL_NAME_LENGTH} 个字符`,
        incomplete: true,
      };
    return name
      ? { name, error: "" }
      : {
          name: "",
          error: `${skillFile} 的 name 字段为空`,
          incomplete: true,
        };
  }

  /**
   * 递归扫描仓库目录，找出所有包含 SKILL.md 的 Skill 目录。
   *
   * 规则：
   *  - 某个目录中存在 SKILL.md（大小写不敏感）时，该目录即视为一个 Skill，且不再向下递归；
   *  - 跳过符号链接、node_modules 与 .git 目录，避免死循环与无关内容；
   *  - 只要有一个子目录读不到，就把 complete 置为 false，用于阻止后续清理动作。
   *
   * @param {string} repositoryPath - 仓库根目录绝对路径
   * @returns {{skills: Array, issues: Array, complete: boolean}} 扫描结果、问题列表与扫描是否完整
   */
  async function scanSkills(repositoryPath) {
    if (!repositoryPath) return { skills: [], issues: [], complete: true };
    const root = await normalizeDirectory(repositoryPath, "Skills 仓库目录");
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
        if (result.incomplete) complete = false;
        pushIssue(
          createIssue(
            result.incomplete ? "error" : "warning",
            `${result.error}，该目录已忽略。${result.incomplete ? "为防止误删，本次不会清理缺失项。" : ""}`,
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
   * @returns {{skills: Array, issues: Array, complete: boolean, locked?: boolean}} 扫描结果
   */
  async function scanConfiguredRepository(config) {
    const hasDependentData =
      config.groups.some((group) => group.skillIds.length) ||
      config.agents.some((agent) => Object.keys(agent.managedLinks).length);
    if (!config.repositoryPath && hasDependentData) {
      return {
        skills: [],
        complete: false,
        locked: Boolean(config._syncLocked),
        issues: [
          createIssue(
            "error",
            "Skills 仓库路径缺失，但仍存在分组或链接记录。为防止误删，现有配置和链接已保留。",
          ),
        ],
      };
    }
    try {
      const scan = await scanSkills(config.repositoryPath);
      if (
        scan.complete &&
        normalizeCachedSkills(config._cachedSkills).length > 0 &&
        scan.skills.length === 0
      ) {
        scan.complete = false;
        scan.issues.push(
          createIssue(
            "error",
            "仓库本次未检测到任何 Skill。为防止临时空目录导致误删，现有分组、选择和链接已保留。",
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
        const insideRepository =
          config.repositoryPath &&
          (await isInsideDirectory(config.repositoryPath, skill.sourcePath));
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

  /**
   * 判断目录是否为有效 Skill 目录（存在 SKILL.md 且能解析出 name）。
   * 用于审计 Agent 目录中「非本应用创建」的链接是否值得保留提示。
   *
   * @param {string} directory - 待检查目录
   * @returns {boolean} 是否为有效 Skill 目录
   */
  async function hasValidSkillFile(directory) {
    try {
      const files = await withReadTimeout(
        fsp.readdir(directory, { withFileTypes: true }),
        `检查 Skill 目录 ${directory}`,
      );
      const entry = files.find(
        (item) => item.isFile() && item.name.toLowerCase() === "skill.md",
      );
      return Boolean(
        entry &&
          (await readSkillNameDetailed(path.join(directory, entry.name))).name,
      );
    } catch (_) {
      return false;
    }
  }

  return {
    inspectEnabledCachedSkills,
    scanConfiguredRepository,
  };
}

module.exports = { createScanner };
