/**
 * 测试环境工具（CommonJS）：
 *  - mock uTools 环境（window.utools.getPath / showOpenDialog）；
 *  - 管理测试目录：独立的 userData、skills_repo 仓库、agents1-3 目录；
 *  - 加载 public/preload/api.js，生成独立的插件 API 实例；
 *  - 提供文件断言辅助（链接列举、安全清空目录等）。
 *
 * 用法：`const { createHarness, createSkill, listLinks } = require("./helpers/harness.cjs")`
 */
const fs = require("node:fs");
const path = require("node:path");

/** test_dir 根目录（本文件位于 test_dir/test/helpers/ 下）。 */
const TEST_DIR = path.resolve(__dirname, "..", "..");
/** 项目根目录（Skills管理器/）。 */
const PROJECT_ROOT = path.resolve(TEST_DIR, "..");
/** preload 源码目录。 */
const PRELOAD_DIR = path.join(PROJECT_ROOT, "public", "preload");
/** 模拟的 Skills 仓库目录。 */
const REPO_DIR = path.join(TEST_DIR, "skills_repo");
/** 模拟的 Agent 目录（3 个，供不同测试场景使用）。 */
const AGENT_DIRS = [1, 2, 3].map((index) => path.join(TEST_DIR, `agents${index}`));
/** 运行产物目录（测试生成的本地配置，位于 .user-data/<模块名>/）。 */
const USER_DATA_DIR = path.join(TEST_DIR, ".user-data");

/** 仓库的标准 fixtures：每次重置后都会生成这三个 Skill。 */
const DEFAULT_SKILLS = [
  { folder: "alpha", name: "Alpha Skill" },
  { folder: "beta", name: "Beta Skill" },
  { folder: "gamma", name: "Gamma Skill" },
];

/**
 * 可靠地递归删除目录树（手动实现，不使用 fs.rmSync）。
 *
 * 说明：在部分 Node 版本/Windows 组合下，`fs.rmSync(dir, { recursive: true, force: true })`
 * 对空目录可能静默失败（返回成功但目录仍在），因此测试环境统一使用本实现：
 * 符号链接 / junction 只删除链接本身，绝不跟随目标。
 *
 * @param {string} directory - 待删除的目录
 */
function removeDirectoryTree(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      try {
        fs.unlinkSync(target);
      } catch (_) {
        fs.rmdirSync(target);
      }
      continue;
    }
    if (stat.isDirectory()) removeDirectoryTree(target);
    else fs.unlinkSync(target);
  }
  fs.rmdirSync(directory);
}

/**
 * 清空目录（不删除目录本身）。
 * 重点：符号链接 / junction 只删除链接本身，绝不跟随目标。
 *
 * @param {string} directory - 待清空的目录
 */
function clearDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of fs.readdirSync(directory)) {
    const target = path.join(directory, name);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      try {
        fs.unlinkSync(target);
      } catch (_) {
        // Windows 下目录链接（junction）需要 rmdir 删除
        fs.rmdirSync(target);
      }
      continue;
    }
    if (stat.isDirectory()) removeDirectoryTree(target);
    else fs.unlinkSync(target);
  }
}

/**
 * 在指定目录写入一个 Skill fixture（含 SKILL.md）。
 *
 * @param {string} directory - Skill 目录
 * @param {string} name - SKILL.md 元数据中的 name
 * @param {{fileName?: string}} [options] - fileName 可指定 SKILL.md 的文件名大小写
 * @returns {string} 目录路径
 */
function createSkill(directory, name, options = {}) {
  const fileName = options.fileName || "SKILL.md";
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, fileName),
    `---\nname: ${name}\ndescription: 测试用 Skill\n---\n\n# ${name}\n`,
    "utf8",
  );
  return directory;
}

/** 把 skills_repo 重置为默认 fixtures（alpha / beta / gamma）。 */
function resetRepository() {
  removeDirectoryTree(REPO_DIR);
  fs.mkdirSync(REPO_DIR, { recursive: true });
  for (const skill of DEFAULT_SKILLS)
    createSkill(path.join(REPO_DIR, skill.folder), skill.name);
}

/** 清空 agents1-3 中的全部内容（安全的链接清理）。 */
function resetAgents() {
  for (const directory of AGENT_DIRS) clearDirectory(directory);
}

/**
 * 列出目录中所有符号链接的名字（排序）。
 *
 * @param {string} directory - 目标目录
 * @returns {string[]} 链接名列表
 */
function listLinks(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => fs.lstatSync(path.join(directory, name)).isSymbolicLink())
    .sort();
}

/**
 * 列出目录中的所有条目名（排序）。
 *
 * @param {string} directory - 目标目录
 * @returns {string[]} 条目名列表
 */
function listEntries(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).sort();
}

/**
 * 执行一个预期会抛错的异步操作。
 *
 * @param {Function} operation - 待执行的函数
 * @returns {Promise<Error|null>} 捕获到的错误；未抛错时返回 null
 */
async function captureError(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * 创建测试环境。
 *  - 重置独立的 userData 目录（test_dir/.user-data/<name>）；
 *  - 默认同时重置 skills_repo 与 agents1-3（可用参数关闭，用于需要保留现场的场景）；
 *  - mock window.utools 并加载 preload API。
 *
 * @param {string} name - 模块名（作为 userData 子目录名与调试标识）
 * @param {{resetRepo?: boolean, resetAgentDirs?: boolean}} [options]
 * @returns {object} 测试环境对象
 */
function createHarness(name, options = {}) {
  const { resetRepo = true, resetAgentDirs = true } = options;
  const userData = path.join(USER_DATA_DIR, name);
  removeDirectoryTree(userData);
  fs.mkdirSync(userData, { recursive: true });
  if (resetRepo) resetRepository();
  if (resetAgentDirs) resetAgents();

  /** 目录选择框的 mock 返回值，可通过 setDialogResult 调整。 */
  let dialogResult = [];
  global.window = {
    utools: {
      getPath: (target) => (target === "userData" ? userData : TEST_DIR),
      showOpenDialog: () => dialogResult,
    },
  };

  const { createSkillsManagerApi } = require(path.join(PRELOAD_DIR, "api.js"));
  const api = createSkillsManagerApi({ utools: global.window.utools });

  return {
    api,
    userData,
    /** 本地配置文件路径（默认位置）。 */
    statePath: path.join(userData, "skills-manager", "state.json"),
    /** 调整目录选择框的返回值（测试"浏览/取消"行为）。 */
    setDialogResult(result) {
      dialogResult = result;
    },
    /** 读取本地配置原始内容；文件不存在时返回 null。 */
    readStoredState() {
      if (!fs.existsSync(this.statePath)) return null;
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    },
    /** 覆盖本地配置（用于模拟损坏、手工编辑等场景）。 */
    writeStoredState(content) {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, content, "utf8");
    },
  };
}

module.exports = {
  AGENT_DIRS,
  DEFAULT_SKILLS,
  PRELOAD_DIR,
  PROJECT_ROOT,
  REPO_DIR,
  TEST_DIR,
  captureError,
  clearDirectory,
  createHarness,
  createSkill,
  listEntries,
  listLinks,
  removeDirectoryTree,
  resetAgents,
  resetRepository,
};
