/**
 * Skills 管理器 —— uTools 预加载脚本（preload）。
 *
 * 运行环境：uTools 的 preload 环境（Electron 渲染进程 + Node.js 原生能力）。
 * 该脚本按 uTools 规范不做打包/压缩，并在 window 上挂载 skillsManager 对象，
 * 供前端 Vue 应用调用（调用方见 src/stores/appStore.js）。
 *
 * 职责划分：
 *  1. 配置持久化：全部配置写入 uTools 本地数据库（utools.dbStorage），不落地 JSON 配置文件；
 *  2. 目录扫描：递归扫描统一 Skills 仓库，识别包含 SKILL.md 的目录并解析其中的 YAML 元数据 name；
 *  3. 链接同步：按「Agent + 已启用 Skills」在 Agent 目录下创建指向仓库源目录的目录链接；
 *  4. 安全兜底：只删除本应用创建且校验通过的链接，其余文件/目录/链接一律保留并给出提示。
 *
 * 三条核心安全原则（贯穿全文）：
 *  A. 只管理自己创建的东西：删除前必须同时校验链接路径、链接目标与创建时记录的文件标识；
 *  B. 数据不完整就不做清理：扫描不完整或数据库结构异常时进入只读保护，绝不依据兜底空值删文件；
 *  C. 配置单文档原子保存：业务配置与设备级链接记录一次写入，避免多键部分成功造成状态撕裂。
 */

// Node.js 文件系统模块：读取 SKILL.md、创建/删除链接、遍历目录。
const fs = require("node:fs");
// Promise 版本的文件系统 API 会把 I/O 交给 Node.js 线程池，避免阻塞 uTools 渲染线程。
const fsp = fs.promises;
// Node.js 路径模块：跨平台地拼接、解析路径并计算相对路径。
const path = require("node:path");

// 配置结构版本号：配置结构变更时递增，便于将来做数据迁移。
const CONFIG_VERSION = 2;
// 所有同步配置集中在一个文档内，dbStorage.setItem 单次写入不会出现半份新、半份旧的配置。
const STATE_KEY = "skills-manager/state-v2";
// 单次只读文件操作的最长等待时间；超时只中止本轮业务，不执行危险清理。
const FILE_READ_TIMEOUT_MS = 15_000;
// 扫描边界：防止误选磁盘根目录或超大目录后无限遍历，数值足以覆盖正常 Skills 仓库。
const MAX_SCAN_DIRECTORIES = 20_000;
const MAX_SCAN_DEPTH = 64;
const MAX_SCAN_DURATION_MS = 30_000;
const MAX_SCAN_ISSUES = 50;
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;
// 仅用于把当前开发阶段已经产生的 v1 数据迁移到单文档结构，不涉及旧 JSON 文件。
const LEGACY_STORAGE_KEYS = Object.freeze({
  version: "skills-manager/version",
  repositoryPath: "skills-manager/repository-path",
  groups: "skills-manager/groups",
  agents: "skills-manager/agents",
  enabledGroups: "skills-manager/enabled-groups",
  theme: "skills-manager/theme",
});

// ============================================================================
// 一、配置结构与存取
// ============================================================================

/**
 * 创建一份默认配置（首次使用或清除数据后返回）。
 *
 * @returns {{version: number, repositoryPath: string, groups: Array, agents: Array, enabledGroups: object, enabledSkills: object, theme: string}}
 */
// 配置只存入 uTools dbStorage；文件系统仅用于扫描 Skill 和维护链接。
function createDefaultConfig() {
  return {
    version: CONFIG_VERSION,
    repositoryPath: "",
    groups: [],
    agents: [],
    enabledGroups: {},
    enabledSkills: {},
    theme: "light",
  };
}

/**
 * 把任意异常整理成可直接展示给用户的中文文案。
 * Node.js 异常通常带 code（如 ENOENT、EPERM、EACCES），拼接后更利于排查问题。
 *
 * @param {any} error - 捕获到的异常
 * @returns {string} 形如「ENOENT：no such file or directory」的文案
 */
function errorMessage(error) {
  if (!error) return "未知错误";
  const code = error.code ? `${error.code}：` : "";
  return `${code}${error.message || String(error)}`;
}

/**
 * 构造一条「问题记录」。问题不会中断流程，而是汇总后交给前端统一提示。
 *
 * @param {'error'|'warning'|'info'} type - 严重级别，error 表示本次操作的关键步骤失败
 * @param {string} message - 面向用户的中文说明
 * @returns {{type: string, message: string}}
 */
function createIssue(type, message) {
  return {
    type: type === "error" ? "error" : type === "info" ? "info" : "warning",
    message,
  };
}

/**
 * 按「类型 + 文案」对问题列表去重，避免同一问题在多轮扫描/同步中被反复提示。
 *
 * @param {Array<{type: string, message: string}>} issues - 原始问题列表
 * @returns {Array} 去重后的问题列表
 */
function uniqueIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue.type}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 为只读文件系统操作增加超时保护。
 * Node.js 16 无法取消所有底层目录调用，但超时后业务流程会立即恢复，且不会继续执行删除操作。
 *
 * @template T
 * @param {Promise<T>} operation - 文件系统 Promise
 * @param {string} label - 超时时显示的操作名称
 * @returns {Promise<T>}
 */
