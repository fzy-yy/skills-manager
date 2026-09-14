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
      // 先看文件大小再读内容：既避免超大文件占满内存，也让“读不到文件”与“元数据写错”两种失败原因可区分。
      const stat = await withReadTimeout(
        fsp.stat(skillFile),
        `检查 Skill 文件 ${skillFile}`,
      );
      // 体积超限同样视为 incomplete：文件没读到，就不能据此判断 Skill 已被删除。
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
      // 读取失败（超时、无权限、被占用）标记 incomplete：上层会保留现有链接并跳过本轮清理。
      return {
        name: "",
        error: `无法读取 ${skillFile}：${errorMessage(error)}`,
        incomplete: true,
      };
    }
    // 匹配文件开头的 YAML frontmatter（--- ... ---），兼容 BOM 与 CRLF 换行。
    const frontmatter = content.match(
      /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/,
    );
    if (!frontmatter)
      return { name: "", error: `${skillFile} 缺少有效的 YAML 元数据` };
    // 在元数据中查找 name 行（允许前面有缩进）。
    const nameLine = frontmatter[1]
      .split(/\r?\n/)
      .find((line) => /^\s*name\s*:/.test(line));
    if (!nameLine)
      return { name: "", error: `${skillFile} 的元数据缺少 name 字段` };
    const rawValue = nameLine.replace(/^\s*name\s*:\s*/, "").trim();
    let name = "";
    try {
      // 双引号写法：按 JSON 字符串解析，可正确处理 \n、\" 等转义。
      if (rawValue.startsWith('"')) {
        const quoted = rawValue.match(/^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/);
        if (!quoted) throw new Error("双引号未正确闭合");
        name = JSON.parse(quoted[1]);
      } else if (rawValue.startsWith("'")) {
        // 单引号写法：YAML 中以两个单引号表示一个单引号。
        const quoted = rawValue.match(/^'((?:''|[^'])*)'\s*(?:#.*)?$/);
        if (!quoted) throw new Error("单引号未正确闭合");
        name = quoted[1].replace(/''/g, "'");
      } else {
        // 裸值写法：去掉行尾注释即可。
        name = rawValue.replace(/\s+#.*$/, "").trim();
      }
    } catch (error) {
      return {
        name: "",
        error: `${skillFile} 的 name 字段无效：${errorMessage(error)}`,
      };
    }
    name = String(name).trim();
    if (name.length > MAX_SKILL_NAME_LENGTH)
      return {
        name: "",
        error: `${skillFile} 的 name 字段超过 ${MAX_SKILL_NAME_LENGTH} 个字符`,
      };
    return name
      ? { name, error: "" }
      : { name: "", error: `${skillFile} 的 name 字段为空` };
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
  // 扫描会记录每个可见错误；只要任一子目录不可读，complete 就为 false。
  async function scanSkills(repositoryPath) {
    // 未配置仓库时视为空仓库，无需报错。
    if (!repositoryPath) return { skills: [], issues: [], complete: true };
    const root = await normalizeDirectory(repositoryPath, "Skills 仓库目录");
    const skills = [];
    const issues = [];
    let complete = true;
    // omittedIssueCount 统计被折叠的问题数量，扫描结束时合并成一条提示。
    let omittedIssueCount = 0;
    // visitedDirectoryCount 与扫描开始时间共同构成“扫描预算”，超限即中止并标记不完整。
    let visitedDirectoryCount = 0;
    const scanStartedAt = Date.now();
    // 显式栈避免递归调用栈溢出，并为深度与目录数量提供清晰边界。
    const pendingDirectories = [{ directory: root, depth: 0 }];
    // 问题数量封顶：目录权限大面积异常时，避免前端提示区被刷屏。
    const pushIssue = (issue) => {
      if (issues.length < MAX_SCAN_ISSUES) issues.push(issue);
      else omittedIssueCount += 1;
    };

    // 递归改为显式栈的深度优先遍历：既避免爆栈，也便于每轮取目录前检查时间与数量预算。
    while (pendingDirectories.length) {
      // 每次取目录前检查总时长预算；超时立即停止，且不完整结果不会触发任何清理。
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
      // 目录数量超限：立即停止并标记不完整，防止误选超大目录后长时间占用磁盘与内存。
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
        // 目录不可读：标记扫描不完整，后续不会清理任何缺失记录，避免误删。
        complete = false;
        pushIssue(
          createIssue(
            "error",
            `无法扫描目录 ${directory}：${errorMessage(error)}。为防止误删，本次不会清理缺失项。`,
          ),
        );
        continue;
      }
      // 当前目录内存在 SKILL.md → 认定为一个 Skill 目录。
      // 判定规则：目录内直接存在 SKILL.md 即为一个 Skill（大小写不敏感），不再向下层递归，
      // 避免把子目录中的 Skill 当作当前目录的 Skill 重复采集。
      const skillEntry = entries.find(
        (entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md",
      );
      if (skillEntry) {
        const skillFile = path.join(directory, skillEntry.name);
        const result = await readSkillNameDetailed(skillFile);
        if (result.name) {
          // id 使用相对于仓库根目录的 POSIX 风格路径（根目录自身记为 '.'），便于跨平台存储与比较。
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
        // 文件系统读取失败与元数据格式错误语义不同：前者不能证明 Skill 已被删除。
        if (result.incomplete) complete = false;
        // 有 SKILL.md 但元数据非法：忽略该目录并提示，继续向下查找子目录。
        pushIssue(
          createIssue(
            result.incomplete ? "error" : "warning",
            `${result.error}，该目录已忽略。${result.incomplete ? "为防止误删，本次不会清理缺失项。" : ""}`,
          ),
        );
      }
      // 继续遍历子目录：跳过符号链接（防止循环）、node_modules 与 .git*。
      // 逆序入栈：弹出顺序即目录名的自然顺序，让扫描顺序与提示顺序更符合直觉。
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
    // 把被折叠的问题合并成一条提示，让用户知道还有多少问题未逐条展示。
    if (omittedIssueCount) {
      issues.push(
        createIssue(
          "warning",
          `另有 ${omittedIssueCount} 条扫描问题未逐条展示，请检查仓库目录权限与结构。`,
        ),
      );
    }
    // 名称统一按中文习惯排序，保证列表展示稳定。
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
    // 是否存在依赖仓库路径的数据（分组内容或受管链接）。
    const hasDependentData =
      config.groups.some((group) => group.skillIds.length) ||
      config.agents.some((agent) => Object.keys(agent.managedLinks).length);
    // 仓库路径缺失但仍有分组/链接：保留现状并阻止清理，避免把链接全部删掉。
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
      // 配置本身处于只读保护时，把标记继续向下传递。
      if (config._syncLocked) scan.locked = true;
      return scan;
    } catch (error) {
      // 目录被删除、无权限等：同样按「不完整」处理，保留现有配置与链接。
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

  // 为什么需要它：切换单个分组开关时只会改动少量 Skill，如果每次都全仓库递归扫描，大仓库会明显卡顿。
  // 因此这里只针对「本次涉及到的 Skill」逐项核验：必须命中最近一次完整扫描缓存，
  // 且源目录仍位于仓库内、仍是有效 Skill；任一项无法确认就把 complete 置为 false，
  // 让 syncAgent 采取“只补不删”的保守策略。缓存缺失时提示用户重新扫描。
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
        // 二次核验：缓存里的路径可能已被移动，必须确认它仍在仓库目录内，防止链接指到仓库之外。
        const insideRepository =
          config.repositoryPath &&
          (await isInsideDirectory(config.repositoryPath, skill.sourcePath));
        // 已启用项沿用最近一次完整扫描结果；只有本轮新开启的项读取 SKILL.md，减少重复磁盘访问。
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
      // 目录不存在或不可读，按无效处理（只影响提示，不影响文件）。
      return false;
    }
  }

  return {
    hasValidSkillFile,
    inspectEnabledCachedSkills,
    scanConfiguredRepository,
  };
}

module.exports = { createScanner };
