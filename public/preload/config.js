/**
 * 本地配置存储：读写 uTools 用户数据目录下的 state.json。
 *
 * 目录约定：<uTools userData>/skills-manager/state.json。
 * 写入采用「临时文件 + fsync + 原子改名」，任何时刻磁盘上都存在完整文件；
 * 读取遇到内容损坏时回退为默认配置并给出提示，避免插件无法启动。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createIssue, errorMessage } = require("./utils");

/** 本地配置的相对目录名与文件名（与旧版本保持兼容，无需迁移）。 */
const FOLDER_NAME = "skills-manager";
const STATE_FILE_NAME = "state.json";
/** 实体名称（分组 / Agent）的最大长度，与界面输入框限制保持一致。 */
const MAX_ENTITY_NAME_LENGTH = 120;

/** 默认配置：全新安装或数据被清除后的初始状态。 */
function createDefaultState() {
  return {
    repositoryPath: "",
    groups: [],
    agents: [],
    enabledSkills: {},
    cachedSkills: [],
    theme: "light",
  };
}

/**
 * 判断值是否为普通对象（排除 null、数组）。
 *
 * @param {unknown} value - 待判断的值
 * @returns {boolean} 是否为普通对象
 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 规范化一个 Skill 缓存项；字段缺失或格式错误时返回 null。
 * id 必须是单层目录名（同时是 Agent 目录中的链接名）；历史版本曾把 id
 * 存为相对路径，这类记录无法与目录名安全对应，按无效丢弃（重新扫描即可恢复）。
 *
 * @param {object} item - 磁盘上的缓存项
 * @returns {{id: string, name: string, sourcePath: string}|null}
 */
function normalizeSkill(item) {
  if (!isPlainObject(item)) return null;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const sourcePath =
    typeof item.sourcePath === "string" ? item.sourcePath.trim() : "";
  if (
    !id ||
    !name ||
    !sourcePath ||
    id !== path.basename(id) ||
    id === "." ||
    id === ".."
  )
    return null;
  return { id, name, sourcePath };
}

/**
 * 规范化一个分组；id / name 缺失或 skillIds 非法时返回 null。
 *
 * @param {object} item - 磁盘上的分组
 * @returns {{id: string, name: string, skillIds: string[]}|null}
 */
function normalizeGroup(item) {
  if (!isPlainObject(item)) return null;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (!id || !name || !Array.isArray(item.skillIds)) return null;
  const skillIds = [
    ...new Set(
      item.skillIds.filter(
        (skillId) => typeof skillId === "string" && skillId.length > 0,
      ),
    ),
  ];
  return { id, name, skillIds };
}

/**
 * 规范化一个 Agent；id / name / directory 任一缺失时返回 null。
 *
 * @param {object} item - 磁盘上的 Agent
 * @returns {{id: string, name: string, directory: string}|null}
 */
function normalizeAgent(item) {
  if (!isPlainObject(item)) return null;
  const id = typeof item.id === "string" ? item.id.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const directory =
    typeof item.directory === "string" ? item.directory.trim() : "";
  if (!id || !name || !directory) return null;
  return { id, name, directory };
}

/**
 * 生成不重名的实体名称（分组 / Agent 共用）：名称已被占用时在末尾追加递增序号，
 * 例如“前端开发 (2)”“Codex (2)”。
 *
 * @param {string} base - 期望的名称
 * @param {Set<string>} usedNames - 已被占用的名称集合
 * @returns {string} 保证唯一的名称（必要时截断基础名称以避免超长）
 */
