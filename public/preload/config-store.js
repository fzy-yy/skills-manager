/** 配置解析、校验与本地持久化。 */
const path = require("node:path");
const { createLocalStorage } = require("./local-storage");
const { createIssue, errorMessage, uniqueIssues } = require("./runtime");
const { pathsEqual } = require("./path-safety");

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

function storage() {
  return createLocalStorage(window.utools);
}

/**
 * 一次完成配置校验和解析。关键字段异常时返回可展示的安全快照，
 * 同时设置只读保护，避免规范化后的缺省值触发链接删除。
 */
async function parseStoredState(stored, storageContext) {
  const issues = [];
  let locked = false;
  const fail = (message) => {
    locked = true;
    issues.push(
      createIssue(
        "error",
        `${message}，已进入只读保护。可在设置页清除数据后重新配置。`,
      ),
    );
  };

  if (!isPlainObject(stored)) {
    fail("本地配置文件不是有效对象");
    stored = {};
  }
  if (stored.version !== CONFIG_VERSION)
    fail(`不支持的配置版本“${String(stored.version)}”`);
  if (typeof stored.repositoryPath !== "string")
    fail("Skills 仓库路径格式异常");
  if (!Array.isArray(stored.groups)) fail("分组数据格式异常");
  if (!Array.isArray(stored.agents)) fail("Agent 数据格式异常");
  if (!isPlainObject(stored.enabledSkills)) fail("Skills 启用配置格式异常");
  if (!Array.isArray(stored.cachedSkills)) fail("Skills 扫描缓存格式异常");
  if (!Array.isArray(stored.orphanAgents)) fail("待清理 Agent 数据格式异常");

  const groups = [];
  const groupIds = new Set();
  for (const group of Array.isArray(stored.groups) ? stored.groups : []) {
    const id = typeof group?.id === "string" ? group.id.trim() : "";
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    if (
      !isPlainObject(group) ||
      !id ||
      !isSafeRecordKey(id) ||
      !name ||
      !Array.isArray(group.skillIds) ||
      group.skillIds.some((skillId) => typeof skillId !== "string" || !skillId) ||
      groupIds.has(id)
    ) {
      fail("分组中存在无效字段、重复标识或无效的 skillIds");
      continue;
    }
    groupIds.add(id);
    groups.push({ id, name, skillIds: [...new Set(group.skillIds)] });
  }

  const agents = [];
  const agentIds = new Set();
  for (const agent of Array.isArray(stored.agents) ? stored.agents : []) {
    const id = typeof agent?.id === "string" ? agent.id.trim() : "";
    const name = typeof agent?.name === "string" ? agent.name.trim() : "";
    const directory =
      typeof agent?.directory === "string" ? agent.directory.trim() : "";
    const managedLinks = normalizeManagedLinks(agent?.managedLinks);
    if (
      !isPlainObject(agent) ||
      !id ||
      !isSafeRecordKey(id) ||
      !name ||
      typeof agent.directory !== "string" ||
      !isPlainObject(agent.managedLinks) ||
      Object.keys(managedLinks).length !== Object.keys(agent.managedLinks || {}).length ||
      agentIds.has(id)
    ) {
      fail("Agent 中存在无效字段、重复标识或受管链接记录");
      continue;
    }
    agentIds.add(id);
    agents.push({ id, name, directory, managedLinks });
  }

  const enabledSkills = {};
  const storedEnabled = isPlainObject(stored.enabledSkills)
    ? stored.enabledSkills
    : {};
  for (const agent of agents) {
    const values = storedEnabled[agent.id];
    if (
      !Array.isArray(values) ||
      values.some((skillId) => typeof skillId !== "string" || !skillId)
    ) {
      fail(`Agent“${agent.id}”缺少有效的 Skills 启用数组`);
      enabledSkills[agent.id] = [];
    } else {
      enabledSkills[agent.id] = [...new Set(values)];
    }
  }
  for (const agentId of Object.keys(storedEnabled)) {
    if (!agentIds.has(agentId))
      fail(`Skills 启用配置包含未知 Agent“${agentId}”`);
  }

  const cachedSkills = normalizeCachedSkills(stored.cachedSkills);
  if (
    Array.isArray(stored.cachedSkills) &&
    cachedSkills.length !== stored.cachedSkills.length
  )
    fail("Skills 扫描缓存中存在无效记录");

  const orphanAgents = [];
  for (const agent of Array.isArray(stored.orphanAgents)
    ? stored.orphanAgents
    : []) {
    const managedLinks = normalizeManagedLinks(agent?.managedLinks);
    if (
      !isPlainObject(agent) ||
      typeof agent.id !== "string" ||
      !agent.id.trim() ||
      typeof agent.name !== "string" ||
      typeof agent.directory !== "string" ||
      !agent.directory.trim() ||
      !isPlainObject(agent.managedLinks) ||
      Object.keys(managedLinks).length !== Object.keys(agent.managedLinks || {}).length
    ) {
      fail("待清理 Agent 中存在无效字段或受管链接记录");
      continue;
    }
    orphanAgents.push({
      id: agent.id,
      name: agent.name,
      directory: agent.directory,
      managedLinks,
    });
  }
  if (orphanAgents.length)
    issues.push(
      createIssue(
        "warning",
        `有 ${orphanAgents.length} 个 Agent 目录仍有链接等待清理。请恢复对应目录后重新扫描仓库，或再次执行清除数据。`,
      ),
    );

  const directories = agents
    .map((agent) => agent.directory)
    .filter(Boolean);
  for (let index = 0; index < directories.length; index += 1) {
    for (let other = 0; other < index; other += 1) {
      if (await pathsEqual(directories[index], directories[other])) {
        fail(`多个 Agent 指向同一个 Skills 目录：${directories[index]}`);
        break;
      }
    }
  }

  const theme = stored.theme === "dark" ? "dark" : "light";
  if (stored.theme !== "light" && stored.theme !== "dark")
    issues.push(createIssue("warning", "本地主题值无效，已恢复为浅色主题。"));
  if (storageContext.recovered)
    issues.push(
      createIssue(
        "warning",
        "主配置文件不可用，已从本地备份恢复。建议确认配置后执行一次保存。",
      ),
    );

  return attachRuntime(
    {
      version: CONFIG_VERSION,
      repositoryPath:
        typeof stored.repositoryPath === "string" ? stored.repositoryPath : "",
      groups,
      agents,
      enabledSkills,
      theme,
    },
    {
      _issues: uniqueIssues(issues),
      _syncLocked: locked,
      _orphanAgents: orphanAgents,
      _cachedSkills: cachedSkills,
    },
  );
}

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

