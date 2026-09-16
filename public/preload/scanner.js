/**
 * Skills 仓库扫描器：检查仓库目录“第一层子目录”中的 SKILL.md，并解析元数据名称。
 *
 * 扫描规则（与界面说明保持一致）：
 *  - 只检查仓库根目录下的直接子目录，不递归更深层级；
 *  - 子目录中存在 SKILL.md（文件名大小写不敏感）时视为一个 Skill，读取其元数据的 name；
 *  - 子目录中没有 SKILL.md 时直接跳过，并提示该目录可能不是一个 Skill；
 *  - 子目录读取失败或 SKILL.md 解析失败时，complete 置为 false，
 *    调用方据此停止同步链接，避免把暂时无法确认的 Skill 当作“已删除”而清理链接。
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  createIssue,
  errorMessage,
  normalizeDirectory,
  uniqueIssues,
  withTimeout,
} = require("./utils");

/** 单次扫描最多逐条展示的问题数量，超出部分合并为一条提示。 */
const MAX_SCAN_ISSUES = 20;
/** SKILL.md 体积上限：元数据文件不应超过该大小。 */
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
/** 体积上限的 MB 展示值（由字节数派生，保证文案与常量始终一致）。 */
const MAX_SKILL_FILE_MB = MAX_SKILL_FILE_BYTES / (1024 * 1024);

/**
 * 读取并解析 SKILL.md 的 YAML 元数据中的 name 字段（不引入 YAML 依赖）。
 * 支持单引号、双引号与裸值三种写法，并允许行尾注释。
 *
 * @param {string} skillFile - SKILL.md 的绝对路径
 * @returns {Promise<{name: string, error: string}>} 解析出的名称或错误说明
 */
async function readSkillName(skillFile) {
  let content;
  try {
    const stat = await withTimeout(
      fs.promises.stat(skillFile),
      `检查 Skill 文件 ${skillFile}`,
    );
    if (stat.size > MAX_SKILL_FILE_BYTES)
      return {
        name: "",
        error: `${skillFile} 超过 ${MAX_SKILL_FILE_MB} MB，已拒绝读取`,
      };
    content = await withTimeout(
      fs.promises.readFile(skillFile, "utf8"),
      `读取 Skill 文件 ${skillFile}`,
    );
  } catch (error) {
    return { name: "", error: `无法读取 ${skillFile}：${errorMessage(error)}` };
  }

  const frontmatter = content.match(
    /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/,
  );
  if (!frontmatter)
    return { name: "", error: `${skillFile} 缺少有效的 YAML 元数据` };
  const nameLine = frontmatter[1]
    .split(/\r?\n/)
    .find((line) => /^\s*name\s*:/.test(line));
  if (!nameLine) return { name: "", error: `${skillFile} 的元数据缺少 name 字段` };

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
    return { name: "", error: `${skillFile} 的 name 字段无效：${errorMessage(error)}` };
  }
  name = String(name).trim();
  return name
    ? { name, error: "" }
    : { name: "", error: `${skillFile} 的 name 字段为空` };
}

/**
 * 扫描指定仓库目录，找出其第一层子目录中所有有效的 Skill。
 * Skill 的 id 与链接目录名均取子目录名（同一层内天然唯一）。
 *
 * @param {string} repositoryPath - 仓库根目录（来自配置，视为可信路径）
 * @returns {Promise<{skills: Array<{id: string, name: string, sourcePath: string}>, issues: Array, complete: boolean}>}
 *          complete 为 false 表示扫描不完整，调用方不应执行链接清理
 */
async function scanRepository(repositoryPath) {
  const issues = [];
  let complete = true;
  let omittedIssueCount = 0;
  const pushIssue = (issue) => {
    if (issues.length < MAX_SCAN_ISSUES) issues.push(issue);
    else omittedIssueCount += 1;
  };

  let root;
  try {
    root = await normalizeDirectory(repositoryPath, "Skills 仓库目录");
  } catch (error) {
    return {
      skills: [],
      issues: [createIssue("error", error.message)],
      complete: false,
    };
  }

  let entries;
  try {
    entries = await withTimeout(
      fs.promises.readdir(root, { withFileTypes: true }),
      `扫描仓库目录 ${root}`,
    );
  } catch (error) {
    return {
      skills: [],
      issues: [
        createIssue(
          "error",
          `无法读取仓库目录 ${root}：${errorMessage(error)}。为防止误删，本次不会清理缺失项。`,
        ),
      ],
      complete: false,
    };
  }

  const skills = [];
  for (const entry of entries) {
    // 只检查第一层子目录；符号链接目录指向仓库外部，不参与扫描。
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(root, entry.name);

    let childEntries;
    try {
      childEntries = await withTimeout(
        fs.promises.readdir(directory, { withFileTypes: true }),
        `扫描目录 ${directory}`,
      );
    } catch (error) {
      complete = false;
      pushIssue(
        createIssue(
          "error",
          `无法读取目录 ${directory}：${errorMessage(error)}。为防止误删，本次不会清理缺失项。`,
        ),
      );
      continue;
    }

    const skillEntry = childEntries.find(
      (item) => item.isFile() && item.name.toLowerCase() === "skill.md",
    );
    if (!skillEntry) {
      pushIssue(
        createIssue(
          "warning",
          `目录“${entry.name}”中没有找到 SKILL.md，可能不是一个 Skill，已跳过。`,
        ),
      );
      continue;
    }

    const result = await readSkillName(path.join(directory, skillEntry.name));
    if (result.name) {
      skills.push({
        id: entry.name,
        name: result.name,
        sourcePath: directory,
      });
      continue;
    }
    complete = false;
    pushIssue(
      createIssue("error", `${result.error}，该目录已忽略。为防止误删，本次不会清理缺失项。`),
    );
  }

  // 聚合提示直接追加：它本身不应再受条数上限影响，否则永远无法展示。
  if (omittedIssueCount)
    issues.push(
      createIssue(
        "warning",
        `另有 ${omittedIssueCount} 条扫描问题未逐条展示，请检查仓库目录权限与结构。`,
      ),
    );

  skills.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return { skills, issues: uniqueIssues(issues), complete };
}

module.exports = { scanRepository };
