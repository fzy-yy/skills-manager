/**
 * SKILL.md 元数据读取：只做「读文件 + 解析 name」，不涉及目录遍历与业务策略。
 *
 * 单独成文件的原因：这是纯粹的字符串与文件读取逻辑，可以脱离扫描器独立测试
 * 各种引号、注释、超长与缺字段写法。
 */
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { errorMessage, withReadTimeout } = require("./runtime");

const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_NAME_LENGTH = 200;

/**
 * 读取并解析 SKILL.md 的 YAML 元数据中的 name 字段（不引入第三方 YAML 依赖）。
 * 支持单引号、双引号与裸值三种写法，并允许行尾注释。
 *
 * @param {string} skillFile - SKILL.md 的绝对路径
 * @returns {Promise<{name: string, error: string, blocksCleanup?: boolean}>}
 *          blocksCleanup 表示"该目录不能作为有效 Skill，但本次扫描不足以认定这个 Skill 已从仓库删除"，
 *          调用方据此停止一切清理动作（清理分组引用、删除受管链接）。
 *          所有失败分支都会置为 true：无论文件暂时读不到，还是元数据永久损坏，
 *          都不能证明用户已经删除了这个 Skill，因此宁可保留现状。
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
        blocksCleanup: true,
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
      blocksCleanup: true,
    };
  }
  const frontmatter = content.match(
    /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/,
  );
  if (!frontmatter)
    return {
      name: "",
      error: `${skillFile} 缺少有效的 YAML 元数据`,
      blocksCleanup: true,
    };
  const nameLine = frontmatter[1]
    .split(/\r?\n/)
    .find((line) => /^\s*name\s*:/.test(line));
  if (!nameLine)
    return {
      name: "",
      error: `${skillFile} 的元数据缺少 name 字段`,
      blocksCleanup: true,
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
      blocksCleanup: true,
    };
  }
  name = String(name).trim();
  if (name.length > MAX_SKILL_NAME_LENGTH)
    return {
      name: "",
      error: `${skillFile} 的 name 字段超过 ${MAX_SKILL_NAME_LENGTH} 个字符`,
      blocksCleanup: true,
    };
  return name
    ? { name, error: "" }
    : {
        name: "",
        error: `${skillFile} 的 name 字段为空`,
        blocksCleanup: true,
      };
}

/**
 * 判断目录是否为有效 Skill 目录（存在 SKILL.md 且能解析出 name）。
 * 用于审计 Agent 目录中「非本应用创建」的链接是否值得保留提示。
 *
 * @param {string} directory - 待检查目录
 * @returns {Promise<boolean>} 是否为有效 Skill 目录
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

module.exports = { hasValidSkillFile, readSkillNameDetailed };