async function writeConfig(config) {
  try {
    await storage().commit(buildStoredState(config));
  } catch (error) {
    throw new Error(`保存本地配置失败：${errorMessage(error)}`);
  }
}

async function writeTheme(config) {
  if (config._syncLocked)
    throw new Error(
      "本地配置文件关键数据异常，无法安全保存主题；请先清除数据并重新配置",
    );
  await writeConfig(config);
}

async function readConfig() {
  try {
    const result = await storage().read();
    if (!result.data)
      return attachRuntime(createDefaultConfig(), {
        _issues: [],
        _syncLocked: false,
        _orphanAgents: [],
        _cachedSkills: [],
      });
    return parseStoredState(result.data, result);
  } catch (error) {
    throw new Error(`读取本地配置失败：${errorMessage(error)}`);
  }
}

async function clearStoredConfig() {
  try {
    await storage().clear();
  } catch (error) {
    throw new Error(`清除本地配置失败：${errorMessage(error)}`);
  }
}

module.exports = {
  MAX_ENTITY_NAME_LENGTH,
  attachRuntime,
  clearStoredConfig,
  createDefaultConfig,
  isSafeRecordKey,
  normalizeCachedSkills,
  normalizeManagedLinks,
  readConfig,
  writeConfig,
  writeTheme,
};
