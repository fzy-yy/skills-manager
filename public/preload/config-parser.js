/**
 * 本地配置的校验与解析。
 *
 * 职责：把磁盘上的任意 JSON 转成可信的内部结构，并把无法安全使用的情况
 * 转成"可展示的问题 + 只读保护标记"。不负责读写文件（见 config-store.js）。
 */
const { findDuplicateDirectory } = require("./path-safety");
const { createIssue, uniqueIssues } = require("./runtime");
const {
  CONFIG_VERSION,
  attachRuntime,
  isPlainObject,
  isSafeRecordKey,
  normalizeCachedSkills,
  normalizeManagedLinks,
} = require("./config-schema");

/** 已向界面播报过的配置问题：同一问题在本次运行期内只提示一次，避免每次操作都重复弹出。 */
const reportedConfigIssues = new Set();

function takeUnreportedIssues(issues) {
  return issues.filter((issue) => {
    const key = `${issue.type}:${issue.message}`;
    if (reportedConfigIssues.has(key)) return false;
    reportedConfigIssues.add(key);
    return true;
  });
}

/**
 * 一次完成配置校验和解析。关键字段异常时返回可展示的安全快照，
 * 同时设置只读保护，避免规范化后的缺省值触发链接删除。
 *
 * @param {object} stored - 从本地存储读到的原始数据
 * @param {{recovered?: boolean, revision?: string}} storageContext - 读取上下文
 * @returns {Promise<object>} 内部配置对象（运行期字段通过 attachRuntime 挂载）
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
      group.skillIds.some(
        (skillId) => typeof skillId !== "string" || !skillId,
      ) ||
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
      Object.keys(managedLinks).length !==
        Object.keys(agent.managedLinks || {}).length ||
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
      Object.keys(managedLinks).length !==
        Object.keys(agent.managedLinks || {}).length
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

  const directories = agents.map((agent) => agent.directory).filter(Boolean);
  const duplicatedDirectory = await findDuplicateDirectory(directories);
  if (duplicatedDirectory)
    fail(`多个 Agent 指向同一个 Skills 目录：${duplicatedDirectory}`);

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
      _issues: takeUnreportedIssues(uniqueIssues(issues)),
      _syncLocked: locked,
      _orphanAgents: orphanAgents,
      _cachedSkills: cachedSkills,
      _revision: String(storageContext.revision || ""),
    },
  );
}

module.exports = { parseStoredState };