function withReadTimeout(operation, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}超时（${FILE_READ_TIMEOUT_MS / 1000} 秒）`);
      error.code = "ETIMEDOUT";
      reject(error);
    }, FILE_READ_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

/** 判断路径是否存在；访问失败统一按不存在处理，由上层按只读保护规则决定后续动作。 */
async function pathExists(target) {
  try {
    await withReadTimeout(fsp.access(target), `访问路径 ${target}`);
    return true;
  } catch (_) {
    return false;
  }
}

/** 规范化缓存的 Skill 扫描结果，缓存仅用于首屏展示，不参与未校验的删除决策。 */
function normalizeCachedSkills(input) {
  if (!Array.isArray(input)) return [];
  const ids = new Set();
  return input.flatMap((item) => {
    if (!isPlainObject(item)) return [];
    const id = String(item.id || "").trim();
    const name = String(item.name || "").trim();
    const relativePath = String(item.relativePath || "").trim();
    const folderName = String(item.folderName || "").trim();
    const sourcePath = String(item.sourcePath || "").trim();
    if (
      !id ||
      !name ||
      !relativePath ||
      !folderName ||
      !sourcePath ||
      folderName !== path.basename(folderName) ||
      folderName === "." ||
      folderName === ".." ||
      ids.has(id)
    )
      return [];
    ids.add(id);
    return [{ id, name, relativePath, folderName, sourcePath }];
  });
}

/**
 * 规范化「受管链接」记录，即 { [skillId]: { linkPath, sourcePath, identity?, pending? } } 结构。
 * 记录损坏（非对象、缺少路径字段）时直接丢弃，避免污染后续的同步与删除逻辑。
 *
 * @param {any} input - 数据库中保存的 managedLinks 原始值
 * @returns {object} 清理后的受管链接映射
 */
function normalizeManagedLinks(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input).flatMap(([skillId, link]) => {
      // 缺少 skillId 或链接记录的条目无法管理，直接跳过。
      if (!skillId || !link || typeof link !== "object") return [];
      // linkPath（Agent 目录下的链接位置）与 sourcePath（仓库中的源目录）必须是字符串，否则无法做安全检查。
      if (
        typeof link.linkPath !== "string" ||
        typeof link.sourcePath !== "string"
      )
        return [];
      // identity 用于确认「该链接仍然是当初由本应用创建的那一条」：设备号 + inode + 创建时间。
      const identity =
        link.identity && typeof link.identity === "object"
          ? {
              dev: Number(link.identity.dev),
              ino: Number(link.identity.ino),
              birthtimeMs: Number(link.identity.birthtimeMs),
            }
          : null;
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

/** 根据启用的 Skill 集合推导完整覆盖的分组，空分组不视为已启用。 */
function deriveEnabledGroupIds(groups, skillIds) {
  const enabledSkillIds = new Set(skillIds);
  return groups
    .filter(
      (group) =>
        group.skillIds.length > 0 &&
        group.skillIds.every((skillId) => enabledSkillIds.has(skillId)),
    )
    .map((group) => group.id);
}

/** 把旧的分组启用关系转换为 Skill 集合，兼容当前开发阶段已经保存的数据。 */
function deriveSkillIdsFromGroups(groups, groupIds) {
  const enabledGroupIds = new Set(groupIds);
  return [
    ...new Set(
      groups
        .filter((group) => enabledGroupIds.has(group.id))
        .flatMap((group) => group.skillIds),
    ),
  ];
}

/**
 * 规范化完整配置：清洗分组、Agent、启用关系与主题，保证结构可直接用于后续逻辑。
 * 所有字段都做类型校验与去重，异常记录被忽略而不是让整份配置失效。
 *
 * @param {any} input - 从数据库读出的原始配置
 * @returns {object} 结构合法的配置对象（还会被 readConfig 附加不可枚举的 _issues / _syncLocked）
 */
function normalizeConfig(input) {
  const config = input && typeof input === "object" ? input : {};
  const groups = [];
  const groupIds = new Set();
  // 分组：要求 id 与 name 非空且 id 唯一；skillIds 去重后统一转为字符串数组。
  for (const item of Array.isArray(config.groups) ? config.groups : []) {
    const id = String(item?.id || "").trim();
    const name = String(item?.name || "").trim();
    if (!id || !name || groupIds.has(id)) continue;
    groupIds.add(id);
    groups.push({
      id,
      name,
      skillIds: [
        ...new Set(
          (Array.isArray(item.skillIds) ? item.skillIds : []).map(String),
        ),
      ],
    });
  }

  // Agent：名称与标识属于共享配置；目录为空表示当前设备尚未配置。
  const agents = [];
  const agentIds = new Set();
  for (const item of Array.isArray(config.agents) ? config.agents : []) {
    const id = String(item?.id || "").trim();
    const name = String(item?.name || "").trim();
    const directory = String(item?.directory || "").trim();
    if (!id || !name || !isSafeRecordKey(id) || agentIds.has(id)) continue;
    agentIds.add(id);
    agents.push({
      id,
      name,
      directory,
      managedLinks: normalizeManagedLinks(item.managedLinks),
      // 外部同源链接不受本应用管理，仅缓存最近一次核验数量用于首屏统计。
      externalLinkedCount:
        Number.isInteger(item.externalLinkedCount) &&
        item.externalLinkedCount >= 0
          ? item.externalLinkedCount
          : 0,
    });
  }

  // Skill 启用关系是应用配置的唯一真值；旧数据没有该字段时由已启用分组无损转换。
  const enabledSkills = {};
  const storedEnabledSkills = isPlainObject(config.enabledSkills)
    ? config.enabledSkills
    : null;
  // 分组启用关系仅为派生缓存，供状态返回与旧数据迁移使用。
  const enabledGroups = {};
  const storedEnabledGroups =
    isPlainObject(config.enabledGroups)
      ? config.enabledGroups
      : {};
  agents.forEach((agent) => {
    const legacyGroupIds = [
      ...new Set(
        (Array.isArray(storedEnabledGroups[agent.id])
          ? storedEnabledGroups[agent.id]
          : []
        ).map(String),
      ),
    ].filter((groupId) => groupIds.has(groupId));
    enabledSkills[agent.id] = [
      ...new Set(
        (storedEnabledSkills && Array.isArray(storedEnabledSkills[agent.id])
          ? storedEnabledSkills[agent.id]
          : deriveSkillIdsFromGroups(groups, legacyGroupIds)
        ).map(String),
      ),
    ].filter(Boolean);
    enabledGroups[agent.id] = deriveEnabledGroupIds(
      groups,
      enabledSkills[agent.id],
    );
  });

  return {
    version: CONFIG_VERSION,
    repositoryPath:
      typeof config.repositoryPath === "string" ? config.repositoryPath : "",
    groups,
    agents,
    enabledGroups,
    enabledSkills,
    theme: config.theme === "dark" ? "dark" : "light",
  };
}

/**
 * 获取 uTools 本地数据库（dbStorage）句柄。
 *
 * @returns {object} utools.dbStorage 实例
 * @throws {Error} 不在 uTools 环境中（未加载 preload）时抛出
 */
function database() {
  const storage = window.utools?.dbStorage;
  if (!storage)
    throw new Error(
      "uTools 本地数据库不可用，请在 uTools 插件环境中重新打开应用",
    );
  return storage;
}

/** 获取稳定的本机标识，用于隔离不可跨设备复用的链接路径与文件标识。 */
function nativeId() {
  const id = window.utools?.getNativeId?.();
  if (!id) throw new Error("无法获取 uTools 本机 ID，已停止链接操作以保护本地文件");
  return String(id);
}

/** 判断值是否为可枚举键值对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 判断字符串能否安全用作普通对象的业务键，避免原型属性污染配置映射。 */
function isSafeRecordKey(value) {
  return !["__proto__", "prototype", "constructor"].includes(value);
}

/** 为配置附加不会写入业务字段的运行期上下文。 */
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

/**
 * 深度校验同步配置与本机链接状态。任何可能改变链接集合的嵌套异常都会进入只读保护，
 * 绝不再把损坏的数组静默当成空数组执行删除。
 */
async function validateStoredState(stored, deviceState, legacy = false) {
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

  if (!isPlainObject(stored)) fail("本地数据库主配置不是有效对象");
  if (!legacy && stored?.version !== CONFIG_VERSION)
    fail(`不支持的配置版本“${String(stored?.version)}”`);
  if (!legacy && !isPlainObject(stored?.deviceStates))
    fail("设备状态分区格式异常");
  if (typeof stored?.repositoryPath !== "string") fail("Skills 仓库路径格式异常");
  if (!Array.isArray(stored?.groups)) fail("分组数据格式异常");
  if (!Array.isArray(stored?.agents)) fail("Agent 数据格式异常");
  if (!isPlainObject(stored?.enabledGroups)) fail("应用配置格式异常");
  if (
    stored?.enabledSkills !== undefined &&
    !isPlainObject(stored.enabledSkills)
  )
    fail("Skills 启用配置格式异常");

  const groupIds = new Set();
  if (Array.isArray(stored?.groups)) {
    stored.groups.forEach((group) => {
      if (
        !isPlainObject(group) ||
        typeof group.id !== "string" ||
        !group.id.trim() ||
        typeof group.name !== "string" ||
        !group.name.trim() ||
        !Array.isArray(group.skillIds) ||
        group.skillIds.some((id) => typeof id !== "string") ||
        groupIds.has(group.id)
      ) {
        fail("分组中存在无效字段、重复标识或非数组的 skillIds");
      } else groupIds.add(group.id);
    });
  }

  const agentIds = new Set();
  if (Array.isArray(stored?.agents)) {
    stored.agents.forEach((agent) => {
      if (
        !isPlainObject(agent) ||
        typeof agent.id !== "string" ||
        !agent.id.trim() ||
        !isSafeRecordKey(agent.id) ||
        typeof agent.name !== "string" ||
        !agent.name.trim() ||
        typeof agent.directory !== "string" ||
        agentIds.has(agent.id)
      ) {
        fail("Agent 中存在无效字段或重复标识");
      } else agentIds.add(agent.id);
    });
  }

  if (isPlainObject(stored?.enabledGroups)) {
    agentIds.forEach((agentId) => {
      if (!Array.isArray(stored.enabledGroups[agentId]))
        fail(`Agent“${agentId}”缺少有效的启用分组数组`);
    });
    Object.entries(stored.enabledGroups).forEach(([agentId, groupIdsValue]) => {
      if (
        !agentIds.has(agentId) ||
        !Array.isArray(groupIdsValue) ||
        groupIdsValue.some(
          (id) => typeof id !== "string" || !groupIds.has(id),
        )
      ) {
        fail(`Agent“${agentId}”的启用分组数据无效`);
      }
    });
  }

  // enabledSkills 是新增的规范字段；字段缺失表示尚未从旧分组关系转换，不判为损坏。
  if (isPlainObject(stored?.enabledSkills)) {
    agentIds.forEach((agentId) => {
      if (!Array.isArray(stored.enabledSkills[agentId]))
        fail(`Agent“${agentId}”缺少有效的 Skills 启用数组`);
    });
    Object.entries(stored.enabledSkills).forEach(([agentId, skillIds]) => {
      if (
        !agentIds.has(agentId) ||
        !Array.isArray(skillIds) ||
        skillIds.some((id) => typeof id !== "string" || !id)
      )
        fail(`Agent“${agentId}”的 Skills 启用数据无效`);
    });
  }

  if (!isPlainObject(deviceState) || !isPlainObject(deviceState.agents)) {
    fail("本机链接状态格式异常");
  } else {
    if (typeof deviceState.repositoryPath !== "string") {
      fail("本机 Skills 仓库路径格式异常");
    }
    const localDirectories = [];
    Object.entries(deviceState.agents).forEach(([agentId, localAgent]) => {
      if (
        !isSafeRecordKey(agentId) ||
        !isPlainObject(localAgent) ||
        typeof localAgent.directory !== "string" ||
        !localAgent.directory.trim() ||
        !isPlainObject(localAgent.managedLinks)
      )
        fail(`Agent“${agentId}”的本机链接记录无效`);
      else if (
        Object.keys(normalizeManagedLinks(localAgent.managedLinks)).length !==
        Object.keys(localAgent.managedLinks).length
      ) {
        fail(`Agent“${agentId}”包含无法识别的受管链接记录`);
      } else if (
        Object.values(localAgent.managedLinks).some(
          (link) =>
            (link.pending !== undefined && link.pending !== true) ||
            (link.identity &&
              (!Number.isFinite(Number(link.identity.dev)) ||
                !Number.isFinite(Number(link.identity.ino)) ||
                !Number.isFinite(Number(link.identity.birthtimeMs)))),
        )
      ) {
        fail(`Agent“${agentId}”包含无效的链接文件标识`);
      }
      if (
        typeof localAgent?.directory === "string" &&
        localAgent.directory.trim()
      )
        localDirectories.push(localAgent.directory);
    });
    // 路径别名需要解析真实目录后比较，因此使用异步循环，避免 realpath 阻塞界面。
    for (let index = 0; index < localDirectories.length; index += 1) {
      for (let other = 0; other < index; other += 1) {
        if (await pathsEqual(localDirectories[index], localDirectories[other])) {
          fail(`多个本机 Agent 指向同一个 Skills 目录：${localDirectories[index]}`);
          break;
        }
      }
    }
  }

  if (stored?.theme !== "light" && stored?.theme !== "dark") {
    issues.push(createIssue("warning", "本地数据库中的主题值无效，已恢复为浅色主题。"));
  }
  return { issues: uniqueIssues(issues), locked };
}

/** 读取旧版 dbStorage 多键配置，仅用于一次性迁移当前开发数据。 */
function readLegacyConfig(storage) {
  const stored = {};
  Object.entries(LEGACY_STORAGE_KEYS).forEach(([field, key]) => {
    stored[field] = storage.getItem(key);
  });
  return Object.values(stored).some((value) => value != null) ? stored : null;
}

/** 把内存配置转换为单文档结构，并只更新当前设备的本地状态分区。 */
function buildStoredState(
  config,
  latestDeviceStates = config._deviceStates || {},
) {
  const normalized = normalizeConfig(config);
  const deviceId = config._deviceId || nativeId();
  const deviceStates = { ...latestDeviceStates };
  const localAgents = {};
  [...normalized.agents, ...(config._orphanAgents || [])].forEach((agent) => {
    // 空目录表示该 Agent 尚未在当前设备配置，不生成本机记录。
    if (!agent.directory) return;
    localAgents[agent.id] = {
      name: agent.name,
      directory: agent.directory,
      managedLinks: normalizeManagedLinks(agent.managedLinks),
      externalLinkedCount: agent.externalLinkedCount || 0,
    };
  });
  if (Object.keys(localAgents).length || normalized.repositoryPath) {
    deviceStates[deviceId] = {
      repositoryPath: normalized.repositoryPath,
      agents: localAgents,
      // 扫描缓存只用于当前设备首屏展示；实际同步前始终重新扫描校验。
      skills: normalizeCachedSkills(config._cachedSkills),
    };
  } else delete deviceStates[deviceId];

  return {
    version: CONFIG_VERSION,
    // 路径不可跨设备复用；共享层只保留字段骨架，真实值位于 deviceStates。
    repositoryPath: "",
    groups: normalized.groups,
    agents: normalized.agents.map(({ id, name }) => ({
      id,
      name,
      directory: "",
    })),
    enabledGroups: normalized.enabledGroups,
    enabledSkills: normalized.enabledSkills,
    theme: normalized.theme,
    deviceStates,
  };
}

/** 单次原子写入全部配置，避免多键循环写入产生部分成功。 */
function writeConfig(config) {
  try {
    const storage = database();
    // 写入前重新读取最新设备分区，避免本设备用旧快照覆盖其他设备刚保存的本地记录。
    const latest = storage.getItem(STATE_KEY);
    const latestDeviceStates =
      latest?.version === CONFIG_VERSION && isPlainObject(latest.deviceStates)
        ? latest.deviceStates
        : config._deviceStates || {};
    storage.setItem(STATE_KEY, buildStoredState(config, latestDeviceStates));
  } catch (error) {
    throw new Error(`保存本地数据库失败：${errorMessage(error)}`);
  }
}

/** 读取单文档配置，并把当前设备的路径与链接记录合并到内存 Agent。 */
async function readConfig() {
  try {
    const storage = database();
    const deviceId = nativeId();
    let stored = storage.getItem(STATE_KEY);
    let legacy = false;
    if (stored == null) {
      stored = readLegacyConfig(storage);
      legacy = Boolean(stored);
    }
    if (!stored) {
      return attachRuntime(createDefaultConfig(), {
        _issues: [],
        _syncLocked: false,
        _deviceId: deviceId,
        _deviceStates: {},
        _orphanAgents: [],
        _cachedSkills: [],
        _storedState: null,
        _legacy: false,
      });
    }

    const deviceStates = isPlainObject(stored.deviceStates)
      ? stored.deviceStates
      : {};
    let deviceState = isPlainObject(deviceStates[deviceId])
      ? deviceStates[deviceId]
      : { repositoryPath: "", agents: {} };
    if (legacy) {
      deviceState = {
        repositoryPath: stored.repositoryPath,
        agents: Object.fromEntries(
          (Array.isArray(stored.agents) ? stored.agents : []).map((agent) => [
            String(agent?.id || ""),
            {
              name: agent?.name,
              directory: agent?.directory,
              managedLinks: agent?.managedLinks || {},
            },
          ]),
        ),
      };
    }

    const validation = await validateStoredState(stored, deviceState, legacy);
    const localAgentRecords = isPlainObject(deviceState.agents)
      ? deviceState.agents
      : {};
    const mergedAgents = (Array.isArray(stored.agents) ? stored.agents : []).map(
      (agent) => {
        const local = localAgentRecords[agent.id];
        return {
          ...agent,
          directory:
            typeof local?.directory === "string"
              ? local.directory
              : legacy
                ? agent.directory
                : "",
          managedLinks: local?.managedLinks || agent.managedLinks || {},
          externalLinkedCount: local?.externalLinkedCount || 0,
        };
      },
    );
    const config = normalizeConfig({
      ...stored,
      repositoryPath:
        typeof deviceState.repositoryPath === "string"
          ? deviceState.repositoryPath
          : legacy
            ? stored.repositoryPath
            : "",
      agents: mergedAgents,
    });
    const currentIds = new Set(config.agents.map((agent) => agent.id));
    const orphanAgents = Object.entries(localAgentRecords)
      .filter(([agentId]) => !currentIds.has(agentId))
      .map(([id, agent]) => ({
        id,
        name: agent.name || id,
        directory: agent.directory || "",
        managedLinks: normalizeManagedLinks(agent.managedLinks),
      }))
      .filter((agent) => agent.directory);
    if (legacy && !validation.locked)
      validation.issues.push(
        createIssue(
          "info",
          "旧版数据库配置已载入，本次刷新会转换为设备隔离的单文档结构。",
        ),
      );
    return attachRuntime(config, {
      _issues: uniqueIssues(validation.issues),
      _syncLocked: validation.locked,
      _deviceId: deviceId,
      _deviceStates: deviceStates,
      _orphanAgents: orphanAgents,
      _cachedSkills: normalizeCachedSkills(deviceState.skills),
      _storedState: stored,
      _legacy: legacy,
    });
  } catch (error) {
    throw new Error(`读取本地数据库失败：${errorMessage(error)}`);
  }
}

/** 清除共享配置与当前设备状态；其他设备状态保留到对应设备下次启动后安全回收。 */
function clearStoredConfig(config) {
  try {
    const storage = database();
    const latest = storage.getItem(STATE_KEY);
    const deviceStates = {
      ...(latest?.version === CONFIG_VERSION &&
      isPlainObject(latest.deviceStates)
        ? latest.deviceStates
        : config._deviceStates || {}),
    };
    delete deviceStates[config._deviceId || nativeId()];
    if (Object.keys(deviceStates).length) {
      storage.setItem(STATE_KEY, { ...createDefaultConfig(), deviceStates });
    } else storage.removeItem(STATE_KEY);
    Object.values(LEGACY_STORAGE_KEYS).forEach((key) => storage.removeItem(key));
  } catch (error) {
    throw new Error(`清除本地数据库失败：${errorMessage(error)}`);
  }
}

// ============================================================================
// 二、路径工具与目录校验
// ============================================================================

/**
 * 校验并规范化目录路径：必须存在、可访问且是文件夹。
 *
 * @param {string} directory - 待校验的目录路径（允许带前后空格）
 * @param {string} [label='目录'] - 用于错误提示的名称，如「Skills 仓库目录」
 * @returns {string} 规范化后的绝对路径
 * @throws {Error} 路径为空、不存在、无权限或不是文件夹
 */
async function normalizeDirectory(directory, label = "目录") {
  if (typeof directory !== "string" || !directory.trim())
    throw new Error(`请选择有效的${label}`);
  const resolved = path.resolve(directory.trim());
  let stat;
  try {
    stat = await withReadTimeout(fsp.stat(resolved), `检查${label}`);
  } catch (error) {
    throw new Error(`${label}不存在或无法访问：${errorMessage(error)}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label}不是文件夹：${resolved}`);
  return resolved;
}

/**
 * 生成用于比较的规范化路径。
 * 处理三类差异：Windows 的 \\?\ 命名空间前缀、大小写不敏感、结尾多余的斜杠。
 *
 * @param {string} target - 任意路径
 * @returns {string} 可安全用于字符串比较的路径
 */
// 所有路径比较都兼容 Windows 大小写、目录链接和 \\?\ 命名空间前缀。
function comparablePath(target) {
  let normalized = path.normalize(
    path.resolve(String(target).replace(/^\\\\\?\\/, "")),
  );
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/, "");
}

/**
 * 判断两个路径是否指向同一位置。
 * 先做字符串比较（快路径），不一致时再用 realpath 解析软链接后比较（慢路径）。
 *
 * @param {string} left - 路径 A
 * @param {string} right - 路径 B
 * @returns {boolean} 是否指向同一位置
 */
async function pathsEqual(left, right) {
  try {
    if (comparablePath(left) === comparablePath(right)) return true;
    // 两侧都存在时才解析真实路径，避免对不存在的路径抛异常。
    const [leftExists, rightExists] = await Promise.all([
      pathExists(left),
      pathExists(right),
    ]);
    if (leftExists && rightExists) {
      const [leftRealPath, rightRealPath] = await Promise.all([
        withReadTimeout(fsp.realpath(left), `解析路径 ${left}`),
        withReadTimeout(fsp.realpath(right), `解析路径 ${right}`),
      ]);
      return (
        comparablePath(leftRealPath) === comparablePath(rightRealPath)
      );
    }
  } catch (_) {}
  return false;
}

/**
 * 判断 child 是否位于 parent 之内（与 parent 相同也算「在内」）。
 * 使用 realpath 解析，避免通过目录链接绕过包含关系检查。
 *
 * @param {string} parent - 父目录
 * @param {string} child - 待判断的目录
 * @returns {boolean} child 是否在 parent 内部
 */
async function isInsideDirectory(parent, child) {
  const canonical = async (target) => {
    try {
      return await withReadTimeout(fsp.realpath(target), `解析路径 ${target}`);
    } catch (_) {
      return path.resolve(target);
    }
  };
  const [canonicalParent, canonicalChild] = await Promise.all([
    canonical(parent),
    canonical(child),
  ]);
  const relative = path.relative(canonicalParent, canonicalChild);
  // 相对路径为空表示同一目录；以 .. 开头或为绝对路径则表示不在内部。
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * 校验 Agent 的 Skills 目录是否可以安全使用。
 * 三类禁止情况：磁盘根目录、与统一仓库目录互相包含、与其他 Agent 目录重复。
 *
 * @param {object} config - 当前配置
 * @param {string} directory - 待校验的 Agent 目录
 * @param {string} [currentAgentId=''] - 正在编辑的 Agent id（校验重复时排除自身）
 * @throws {Error} 目录不满足约束时抛出带原因的异常
 */
async function assertSafeAgentDirectory(
  config,
  directory,
  currentAgentId = "",
) {
  let canonicalDirectory = directory;
  // 优先使用 realpath，保证符号链接形式的根目录也能被识别。
  try {
    canonicalDirectory = await withReadTimeout(
      fsp.realpath(directory),
      `解析 Agent Skills 目录 ${directory}`,
    );
  } catch (_) {}
  if (path.parse(canonicalDirectory).root === canonicalDirectory)
    throw new Error("Agent Skills 目录不能是磁盘根目录");
  // 与仓库目录互相包含会导致「扫描结果里出现自己创建的链接」，形成递归干扰。
  if (
    config.repositoryPath &&
    ((await isInsideDirectory(config.repositoryPath, directory)) ||
      (await isInsideDirectory(directory, config.repositoryPath)))
  ) {
    throw new Error(
      "Agent Skills 目录不能与统一 Skills 仓库相同或互相包含，以免扫描和链接相互影响",
    );
  }
  // 同一目录被两个 Agent 使用会导致链接被互相删除，必须禁止。
  let duplicate;
  for (const agent of config.agents) {
    if (agent.id === currentAgentId || !agent.directory) continue;
    if (await pathsEqual(agent.directory, directory)) {
      duplicate = agent;
      break;
    }
  }
  if (duplicate)
    throw new Error(
      `该 Skills 目录已由 Agent“${duplicate.name}”使用，请选择其他目录`,
    );
  let pendingCleanup;
  for (const agent of config._orphanAgents || []) {
    if (agent.directory && (await pathsEqual(agent.directory, directory))) {
      pendingCleanup = agent;
      break;
    }
  }
  if (pendingCleanup)
    throw new Error(
      `该目录仍有 Agent“${pendingCleanup.name}”的受管链接等待清理，请处理相关错误后刷新再试`,
    );
}

// ============================================================================
// 三、SKILL.md 解析与仓库扫描
// ============================================================================

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
  let omittedIssueCount = 0;
  let visitedDirectoryCount = 0;
  const scanStartedAt = Date.now();
  // 显式栈避免递归调用栈溢出，并为深度与目录数量提供清晰边界。
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

/**
 * 为单个 Agent 的开关变更核验实际涉及的缓存 Skills。
 * 不递归扫描整个仓库；任一源目录不可用时标记为不完整，从而保留已有受管链接并停止危险清理。
 */
async function inspectEnabledCachedSkills(config, agent) {
  const desiredSkillIds = new Set(config.enabledSkills[agent.id] || []);
  const cachedById = new Map(
    normalizeCachedSkills(config._cachedSkills).map((skill) => [
      skill.id,
      skill,
    ]),
  );
  const skills = [];
  const issues = [];
  let complete = true;

  for (const skillId of desiredSkillIds) {
    const skill = cachedById.get(skillId);
    if (!skill) {
      complete = false;
      issues.push(
        createIssue(
          "warning",
          `Skill“${skillId}”不在最近一次完整扫描缓存中，已跳过创建。请重新扫描仓库后再试。`,
        ),
      );
      continue;
    }
    const insideRepository =
      config.repositoryPath &&
      (await isInsideDirectory(config.repositoryPath, skill.sourcePath));
    if (!insideRepository || !(await hasValidSkillFile(skill.sourcePath))) {
      complete = false;
      issues.push(
        createIssue(
          "warning",
          `Skill“${skill.name}”的源目录不可用或已不是有效 Skill，已跳过创建并保留现有链接。`,
        ),
      );
      continue;
    }
    skills.push(skill);
  }

  return { skills, issues: uniqueIssues(issues), complete };
}

// ============================================================================
// 四、链接检查与安全删除
// ============================================================================

/**
 * 检查某个路径的真实状态，用于判断它是否是「本应用创建的链接」。
 *
 * @param {string} linkPath - 待检查的路径
 * @param {string} [expectedSource] - 期望的链接目标（仓库源目录）
 * @returns {{kind: 'missing'|'directory'|'file'|'link'|'error', targetPath?: string, sameTarget?: boolean, dangling?: boolean, identity?: object, error?: Error}}
 *          kind 说明：missing 不存在；directory/file 是普通目录/文件（非链接）；
 *          link 是符号链接（附带目标、是否同源、是否失效、文件标识）；error 检查失败
 */
async function inspectLink(linkPath, expectedSource) {
  let stat;
  try {
    stat = await withReadTimeout(fsp.lstat(linkPath), `检查链接 ${linkPath}`);
  } catch (error) {
    // 路径不存在属于正常情况（尚未创建链接）。
    if (error.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error };
  }
  // 不是符号链接：可能是用户自己创建的目录或文件，必须保留。
  if (!stat.isSymbolicLink())
    return { kind: stat.isDirectory() ? "directory" : "file" };
  try {
    const rawTarget = await withReadTimeout(
      fsp.readlink(linkPath),
      `读取链接 ${linkPath}`,
    );
    // 相对目标的链接需要基于链接所在目录解析成绝对路径。
    const targetPath = path.isAbsolute(rawTarget)
      ? rawTarget
      : path.resolve(path.dirname(linkPath), rawTarget);
    return {
      kind: "link",
      targetPath,
      // 目标是否与期望的仓库源目录一致（不一致说明链接已被外部改写）。
      sameTarget: expectedSource
        ? await pathsEqual(targetPath, expectedSource)
        : false,
      // 目标不存在说明该链接已失效。
      dangling: !(await pathExists(targetPath)),
      // 文件标识：用于确认链接未被「删除后重建」。
      identity: {
        dev: Number(stat.dev),
        ino: Number(stat.ino),
        birthtimeMs: Number(stat.birthtimeMs),
      },
    };
  } catch (error) {
    return { kind: "error", error };
  }
}

/**
 * 比较创建链接时记录的文件标识与当前标识是否一致。
 * 三者任一不同，都说明该路径已不是本应用创建的那条链接。
 *
 * @param {object|undefined} stored - 创建时记录的 identity
 * @param {{dev: number, ino: number, birthtimeMs: number}} current - 当前读到的 identity
 * @returns {boolean} 是否仍归本应用管理（无历史记录时按兼容处理返回 true）
 */
// 只有路径、目标和创建时文件标识都匹配，才认定链接仍归本应用管理。
function identitiesEqual(stored, current) {
  if (!stored) return true;
  return (
    stored.dev === current.dev &&
    stored.ino === current.ino &&
    stored.birthtimeMs === current.birthtimeMs
  );
}

/**
 * 判断 child 是否是 parent 的直接子项（不跨层级）。
 * 用于确保受管链接只会出现在 Agent 目录的第一层。
 *
 * @param {string} parent - 父目录
 * @param {string} child - 待判断路径
 * @returns {boolean} 是否为直接子项
 */
async function isDirectChild(parent, child) {
  return pathsEqual(path.dirname(child), parent);
}

/**
 * 安全移除一条受管链接。
 *
 * 移除条件（必须全部满足）：路径位于允许目录内、仍是符号链接、目标未变、文件标识一致。
 * 任一条件不满足都只提示不删除，并把 relinquished 置为 true（表示放弃管理该记录）。
 *
 * @param {{linkPath: string, sourcePath: string, identity?: object, pending?: boolean}} link - 受管链接记录
 * @param {string} label - 用于提示文案的名称
 * @param {string} [allowedDirectory] - 允许删除的目录（通常是 Agent 目录）
 * @returns {{removed: boolean, relinquished: boolean, issues: Array}} removed 是否已删除；
 *          relinquished 是否已放弃管理（为 false 时调用方应保留该记录以便下次重试）
 */
async function removeOwnedLink(link, label, allowedDirectory) {
  // 记录不完整视作放弃管理，不做任何文件操作。
  if (!link?.linkPath || !link?.sourcePath)
    return { removed: false, relinquished: true, issues: [] };
  // 路径不在允许目录内：仅提示，绝不删除。
  if (
    allowedDirectory &&
    !(await isDirectChild(allowedDirectory, link.linkPath))
  ) {
    return {
      removed: false,
      relinquished: true,
      issues: [
        createIssue(
          "warning",
          `${label}超出 Agent 目录，记录已忽略且不会删除该路径。`,
        ),
      ],
    };
  }
  const inspected = await inspectLink(link.linkPath, link.sourcePath);
  // 已经不存在：视为管理结束，无需提示。
  if (inspected.kind === "missing")
    return { removed: false, relinquished: true, issues: [] };
  // 检查失败（权限等）：保留记录，下次再试。
  if (inspected.kind === "error") {
    return {
      removed: false,
      relinquished: false,
      issues: [
        createIssue(
          "error",
          `无法检查${label}：${errorMessage(inspected.error)}`,
        ),
      ],
    };
  }
  // 不是链接、目标被改写或文件标识不符 → 已非本应用创建，停止管理并保留现场。
  if (
    inspected.kind !== "link" ||
    !inspected.sameTarget ||
    !identitiesEqual(link.identity, inspected.identity)
  ) {
    return {
      removed: false,
      relinquished: true,
      issues: [
        createIssue(
          "warning",
          `${label}已被外部替换，已停止管理并保留当前内容。`,
        ),
      ],
    };
  }
  try {
    // 仅删除链接本身，不会影响链接指向的源目录内容。
    await fsp.unlink(link.linkPath);
    return { removed: true, relinquished: true, issues: [] };
  } catch (error) {
    // 删除失败（如被占用）：保留记录，返回可重试状态。
    return {
      removed: false,
      relinquished: false,
      issues: [
        createIssue("error", `无法移除${label}：${errorMessage(error)}`),
      ],
    };
  }
}

/**
 * 为「目标位置已被占用」的冲突生成用户可读的说明文案。
 *
 * @param {{name: string}} skill - Skill 信息
 * @param {string} linkPath - 期望创建的链接路径
 * @param {{kind: string, dangling?: boolean}} inspected - inspectLink 的检查结果
 * @returns {string} 冲突说明
 */
function describeConflict(skill, linkPath, inspected) {
  if (inspected.kind === "directory")
    return `“${skill.name}”无法链接：目标位置已有普通目录 ${linkPath}，已保留原目录。`;
  if (inspected.kind === "file")
    return `“${skill.name}”无法链接：目标位置已有文件 ${linkPath}，已保留原文件。`;
  if (inspected.kind === "error")
    return `“${skill.name}”无法检查目标位置 ${linkPath}：${errorMessage(inspected.error)}`;
  if (inspected.kind === "link" && inspected.dangling)
    return `“${skill.name}”无法链接：目标位置已有失效的手动链接 ${linkPath}，请手动处理后重试。`;
  return `“${skill.name}”无法链接：目标位置已有指向其他位置的手动链接 ${linkPath}，已保留原链接。`;
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

/**
 * 审计 Agent 目录中「不受本应用管理」的符号链接，仅生成提示、不修改文件。
 * 这样既能让用户知道目录里存在的异常链接，也不会误删他人创建的内容。
 *
 * @param {{name: string, directory: string}} agent - Agent 信息
 * @param {Set<string>} knownPaths - 本应用已知的链接路径（comparablePath 形式）
 * @returns {Array} 问题列表
 */
async function auditUnmanagedLinks(agent, knownPaths) {
  const issues = [];
  let entries;
  try {
    entries = await withReadTimeout(
      fsp.readdir(agent.directory, { withFileTypes: true }),
      `检查 Agent“${agent.name}”目录`,
    );
  } catch (error) {
    return [
      createIssue(
        "error",
        `无法检查 Agent“${agent.name}”目录：${errorMessage(error)}`,
      ),
    ];
  }
  for (const entry of entries.filter((item) => item.isSymbolicLink())) {
    const linkPath = path.join(agent.directory, entry.name);
    // 本应用管理的链接已单独处理，这里只关心外部链接。
    if (knownPaths.has(comparablePath(linkPath))) continue;
    const inspected = await inspectLink(linkPath);
    // 失效链接或目标不是有效 Skill 的链接，提示用户但不做处理。
    if (
      inspected.kind !== "link" ||
      inspected.dangling ||
      !(await hasValidSkillFile(inspected.targetPath))
    ) {
      issues.push(
        createIssue(
          "warning",
          `Agent“${agent.name}”中发现非 Skill 或失效的手动链接 ${linkPath}，已忽略并保留。`,
        ),
      );
    }
  }
  return issues;
}

// ============================================================================
// 五、单个 Agent 的链接同步
// ============================================================================

/**
 * 同步一个 Agent 目录下的 Skills 链接，使其与「已启用 Skills」一致。
 *
 * 执行顺序：
 *  1. 读取该 Agent 已启用的 Skill 集合；
 *  2. 检查目标目录是否可用，不可用则直接返回且不改动任何文件；
 *  3. 只读保护（scan.locked）时仅观察现有链接，不做任何增删；
 *  4. 逐条处理历史受管链接：仍需要且仍然有效的保留，否则安全移除；
 *  5. 为缺失的 Skill 创建链接；目标已存在时按冲突处理（提示并保留）；
 *  6. 审计不受管的外部链接并汇总问题。
 *
 * @param {object} config - 当前配置（会就地更新该 Agent 的 managedLinks）
 * @param {{id: string, name: string, directory: string, managedLinks: object}} agent - 目标 Agent
 * @param {{skills: Array, complete: boolean, locked?: boolean}} scan - 仓库扫描结果
 * @returns {{linked: Array, external: Array, createdLinks: Array, issues: Array}} 本次同步结果
 */
// 同步遵循“只删除自己创建的链接”原则，任何手动文件、目录和链接都只提示不改动。
async function syncAgent(config, agent, scan) {
  const issues = [];
  // 单个 Skill 集合是唯一同步依据；分组仅作为界面上的批量选择器。
  const desiredSkillIds = new Set(config.enabledSkills[agent.id] || []);
  // 用 id 索引扫描结果，便于判断某个 skillId 是否仍然存在。
  const skillById = new Map(scan.skills.map((skill) => [skill.id, skill]));
  // 历史受管链接（已规范化）。
  const previousLinks = normalizeManagedLinks(agent.managedLinks);
  // 下一轮要写入数据库的受管链接。
  const nextLinks = {};
  // 已确认存在、可用的链接对应 Skill id。
  const linked = [];
  // 由外部预先存在、被直接沿用的同源链接对应 Skill id（本应用不删除它们）。
  const external = [];
  // 本次新建的链接记录，数据库保存失败时用于回滚。
  const createdLinks = [];
  const finish = () => {
    agent.externalLinkedCount = external.length;
    return {
      linked,
      external,
      createdLinks,
      issues: uniqueIssues(issues),
    };
  };

  // 同步配置可能先于本机路径同步到新设备；未配置目录时保持只读，不猜测其他设备的路径。
  if (!agent.directory) {
    issues.push(
      createIssue(
        "warning",
        `Agent“${agent.name}”尚未在当前设备配置 Skills 目录，已跳过链接同步。`,
      ),
    );
    agent.managedLinks = previousLinks;
    return finish();
  }

  let targetUsable = true;
  try {
    const stat = await withReadTimeout(
      fsp.stat(agent.directory),
      `检查 Agent“${agent.name}”目录`,
    );
    if (!stat.isDirectory()) throw new Error("该路径不是文件夹");
  } catch (error) {
    // 目录不可用（被删除、无权限、不是目录）：不改动任何文件，直接返回。
    targetUsable = false;
    issues.push(
      createIssue(
        "error",
        `Agent“${agent.name}”的 Skills 目录不可用：${errorMessage(error)}。未创建或删除任何链接。`,
      ),
    );
  }
  if (!targetUsable) {
    // 保持原记录不变，等待目录恢复后继续管理。
    agent.managedLinks = previousLinks;
    return finish();
  }
  // 数据库关键结构异常时只做观察，不根据兜底后的空值改动任何文件。
  if (scan.locked) {
    for (const [skillId, link] of Object.entries(previousLinks)) {
      // 仅统计确实仍指向原目标、且文件标识一致的链接。
      if (!(await isDirectChild(agent.directory, link.linkPath))) continue;
      const inspected = await inspectLink(link.linkPath, link.sourcePath);
      if (
        inspected.kind === "link" &&
        inspected.sameTarget &&
        identitiesEqual(link.identity, inspected.identity)
      )
        linked.push(skillId);
    }
    agent.managedLinks = previousLinks;
    // 已知路径用于排除自身管理的链接，避免误报。
    const knownPaths = new Set(
      Object.values(previousLinks).map((link) => comparablePath(link.linkPath)),
    );
    issues.push(...(await auditUnmanagedLinks(agent, knownPaths)));
    return finish();
  }

  // 处理历史受管链接：保留仍然需要的，安全移除不再需要的。
  for (const [skillId, link] of Object.entries(previousLinks)) {
    const skill = skillById.get(skillId);
    // 记录位置异常（不在 Agent 目录第一层）：仅提示，绝不删除。
    if (!(await isDirectChild(agent.directory, link.linkPath))) {
      issues.push(
        createIssue(
          "warning",
          `Agent“${agent.name}”存在超出其 Skills 目录的异常受管记录，已停止管理且不会删除该路径：${link.linkPath}`,
        ),
      );
      continue;
    }
    // 扫描不完整时，无法确认 Skill 是否真的被删除，因此保留仍被启用的受管链接。
    const shouldKeep =
      desiredSkillIds.has(skillId) && (skill || !scan.complete);
    // 源目录以当前扫描结果为准，扫描不到时回退到历史记录。
    const currentSource = skill?.sourcePath || link.sourcePath;
    const inspected = await inspectLink(link.linkPath, link.sourcePath);
    // 仍是同一链接（类型、目标、文件标识都匹配）才算「仍归本应用所有」。
    const stillOwned =
      inspected.kind === "link" &&
      inspected.sameTarget &&
      identitiesEqual(link.identity, inspected.identity);
    // 需要保留且源目录未变化：直接沿用，无需改动。
    if (
      shouldKeep &&
      stillOwned &&
      (await pathsEqual(link.sourcePath, currentSource))
    ) {
      // “待创建”记录说明上次可能在创建后中断；确认链接存在后补齐身份并转为正式记录。
      nextLinks[skillId] = link.pending
        ? {
            linkPath: link.linkPath,
            sourcePath: link.sourcePath,
            identity: inspected.identity,
          }
        : link;
      linked.push(skillId);
      continue;
    }
    // 扫描不完整且链接仍归本应用所有：宁可保留，等下次完整扫描再处理。
    if (shouldKeep && !scan.complete && stillOwned) {
      nextLinks[skillId] = link;
      linked.push(skillId);
      continue;
    }
    // 其余情况执行安全移除（内部会再次校验，只有确认归本应用所有才会真正删除）。
    const removal = await removeOwnedLink(
      link,
      `Agent“${agent.name}”中的受管链接 ${link.linkPath}`,
      agent.directory,
    );
    issues.push(...removal.issues);
    // 未放弃管理的记录需要保留，便于下次重试。
    if (!removal.relinquished) nextLinks[skillId] = link;
    // 扫描完整且 Skill 确实已不存在，且链接已被删除 → 提示信息级通知。
    if (scan.complete && !skill && removal.removed) {
      issues.push(
        createIssue(
          "info",
          `Skill“${skillId}”已不在主仓库中，对应的受管链接已移除。`,
        ),
      );
    }
  }

  const desiredSkills = [...desiredSkillIds]
    .map((skillId) => skillById.get(skillId))
    .filter(Boolean);
  // 统计同名目录数量：链接名使用目录名，同名会互相覆盖，需要提前拦截。
  const folderCounts = desiredSkills.reduce(
    (counts, skill) =>
      counts.set(skill.folderName, (counts.get(skill.folderName) || 0) + 1),
    new Map(),
  );
  // 先完成只读冲突检查，再把本轮全部待创建记录一次性落库，避免每个 Skill 重写整份配置。
  const pendingCreations = [];
  for (const skill of desiredSkills) {
    // 已在上一步保留的链接无需重复创建。
    if (nextLinks[skill.id]) continue;
    // 多个启用 Skill 目录名相同：跳过创建，避免覆盖，并提示用户改名。
    if (folderCounts.get(skill.folderName) > 1) {
      issues.push(
        createIssue(
          "error",
          `多个已启用 Skills 使用同一目录名“${skill.folderName}”，为避免覆盖，Agent“${agent.name}”未创建这些链接。`,
        ),
      );
      continue;
    }
    const linkPath = path.join(agent.directory, skill.folderName);
    const inspected = await inspectLink(linkPath, skill.sourcePath);
    // 目标位置已被占用：区分「同源手动链接」「普通文件/目录」「其他链接」分别提示。
    if (inspected.kind !== "missing") {
      if (inspected.kind === "link" && inspected.sameTarget) {
        // 用户自己创建的、指向同一源目录的链接：直接沿用，但不纳入受管（不会被本应用删除）。
        external.push(skill.id);
        issues.push(
          createIssue(
            "info",
            `Agent“${agent.name}”已存在“${skill.name}”的手动同源链接，已直接使用但不会由本应用删除。`,
          ),
        );
      } else {
        issues.push(
          createIssue(
            inspected.kind === "error" ? "error" : "warning",
            describeConflict(skill, linkPath, inspected),
          ),
        );
      }
      continue;
    }
    pendingCreations.push({ skill, linkPath });
  }

  if (pendingCreations.length) {
    pendingCreations.forEach(({ skill, linkPath }) => {
      nextLinks[skill.id] = {
        linkPath,
        sourcePath: skill.sourcePath,
        pending: true,
      };
    });
    agent.managedLinks = nextLinks;
    try {
      // 一次批量安全检查点覆盖本轮所有待创建链接，兼顾崩溃恢复与写入性能。
      writeConfig(config);
    } catch (error) {
      pendingCreations.forEach(({ skill }) => {
        delete nextLinks[skill.id];
      });
      issues.push(
        createIssue(
          "error",
          `创建链接前无法保存批量安全检查点：${error.message}。本轮 ${pendingCreations.length} 个链接均未创建。`,
        ),
      );
      pendingCreations.length = 0;
    }
  }

  for (const { skill, linkPath } of pendingCreations) {
    try {
      // Windows 使用 junction（目录联接，无需管理员权限），其他平台使用目录符号链接。
      await fsp.symlink(
        skill.sourcePath,
        linkPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      let identity;
      try {
        // 记录文件标识，用于后续判断链接是否被外部替换。
        const created = await withReadTimeout(
          fsp.lstat(linkPath),
          `记录链接标识 ${linkPath}`,
        );
        identity = {
          dev: Number(created.dev),
          ino: Number(created.ino),
          birthtimeMs: Number(created.birthtimeMs),
        };
      } catch (error) {
        // 记录不到标识也不影响使用：后续按「目标一致」继续管理。
        issues.push(
          createIssue(
            "warning",
            `“${skill.name}”链接已创建，但无法记录文件标识：${errorMessage(error)}。后续仍会按链接目标安全管理。`,
          ),
        );
      }
      nextLinks[skill.id] = {
        linkPath,
        sourcePath: skill.sourcePath,
        ...(identity ? { identity } : {}),
      };
      createdLinks.push({ skillId: skill.id, ...nextLinks[skill.id] });
      linked.push(skill.id);
    } catch (error) {
      // 创建失败时从内存移除待创建项；数据库中的检查点会由最终写入清理。
      delete nextLinks[skill.id];
      // 创建失败（权限、占用等）：提示并继续处理其他 Skill。
      issues.push(
        createIssue(
          "error",
          `创建“${skill.name}”链接失败：${errorMessage(error)}`,
        ),
      );
    }
  }

  // 已知路径 = 本轮受管链接 + 期望的链接位置，用于审计外部链接时排除自身。
  const knownPaths = new Set([
    ...Object.values(nextLinks).map((link) => comparablePath(link.linkPath)),
    ...desiredSkills.map((skill) =>
      comparablePath(path.join(agent.directory, skill.folderName)),
    ),
  ]);
  issues.push(...(await auditUnmanagedLinks(agent, knownPaths)));
  // 就地更新受管链接记录，由调用方统一写回数据库。
  agent.managedLinks = nextLinks;
  return finish();
}

/**
 * 依次同步所有 Agent。
 *
 * @param {object} config - 当前配置
 * @param {object} scan - 仓库扫描结果
 * @returns {object} { [agentId]: syncAgent 的返回值 }
 */
async function syncAllAgents(config, scan) {
  const results = {};
  // 顺序执行可避免多个 Agent 同时冲击磁盘，也让每个批量检查点保持可恢复。
  for (const agent of config.agents) {
    results[agent.id] = await syncAgent(config, agent, scan);
  }
  return results;
}

/**
 * 清理分组和 Agent 选择中「已从仓库删除」的 Skill 引用。
 * 仅在扫描完整且未处于只读保护时执行，保证不会因扫描失败误删引用。
 *
 * @param {object} config - 当前配置（会就地清理 group.skillIds 与 enabledSkills）
 * @param {object} scan - 仓库扫描结果
 * @returns {Array} 清理过程中产生的问题列表
 */
function reconcileDeletedSkills(config, scan) {
  if (!scan.complete || scan.locked) return [];
  const validSkillIds = new Set(scan.skills.map((skill) => skill.id));
  const issues = [];
  config.groups.forEach((group) => {
    const missing = group.skillIds.filter(
      (skillId) => !validSkillIds.has(skillId),
    );
    if (!missing.length) return;
    // 保留仍然存在的引用，丢弃失效引用。
    group.skillIds = group.skillIds.filter((skillId) =>
      validSkillIds.has(skillId),
    );
    issues.push(
      createIssue(
        "warning",
        `分组“${group.name}”中有 ${missing.length} 个 Skill 已从主仓库删除，失效引用已自动清理。`,
      ),
    );
  });
  config.agents.forEach((agent) => {
    const current = config.enabledSkills[agent.id] || [];
    const missing = current.filter((skillId) => !validSkillIds.has(skillId));
    config.enabledSkills[agent.id] = current.filter((skillId) =>
      validSkillIds.has(skillId),
    );
    config.enabledGroups[agent.id] = deriveEnabledGroupIds(
      config.groups,
      config.enabledSkills[agent.id],
    );
    if (missing.length) {
      issues.push(
        createIssue(
          "warning",
          `Agent“${agent.name}”有 ${missing.length} 个已启用 Skill 不再存在，选择记录和受管链接已自动清理。`,
        ),
      );
    }
  });
  return issues;
}

/**
 * 汇总一次刷新过程中的全部问题：扫描问题 + 附加问题 + 各 Agent 同步问题。
 *
 * @param {object} scan - 仓库扫描结果
 * @param {object} syncResults - syncAllAgents 的返回值
 * @param {Array} [extra=[]] - 额外问题（如配置读取问题、分组清理问题）
 * @returns {Array} 去重后的问题列表
 */
function collectIssues(scan, syncResults, extra = []) {
  return uniqueIssues([
    ...(scan?.issues || []),
    ...extra,
    ...Object.values(syncResults || {}).flatMap(
      (result) => result.issues || [],
    ),
  ]);
}

/**
 * 把内部 Agent 结构转换为前端需要的公开结构（附带链接数量统计）。
 *
 * @param {object} agent - 内部 Agent 对象
 * @param {object} [syncResult] - 该 Agent 本轮同步结果；缺失时回退为数据库记录的链接数
 * @returns {{id: string, name: string, directory: string, linkedCount: number, managedLinkedCount: number, externalLinkedCount: number}}
 */
function publicAgent(agent, syncResult) {
  // 受管链接数量：本轮同步结果优先，没有同步结果时以数据库记录为准。
  const managedLinkedCount = syncResult
    ? syncResult.linked.length
    : Object.keys(agent.managedLinks || {}).length;
  // 外部同源链接数量（不由本应用创建，仅统计展示）。
  const externalLinkedCount = syncResult
    ? syncResult.external.length
    : agent.externalLinkedCount || 0;
  return {
    id: agent.id,
    name: agent.name,
    directory: agent.directory,
    linkedCount: managedLinkedCount + externalLinkedCount,
    managedLinkedCount,
    externalLinkedCount,
  };
}

/**
 * 组装返回给前端的状态对象（前端 applyState 会逐字段合并）。
 *
 * @param {object} config - 当前配置
 * @param {{skills?: Array}} [scan={ skills: [] }] - 仓库扫描结果
 * @param {object} [syncResults={}] - 各 Agent 的同步结果
 * @param {Array} [issues=[]] - 需要展示的问题列表
 * @returns {object} 前端可用的完整状态
 */
function buildState(
  config,
  scan = { skills: [] },
  syncResults = {},
  issues = [],
) {
  return {
    repositoryPath: config.repositoryPath,
    skills: scan.skills || [],
    groups: config.groups,
    // Agent 列表转为公开结构，避免把 managedLinks 等内部字段暴露给前端。
    agents: config.agents.map((agent) =>
      publicAgent(agent, syncResults[agent.id]),
    ),
    enabledGroups: config.enabledGroups,
    enabledSkills: config.enabledSkills,
    theme: config.theme === "dark" ? "dark" : "light",
    issues: uniqueIssues(issues),
  };
}

/**
 * 保存同步后的链接状态；保存失败时安全回滚本轮新建链接，并重试记录最终状态。
 *
 * @param {object} config - 当前完整配置
 * @param {object} syncResults - 本轮参与同步的 Agent 结果
 * @returns {Promise<Array>} 持久化或回滚期间产生的问题
 */
async function persistSyncResults(config, syncResults) {
  const persistenceIssues = [];
  if (config._syncLocked) return persistenceIssues;
  try {
    writeConfig(config);
  } catch (error) {
    const rollbackIssues = [];
    for (const agent of config.agents) {
      const createdLinks = syncResults[agent.id]?.createdLinks || [];
      for (const link of createdLinks) {
        const removal = await removeOwnedLink(
          link,
          `保存失败后的新建链接 ${link.linkPath}`,
          agent.directory,
        );
        rollbackIssues.push(...removal.issues);
        if (removal.relinquished) {
          delete agent.managedLinks[link.skillId];
          const syncResult = syncResults[agent.id];
          syncResult.linked = syncResult.linked.filter(
            (id) => id !== link.skillId,
          );
        }
      }
    }
    try {
      writeConfig(config);
      const detail = rollbackIssues.length
        ? `部分新建链接未能回滚，但其受管记录已保留：${rollbackIssues.map((issue) => issue.message).join("；")}`
        : "本轮新建链接已回滚，数据库重试保存成功";
      persistenceIssues.push(
        createIssue("warning", `${error.message}；${detail}。`),
      );
    } catch (retryError) {
      const detail = rollbackIssues.length
        ? `；新建链接回滚存在问题：${rollbackIssues.map((issue) => issue.message).join("；")}`
        : "；本轮新建链接已回滚，其余状态将在下次启动时按安全检查点自动收敛";
      persistenceIssues.push(
        createIssue(
          "error",
          `${error.message}；重试保存仍失败：${retryError.message}${detail}`,
        ),
      );
    }
  }
  return persistenceIssues;
}

/**
 * 刷新状态的核心流程：扫描仓库 → 写入恢复检查点 → 同步所有 Agent → 保存结果 → 组装状态。
 *
 * 关键点：文件操作前先持久化业务目标与旧链接记录；最终写入失败时回滚本轮新建链接，
 * 删除结果则可依据检查点在下次启动时安全收敛。
 *
 * @param {object} config - 已读取（可能已修改）的配置对象
 * @returns {object} 前端可用的完整状态
 * @throws {Error} 恢复检查点无法写入时抛出，且不会执行任何文件操作
 */
async function refreshState(config) {
  const scan = await scanConfiguredRepository(config);
  // 只有完整扫描结果才替换首屏缓存；不完整结果绝不成为后续清理依据。
  if (scan.complete && !scan.locked)
    config._cachedSkills = normalizeCachedSkills(scan.skills);
  const reconciledIssues = reconcileDeletedSkills(config, scan);
  // 只读保护时只观察链接；正常状态先保存恢复检查点，再开始文件系统变更。
  if (!config._syncLocked) writeConfig(config);
  const orphanIssues = config._syncLocked
    ? []
    : await cleanupOrphanAgents(config);
  const syncResults = await syncAllAgents(config, scan);
  const persistenceIssues = await persistSyncResults(config, syncResults);
  return buildState(
    config,
    scan,
    syncResults,
    collectIssues(scan, syncResults, [
      ...(config._issues || []),
      ...reconciledIssues,
      ...orphanIssues,
      ...persistenceIssues,
    ]),
  );
}

/**
 * 只同步一次应用配置开关涉及的 Agent。
 * 使用最近一次完整扫描缓存并逐项验证源目录，避免每次点击都递归遍历整个仓库。
 */
async function syncAgentSkillsState(config, agent) {
  const targetedScan = await inspectEnabledCachedSkills(config, agent);
  // 先保存新的启用关系和旧链接记录；检查点失败时不会触碰文件系统。
  writeConfig(config);
  const syncResults = {
    [agent.id]: await syncAgent(config, agent, targetedScan),
  };
  const persistenceIssues = await persistSyncResults(config, syncResults);
  return buildState(
    config,
    { skills: config._cachedSkills || [] },
    syncResults,
    collectIssues(targetedScan, syncResults, [
      ...(config._issues || []),
      ...persistenceIssues,
    ]),
  );
}

/**
 * 清理某个 Agent 的全部受管链接（删除 Agent、更换目录、清除数据时使用）。
 *
 * @param {object} agent - 目标 Agent（会就地更新其 managedLinks）
 * @returns {Array} 问题列表（含无法删除的错误）
 */
async function cleanupAgentLinks(agent) {
  const issues = [];
  // 未能放弃管理的记录需要保留，便于下次重试。
  const remaining = {};
  for (const [skillId, link] of Object.entries(
    normalizeManagedLinks(agent.managedLinks),
  )) {
    const removal = await removeOwnedLink(
      link,
      `Agent“${agent.name}”中的受管链接 ${link.linkPath}`,
      agent.directory,
    );
    issues.push(...removal.issues);
    if (!removal.relinquished) remaining[skillId] = link;
  }
  agent.managedLinks = remaining;
  return uniqueIssues(issues);
}

/** 清理当前设备上已经不属于共享配置的 Agent 链接，并保留失败项供下次重试。 */
async function cleanupOrphanAgents(config) {
  const issues = [];
  const remaining = [];
  for (const agent of config._orphanAgents || []) {
    const agentIssues = await cleanupAgentLinks(agent);
    issues.push(...agentIssues);
    if (Object.keys(agent.managedLinks || {}).length) remaining.push(agent);
  }
  config._orphanAgents = remaining;
  return uniqueIssues(issues);
}

/**
 * 写操作前的守卫：配置处于只读保护时，禁止任何会改动数据库或磁盘的操作。
 *
 * @param {object} config - 当前配置
 * @throws {Error} 配置处于只读保护时抛出
 */
function assertConfigWritable(config) {
  if (config._syncLocked)
    throw new Error(
      "本地数据库关键配置异常，当前处于只读保护。请先在设置页清除数据，再重新配置。",
    );
}

// ============================================================================
// 六、对外接口（供前端 window.skillsManager 调用）
// ============================================================================

// 前端通过 window.skillsManager.xxx() 调用以下方法；
// 所有方法在失败时抛出带中文说明的 Error，由前端统一转换为界面提示。
window.skillsManager = {
  /**
   * 打开系统目录选择框（uTools 的 showOpenDialog，options 与 Electron 一致）。
   *
   * @param {string} [defaultPath] - 默认打开的目录
   * @returns {string} 选中的目录绝对路径；用户取消时返回空字符串
   * @throws {Error} 调用系统对话框失败
   */
  chooseDirectory(defaultPath) {
    try {
      // properties 同时允许选择已有目录与新建目录。
      const result = window.utools.showOpenDialog({
        title: "选择目录",
        defaultPath: defaultPath || undefined,
        properties: ["openDirectory", "createDirectory"],
      });
      return result && result.length ? result[0] : "";
    } catch (error) {
      throw new Error(`打开目录选择器失败：${errorMessage(error)}`);
    }
  },

  /**
   * 读取当前数据库状态与上次完整扫描缓存，不执行文件系统写操作。
   * 前端先用该结果绘制首屏，再通过 reconcile 异步完成一致性校验。
   *
   * @returns {object} 前端可用的完整状态
   */
  async getState() {
    const config = await readConfig();
    // 启动阶段只返回已验证的缓存，不扫描仓库、不修改链接，确保窗口可以立即绘制。
    return buildState(
      config,
      { skills: config._cachedSkills || [] },
      {},
      config._issues || [],
    );
  },

  /** 启动首屏绘制后执行后台一致性校验。 */
  async reconcile() {
    return refreshState(await readConfig());
  },

  /**
   * 保存主题。
   * 主题不依赖文件系统，因此即使仓库离线也能正常切换，只写入数据库。
   *
   * @param {'light'|'dark'} theme - 目标主题
   * @returns {{theme: string, issues: Array}} 变更后的主题与读取阶段发现的问题
   */
  // 主题保存不依赖文件系统，主仓库暂时离线时仍可正常切换。
  async setTheme(theme) {
    const config = await readConfig();
    config.theme = theme === "dark" ? "dark" : "light";
    // 只读保护时不能用规范化后的配置覆盖损坏原文档，但主题仍可独立更新。
    if (config._syncLocked) {
      if (config._legacy || !isPlainObject(config._storedState))
        throw new Error(
          "本地数据库处于只读保护，暂时无法保存主题。请先在设置页清除数据。",
        );
      try {
        database().setItem(STATE_KEY, {
          ...config._storedState,
          theme: config.theme,
        });
      } catch (error) {
        throw new Error(`保存主题失败：${errorMessage(error)}`);
      }
    } else writeConfig(config);
    return { theme: config.theme, issues: config._issues || [] };
  },

  /**
   * 设置统一 Skills 仓库目录并立即刷新。
   *
   * @param {string} repositoryPath - 仓库目录路径
   * @returns {object} 刷新后的完整状态
   * @throws {Error} 目录非法、与某个 Agent 目录互相包含、或处于只读保护
   */
  async setRepository(repositoryPath) {
    const config = await readConfig();
    assertConfigWritable(config);
    const normalizedPath = await normalizeDirectory(
      repositoryPath,
      "Skills 仓库目录",
    );
    if (path.parse(normalizedPath).root === normalizedPath)
      throw new Error(
        "Skills 仓库不能是磁盘根目录，请选择专用的 Skills 文件夹",
      );
    // 仓库与 Agent 目录互相包含会导致扫描结果污染（把自己的链接当成 Skill）。
    let conflictingAgent;
    for (const agent of config.agents) {
      if (
        agent.directory &&
        ((await isInsideDirectory(normalizedPath, agent.directory)) ||
          (await isInsideDirectory(agent.directory, normalizedPath)))
      ) {
        conflictingAgent = agent;
        break;
      }
    }
    if (conflictingAgent)
      throw new Error(
        `Skills 仓库不能与 Agent“${conflictingAgent.name}”的目录相同或互相包含，请调整其中一个路径`,
      );
    config.repositoryPath = normalizedPath;
    return refreshState(config);
  },

  /**
   * 按已保存的仓库路径重新扫描并同步（不改动仓库路径）。
   *
   * @returns {object} 刷新后的完整状态
   * @throws {Error} 尚未配置仓库路径或处于只读保护
   */
  async refreshSkills() {
    const config = await readConfig();
    assertConfigWritable(config);
    if (!config.repositoryPath) throw new Error("请先配置 Skills 仓库目录");
    return refreshState(config);
  },

  /**
   * 保存分组列表（新增、改名、增删 Skills 都复用该接口）。
   * 保存后会顺带清理「已删除分组」在 Agent 上的启用记录，并同步链接。
   *
   * @param {Array<{id: string, name: string, skillIds: Array}>} groups - 前端提交的完整分组列表
   * @returns {object} 刷新后的完整状态
   * @throws {Error} 分组 id 重复或处于只读保护
   */
  async saveGroups(groups) {
    const config = await readConfig();
    assertConfigWritable(config);
    // 只保留 id、name 非空的分组，并对 skillIds 去重。
    config.groups = (Array.isArray(groups) ? groups : [])
      .map((group) => ({
        id: String(group.id || "").trim(),
        name: String(group.name || "").trim(),
        skillIds: [
          ...new Set(
            Array.isArray(group.skillIds) ? group.skillIds.map(String) : [],
          ),
        ],
      }))
      .filter((group) => group.id && group.name);
    // 分组 id 必须唯一，否则链接同步无法区分分组。
    if (
      new Set(config.groups.map((group) => group.id)).size !==
      config.groups.length
    )
      throw new Error("分组标识重复，请重新创建分组");
    // 分组状态由已启用 Skills 实时推导，分组改名或调整内容后仍保持一致。
    Object.keys(config.enabledSkills).forEach((agentId) => {
      config.enabledGroups[agentId] = deriveEnabledGroupIds(
        config.groups,
        config.enabledSkills[agentId],
      );
    });
    return refreshState(config);
  },

  /**
   * 新增或更新一个 Agent。
   * 携带 id 表示更新；修改目录时会先清理旧目录中由本应用创建的链接。
   *
   * @param {{id?: string, name: string, directory: string}} input - 表单数据
   * @returns {object} 刷新后的完整状态（issues 中附加了目录变更时的清理问题）
   * @throws {Error} 名称为空、目录非法、目录冲突或处于只读保护
   */
  async upsertAgent(input) {
    const config = await readConfig();
    assertConfigWritable(config);
    const name = String(input?.name || "").trim();
    if (!name) throw new Error("请输入 Agent 名称");
    const directory = await normalizeDirectory(
      String(input?.directory || ""),
      "Agent Skills 目录",
    );
    // 新增时生成唯一 id：时间戳 + 随机串，避免同一毫秒内重复。
    const id = input?.id
      ? String(input.id)
      : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!isSafeRecordKey(id)) throw new Error("Agent 标识无效，请重新创建 Agent");
    await assertSafeAgentDirectory(config, directory, id);
    const existing = config.agents.find((agent) => agent.id === id);
    if (existing) {
      // 目录变更：旧目录记录转为设备级待清理项，refreshState 保存检查点后再安全清理。
      if (
        existing.directory &&
        !(await pathsEqual(existing.directory, directory))
      ) {
        config._orphanAgents.push({
          id: `${existing.id}:moved:${Date.now()}`,
          name: existing.name,
          directory: existing.directory,
          managedLinks: normalizeManagedLinks(existing.managedLinks),
        });
        existing.managedLinks = {};
      }
      existing.name = name;
      existing.directory = directory;
    } else {
      // 新增 Agent：同时初始化派生分组与 Skill 选择为空数组。
      config.agents.push({ id, name, directory, managedLinks: {} });
      config.enabledGroups[id] = [];
      config.enabledSkills[id] = [];
    }
    return refreshState(config);
  },

  /**
   * 删除 Agent：先保存删除目标，再安全清理受管链接；失败记录会留在本机分区供下次重试。
   *
   * @param {string} agentId - 目标 Agent id
   * @returns {object} 刷新后的完整状态（issues 中附加了清理问题）
   * @throws {Error} Agent 不存在、检查点保存失败或处于只读保护
   */
  async deleteAgent(agentId) {
    const config = await readConfig();
    assertConfigWritable(config);
    const agent = config.agents.find((item) => item.id === agentId);
    if (!agent)
      throw new Error("未找到要删除的 Agent，配置可能已被其他窗口更新");
    // 先把本机记录转成待清理项，确保数据库检查点写入成功后才会触碰文件系统。
    config._orphanAgents.push({
      ...agent,
      managedLinks: normalizeManagedLinks(agent.managedLinks),
    });
    config.agents = config.agents.filter((item) => item.id !== agentId);
    // 同步删除该 Agent 的分组派生状态与 Skill 选择记录。
    delete config.enabledGroups[agentId];
    delete config.enabledSkills[agentId];
    const state = refreshState(config);
    return state;
  },

  /**
   * 清除全部数据：先保存清空目标，再清理当前设备的受管链接并删除共享配置。
   * 仓库中的源文件与用户手动创建的内容都不会被删除。
   *
   * @returns {object} 默认配置对应的空状态（附带清理过程中的问题）
   * @throws {Error} 安全检查点或数据库清除失败
   */
  // 未清理完成的链接继续保留设备级记录，避免产生无法追踪的链接。
  async clearData() {
    const config = await readConfig();
    const cleared = attachRuntime(createDefaultConfig(), {
      _issues: [],
      _syncLocked: false,
      _deviceId: config._deviceId,
      _deviceStates: config._deviceStates,
      _orphanAgents: [...config.agents, ...(config._orphanAgents || [])],
      _cachedSkills: [],
    });
    // 先用单文档写入“共享配置已清空 + 本机待清理记录”的检查点。
    writeConfig(cleared);
    const issues = await cleanupOrphanAgents(cleared);
    if (config._syncLocked) {
      issues.push(
        createIssue(
          "warning",
          "数据库配置异常，仅清理了仍可识别的本机受管链接；其他内容均已保留。",
        ),
      );
    }
    if (cleared._orphanAgents.length) writeConfig(cleared);
    else clearStoredConfig(cleared);
    return buildState(
      createDefaultConfig(),
      { skills: [] },
      {},
      uniqueIssues(issues),
    );
  },

  /**
   * 设置某个 Agent 启用的 Skills，并按差集同步其目录下的链接。
   *
   * @param {string} agentId - 目标 Agent id
   * @param {Array<string>} skillIds - 启用的 Skill id 列表
   * @returns {object} 刷新后的完整状态
   * @throws {Error} Agent 不存在或处于只读保护
   */
  async setAgentSkills(agentId, skillIds) {
    const config = await readConfig();
    assertConfigWritable(config);
    const agent = config.agents.find((item) => item.id === agentId);
    if (!agent) throw new Error("未找到该 Agent，配置可能已被其他窗口更新");
    // 只接收最近一次完整扫描确认过的 Skill id，避免异常输入写入配置。
    const validIds = new Set(
      normalizeCachedSkills(config._cachedSkills).map((skill) => skill.id),
    );
    config.enabledSkills[agentId] = [
      ...new Set(Array.isArray(skillIds) ? skillIds.map(String) : []),
    ].filter((skillId) => validIds.has(skillId));
    config.enabledGroups[agentId] = deriveEnabledGroupIds(
      config.groups,
      config.enabledSkills[agentId],
    );
    return syncAgentSkillsState(config, agent);
  },
};
