/**
 * 配置结构定义与纯函数：默认值、规范化与持久化结构组装。
 *
 * 本文件不做任何文件系统或存储访问，因此可以脱离运行环境直接测试。
 * 目录解析、问题收集与读写分别由 config-parser.js 与 config-store.js 承担。
 */
const path = require("node:path");

const CONFIG_VERSION = 4;
const MAX_ENTITY_NAME_LENGTH = 120;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeRecordKey(value) {
  return !["__proto__", "prototype", "constructor"].includes(value);
}

function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    repositoryPath: "",
    groups: [],
    agents: [],
    enabledSkills: {},
    theme: "light",
  };
}

function normalizeCachedSkills(input) {
  if (!Array.isArray(input)) return [];
  const ids = new Set();
  return input.flatMap((item) => {
    if (!isPlainObject(item)) return [];
    const skill = {
      id: String(item.id || "").trim(),
      name: String(item.name || "").trim(),
      relativePath: String(item.relativePath || "").trim(),
      folderName: String(item.folderName || "").trim(),
      sourcePath: String(item.sourcePath || "").trim(),
    };
    if (
      !Object.values(skill).every(Boolean) ||
      skill.folderName !== path.basename(skill.folderName) ||
      skill.folderName === "." ||
      skill.folderName === ".." ||
      ids.has(skill.id)
    )
      return [];
    ids.add(skill.id);
    return [skill];
  });
}

function normalizeManagedLinks(input) {
  if (!isPlainObject(input)) return {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([skillId, link]) => {
      if (
        !skillId ||
        !isPlainObject(link) ||
        typeof link.linkPath !== "string" ||
        !link.linkPath ||
        typeof link.sourcePath !== "string" ||
        !link.sourcePath
      )
        return [];

      let identity;
      if (isPlainObject(link.identity)) {
        identity = {
          dev: Number(link.identity.dev),
          ino: Number(link.identity.ino),
          birthtimeMs: Number(link.identity.birthtimeMs),
        };
        if (!Object.values(identity).every(Number.isFinite)) return [];
      }
      return [
        [
          String(skillId),
          {
            linkPath: link.linkPath,
            sourcePath: link.sourcePath,
            ...(identity ? { identity } : {}),
            ...(link.pending === true ? { pending: true } : {}),
          },
        ],
      ];
    }),
  );
}

/**
 * 把运行期字段挂到配置对象上（不参与序列化）。
 *
 * @param {object} config - 业务配置对象
 * @param {object} context - 形如 { _issues, _syncLocked, _orphanAgents, _cachedSkills, _revision } 的运行期字段
 * @returns {object} 同一个配置对象
 */
function attachRuntime(config, context) {
  Object.entries(context).forEach(([key, value]) => {
    Object.defineProperty(config, key, {
      value,
      enumerable: false,
      writable: true,
    });
  });
  return config;
}

/** 组装真正落盘的结构：只包含业务字段，运行期字段一律不写入。 */
function buildStoredState(config) {
  return {
    version: CONFIG_VERSION,
    repositoryPath: config.repositoryPath,
    groups: config.groups.map((group) => ({
      id: group.id,
      name: group.name,
      skillIds: [...new Set(group.skillIds || [])],
    })),
    agents: config.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      directory: agent.directory,
      managedLinks: normalizeManagedLinks(agent.managedLinks),
    })),
    enabledSkills: Object.fromEntries(
      config.agents.map((agent) => [
        agent.id,
        [...new Set(config.enabledSkills[agent.id] || [])],
      ]),
    ),
    theme: config.theme === "dark" ? "dark" : "light",
    cachedSkills: normalizeCachedSkills(config._cachedSkills),
    orphanAgents: (config._orphanAgents || []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      directory: agent.directory,
      managedLinks: normalizeManagedLinks(agent.managedLinks),
    })),
  };
}

module.exports = {
  CONFIG_VERSION,
  MAX_ENTITY_NAME_LENGTH,
  attachRuntime,
  buildStoredState,
  createDefaultConfig,
  isPlainObject,
  isSafeRecordKey,
  normalizeCachedSkills,
  normalizeManagedLinks,
};