function uniqueEntityName(base, usedNames) {
  if (!usedNames.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${base.slice(0, Math.max(MAX_ENTITY_NAME_LENGTH - suffix.length, 1))}${suffix}`;
    if (!usedNames.has(candidate)) return candidate;
  }
}

/**
 * 规范化一组实体（分组 / Agent 共用）：丢弃无效项与重复 id，并对重名实体
 * 自动追加递增序号（历史数据也可能因此被改名）。
 *
 * @param {Array} list - 磁盘上的原始数组
 * @param {(item: object) => object|null} normalizeItem - 单项规范化函数
 * @returns {{items: Array, rawCount: number, renamedCount: number}} 规范化结果与统计
 */
function normalizeEntityList(list, normalizeItem) {
  const ids = new Set();
  const names = new Set();
  let renamedCount = 0;
  const items = (Array.isArray(list) ? list : [])
    .map(normalizeItem)
    .filter((item) => {
      if (!item || ids.has(item.id)) return false;
      ids.add(item.id);
      return true;
    })
    .map((item) => {
      const name = uniqueEntityName(item.name, names);
      if (name !== item.name) renamedCount += 1;
      names.add(name);
      return { ...item, name };
    });
  return { items, rawCount: Array.isArray(list) ? list.length : 0, renamedCount };
}

/**
 * 把磁盘上的任意 JSON 规范化为可信配置对象。
 * 无效的分组 / Agent / 缓存项会被丢弃，enabledSkills 只保留现存 Agent 的条目；
 * 重名的分组与 Agent 会被自动追加递增序号（历史数据也可能因此被改名）。
 *
 * @param {object} raw - 解析后的原始数据
 * @returns {{state: object, issues: Array}} 规范化配置与需要提示的问题
 */
function normalizeState(raw) {
  const issues = [];
  const source = isPlainObject(raw) ? raw : {};

  const groups = normalizeEntityList(source.groups, normalizeGroup);
  const agents = normalizeEntityList(source.agents, normalizeAgent);

  const skillIds = new Set();
  const cachedSkills = (
    Array.isArray(source.cachedSkills) ? source.cachedSkills : []
  )
    .map(normalizeSkill)
    .filter((skill) => {
      if (!skill || skillIds.has(skill.id)) return false;
      skillIds.add(skill.id);
      return true;
    });

  const enabledSkills = {};
  const rawEnabled = isPlainObject(source.enabledSkills)
    ? source.enabledSkills
    : {};
  for (const agent of agents.items) {
    const values = rawEnabled[agent.id];
    enabledSkills[agent.id] = Array.isArray(values)
      ? [
          ...new Set(
            values.filter(
              (skillId) => typeof skillId === "string" && skillId.length > 0,
            ),
          ),
        ]
      : [];
  }

  const state = {
    repositoryPath:
      typeof source.repositoryPath === "string"
        ? source.repositoryPath.trim()
        : "",
    groups: groups.items,
    agents: agents.items,
    enabledSkills,
    cachedSkills,
    theme: source.theme === "dark" ? "dark" : "light",
  };

  if (groups.items.length < groups.rawCount)
    issues.push(createIssue("warning", "本地配置中有无效或重复的分组记录，已忽略。"));
  if (groups.renamedCount)
    issues.push(
      createIssue(
        "warning",
        `有 ${groups.renamedCount} 个分组名称重复，已自动添加序号区分。`,
      ),
    );
  if (agents.items.length < agents.rawCount)
    issues.push(createIssue("warning", "本地配置中有无效或重复的 Agent 记录，已忽略。"));
  if (agents.renamedCount)
    issues.push(
      createIssue(
        "warning",
        `有 ${agents.renamedCount} 个 Agent 名称重复，已自动添加序号区分。`,
      ),
    );
  return { state, issues };
}

/**
 * 创建绑定到具体 uTools 环境的配置存储器。
 *
 * @param {object} utools - window.utools 实例
 * @returns {{read: Function, write: Function, clear: Function}}
 * @throws {Error} 无法获取 uTools 用户数据目录时抛出
 */
function createConfigStore(utools) {
  const userDataPath = utools?.getPath?.("userData");
  if (!userDataPath)
    throw new Error("无法获取 uTools 用户数据目录，请在 uTools 中重新打开插件");

  const directory = path.join(userDataPath, FOLDER_NAME);
  const filePath = path.join(directory, STATE_FILE_NAME);

  /**
   * 读取并规范化本地配置。
   * 文件不存在时返回默认配置；内容损坏时返回默认配置并附带提示。
   *
   * @returns {Promise<{state: object, issues: Array}>}
   */
  async function read() {
    let text;
    try {
      text = await fs.promises.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT")
        return { state: createDefaultState(), issues: [] };
      throw new Error(`读取本地配置失败：${errorMessage(error)}`);
    }
    try {
      return normalizeState(JSON.parse(text));
    } catch (error) {
      return {
        state: createDefaultState(),
        issues: [
          createIssue(
            "warning",
            `本地配置内容已损坏（${errorMessage(error)}），已重置为默认配置。`,
          ),
        ],
      };
    }
  }

  /**
   * 原子写入配置：先写同目录临时文件并 fsync，再改名覆盖正式文件。
   *
   * @param {object} state - 待保存的配置对象（会被规范化，多的字段不会落盘）
   * @returns {Promise<void>}
   * @throws {Error} 写入失败时抛出（临时文件会被清理）
   */
  async function write(state) {
    const payload = {
      repositoryPath: state.repositoryPath,
      groups: state.groups.map((group) => ({
        id: group.id,
        name: group.name,
        skillIds: [...new Set(group.skillIds || [])],
      })),
      agents: state.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        directory: agent.directory,
      })),
      enabledSkills: Object.fromEntries(
        state.agents.map((agent) => [
          agent.id,
          [...new Set(state.enabledSkills[agent.id] || [])],
        ]),
      ),
      cachedSkills: state.cachedSkills,
      theme: state.theme === "dark" ? "dark" : "light",
    };
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    try {
      await fs.promises.mkdir(directory, { recursive: true });
      handle = await fs.promises.open(temporaryPath, "w");
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.rename(temporaryPath, filePath);
    } catch (error) {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
      throw new Error(`保存本地配置失败：${errorMessage(error)}`);
    }
  }

  /**
   * 删除本地配置文件（用于清除数据）。文件不存在视为成功。
   *
   * @returns {Promise<void>}
   */
  async function clear() {
    try {
      await fs.promises.unlink(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT")
        throw new Error(`清除本地配置失败：${errorMessage(error)}`);
    }
  }

  return { clear, read, write };
}

module.exports = {
  MAX_ENTITY_NAME_LENGTH,
  createConfigStore,
  createDefaultState,
  uniqueEntityName,
};
