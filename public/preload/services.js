/**
 * Skills 管理器 —— uTools 预加载脚本（preload）。
 *
 * 运行环境：uTools 的 preload 环境（Electron 渲染进程 + Node.js 原生能力）。
 * 该脚本按 uTools 规范不做打包/压缩，并在 window 上挂载 skillsManager 对象，
 * 供前端 Vue 应用调用（调用方见 src/stores/appStore.js）。
 *
 * 职责划分：
 *  1. 配置持久化：业务状态拆分写入 uTools 文档数据库，不落地 JSON 配置文件；
 *  2. 目录扫描：递归扫描统一 Skills 仓库，识别包含 SKILL.md 的目录并解析其中的 YAML 元数据 name；
 *  3. 链接同步：按「Agent + 已启用 Skills」在 Agent 目录下创建指向仓库源目录的目录链接；
 *  4. 安全兜底：只删除本应用创建且校验通过的链接，其余文件/目录/链接一律保留并给出提示。
 *
 * 三条核心安全原则（贯穿全文）：
 *  A. 只管理自己创建的东西：删除前必须同时校验链接路径、链接目标与创建时记录的文件标识；
 *  B. 数据不完整就不做清理：扫描不完整或数据库结构异常时进入只读保护，绝不依据兜底空值删文件；
 *  C. 分片与冲突保护：共享配置、设备路径、扫描缓存和链接记录分文档保存，并用 _rev 防止旧快照覆盖。
 */

// Node.js 路径模块：跨平台地拼接、解析路径并计算相对路径。
const path = require("node:path");
// 数据库适配层：按文档拆分状态，并使用 _rev 检测并发覆盖。
const { createDocumentRepository, documentPayload } = require("./database");
const { createIssue, errorMessage, uniqueIssues } = require("./runtime");
const {
  assertSafeAgentDirectory,
  isInsideDirectory,
  normalizeDirectory,
  pathsEqual,
} = require("./path-safety");
const { createScanner } = require("./scanner");
const { createLinkManager } = require("./link-manager");

// 配置结构版本号：配置结构变更时递增，便于将来做数据迁移。
const CONFIG_VERSION = 3;
// v3 按职责拆成多个 uTools 数据库文档，避免单文档超限并减少多设备冲突范围。
const DB_PREFIX = "skills-manager/v3/";
const CORE_DOCUMENT_ID = `${DB_PREFIX}shared/core`;
const THEME_DOCUMENT_ID = `${DB_PREFIX}shared/theme`;
const GROUP_PREFIX = `${DB_PREFIX}shared/group/`;
const AGENT_PREFIX = `${DB_PREFIX}shared/agent/`;
const SELECTION_PREFIX = `${DB_PREFIX}shared/selection/`;
const DEVICE_PREFIX = `${DB_PREFIX}device/`;
const CACHE_CHUNK_SIZE = 400;
const CACHE_CHUNK_MAX_BYTES = 700 * 1024;
const ID_CHUNK_SIZE = 1_000;
const ID_CHUNK_MAX_BYTES = 600 * 1024;
// 仅用于把当前开发阶段的 state-v2 数据迁移到 v3 文档结构，不读取任何 JSON 配置文件。
const V2_STATE_KEY = "skills-manager/state-v2";
const MAX_ENTITY_NAME_LENGTH = 120;
// 更早的开发版 dbStorage 键仅在清除数据时移除，不再作为配置来源。
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
// 配置只存入 uTools 文档数据库；文件系统仅用于扫描 Skill 和维护链接。
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

// 为什么需要这个函数：缓存来自上一次完整扫描，用于首屏秒开，但必须假设它可能来自旧版本、
// 被手工改坏或与磁盘现状不一致；因此这里只接受「字段齐全 + folderName 为单层目录名 + id 唯一」的记录，
// 非法项直接丢弃。缓存只服务于展示与目标定位，真正的删除决策仍以本轮完整扫描为准。
/** 规范化缓存的 Skill 扫描结果，缓存仅用于首屏展示，不参与未校验的删除决策。 */
function normalizeCachedSkills(input) {
  if (!Array.isArray(input)) return [];
  // ids 用于去重：同一 id 重复出现时只保留第一条，避免前端列表出现重复项。
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
            // pending 表示「已写入数据库检查点、但尚未确认创建成功」的链接：
            // 崩溃恢复时若链接已存在则补齐文件标识，若不存在则按普通缺失流程处理。
            ...(link.pending === true ? { pending: true } : {}),
          },
        ],
      ];
    }),
  );
}

