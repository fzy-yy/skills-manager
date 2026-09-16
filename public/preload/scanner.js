/**
 * Skills 仓库扫描器：递归查找包含 SKILL.md 的目录，并解析元数据名称。
 *
 * 扫描规则（与界面说明保持一致）：
 *  - 某个子目录中存在 SKILL.md（文件名大小写不敏感）时，该目录即视为一个 Skill，且不再向下递归；
 *  - 仓库根目录只作为容器，即使含 SKILL.md 也不视为 Skill（避免漏掉全部子目录）；
 *  - 跳过符号链接目录、node_modules 与 .git 相关内容，避免死循环与无关内容；
 *  - 任一目录读取失败或达到遍历上限时，complete 置为 false，调用方据此停止同步链接。
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

/** 遍历上限：防止用户误选一个巨型目录导致扫描长时间占用。 */
const MAX_SCAN_DIRECTORIES = 5_000;
const MAX_SCAN_DEPTH = 32;
/** 单次扫描最多逐条展示的问题数量，超出部分合并为一条提示。 */
const MAX_SCAN_ISSUES = 20;
/** SKILL.md 体积上限：元数据文件不应超过该大小。 */
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;

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
      return { name: "", error: `${skillFile} 超过 2 MB，已拒绝读取` };
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
 * 扫描指定仓库目录，找出所有有效的 Skill。
 *
 * @param {string} repositoryPath - 仓库根目录（来自配置，视为可信路径）
 * @returns {Promise<{skills: Array<{id: string, name: string, folderName: string, sourcePath: string}>, issues: Array, complete: boolean}>}
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

  const skills = [];
  const pendingDirectories = [{ directory: root, depth: 0 }];
  let visitedCount = 0;

  while (pendingDirectories.length) {
    const { directory, depth } = pendingDirectories.pop();
    visitedCount += 1;
    if (visitedCount > MAX_SCAN_DIRECTORIES) {
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
      entries = await withTimeout(
        fs.promises.readdir(directory, { withFileTypes: true }),
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

    // 子目录包含 SKILL.md 时视为一个 Skill，不再向下递归；根目录只作为容器。
    const skillEntry =
      depth > 0
        ? entries.find(
            (entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md",
          )
        : undefined;
    if (skillEntry) {
      const skillFile = path.join(directory, skillEntry.name);
      const result = await readSkillName(skillFile);
      if (result.name) {
        const relativePath =
          path.relative(root, directory).split(path.sep).join("/") || ".";
        skills.push({
          id: relativePath,
          name: result.name,
          folderName: path.basename(directory),
          sourcePath: directory,
        });
        continue;
      }
      complete = false;
      pushIssue(
        createIssue("error", `${result.error}，该目录已忽略。为防止误删，本次不会清理缺失项。`),
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

  if (omittedIssueCount)
    pushIssue(
      createIssue(
        "warning",
        `另有 ${omittedIssueCount} 条扫描问题未逐条展示，请检查仓库目录权限与结构。`,
      ),
    );

  skills.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  return { skills, issues: uniqueIssues(issues), complete };
}

module.exports = { scanRepository };