// 「分组与 Skills 双向联动」的一致性保证：分组只是界面上的批量选择器，
// 真正的启用状态始终以 enabledSkills 为准。这样分组被改名、增删 Skills 之后，
// 开关状态会按“分组内容是否被完整覆盖”自动重算，不会出现勾选状态与链接不一致。
// 判定规则：分组必须非空，且其包含的每一个 Skill 都被启用，才算该分组处于开启状态。
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

// 仅用于旧数据迁移：早期版本只保存「已启用分组」，这里把它展开为等价的 Skill 集合，
// 使升级后用户已有的选择不丢失。展开是一次性的：之后分组内容再变化也不会影响这份选择，
// 避免用户调整分组时“顺带”改变其他设备的链接配置。
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
  const storedEnabledGroups = isPlainObject(config.enabledGroups)
    ? config.enabledGroups
    : {};
  agents.forEach((agent) => {
    // 旧结构：先从 enabledGroups 还原出分组 id（并丢弃已不存在的分组），再展开为 Skill 集合。
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
      // filter(Boolean) 兜底剔除空字符串 id，避免脏数据进入启用集合。
    ].filter(Boolean);
    // 反向推导分组开关状态，保证返回给前端的 enabledGroups 与 enabledSkills 永远自洽。
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

// 扫描器通过显式依赖注入复用配置规范化规则，避免模块之间形成循环引用。
const {
  hasValidSkillFile,
  inspectEnabledCachedSkills,
  scanConfiguredRepository,
} = createScanner({ normalizeCachedSkills });
const { removeOwnedLink, syncAgent, syncAllAgents } = createLinkManager({
  hasValidSkillFile,
  normalizeManagedLinks,
  writeConfig,
});

/**
 * 获取带 revision 冲突保护的 uTools 文档数据库仓库。
 *
 * @returns {object} 文档仓库
 * @throws {Error} 不在 uTools 环境中（未加载 preload）时抛出
 */
function database() {
  return createDocumentRepository(window.utools, DB_PREFIX);
}

/** state-v2 迁移与旧开发键清理仍需访问 dbStorage；业务数据不再写入这里。 */
function legacyStorage() {
  return window.utools?.dbStorage;
}

// 为什么需要设备隔离：uTools 本地数据库会随账号在多台设备间同步，但「绝对路径」和
// 链接的 inode/创建时间只在本机有意义。若把其他设备的路径拿到本机直接使用，
// 轻则同步失败，重则可能在错误目录里创建或删除链接，因此本机相关数据全部按设备 ID 分区存放。
/** 获取稳定的本机标识，用于隔离不可跨设备复用的链接路径与文件标识。 */
function nativeId() {
  const id = window.utools?.getNativeId?.();
  if (!id)
    throw new Error("无法获取 uTools 本机 ID，已停止链接操作以保护本地文件");
  return String(id);
}

// 配置校验的基础判断：数组与 null 都不算「普通对象」，避免后续对数组做键值遍历造成误判。
/** 判断值是否为可枚举键值对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 配置里的键最终会作为普通对象属性使用（如 enabledSkills[agentId]），
// 若键为 __proto__ / prototype / constructor 会引起原型链污染，因此这类 id 一律拒绝。
/** 判断字符串能否安全用作普通对象的业务键，避免原型属性污染配置映射。 */
function isSafeRecordKey(value) {
  return !["__proto__", "prototype", "constructor"].includes(value);
}

// 运行期上下文（_issues/_syncLocked/_deviceId/_orphanAgents/_cachedSkills/_baselineDocuments 等）
// 只在内存中使用：用 defineProperty 定义为不可枚举属性，这样写入数据库时
// 会被 JSON 序列化自动忽略，不会污染持久化的配置结构。
// writable 设为 true，便于 refreshState 等流程就地更新缓存与待清理项。
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
// 校验总原则：这里只做「只读体检」，绝不修改数据库或磁盘；发现任何可能影响链接集合的异常，
// 都通过 fail() 打开只读保护开关，让后续流程只观察、不清理。
async function validateStoredState(stored, deviceState, legacy = false) {
  // issues 汇总所有问题；locked 一旦置真就不再恢复：宁可少动文件，也不冒误删风险。
  const issues = [];
  let locked = false;
  // 统一的问题构造入口：错误文案都会带上「只读保护 + 如何恢复」的引导。
  const fail = (message) => {
    locked = true;
    issues.push(
      createIssue(
        "error",
        `${message}，已进入只读保护。可在设置页清除数据后重新配置。`,
      ),
    );
  };

  // 顶层结构体检：版本号、设备分区、仓库路径、分组、Agent、启用关系逐项校验类型。
  if (!isPlainObject(stored)) fail("本地数据库主配置不是有效对象");
  if (!legacy && stored?.version !== CONFIG_VERSION)
    fail(`不支持的配置版本“${String(stored?.version)}”`);
  if (!legacy && !isPlainObject(stored?.deviceStates))
    fail("设备状态分区格式异常");
  if (typeof stored?.repositoryPath !== "string")
    fail("Skills 仓库路径格式异常");
  if (!Array.isArray(stored?.groups)) fail("分组数据格式异常");
  if (!Array.isArray(stored?.agents)) fail("Agent 数据格式异常");
  if (!isPlainObject(stored?.enabledGroups)) fail("应用配置格式异常");
  if (
    stored?.enabledSkills !== undefined &&
    !isPlainObject(stored.enabledSkills)
  )
    fail("Skills 启用配置格式异常");

  // 逐条深度校验分组记录：字段类型、非空、id 唯一、skillIds 必须为字符串数组。
  // 这里不直接把脏记录过滤掉，是因为“少了一条分组”可能被误认为用户删除了分组，
  // 进而连累 Agent 链接；宁可进入只读保护让用户确认。
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

  // 逐条深度校验 Agent 记录：id 合法且唯一、名称非空；目录允许为空（表示当前设备尚未配置）。
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

  // 启用分组必须覆盖每个 Agent（即使是空数组），且引用的分组 id 必须真实存在。
  if (isPlainObject(stored?.enabledGroups)) {
    agentIds.forEach((agentId) => {
      if (!Array.isArray(stored.enabledGroups[agentId]))
        fail(`Agent“${agentId}”缺少有效的启用分组数组`);
    });
    Object.entries(stored.enabledGroups).forEach(([agentId, groupIdsValue]) => {
      if (
        !agentIds.has(agentId) ||
        !Array.isArray(groupIdsValue) ||
        groupIdsValue.some((id) => typeof id !== "string" || !groupIds.has(id))
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

  // 本机分区体检：这部分数据直接决定「删除哪些链接」，因此校验最严格。
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
      // 收集本机目录，供后面的“两个 Agent 指向同一目录”检查使用。
      if (
        typeof localAgent?.directory === "string" &&
        localAgent.directory.trim()
      )
        localDirectories.push(localAgent.directory);
    });
    // 路径别名需要解析真实目录后比较，因此使用异步循环，避免 realpath 阻塞界面。
    // 采用两两比较（O(n²)）而非去重集合：Agent 数量通常只有个位数，可读性优先于微优化。
    for (let index = 0; index < localDirectories.length; index += 1) {
      for (let other = 0; other < index; other += 1) {
        if (
          await pathsEqual(localDirectories[index], localDirectories[other])
        ) {
          fail(
            `多个本机 Agent 指向同一个 Skills 目录：${localDirectories[index]}`,
          );
          break;
        }
      }
    }
  }

  // 主题只影响界面显示，属于可自愈的轻微问题：仅提示，不触发只读保护。
  if (stored?.theme !== "light" && stored?.theme !== "dark") {
    issues.push(
      createIssue("warning", "本地数据库中的主题值无效，已恢复为浅色主题。"),
    );
  }
  return { issues: uniqueIssues(issues), locked };
}

/** 为动态业务 id 生成不会破坏文档层级的安全片段。 */
function documentIdPart(value) {
  return encodeURIComponent(String(value));
}

/** 从分组/Agent/选择文档 id 中还原业务 id；后续的 skills 分块层级会被忽略。 */
function businessIdFromDocumentId(documentId, prefix) {
  if (!documentId.startsWith(prefix)) return "";
  try {
    return decodeURIComponent(documentId.slice(prefix.length).split("/")[0]);
  } catch (_) {
    return "";
  }
}

/** 当前设备数据库文档前缀。 */
function currentDevicePrefix(deviceId) {
  return `${DEVICE_PREFIX}${documentIdPart(deviceId)}/`;
}

/** 按数量和 UTF-8 字节数双重限制拆分 id 数组，确保每个文档显著低于 1M。 */
function splitIds(ids) {
  const chunks = [];
  let current = [];
  ids.forEach((id) => {
    const candidate = [...current, id];
    if (
      current.length &&
      (candidate.length > ID_CHUNK_SIZE ||
        Buffer.byteLength(JSON.stringify(candidate), "utf8") >
          ID_CHUNK_MAX_BYTES)
    ) {
      chunks.push(current);
      current = [id];
    } else current = candidate;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

/** 从元数据声明的分块文档还原 id 数组；缺块时返回 null 触发只读保护。 */
function readChunkedIds(allDocuments, baseId, chunkCount) {
  if (!Number.isInteger(chunkCount) || chunkCount < 0) return null;
  const ids = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = documentPayload(
      allDocuments.get(`${baseId}/skills/${String(index).padStart(5, "0")}`),
    );
    if (!Array.isArray(chunk?.ids)) return null;
    ids.push(...chunk.ids);
  }
  return ids;
}

/**
 * 把内存状态拆成职责单一的小文档：分组、Agent、选择、主题和设备缓存互不覆盖。
 * 扫描缓存按固定数量分块，仓库规模增大时也不会触碰单文档 1M 上限。
 */
function buildStoredDocuments(config) {
  const normalized = normalizeConfig(config);
  const documents = new Map();
  const devicePrefix = currentDevicePrefix(config._deviceId || nativeId());
  documents.set(CORE_DOCUMENT_ID, {
    version: CONFIG_VERSION,
    groupIds: normalized.groups.map((group) => group.id),
    agentIds: normalized.agents.map((agent) => agent.id),
  });
  documents.set(THEME_DOCUMENT_ID, { theme: normalized.theme });
  normalized.groups.forEach((group) => {
    const baseId = `${GROUP_PREFIX}${documentIdPart(group.id)}`;
    const chunks = splitIds(group.skillIds);
    documents.set(baseId, {
      id: group.id,
      name: group.name,
      skillChunkCount: chunks.length,
    });
    chunks.forEach((ids, index) =>
      documents.set(`${baseId}/skills/${String(index).padStart(5, "0")}`, {
        ids,
      }),
    );
  });
  normalized.agents.forEach((agent) => {
    documents.set(`${AGENT_PREFIX}${documentIdPart(agent.id)}`, {
      id: agent.id,
      name: agent.name,
    });
    const selectionId = `${SELECTION_PREFIX}${documentIdPart(agent.id)}`;
    const selectionChunks = splitIds(normalized.enabledSkills[agent.id] || []);
    documents.set(selectionId, {
      agentId: agent.id,
      skillChunkCount: selectionChunks.length,
    });
    selectionChunks.forEach((ids, index) =>
      documents.set(`${selectionId}/skills/${String(index).padStart(5, "0")}`, {
        ids,
      }),
    );
  });
  documents.set(`${devicePrefix}profile`, {
    repositoryPath: normalized.repositoryPath,
  });
  [...normalized.agents, ...(config._orphanAgents || [])].forEach((agent) => {
    if (!agent.directory) return;
    documents.set(`${devicePrefix}agent/${documentIdPart(agent.id)}`, {
      id: agent.id,
      name: agent.name,
      directory: agent.directory,
      managedLinks: normalizeManagedLinks(agent.managedLinks),
      externalLinkedCount: agent.externalLinkedCount || 0,
    });
  });
  const cachedSkills = normalizeCachedSkills(config._cachedSkills);
  const cacheChunks = [];
  let currentChunk = [];
  cachedSkills.forEach((skill) => {
    const candidate = [...currentChunk, skill];
    if (
      currentChunk.length &&
      (candidate.length > CACHE_CHUNK_SIZE ||
        Buffer.byteLength(JSON.stringify(candidate), "utf8") >
          CACHE_CHUNK_MAX_BYTES)
    ) {
      cacheChunks.push(currentChunk);
      currentChunk = [skill];
    } else currentChunk = candidate;
  });
  if (currentChunk.length) cacheChunks.push(currentChunk);
  cacheChunks.forEach((skills, chunkIndex) => {
    documents.set(
      `${devicePrefix}cache/${String(chunkIndex).padStart(5, "0")}`,
      {
        index: chunkIndex,
        skills,
      },
    );
  });
  return documents;
}

/** 仅提交相对读取基线发生变化的文档，并更新基线供同一业务流程继续保存检查点。 */
function writeConfig(config) {
  try {
    const desired = buildStoredDocuments(config);
    const baseline = config._baselineDocuments || new Map();
    const baselineCore = baseline.get(CORE_DOCUMENT_ID) || {};
    // 云同步可能先送达明细文档、稍后才送达 core。未被旧 core 引用的陌生共享文档先保留，
    // 只有“旧 core 明确存在、当前 core 明确删除”的记录才由本轮移除。
    for (const [id, payload] of baseline) {
      if (desired.has(id) || !id.startsWith(`${DB_PREFIX}shared/`)) continue;
      const groupId = businessIdFromDocumentId(id, GROUP_PREFIX);
      const agentId =
        businessIdFromDocumentId(id, AGENT_PREFIX) ||
        businessIdFromDocumentId(id, SELECTION_PREFIX);
      const knownBefore = groupId
        ? baselineCore.groupIds?.includes(groupId)
        : agentId
          ? baselineCore.agentIds?.includes(agentId)
          : true;
      if (!knownBefore) desired.set(id, payload);
    }
    config._baselineDocuments = database().commit(baseline, desired);
    // v3 首次成功写入后移除开发阶段的旧 dbStorage 数据，避免两套数据长期并存。
    if (config._migratedFromV2) {
      legacyStorage()?.removeItem(V2_STATE_KEY);
      Object.values(LEGACY_STORAGE_KEYS).forEach((key) =>
        legacyStorage()?.removeItem(key),
      );
      config._migratedFromV2 = false;
    }
  } catch (error) {
    throw new Error(`保存本地数据库失败：${errorMessage(error)}`);
  }
}

/** 主题使用独立文档保存，即使其他配置处于只读保护也不会重写任何业务数据。 */
function writeTheme(config) {
  try {
    const baselinePayload = config._baselineDocuments?.get(THEME_DOCUMENT_ID);
    const committed = database().commit(
      new Map([[THEME_DOCUMENT_ID, baselinePayload]]),
      new Map([[THEME_DOCUMENT_ID, { theme: config.theme }]]),
    );
    config._baselineDocuments = new Map(config._baselineDocuments || []);
    config._baselineDocuments.set(
      THEME_DOCUMENT_ID,
      committed.get(THEME_DOCUMENT_ID),
    );
  } catch (error) {
    throw new Error(`保存主题失败：${errorMessage(error)}`);
  }
}

// 读取流程：汇总共享小文档与当前设备文档 → 深度校验 → 合并本机目录和受管链接 → 附加运行期上下文。
/** 读取 v3 分片文档，并兼容一次性迁移开发阶段已产生的 state-v2 数据。 */
async function readConfig() {
  try {
    const repository = database();
    const deviceId = nativeId();
    const devicePrefix = currentDevicePrefix(deviceId);
    const allDocuments = repository.readAll();
    const core = documentPayload(allDocuments.get(CORE_DOCUMENT_ID));
    const baselineDocuments = new Map(
      [...allDocuments]
        .filter(
          ([id]) =>
            id.startsWith(`${DB_PREFIX}shared/`) || id.startsWith(devicePrefix),
        )
        .map(([id, document]) => [id, documentPayload(document)]),
    );
    let stored;
    let deviceState;
    let migratedFromV2 = false;

    if (!core) {
      // state-v2 同样来自 uTools dbStorage，不涉及旧 JSON；成功写入 v3 后立即删除。
      stored = legacyStorage()?.getItem(V2_STATE_KEY) || null;
      if (stored) {
        migratedFromV2 = true;
        const v2DeviceStates = isPlainObject(stored.deviceStates)
          ? stored.deviceStates
          : {};
        deviceState = isPlainObject(v2DeviceStates[deviceId])
          ? v2DeviceStates[deviceId]
          : {
              repositoryPath: stored.repositoryPath || "",
              agents: Object.fromEntries(
                (Array.isArray(stored.agents) ? stored.agents : []).map(
                  (agent) => [agent.id, agent],
                ),
              ),
              skills: [],
            };
      }
    } else {
      const groupIds = Array.isArray(core.groupIds) ? core.groupIds : [];
      const agentIds = Array.isArray(core.agentIds) ? core.agentIds : [];
      const groups = groupIds.map((id) => {
        const baseId = `${GROUP_PREFIX}${documentIdPart(id)}`;
        const group = documentPayload(allDocuments.get(baseId));
        if (!group) return null;
        const skillIds = readChunkedIds(
          allDocuments,
          baseId,
          group.skillChunkCount,
        );
        return skillIds ? { id: group.id, name: group.name, skillIds } : null;
      });
      const agents = agentIds.map((id) => ({
        ...(documentPayload(
          allDocuments.get(`${AGENT_PREFIX}${documentIdPart(id)}`),
        ) || {}),
        directory: "",
      }));
      const enabledSkills = Object.fromEntries(
        agentIds.map((id) => {
          const baseId = `${SELECTION_PREFIX}${documentIdPart(id)}`;
          const selection = documentPayload(allDocuments.get(baseId));
          return [
            id,
            selection
              ? readChunkedIds(allDocuments, baseId, selection.skillChunkCount)
              : null,
          ];
        }),
      );
      const theme =
        documentPayload(allDocuments.get(THEME_DOCUMENT_ID))?.theme || "light";
      const localAgents = {};
      const cachedChunks = [];
      for (const [id, document] of allDocuments) {
        if (id.startsWith(`${devicePrefix}agent/`)) {
          const localAgent = documentPayload(document);
          if (localAgent?.id) localAgents[localAgent.id] = localAgent;
        } else if (id.startsWith(`${devicePrefix}cache/`)) {
          cachedChunks.push(documentPayload(document));
        }
      }
      cachedChunks.sort(
        (left, right) => Number(left?.index) - Number(right?.index),
      );
      deviceState = {
        repositoryPath:
          documentPayload(allDocuments.get(`${devicePrefix}profile`))
            ?.repositoryPath || "",
        agents: localAgents,
        skills: cachedChunks.flatMap((chunk) =>
          Array.isArray(chunk?.skills) ? chunk.skills : [],
        ),
      };
      stored = {
        version: core.version,
        repositoryPath: "",
        groups,
        agents,
        enabledSkills,
        enabledGroups: Object.fromEntries(
          agentIds.map((id) => [
            id,
            deriveEnabledGroupIds(
              groups.filter(Boolean),
              Array.isArray(enabledSkills[id]) ? enabledSkills[id] : [],
            ),
          ]),
        ),
        theme,
        deviceStates: { [deviceId]: deviceState },
      };
    }

    if (!stored) {
      return attachRuntime(createDefaultConfig(), {
        _issues: [],
        _syncLocked: false,
        _deviceId: deviceId,
        _orphanAgents: [],
        _cachedSkills: [],
        _baselineDocuments: baselineDocuments,
        _migratedFromV2: false,
      });
    }
    // 校验只决定 locked 与 issues，不会修改任何共享数据。
    const validation = await validateStoredState(
      stored,
      deviceState || { repositoryPath: "", agents: {} },
      migratedFromV2,
    );
    // 合并策略：名称等共享字段取共享层，路径与受管链接只取本机分区（旧结构回退到原字段）。
    const localAgentRecords = isPlainObject(deviceState.agents)
      ? deviceState.agents
      : {};
    const mergedAgents = (
      Array.isArray(stored.agents) ? stored.agents : []
    ).map((agent) => {
      const local = localAgentRecords[agent.id];
      return {
        ...agent,
        directory:
          typeof local?.directory === "string"
            ? local.directory
            : migratedFromV2
              ? agent.directory
              : "",
        managedLinks: local?.managedLinks || agent.managedLinks || {},
        externalLinkedCount: local?.externalLinkedCount || 0,
      };
    });
    const config = normalizeConfig({
      ...stored,
      repositoryPath:
        typeof deviceState.repositoryPath === "string"
          ? deviceState.repositoryPath
          : migratedFromV2
            ? stored.repositoryPath
            : "",
      agents: mergedAgents,
    });
    // 本机分区里仍保留、但共享配置已删除的 Agent：转成待清理项，交给 refreshState 安全回收。
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
    // 旧数据只在“未进入只读保护”时提示迁移，属于信息级提示。
    if (migratedFromV2 && !validation.locked)
      validation.issues.push(
        createIssue(
          "info",
          "开发阶段的 state-v2 数据已迁移为 v3 分片文档结构。",
        ),
      );
    const runtimeConfig = attachRuntime(config, {
      _issues: uniqueIssues(validation.issues),
      _syncLocked: validation.locked,
      _deviceId: deviceId,
      _orphanAgents: orphanAgents,
      _cachedSkills: normalizeCachedSkills(deviceState.skills),
      _baselineDocuments: baselineDocuments,
      _migratedFromV2: migratedFromV2,
    });
    // 迁移在首次成功读取时立即完成，避免仅保存主题时继续被旧文档覆盖。
    if (migratedFromV2 && !validation.locked) writeConfig(runtimeConfig);
    return runtimeConfig;
  } catch (error) {
    throw new Error(`读取本地数据库失败：${errorMessage(error)}`);
  }
}

/** 清除共享文档和当前设备文档；其他设备的受管记录保留，供对应设备下次安全清理。 */
function clearStoredConfig(config) {
  try {
    database().commit(config._baselineDocuments || new Map(), new Map());
    legacyStorage()?.removeItem(V2_STATE_KEY);
    Object.values(LEGACY_STORAGE_KEYS).forEach((key) =>
      legacyStorage()?.removeItem(key),
    );
  } catch (error) {
    throw new Error(`清除本地数据库失败：${errorMessage(error)}`);
  }
}

// ============================================================================
// 四、状态收敛与同步编排
// ============================================================================

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
  // 同样的清理也要作用于 enabledSkills：否则已删除的 Skill 会残留在选择状态中，
  // 界面上就会出现“显示已选中、实际却无链接”的假象。
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
  // 只读保护下不做任何持久化：不能用规范化后的内存配置覆盖已损坏的原文档。
  if (config._syncLocked) return persistenceIssues;
  try {
    writeConfig(config);
  } catch (error) {
    // 写入失败 → 回滚本轮新建的链接（只会删除本应用刚创建、且已校验归属的链接），
    // 避免出现“数据库里没有记录、磁盘上却留有链接”的不可追踪状态。
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
  // 步骤 1：扫描仓库，得到 Skill 列表、问题列表以及“扫描是否完整 / 是否只读保护”。
  const scan = await scanConfiguredRepository(config);
  // 只有完整扫描结果才替换首屏缓存；不完整结果绝不成为后续清理依据。
  if (scan.complete && !scan.locked)
    config._cachedSkills = normalizeCachedSkills(scan.skills);
  // 步骤 2：清理已失效的 Skill 引用（扫描不完整或只读保护时，函数内部直接返回空结果）。
  const reconciledIssues = reconcileDeletedSkills(config, scan);
  // 只读保护时只观察链接；正常状态先保存恢复检查点，再开始文件系统变更。
  if (!config._syncLocked) writeConfig(config);
  // 步骤 3：先清理本机遗留的 orphan 链接，再做常规同步，避免两类操作互相干扰。
  const orphanIssues = config._syncLocked
    ? []
    : await cleanupOrphanAgents(config);
  // 步骤 4：按 Agent 逐个同步链接集合，并在结束后统一持久化 + 失败回滚。
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

// 使用场景：应用配置页切换某个分组/Skill 开关时调用（对应 setAgentSkills）。
// 与 refreshState 的区别：不做全仓库扫描，只核验本次涉及的 Skill，因此响应更快；
// 代价是依赖「最近一次完整扫描」的缓存，缓存缺失或源目录不可用时会退化为只补不删。
/**
 * 只同步一次应用配置开关涉及的 Agent。
 * 使用最近一次完整扫描缓存并逐项验证源目录，避免每次点击都递归遍历整个仓库。
 */
async function syncAgentSkillsState(config, agent, previousSkillIds) {
  const targetedScan = await inspectEnabledCachedSkills(
    config,
    agent,
    previousSkillIds,
  );
  // 先保存新的启用关系和旧链接记录；检查点失败时不会触碰文件系统。
  writeConfig(config);
  const syncResults = {
    [agent.id]: await syncAgent(config, agent, targetedScan, {
      // 手动链接全量审计只在刷新/启动时执行，避免每次开关都遍历整个 Agent 目录。
      auditExternalLinks: false,
    }),
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

// orphan Agent 的两种来源：① 其他设备删除了 Agent（本机还留着目录与链接）；
// ② 本机更换了 Agent 目录或删除了 Agent，但上次清理未完成。两者都只清理“可识别的受管链接”。
/** 清理当前设备上已经不属于共享配置的 Agent 链接，并保留失败项供下次重试。 */
async function cleanupOrphanAgents(config) {
  const issues = [];
  const remaining = [];
  for (const agent of config._orphanAgents || []) {
    const agentIssues = await cleanupAgentLinks(agent);
    issues.push(...agentIssues);
    // 仍有未能清理的链接 → 保留在待清理列表中，下次启动继续尝试，避免链接变成无人认领的孤儿。
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
// 除 chooseDirectory（调用系统对话框）外，其余方法均为 async：文件系统 I/O 全部异步执行，不阻塞 uTools 渲染线程。
const dataChangedListeners = new Set();
// 云端拉取只通知前端重新读取；不在事件回调中直接操作文件系统，避免与本地写入交叉。
window.utools?.onDbPull?.((documents) => {
  let localPrefix;
  try {
    localPrefix = currentDevicePrefix(nativeId());
  } catch (_) {
    return;
  }
  if (
    Array.isArray(documents) &&
    documents.some(
      (document) =>
        document?._id?.startsWith(`${DB_PREFIX}shared/`) ||
        document?._id?.startsWith(localPrefix),
    )
  )
    dataChangedListeners.forEach((listener) => listener());
});

const skillsManagerApi = {
  /** 订阅其他设备同步事件；返回取消订阅函数。 */
  onDataChanged(listener) {
    if (typeof listener !== "function") return () => {};
    dataChangedListeners.add(listener);
    return () => dataChangedListeners.delete(listener);
  },
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

  // 前端首屏渲染完成后再调用：重新扫描仓库并同步链接，把最新的真实状态推给界面。
  // 之所以拆成 getState + reconcile 两步，是为了让窗口先出现内容，避免启动时长时间白屏。
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
    writeTheme(config);
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
    // 拒绝磁盘根目录：根目录不仅扫描极慢，还会把整盘内容都当成候选 Skills，风险与开销都不可接受。
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
   * 保存后会重新推导分组开关；Agent 的实际启用 Skills 不随分组编辑而隐式改变。
   *
   * @param {Array<{id: string, name: string, skillIds: Array}>} groups - 前端提交的完整分组列表
   * @returns {object} 刷新后的完整状态
   * @throws {Error} 分组 id 重复或处于只读保护
   */
  async saveGroups(groups) {
    const config = await readConfig();
    assertConfigWritable(config);
    const inputGroups = Array.isArray(groups) ? groups : [];
    for (const group of inputGroups) {
      const id = String(group?.id || "").trim();
      const name = String(group?.name || "").trim();
      if (!id || !isSafeRecordKey(id) || !name)
        throw new Error("分组数据不完整，请重新创建该分组");
      if (name.length > MAX_ENTITY_NAME_LENGTH)
        throw new Error(`分组名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`);
      if (!Array.isArray(group.skillIds))
        throw new Error(`分组“${name}”的 Skills 配置格式无效`);
    }
    // 只保留 id、name 非空的分组，并对 skillIds 去重。
    config.groups = inputGroups
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
    if (name.length > MAX_ENTITY_NAME_LENGTH)
      throw new Error(`Agent 名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`);
    const directory = await normalizeDirectory(
      String(input?.directory || ""),
      "Agent Skills 目录",
    );
    // 新增时生成唯一 id：时间戳 + 随机串，避免同一毫秒内重复。
    const id = input?.id
      ? String(input.id)
      : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!isSafeRecordKey(id))
      throw new Error("Agent 标识无效，请重新创建 Agent");
    await assertSafeAgentDirectory(config, directory, id);
    const existing = config.agents.find((agent) => agent.id === id);
    if (existing) {
      // 目录变更：旧目录记录转为设备级待清理项，refreshState 保存检查点后再安全清理。
      // 目录变更不直接删旧链接：先把旧目录记录转为本机待清理项，待 refreshState 写入检查点后再安全清理，
      // 这样即使中途崩溃或断电，旧链接也不会变成无人管理的孤儿。
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
        // 旧链接归属已转移到 orphan 记录，当前 Agent 从空记录开始，避免同一链接被两处引用。
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
    // refreshState 会保存删除结果、清理受管链接并返回最新状态；未能清理的链接会留在 orphan 记录中。
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
      _orphanAgents: [...config.agents, ...(config._orphanAgents || [])],
      _cachedSkills: [],
      _baselineDocuments: config._baselineDocuments,
      _migratedFromV2: config._migratedFromV2,
    });
    // 先用分片文档写入“共享配置已清空 + 本机待清理记录”的检查点。
    writeConfig(cleared);
    // 再按待清理记录逐条安全删除本机链接；只有可识别的链接都处理完，才会真正清空数据库文档。
    const issues = await cleanupOrphanAgents(cleared);
    if (config._syncLocked) {
      issues.push(
        createIssue(
          "warning",
          "数据库配置异常，仅清理了仍可识别的本机受管链接；其他内容均已保留。",
        ),
      );
    }
    // 仍有未清理项 → 保留本机待清理记录供下次重试；否则只删除当前设备分区（其他设备分区保留）。
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
    const previousSkillIds = [...(config.enabledSkills[agentId] || [])];
    config.enabledSkills[agentId] = [
      ...new Set(Array.isArray(skillIds) ? skillIds.map(String) : []),
    ].filter((skillId) => validIds.has(skillId));
    // 同步重算分组开关状态：分组是否开启完全由 enabledSkills 推导，保证界面上的双向联动一致。
    config.enabledGroups[agentId] = deriveEnabledGroupIds(
      config.groups,
      config.enabledSkills[agentId],
    );
    // 只做本次开关变更的定向同步：不扫全仓库，先写检查点再改链接。
    return syncAgentSkillsState(config, agent, previousSkillIds);
  },
};

// preload 内再设一道串行队列：即使多个前端入口或未来代码绕过 Pinia，也不会交叉修改数据库和链接。
let mutationTail = Promise.resolve();
const mutationMethods = [
  "setTheme",
  "setRepository",
  "refreshSkills",
  "saveGroups",
  "upsertAgent",
  "deleteAgent",
  "clearData",
  "setAgentSkills",
  "reconcile",
];
mutationMethods.forEach((method) => {
  const operation = skillsManagerApi[method].bind(skillsManagerApi);
  skillsManagerApi[method] = (...args) => {
    const run = mutationTail.then(() => operation(...args));
    mutationTail = run.catch(() => undefined);
    return run;
  };
});

window.skillsManager = skillsManagerApi;
