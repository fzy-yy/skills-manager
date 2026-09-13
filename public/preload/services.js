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
 *  3. 链接同步：按「Agent + 已启用分组」在 Agent 目录下创建指向仓库源目录的目录链接；
 *  4. 安全兜底：只删除本应用创建且校验通过的链接，其余文件/目录/链接一律保留并给出提示。
 *
 * 三条核心安全原则（贯穿全文）：
 *  A. 只管理自己创建的东西：删除前必须同时校验链接路径、链接目标与创建时记录的文件标识；
 *  B. 数据不完整就不做清理：扫描不完整或数据库结构异常时进入只读保护，绝不依据兜底空值删文件；
 *  C. 先写数据库再落盘、落盘失败要回滚：数据库保存失败时回滚本轮新建的链接，避免产生孤立链接。
 */

// Node.js 文件系统模块：读取 SKILL.md、创建/删除链接、遍历目录。
const fs = require('node:fs')
// Node.js 路径模块：跨平台地拼接、解析路径并计算相对路径。
const path = require('node:path')

// 配置结构版本号：配置结构变更时递增，便于将来做数据迁移。
const CONFIG_VERSION = 1
// uTools 本地数据库（dbStorage）的键名表：字段名 → 存储键。
// 使用 Object.freeze 冻结，避免运行期被误改导致读写键名不一致。
const STORAGE_KEYS = Object.freeze({
  // 配置结构版本
  version: 'skills-manager/version',
  // 统一 Skills 仓库目录的绝对路径
  repositoryPath: 'skills-manager/repository-path',
  // 分组列表
  groups: 'skills-manager/groups',
  // Agent 列表（含每个 Agent 的受管链接记录）
  agents: 'skills-manager/agents',
  // 每个 Agent 已启用的分组 id 列表
  enabledGroups: 'skills-manager/enabled-groups',
  // 界面主题（light / dark）
  theme: 'skills-manager/theme'
})

// ============================================================================
// 一、配置结构与存取
// ============================================================================

/**
 * 创建一份默认配置（首次使用或清除数据后返回）。
 *
 * @returns {{version: number, repositoryPath: string, groups: Array, agents: Array, enabledGroups: object, theme: string}}
 */
// 配置只存入 uTools dbStorage；文件系统仅用于扫描 Skill 和维护链接。
function createDefaultConfig () {
  return { version: CONFIG_VERSION, repositoryPath: '', groups: [], agents: [], enabledGroups: {}, theme: 'light' }
}

/**
 * 把任意异常整理成可直接展示给用户的中文文案。
 * Node.js 异常通常带 code（如 ENOENT、EPERM、EACCES），拼接后更利于排查问题。
 *
 * @param {any} error - 捕获到的异常
 * @returns {string} 形如「ENOENT：no such file or directory」的文案
 */
function errorMessage (error) {
  if (!error) return '未知错误'
  const code = error.code ? `${error.code}：` : ''
  return `${code}${error.message || String(error)}`
}

/**
 * 构造一条「问题记录」。问题不会中断流程，而是汇总后交给前端统一提示。
 *
 * @param {'error'|'warning'|'info'} type - 严重级别，error 表示本次操作的关键步骤失败
 * @param {string} message - 面向用户的中文说明
 * @returns {{type: string, message: string}}
 */
function createIssue (type, message) {
  return { type: type === 'error' ? 'error' : type === 'info' ? 'info' : 'warning', message }
}

/**
 * 按「类型 + 文案」对问题列表去重，避免同一问题在多轮扫描/同步中被反复提示。
 *
 * @param {Array<{type: string, message: string}>} issues - 原始问题列表
 * @returns {Array} 去重后的问题列表
 */
function uniqueIssues (issues) {
  const seen = new Set()
  return issues.filter(issue => {
    const key = `${issue.type}:${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 规范化「受管链接」记录，即 { [skillId]: { linkPath, sourcePath, identity? } } 结构。
 * 记录损坏（非对象、缺少路径字段）时直接丢弃，避免污染后续的同步与删除逻辑。
 *
 * @param {any} input - 数据库中保存的 managedLinks 原始值
 * @returns {object} 清理后的受管链接映射
 */
function normalizeManagedLinks (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return Object.fromEntries(Object.entries(input).flatMap(([skillId, link]) => {
    // 缺少 skillId 或链接记录的条目无法管理，直接跳过。
    if (!skillId || !link || typeof link !== 'object') return []
    // linkPath（Agent 目录下的链接位置）与 sourcePath（仓库中的源目录）必须是字符串，否则无法做安全检查。
    if (typeof link.linkPath !== 'string' || typeof link.sourcePath !== 'string') return []
    // identity 用于确认「该链接仍然是当初由本应用创建的那一条」：设备号 + inode + 创建时间。
    const identity = link.identity && typeof link.identity === 'object'
      ? { dev: Number(link.identity.dev), ino: Number(link.identity.ino), birthtimeMs: Number(link.identity.birthtimeMs) }
      : null
    return [[String(skillId), { linkPath: link.linkPath, sourcePath: link.sourcePath, ...(identity ? { identity } : {}) }]]
  }))
}

/**
 * 规范化完整配置：清洗分组、Agent、启用关系与主题，保证结构可直接用于后续逻辑。
 * 所有字段都做类型校验与去重，异常记录被忽略而不是让整份配置失效。
 *
 * @param {any} input - 从数据库读出的原始配置
 * @returns {object} 结构合法的配置对象（还会被 readConfig 附加不可枚举的 _issues / _syncLocked）
 */
function normalizeConfig (input) {
  const config = input && typeof input === 'object' ? input : {}
  const groups = []
  const groupIds = new Set()
  // 分组：要求 id 与 name 非空且 id 唯一；skillIds 去重后统一转为字符串数组。
  for (const item of Array.isArray(config.groups) ? config.groups : []) {
    const id = String(item?.id || '').trim()
    const name = String(item?.name || '').trim()
    if (!id || !name || groupIds.has(id)) continue
    groupIds.add(id)
    groups.push({ id, name, skillIds: [...new Set((Array.isArray(item.skillIds) ? item.skillIds : []).map(String))] })
  }

  // Agent：要求 id、name、directory 均非空且 id 唯一；目录本身是否可用由后续目录校验负责。
  const agents = []
  const agentIds = new Set()
  for (const item of Array.isArray(config.agents) ? config.agents : []) {
    const id = String(item?.id || '').trim()
    const name = String(item?.name || '').trim()
    const directory = String(item?.directory || '').trim()
    if (!id || !name || !directory || agentIds.has(id)) continue
    agentIds.add(id)
    agents.push({ id, name, directory, managedLinks: normalizeManagedLinks(item.managedLinks) })
  }

  // 启用关系：以现存 Agent 为准重建，并过滤掉已不存在的分组 id（分组被删除后的自愈）。
  const enabledGroups = {}
  const storedEnabledGroups = config.enabledGroups && typeof config.enabledGroups === 'object' ? config.enabledGroups : {}
  agents.forEach(agent => {
    enabledGroups[agent.id] = [...new Set((Array.isArray(storedEnabledGroups[agent.id]) ? storedEnabledGroups[agent.id] : []).map(String))]
      .filter(groupId => groupIds.has(groupId))
  })

  return {
    version: CONFIG_VERSION,
    repositoryPath: typeof config.repositoryPath === 'string' ? config.repositoryPath : '',
    groups,
    agents,
    enabledGroups,
    theme: config.theme === 'dark' ? 'dark' : 'light'
  }
}

/**
 * 获取 uTools 本地数据库（dbStorage）句柄。
 *
 * @returns {object} utools.dbStorage 实例
 * @throws {Error} 不在 uTools 环境中（未加载 preload）时抛出
 */
function database () {
  const storage = window.utools?.dbStorage
  if (!storage) throw new Error('uTools 本地数据库不可用，请在 uTools 插件环境中重新打开应用')
  return storage
}

/**
 * 写入完整配置：先规范化，再按 STORAGE_KEYS 逐字段写入 uTools 本地数据库。
 *
 * @param {object} config - 待保存的配置对象
 * @throws {Error} 写入失败时抛出带原因的异常，由调用方决定是否需要回滚链接
 */
function writeConfig (config) {
  const normalized = normalizeConfig(config)
  try {
    const storage = database()
    // 一个字段对应一个 dbStorage 键，读取时按同样的映射还原。
    Object.entries(STORAGE_KEYS).forEach(([field, key]) => storage.setItem(key, normalized[field]))
  } catch (error) {
    throw new Error(`保存本地数据库失败：${errorMessage(error)}`)
  }
}

/**
 * 读取并校验完整配置。
 *
 * 校验策略：
 *  - 所有键都为空 → 视为首次使用，返回默认配置；
 *  - 关键字段缺失/结构异常，且已存在分组、Agent 或启用关系数据 → 标记 _syncLocked 进入只读保护；
 *  - 非关键异常（如无效主题值）只记录问题，不影响读写。
 *
 * @returns {object} 规范化后的配置；另带两个不可枚举属性：
 *                  _issues（读取过程中发现的问题列表）、_syncLocked（是否只读保护）
 * @throws {Error} 读取数据库本身失败时抛出
 */
function readConfig () {
  try {
    const storage = database()
    const stored = {}
    Object.entries(STORAGE_KEYS).forEach(([field, key]) => { stored[field] = storage.getItem(key) })
    // 所有键都为 null/undefined 表示数据库里没有本插件的任何数据。
    const hasDatabaseData = Object.values(stored).some(value => value !== null && value !== undefined)
    if (!hasDatabaseData) return createDefaultConfig()
    const issues = []
    // 缺失字段：用于提示用户，并参与「是否需要只读保护」的判断。
    const missingFields = Object.keys(STORAGE_KEYS).filter(field => stored[field] === null || stored[field] === undefined)
    // 是否已存在与链接相关的数据：只有存在依赖数据时，关键字段缺失才是危险的。
    const hasDependentData = (Array.isArray(stored.groups) && stored.groups.length > 0) ||
      (Array.isArray(stored.agents) && stored.agents.length > 0) ||
      (stored.enabledGroups && typeof stored.enabledGroups === 'object' && Object.keys(stored.enabledGroups).length > 0)
    // 关键字段缺失且已有依赖数据 → 只读保护，避免用兜底空值清空真实链接。
    const criticalMissing = missingFields.some(field => ['repositoryPath', 'groups', 'agents', 'enabledGroups'].includes(field))
    let syncLocked = criticalMissing && hasDependentData
    if (missingFields.length) issues.push(createIssue('warning', `本地数据库配置不完整，缺失项已使用默认值：${missingFields.join('、')}`))
    // 分组结构不是数组：配置已不可信，进入只读保护（只观察、不改动磁盘）。
    if (stored.groups != null && !Array.isArray(stored.groups)) {
      syncLocked = true
      issues.push(createIssue('error', '本地数据库中的分组数据格式异常，已进入只读保护。可在设置页清除数据后重新配置。'))
    }
    // Agent 结构不是数组：同上，避免因解析失败误判「所有 Agent 都被删除」而清理链接。
    if (stored.agents != null && !Array.isArray(stored.agents)) {
      syncLocked = true
      issues.push(createIssue('error', '本地数据库中的 Agent 数据格式异常，已进入只读保护。可在设置页清除数据后重新配置。'))
    }
    // 启用关系不是普通对象（数组或原始值）：同样进入只读保护。
    if (stored.enabledGroups != null && (typeof stored.enabledGroups !== 'object' || Array.isArray(stored.enabledGroups))) {
      syncLocked = true
      issues.push(createIssue('error', '本地数据库中的应用配置格式异常，已进入只读保护。可在设置页清除数据后重新配置。'))
    }
    const config = normalizeConfig(stored)
    // 规范化时丢弃了记录 → 说明存在无效或重复数据，提示用户但不阻断使用。
    if (Array.isArray(stored.groups) && config.groups.length !== stored.groups.length) {
      issues.push(createIssue('warning', '部分分组记录无效或标识重复，已忽略异常记录。'))
    }
    // Agent 记录被丢弃的提示（同样只提示，不影响后续同步）。
    if (Array.isArray(stored.agents) && config.agents.length !== stored.agents.length) {
      issues.push(createIssue('warning', '部分 Agent 记录无效或标识重复，已忽略异常记录。'))
    }
    // 仓库路径类型异常：不能猜测用户意图，进入只读保护。
    if (stored.repositoryPath != null && typeof stored.repositoryPath !== 'string') {
      syncLocked = true
      issues.push(createIssue('error', '本地数据库中的仓库路径格式异常，已进入只读保护。可在设置页清除数据后重新配置。'))
    }
    // 主题值非法：可直接回退为浅色，属于可自愈的轻微问题。
    if (stored.theme != null && stored.theme !== 'light' && stored.theme !== 'dark') {
      issues.push(createIssue('warning', '本地数据库中的主题值无效，已恢复为浅色主题。'))
    }
    // 用不可枚举属性携带诊断信息：既不影响 JSON 序列化，也不会写回数据库。
    Object.defineProperty(config, '_issues', { value: issues, enumerable: false })
    Object.defineProperty(config, '_syncLocked', { value: syncLocked, enumerable: false })
    return config
  } catch (error) {
    throw new Error(`读取本地数据库失败：${errorMessage(error)}`)
  }
}

/**
 * 删除本地数据库中的全部插件配置键。
 * 单个键删除失败不影响其他键，最后统一汇总失败项。
 *
 * @throws {Error} 存在删除失败的键时抛出（附带键名与原因）
 */
function clearStoredConfig () {
  const failures = []
  const storage = database()
  Object.values(STORAGE_KEYS).forEach(key => {
    try { storage.removeItem(key) } catch (error) { failures.push(`${key}（${errorMessage(error)}）`) }
  })
  if (failures.length) throw new Error(`清除本地数据库失败：${failures.join('；')}`)
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
function normalizeDirectory (directory, label = '目录') {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error(`请选择有效的${label}`)
  const resolved = path.resolve(directory.trim())
  let stat
  try { stat = fs.statSync(resolved) } catch (error) { throw new Error(`${label}不存在或无法访问：${errorMessage(error)}`) }
  if (!stat.isDirectory()) throw new Error(`${label}不是文件夹：${resolved}`)
  return resolved
}

/**
 * 生成用于比较的规范化路径。
 * 处理三类差异：Windows 的 \\?\ 命名空间前缀、大小写不敏感、结尾多余的斜杠。
 *
 * @param {string} target - 任意路径
 * @returns {string} 可安全用于字符串比较的路径
 */
// 所有路径比较都兼容 Windows 大小写、目录链接和 \\?\ 命名空间前缀。
function comparablePath (target) {
  let normalized = path.normalize(path.resolve(String(target).replace(/^\\\\\?\\/, '')))
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  return normalized.replace(/[\\/]+$/, '')
}

/**
 * 判断两个路径是否指向同一位置。
 * 先做字符串比较（快路径），不一致时再用 realpath 解析软链接后比较（慢路径）。
 *
 * @param {string} left - 路径 A
 * @param {string} right - 路径 B
 * @returns {boolean} 是否指向同一位置
 */
function pathsEqual (left, right) {
  try {
    if (comparablePath(left) === comparablePath(right)) return true
    // 两侧都存在时才解析真实路径，避免对不存在的路径抛异常。
    if (fs.existsSync(left) && fs.existsSync(right)) return comparablePath(fs.realpathSync(left)) === comparablePath(fs.realpathSync(right))
  } catch (_) {}
  return false
}

/**
 * 判断 child 是否位于 parent 之内（与 parent 相同也算「在内」）。
 * 使用 realpath 解析，避免通过目录链接绕过包含关系检查。
 *
 * @param {string} parent - 父目录
 * @param {string} child - 待判断的目录
 * @returns {boolean} child 是否在 parent 内部
 */
function isInsideDirectory (parent, child) {
  const canonical = target => {
    try { return fs.realpathSync(target) } catch (_) { return path.resolve(target) }
  }
  const relative = path.relative(canonical(parent), canonical(child))
  // 相对路径为空表示同一目录；以 .. 开头或为绝对路径则表示不在内部。
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
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
function assertSafeAgentDirectory (config, directory, currentAgentId = '') {
  let canonicalDirectory = directory
  // 优先使用 realpath，保证符号链接形式的根目录也能被识别。
  try { canonicalDirectory = fs.realpathSync(directory) } catch (_) {}
  if (path.parse(canonicalDirectory).root === canonicalDirectory) throw new Error('Agent Skills 目录不能是磁盘根目录')
  // 与仓库目录互相包含会导致「扫描结果里出现自己创建的链接」，形成递归干扰。
  if (config.repositoryPath && (isInsideDirectory(config.repositoryPath, directory) || isInsideDirectory(directory, config.repositoryPath))) {
    throw new Error('Agent Skills 目录不能与统一 Skills 仓库相同或互相包含，以免扫描和链接相互影响')
  }
  // 同一目录被两个 Agent 使用会导致链接被互相删除，必须禁止。
  const duplicate = config.agents.find(agent => agent.id !== currentAgentId && pathsEqual(agent.directory, directory))
  if (duplicate) throw new Error(`该 Skills 目录已由 Agent“${duplicate.name}”使用，请选择其他目录`)
}

// ============================================================================
// 三、SKILL.md 解析与仓库扫描
// ============================================================================

/**
 * 读取并解析 SKILL.md 的 YAML 元数据中的 name 字段（不引入第三方 YAML 依赖）。
 * 支持单引号、双引号与裸值三种写法，并允许行尾注释。
 *
 * @param {string} skillFile - SKILL.md 的绝对路径
 * @returns {{name: string, error: string}} 成功时返回 name 且 error 为空；失败时 name 为空并给出原因
 */
function readSkillNameDetailed (skillFile) {
  let content
  try { content = fs.readFileSync(skillFile, 'utf8') } catch (error) {
    return { name: '', error: `无法读取 ${skillFile}：${errorMessage(error)}` }
  }
  // 匹配文件开头的 YAML frontmatter（--- ... ---），兼容 BOM 与 CRLF 换行。
  const frontmatter = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (!frontmatter) return { name: '', error: `${skillFile} 缺少有效的 YAML 元数据` }
  // 在元数据中查找 name 行（允许前面有缩进）。
  const nameLine = frontmatter[1].split(/\r?\n/).find(line => /^\s*name\s*:/.test(line))
  if (!nameLine) return { name: '', error: `${skillFile} 的元数据缺少 name 字段` }
  const rawValue = nameLine.replace(/^\s*name\s*:\s*/, '').trim()
  let name = ''
  try {
    // 双引号写法：按 JSON 字符串解析，可正确处理 \n、\" 等转义。
    if (rawValue.startsWith('"')) {
      const quoted = rawValue.match(/^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/)
      if (!quoted) throw new Error('双引号未正确闭合')
      name = JSON.parse(quoted[1])
    } else if (rawValue.startsWith("'")) {
      // 单引号写法：YAML 中以两个单引号表示一个单引号。
      const quoted = rawValue.match(/^'((?:''|[^'])*)'\s*(?:#.*)?$/)
      if (!quoted) throw new Error('单引号未正确闭合')
      name = quoted[1].replace(/''/g, "'")
    } else {
      // 裸值写法：去掉行尾注释即可。
      name = rawValue.replace(/\s+#.*$/, '').trim()
    }
  } catch (error) {
    return { name: '', error: `${skillFile} 的 name 字段无效：${errorMessage(error)}` }
  }
  name = String(name).trim()
  return name ? { name, error: '' } : { name: '', error: `${skillFile} 的 name 字段为空` }
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
function scanSkills (repositoryPath) {
  // 未配置仓库时视为空仓库，无需报错。
  if (!repositoryPath) return { skills: [], issues: [], complete: true }
  const root = normalizeDirectory(repositoryPath, 'Skills 仓库目录')
  const skills = []
  const issues = []
  let complete = true

  /**
   * 深度优先遍历单个目录。
   *
   * @param {string} directory - 当前目录绝对路径
   */
  function visit (directory) {
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch (error) {
      // 目录不可读：标记扫描不完整，后续不会清理任何缺失记录，避免误删。
      complete = false
      issues.push(createIssue('error', `无法扫描目录 ${directory}：${errorMessage(error)}。为防止误删，本次不会清理缺失项。`))
      return
    }
    // 当前目录内存在 SKILL.md → 认定为一个 Skill 目录。
    const skillEntry = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md')
    if (skillEntry) {
      const skillFile = path.join(directory, skillEntry.name)
      const result = readSkillNameDetailed(skillFile)
      if (result.name) {
        // id 使用相对于仓库根目录的 POSIX 风格路径（根目录自身记为 '.'），便于跨平台存储与比较。
        const relativePath = path.relative(root, directory).split(path.sep).join('/') || '.'
        skills.push({ id: relativePath, name: result.name, relativePath, folderName: path.basename(directory), sourcePath: directory })
        return
      }
      // 有 SKILL.md 但元数据非法：忽略该目录并提示，继续向下查找子目录。
      issues.push(createIssue('warning', `${result.error}，该目录已忽略。`))
    }
    // 继续遍历子目录：跳过符号链接（防止循环）、node_modules 与 .git*。
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name.startsWith('.git')) continue
      visit(path.join(directory, entry.name))
    }
  }

  visit(root)
  // 名称统一按中文习惯排序，保证列表展示稳定。
  skills.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  return { skills, issues: uniqueIssues(issues), complete }
}

/**
 * 扫描当前配置指向的仓库目录，并把「配置异常」转换为可展示的问题。
 *
 * @param {object} config - 当前配置（可能带 _syncLocked 标记）
 * @returns {{skills: Array, issues: Array, complete: boolean, locked?: boolean}} 扫描结果
 */
function scanConfiguredRepository (config) {
  // 是否存在依赖仓库路径的数据（分组内容或受管链接）。
  const hasDependentData = config.groups.some(group => group.skillIds.length) || config.agents.some(agent => Object.keys(agent.managedLinks).length)
  // 仓库路径缺失但仍有分组/链接：保留现状并阻止清理，避免把链接全部删掉。
  if (!config.repositoryPath && hasDependentData) {
    return {
      skills: [],
      complete: false,
      locked: Boolean(config._syncLocked),
      issues: [createIssue('error', 'Skills 仓库路径缺失，但仍存在分组或链接记录。为防止误删，现有配置和链接已保留。')]
    }
  }
  try {
    const scan = scanSkills(config.repositoryPath)
    // 配置本身处于只读保护时，把标记继续向下传递。
    if (config._syncLocked) scan.locked = true
    return scan
  } catch (error) {
    // 目录被删除、无权限等：同样按「不完整」处理，保留现有配置与链接。
    return {
      skills: [],
      complete: false,
      locked: Boolean(config._syncLocked),
      issues: [createIssue('error', `${error.message}。现有配置和链接已保留，请恢复目录后重新扫描。`)]
    }
  }
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
function inspectLink (linkPath, expectedSource) {
  let stat
  try { stat = fs.lstatSync(linkPath) } catch (error) {
    // 路径不存在属于正常情况（尚未创建链接）。
    if (error.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'error', error }
  }
  // 不是符号链接：可能是用户自己创建的目录或文件，必须保留。
  if (!stat.isSymbolicLink()) return { kind: stat.isDirectory() ? 'directory' : 'file' }
  try {
    const rawTarget = fs.readlinkSync(linkPath)
    // 相对目标的链接需要基于链接所在目录解析成绝对路径。
    const targetPath = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(linkPath), rawTarget)
    return {
      kind: 'link',
      targetPath,
      // 目标是否与期望的仓库源目录一致（不一致说明链接已被外部改写）。
      sameTarget: expectedSource ? pathsEqual(targetPath, expectedSource) : false,
      // 目标不存在说明该链接已失效。
      dangling: !fs.existsSync(targetPath),
      // 文件标识：用于确认链接未被「删除后重建」。
      identity: { dev: Number(stat.dev), ino: Number(stat.ino), birthtimeMs: Number(stat.birthtimeMs) }
    }
  } catch (error) {
    return { kind: 'error', error }
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
function identitiesEqual (stored, current) {
  if (!stored) return true
  return stored.dev === current.dev && stored.ino === current.ino && stored.birthtimeMs === current.birthtimeMs
}

/**
 * 判断 child 是否是 parent 的直接子项（不跨层级）。
 * 用于确保受管链接只会出现在 Agent 目录的第一层。
 *
 * @param {string} parent - 父目录
 * @param {string} child - 待判断路径
 * @returns {boolean} 是否为直接子项
 */
function isDirectChild (parent, child) {
  return comparablePath(path.dirname(child)) === comparablePath(parent)
}

/**
 * 安全移除一条受管链接。
 *
 * 移除条件（必须全部满足）：路径位于允许目录内、仍是符号链接、目标未变、文件标识一致。
 * 任一条件不满足都只提示不删除，并把 relinquished 置为 true（表示放弃管理该记录）。
 *
 * @param {{linkPath: string, sourcePath: string, identity?: object}} link - 受管链接记录
 * @param {string} label - 用于提示文案的名称
 * @param {string} [allowedDirectory] - 允许删除的目录（通常是 Agent 目录）
 * @returns {{removed: boolean, relinquished: boolean, issues: Array}} removed 是否已删除；
 *          relinquished 是否已放弃管理（为 false 时调用方应保留该记录以便下次重试）
 */
function removeOwnedLink (link, label, allowedDirectory) {
  // 记录不完整视作放弃管理，不做任何文件操作。
  if (!link?.linkPath || !link?.sourcePath) return { removed: false, relinquished: true, issues: [] }
  // 路径不在允许目录内：仅提示，绝不删除。
  if (allowedDirectory && !isDirectChild(allowedDirectory, link.linkPath)) {
    return { removed: false, relinquished: true, issues: [createIssue('warning', `${label}超出 Agent 目录，记录已忽略且不会删除该路径。`)] }
  }
  const inspected = inspectLink(link.linkPath, link.sourcePath)
  // 已经不存在：视为管理结束，无需提示。
  if (inspected.kind === 'missing') return { removed: false, relinquished: true, issues: [] }
  // 检查失败（权限等）：保留记录，下次再试。
  if (inspected.kind === 'error') {
    return { removed: false, relinquished: false, issues: [createIssue('error', `无法检查${label}：${errorMessage(inspected.error)}`)] }
  }
  // 不是链接、目标被改写或文件标识不符 → 已非本应用创建，停止管理并保留现场。
  if (inspected.kind !== 'link' || !inspected.sameTarget || !identitiesEqual(link.identity, inspected.identity)) {
    return {
      removed: false,
      relinquished: true,
      issues: [createIssue('warning', `${label}已被外部替换，已停止管理并保留当前内容。`)]
    }
  }
  try {
    // 仅删除链接本身，不会影响链接指向的源目录内容。
    fs.unlinkSync(link.linkPath)
    return { removed: true, relinquished: true, issues: [] }
  } catch (error) {
    // 删除失败（如被占用）：保留记录，返回可重试状态。
    return { removed: false, relinquished: false, issues: [createIssue('error', `无法移除${label}：${errorMessage(error)}`)] }
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
function describeConflict (skill, linkPath, inspected) {
  if (inspected.kind === 'directory') return `“${skill.name}”无法链接：目标位置已有普通目录 ${linkPath}，已保留原目录。`
  if (inspected.kind === 'file') return `“${skill.name}”无法链接：目标位置已有文件 ${linkPath}，已保留原文件。`
  if (inspected.kind === 'error') return `“${skill.name}”无法检查目标位置 ${linkPath}：${errorMessage(inspected.error)}`
  if (inspected.kind === 'link' && inspected.dangling) return `“${skill.name}”无法链接：目标位置已有失效的手动链接 ${linkPath}，请手动处理后重试。`
  return `“${skill.name}”无法链接：目标位置已有指向其他位置的手动链接 ${linkPath}，已保留原链接。`
}

/**
 * 判断目录是否为有效 Skill 目录（存在 SKILL.md 且能解析出 name）。
 * 用于审计 Agent 目录中「非本应用创建」的链接是否值得保留提示。
 *
 * @param {string} directory - 待检查目录
 * @returns {boolean} 是否为有效 Skill 目录
 */
function hasValidSkillFile (directory) {
  try {
    const files = fs.readdirSync(directory, { withFileTypes: true })
    const entry = files.find(item => item.isFile() && item.name.toLowerCase() === 'skill.md')
    return Boolean(entry && readSkillNameDetailed(path.join(directory, entry.name)).name)
  } catch (_) {
    // 目录不存在或不可读，按无效处理（只影响提示，不影响文件）。
    return false
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
function auditUnmanagedLinks (agent, knownPaths) {
  const issues = []
  let entries
  try { entries = fs.readdirSync(agent.directory, { withFileTypes: true }) } catch (error) {
    return [createIssue('error', `无法检查 Agent“${agent.name}”目录：${errorMessage(error)}`)]
  }
  entries.filter(entry => entry.isSymbolicLink()).forEach(entry => {
    const linkPath = path.join(agent.directory, entry.name)
    // 本应用管理的链接已单独处理，这里只关心外部链接。
    if (knownPaths.has(comparablePath(linkPath))) return
    const inspected = inspectLink(linkPath)
    // 失效链接或目标不是有效 Skill 的链接，提示用户但不做处理。
    if (inspected.kind !== 'link' || inspected.dangling || !hasValidSkillFile(inspected.targetPath)) {
      issues.push(createIssue('warning', `Agent“${agent.name}”中发现非 Skill 或失效的手动链接 ${linkPath}，已忽略并保留。`))
    }
  })
  return issues
}

// ============================================================================
// 五、单个 Agent 的链接同步
// ============================================================================

/**
 * 同步一个 Agent 目录下的 Skills 链接，使其与「已启用分组包含的 Skills」一致。
 *
 * 执行顺序：
 *  1. 计算期望的 Skill 集合（启用分组内所有 skillId）；
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
function syncAgent (config, agent, scan) {
  const issues = []
  // 该 Agent 已启用的分组 id 集合。
  const enabled = new Set(config.enabledGroups[agent.id] || [])
  // 期望在 Agent 目录中出现的 Skill id 集合。
  const desiredSkillIds = new Set()
  config.groups.forEach(group => {
    if (enabled.has(group.id)) (group.skillIds || []).forEach(skillId => desiredSkillIds.add(skillId))
  })
  // 用 id 索引扫描结果，便于判断某个 skillId 是否仍然存在。
  const skillById = new Map(scan.skills.map(skill => [skill.id, skill]))
  // 历史受管链接（已规范化）。
  const previousLinks = normalizeManagedLinks(agent.managedLinks)
  // 下一轮要写入数据库的受管链接。
  const nextLinks = {}
  // 已确认存在、可用的链接对应 Skill id。
  const linked = []
  // 由外部预先存在、被直接沿用的同源链接对应 Skill id（本应用不删除它们）。
  const external = []
  // 本次新建的链接记录，数据库保存失败时用于回滚。
  const createdLinks = []

  let targetUsable = true
  try {
    const stat = fs.statSync(agent.directory)
    if (!stat.isDirectory()) throw new Error('该路径不是文件夹')
  } catch (error) {
    // 目录不可用（被删除、无权限、不是目录）：不改动任何文件，直接返回。
    targetUsable = false
    issues.push(createIssue('error', `Agent“${agent.name}”的 Skills 目录不可用：${errorMessage(error)}。未创建或删除任何链接。`))
  }
  if (!targetUsable) {
    // 保持原记录不变，等待目录恢复后继续管理。
    agent.managedLinks = previousLinks
    return { linked, external, createdLinks, issues }
  }
  // 数据库关键结构异常时只做观察，不根据兜底后的空值改动任何文件。
  if (scan.locked) {
    Object.entries(previousLinks).forEach(([skillId, link]) => {
      // 仅统计确实仍指向原目标、且文件标识一致的链接。
      if (!isDirectChild(agent.directory, link.linkPath)) return
      const inspected = inspectLink(link.linkPath, link.sourcePath)
      if (inspected.kind === 'link' && inspected.sameTarget && identitiesEqual(link.identity, inspected.identity)) linked.push(skillId)
    })
    agent.managedLinks = previousLinks
    // 已知路径用于排除自身管理的链接，避免误报。
    const knownPaths = new Set(Object.values(previousLinks).map(link => comparablePath(link.linkPath)))
    issues.push(...auditUnmanagedLinks(agent, knownPaths))
    return { linked, external, createdLinks, issues: uniqueIssues(issues) }
  }

  // 处理历史受管链接：保留仍然需要的，安全移除不再需要的。
  Object.entries(previousLinks).forEach(([skillId, link]) => {
    const skill = skillById.get(skillId)
    // 记录位置异常（不在 Agent 目录第一层）：仅提示，绝不删除。
    if (!isDirectChild(agent.directory, link.linkPath)) {
      issues.push(createIssue('warning', `Agent“${agent.name}”存在超出其 Skills 目录的异常受管记录，已停止管理且不会删除该路径：${link.linkPath}`))
      return
    }
    // 扫描不完整时，无法确认 Skill 是否真的被删除，因此保留仍被启用的受管链接。
    const shouldKeep = desiredSkillIds.has(skillId) && (skill || !scan.complete)
    // 源目录以当前扫描结果为准，扫描不到时回退到历史记录。
    const currentSource = skill?.sourcePath || link.sourcePath
    const inspected = inspectLink(link.linkPath, link.sourcePath)
    // 仍是同一链接（类型、目标、文件标识都匹配）才算「仍归本应用所有」。
    const stillOwned = inspected.kind === 'link' && inspected.sameTarget && identitiesEqual(link.identity, inspected.identity)
    // 需要保留且源目录未变化：直接沿用，无需改动。
    if (shouldKeep && stillOwned && pathsEqual(link.sourcePath, currentSource)) {
      nextLinks[skillId] = link
      linked.push(skillId)
      return
    }
    // 扫描不完整且链接仍归本应用所有：宁可保留，等下次完整扫描再处理。
    if (shouldKeep && !scan.complete && stillOwned) {
      nextLinks[skillId] = link
      linked.push(skillId)
      return
    }
    // 其余情况执行安全移除（内部会再次校验，只有确认归本应用所有才会真正删除）。
    const removal = removeOwnedLink(link, `Agent“${agent.name}”中的受管链接 ${link.linkPath}`, agent.directory)
    issues.push(...removal.issues)
    // 未放弃管理的记录需要保留，便于下次重试。
    if (!removal.relinquished) nextLinks[skillId] = link
    // 扫描完整且 Skill 确实已不存在，且链接已被删除 → 提示信息级通知。
    if (scan.complete && !skill && removal.removed) {
      issues.push(createIssue('info', `Skill“${skillId}”已不在主仓库中，对应的受管链接已移除。`))
    }
  })

  const desiredSkills = [...desiredSkillIds].map(skillId => skillById.get(skillId)).filter(Boolean)
  // 统计同名目录数量：链接名使用目录名，同名会互相覆盖，需要提前拦截。
  const folderCounts = desiredSkills.reduce((counts, skill) => counts.set(skill.folderName, (counts.get(skill.folderName) || 0) + 1), new Map())
  desiredSkills.forEach(skill => {
    // 已在上一步保留的链接无需重复创建。
    if (nextLinks[skill.id]) return
    // 多个启用 Skill 目录名相同：跳过创建，避免覆盖，并提示用户改名。
    if (folderCounts.get(skill.folderName) > 1) {
      issues.push(createIssue('error', `多个已启用 Skills 使用同一目录名“${skill.folderName}”，为避免覆盖，Agent“${agent.name}”未创建这些链接。`))
      return
    }
    const linkPath = path.join(agent.directory, skill.folderName)
    const inspected = inspectLink(linkPath, skill.sourcePath)
    // 目标位置已被占用：区分「同源手动链接」「普通文件/目录」「其他链接」分别提示。
    if (inspected.kind !== 'missing') {
      if (inspected.kind === 'link' && inspected.sameTarget) {
        // 用户自己创建的、指向同一源目录的链接：直接沿用，但不纳入受管（不会被本应用删除）。
        external.push(skill.id)
        issues.push(createIssue('info', `Agent“${agent.name}”已存在“${skill.name}”的手动同源链接，已直接使用但不会由本应用删除。`))
      } else {
        issues.push(createIssue(inspected.kind === 'error' ? 'error' : 'warning', describeConflict(skill, linkPath, inspected)))
      }
      return
    }
    try {
      // Windows 使用 junction（目录联接，无需管理员权限），其他平台使用目录符号链接。
      fs.symlinkSync(skill.sourcePath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      let identity
      try {
        // 记录文件标识，用于后续判断链接是否被外部替换。
        const created = fs.lstatSync(linkPath)
        identity = { dev: Number(created.dev), ino: Number(created.ino), birthtimeMs: Number(created.birthtimeMs) }
      } catch (error) {
        // 记录不到标识也不影响使用：后续按「目标一致」继续管理。
        issues.push(createIssue('warning', `“${skill.name}”链接已创建，但无法记录文件标识：${errorMessage(error)}。后续仍会按链接目标安全管理。`))
      }
      nextLinks[skill.id] = { linkPath, sourcePath: skill.sourcePath, ...(identity ? { identity } : {}) }
      createdLinks.push(nextLinks[skill.id])
      linked.push(skill.id)
    } catch (error) {
      // 创建失败（权限、占用等）：提示并继续处理其他 Skill。
      issues.push(createIssue('error', `创建“${skill.name}”链接失败：${errorMessage(error)}`))
    }
  })

  // 已知路径 = 本轮受管链接 + 期望的链接位置，用于审计外部链接时排除自身。
  const knownPaths = new Set([
    ...Object.values(nextLinks).map(link => comparablePath(link.linkPath)),
    ...desiredSkills.map(skill => comparablePath(path.join(agent.directory, skill.folderName)))
  ])
  issues.push(...auditUnmanagedLinks(agent, knownPaths))
  // 就地更新受管链接记录，由调用方统一写回数据库。
  agent.managedLinks = nextLinks
  return { linked, external, createdLinks, issues: uniqueIssues(issues) }
}

/**
 * 依次同步所有 Agent。
 *
 * @param {object} config - 当前配置
 * @param {object} scan - 仓库扫描结果
 * @returns {object} { [agentId]: syncAgent 的返回值 }
 */
function syncAllAgents (config, scan) {
  const results = {}
  config.agents.forEach(agent => { results[agent.id] = syncAgent(config, agent, scan) })
  return results
}

/**
 * 清理分组中「已从仓库删除」的 Skill 引用。
 * 仅在扫描完整且未处于只读保护时执行，保证不会因扫描失败误删引用。
 *
 * @param {object} config - 当前配置（会就地清理 group.skillIds）
 * @param {object} scan - 仓库扫描结果
 * @returns {Array} 清理过程中产生的问题列表
 */
function reconcileDeletedSkills (config, scan) {
  if (!scan.complete || scan.locked) return []
  const validSkillIds = new Set(scan.skills.map(skill => skill.id))
  const issues = []
  config.groups.forEach(group => {
    const missing = group.skillIds.filter(skillId => !validSkillIds.has(skillId))
    if (!missing.length) return
    // 保留仍然存在的引用，丢弃失效引用。
    group.skillIds = group.skillIds.filter(skillId => validSkillIds.has(skillId))
    issues.push(createIssue('warning', `分组“${group.name}”中有 ${missing.length} 个 Skill 已从主仓库删除，失效引用已自动清理。`))
  })
  return issues
}

/**
 * 汇总一次刷新过程中的全部问题：扫描问题 + 附加问题 + 各 Agent 同步问题。
 *
 * @param {object} scan - 仓库扫描结果
 * @param {object} syncResults - syncAllAgents 的返回值
 * @param {Array} [extra=[]] - 额外问题（如配置读取问题、分组清理问题）
 * @returns {Array} 去重后的问题列表
 */
function collectIssues (scan, syncResults, extra = []) {
  return uniqueIssues([
    ...(scan?.issues || []),
    ...extra,
    ...Object.values(syncResults || {}).flatMap(result => result.issues || [])
  ])
}

/**
 * 把内部 Agent 结构转换为前端需要的公开结构（附带链接数量统计）。
 *
 * @param {object} agent - 内部 Agent 对象
 * @param {object} [syncResult] - 该 Agent 本轮同步结果；缺失时回退为数据库记录的链接数
 * @returns {{id: string, name: string, directory: string, linkedCount: number, managedLinkedCount: number, externalLinkedCount: number}}
 */
function publicAgent (agent, syncResult) {
  // 受管链接数量：本轮同步结果优先，没有同步结果时以数据库记录为准。
  const managedLinkedCount = syncResult ? syncResult.linked.length : Object.keys(agent.managedLinks || {}).length
  // 外部同源链接数量（不由本应用创建，仅统计展示）。
  const externalLinkedCount = syncResult?.external.length || 0
  return { id: agent.id, name: agent.name, directory: agent.directory, linkedCount: managedLinkedCount + externalLinkedCount, managedLinkedCount, externalLinkedCount }
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
function buildState (config, scan = { skills: [] }, syncResults = {}, issues = []) {
  return {
    repositoryPath: config.repositoryPath,
    skills: scan.skills || [],
    groups: config.groups,
    // Agent 列表转为公开结构，避免把 managedLinks 等内部字段暴露给前端。
    agents: config.agents.map(agent => publicAgent(agent, syncResults[agent.id])),
    enabledGroups: config.enabledGroups,
    theme: config.theme === 'dark' ? 'dark' : 'light',
    issues: uniqueIssues(issues)
  }
}

/**
 * 刷新状态的核心流程：扫描仓库 → 清理失效引用 → 同步所有 Agent → 保存配置 → 组装状态。
 *
 * 关键点：所有文件操作完成后统一写数据库；写入失败时回滚本轮新建的链接，
 * 保证不会留下「磁盘上有链接、数据库里没记录」的孤立链接。
 *
 * @param {object} config - 已读取（可能已修改）的配置对象
 * @returns {object} 前端可用的完整状态
 * @throws {Error} 配置只读保护以外的数据库写入失败，或写入失败且回滚不完整
 */
function refreshState (config) {
  const scan = scanConfiguredRepository(config)
  const reconciledIssues = reconcileDeletedSkills(config, scan)
  const syncResults = syncAllAgents(config, scan)
  // 只读保护时绝不写库（配置可能已被异常数据污染）。
  if (!config._syncLocked) {
    try {
      writeConfig(config)
    } catch (error) {
      // 数据库保存失败时回滚本轮新建链接，避免产生没有持久记录的孤立链接。
      const rollbackIssues = []
      config.agents.forEach(agent => {
        const createdLinks = syncResults[agent.id]?.createdLinks || []
        createdLinks.forEach(link => {
          rollbackIssues.push(...removeOwnedLink(link, `保存失败后的新建链接 ${link.linkPath}`, agent.directory).issues)
        })
      })
      // 回滚失败时把失败原因追加到异常信息中，便于用户手工处理。
      const detail = rollbackIssues.length ? `；部分链接回滚失败：${rollbackIssues.map(issue => issue.message).join('；')}` : '；本轮新建链接已回滚'
      throw new Error(`${error.message}${detail}`)
    }
  }
  return buildState(config, scan, syncResults, collectIssues(scan, syncResults, [...(config._issues || []), ...reconciledIssues]))
}

/**
 * 清理某个 Agent 的全部受管链接（删除 Agent、更换目录、清除数据时使用）。
 *
 * @param {object} agent - 目标 Agent（会就地更新其 managedLinks）
 * @returns {Array} 问题列表（含无法删除的错误）
 */
function cleanupAgentLinks (agent) {
  const issues = []
  // 未能放弃管理的记录需要保留，便于下次重试。
  const remaining = {}
  Object.entries(normalizeManagedLinks(agent.managedLinks)).forEach(([skillId, link]) => {
    const removal = removeOwnedLink(link, `Agent“${agent.name}”中的受管链接 ${link.linkPath}`, agent.directory)
    issues.push(...removal.issues)
    if (!removal.relinquished) remaining[skillId] = link
  })
  agent.managedLinks = remaining
  return uniqueIssues(issues)
}

/**
 * 若清理过程中存在 error 级问题，则抛出异常阻止后续步骤（例如删除配置记录）。
 * 这样可避免「链接没删干净，但数据库记录已经没了」导致链接再也无法追踪。
 *
 * @param {Array} issues - 问题列表
 * @param {string} action - 操作名称，用于错误提示
 * @throws {Error} 存在 error 级问题时抛出
 */
function throwIfCleanupFailed (issues, action) {
  const failures = issues.filter(issue => issue.type === 'error')
  if (failures.length) throw new Error(`${action}未完成：${failures.map(issue => issue.message).join('；')}`)
}

/**
 * 写操作前的守卫：配置处于只读保护时，禁止任何会改动数据库或磁盘的操作。
 *
 * @param {object} config - 当前配置
 * @throws {Error} 配置处于只读保护时抛出
 */
function assertConfigWritable (config) {
  if (config._syncLocked) throw new Error('本地数据库关键配置异常，当前处于只读保护。请先在设置页清除数据，再重新配置。')
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
  chooseDirectory (defaultPath) {
    try {
      // properties 同时允许选择已有目录与新建目录。
      const result = window.utools.showOpenDialog({ title: '选择目录', defaultPath: defaultPath || undefined, properties: ['openDirectory', 'createDirectory'] })
      return result && result.length ? result[0] : ''
    } catch (error) {
      throw new Error(`打开目录选择器失败：${errorMessage(error)}`)
    }
  },

  /**
   * 读取当前状态并执行一次完整刷新（扫描仓库 + 同步链接）。
   * 前端初始化（appStore.initialize）与页面首次加载都会调用。
   *
   * @returns {object} 前端可用的完整状态
   */
  getState () {
    return refreshState(readConfig())
  },

  /**
   * 保存主题。
   * 主题不依赖文件系统，因此即使仓库离线也能正常切换，只写入数据库。
   *
   * @param {'light'|'dark'} theme - 目标主题
   * @returns {{theme: string, issues: Array}} 变更后的主题与读取阶段发现的问题
   */
  // 主题保存不依赖文件系统，主仓库暂时离线时仍可正常切换。
  setTheme (theme) {
    const config = readConfig()
    config.theme = theme === 'dark' ? 'dark' : 'light'
    try { database().setItem(STORAGE_KEYS.theme, config.theme) } catch (error) {
      throw new Error(`保存主题失败：${errorMessage(error)}`)
    }
    return { theme: config.theme, issues: config._issues || [] }
  },

  /**
   * 设置统一 Skills 仓库目录并立即刷新。
   *
   * @param {string} repositoryPath - 仓库目录路径
   * @returns {object} 刷新后的完整状态
   * @throws {Error} 目录非法、与某个 Agent 目录互相包含、或处于只读保护
   */
  setRepository (repositoryPath) {
    const config = readConfig()
    assertConfigWritable(config)
    const normalizedPath = normalizeDirectory(repositoryPath, 'Skills 仓库目录')
    // 仓库与 Agent 目录互相包含会导致扫描结果污染（把自己的链接当成 Skill）。
    const nestedAgent = config.agents.find(agent => isInsideDirectory(normalizedPath, agent.directory) || isInsideDirectory(agent.directory, normalizedPath))
    if (nestedAgent) throw new Error(`Skills 仓库不能与 Agent“${nestedAgent.name}”的目录相同或互相包含，请调整其中一个路径`)
    config.repositoryPath = normalizedPath
    return refreshState(config)
  },

  /**
   * 按已保存的仓库路径重新扫描并同步（不改动仓库路径）。
   *
   * @returns {object} 刷新后的完整状态
   * @throws {Error} 尚未配置仓库路径或处于只读保护
   */
  refreshSkills () {
    const config = readConfig()
    assertConfigWritable(config)
    if (!config.repositoryPath) throw new Error('请先配置 Skills 仓库目录')
    return refreshState(config)
  },

  /**
   * 保存分组列表（新增、改名、增删 Skills 都复用该接口）。
   * 保存后会顺带清理「已删除分组」在 Agent 上的启用记录，并同步链接。
   *
   * @param {Array<{id: string, name: string, skillIds: Array}>} groups - 前端提交的完整分组列表
   * @returns {object} 刷新后的完整状态
   * @throws {Error} 分组 id 重复或处于只读保护
   */
  saveGroups (groups) {
    const config = readConfig()
    assertConfigWritable(config)
    // 只保留 id、name 非空的分组，并对 skillIds 去重。
    config.groups = (Array.isArray(groups) ? groups : []).map(group => ({
      id: String(group.id || '').trim(),
      name: String(group.name || '').trim(),
      skillIds: [...new Set(Array.isArray(group.skillIds) ? group.skillIds.map(String) : [])]
    })).filter(group => group.id && group.name)
    // 分组 id 必须唯一，否则链接同步无法区分分组。
    if (new Set(config.groups.map(group => group.id)).size !== config.groups.length) throw new Error('分组标识重复，请重新创建分组')
    // 清理已不存在分组的启用记录（保持启用关系始终有效）。
    const validIds = new Set(config.groups.map(group => group.id))
    Object.keys(config.enabledGroups).forEach(agentId => {
      config.enabledGroups[agentId] = (config.enabledGroups[agentId] || []).filter(groupId => validIds.has(groupId))
    })
    return refreshState(config)
  },

  /**
   * 新增或更新一个 Agent。
   * 携带 id 表示更新；修改目录时会先清理旧目录中由本应用创建的链接。
   *
   * @param {{id?: string, name: string, directory: string}} input - 表单数据
   * @returns {object} 刷新后的完整状态（issues 中附加了目录变更时的清理问题）
   * @throws {Error} 名称为空、目录非法、目录冲突或处于只读保护
   */
  upsertAgent (input) {
    const config = readConfig()
    assertConfigWritable(config)
    const name = String(input?.name || '').trim()
    if (!name) throw new Error('请输入 Agent 名称')
    const directory = normalizeDirectory(String(input?.directory || ''), 'Agent Skills 目录')
    // 新增时生成唯一 id：时间戳 + 随机串，避免同一毫秒内重复。
    const id = input?.id ? String(input.id) : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    assertSafeAgentDirectory(config, directory, id)
    const existing = config.agents.find(agent => agent.id === id)
    const cleanupIssues = []
    if (existing) {
      // 目录变更：先清理旧目录中的受管链接，失败则中止（避免残留链接失去记录）。
      if (!pathsEqual(existing.directory, directory)) {
        cleanupIssues.push(...cleanupAgentLinks(existing))
        throwIfCleanupFailed(cleanupIssues, '更换 Agent 目录')
        existing.managedLinks = {}
      }
      existing.name = name
      existing.directory = directory
    } else {
      // 新增 Agent：同时初始化其启用分组为空数组。
      config.agents.push({ id, name, directory, managedLinks: {} })
      config.enabledGroups[id] = []
    }
    const state = refreshState(config)
    // 把目录变更时的清理问题合并到返回结果中。
    state.issues = uniqueIssues([...cleanupIssues, ...state.issues])
    return state
  },

  /**
   * 删除 Agent：先安全清理其目录下的受管链接，全部成功后才删除数据库记录。
   *
   * @param {string} agentId - 目标 Agent id
   * @returns {object} 刷新后的完整状态（issues 中附加了清理问题）
   * @throws {Error} Agent 不存在、清理未完成或处于只读保护
   */
  deleteAgent (agentId) {
    const config = readConfig()
    assertConfigWritable(config)
    const agent = config.agents.find(item => item.id === agentId)
    if (!agent) throw new Error('未找到要删除的 Agent，配置可能已被其他窗口更新')
    const issues = cleanupAgentLinks(agent)
    // 有链接未能安全删除时中止删除，保证记录与磁盘状态一致。
    throwIfCleanupFailed(issues, '删除 Agent')
    config.agents = config.agents.filter(item => item.id !== agentId)
    // 同步删除该 Agent 的启用分组记录。
    delete config.enabledGroups[agentId]
    const state = refreshState(config)
    state.issues = uniqueIssues([...issues, ...state.issues])
    return state
  },

  /**
   * 清除全部本地数据：先清理所有受管链接，再删除数据库中的配置键。
   * 仓库中的源文件与用户手动创建的内容都不会被删除。
   *
   * @returns {object} 默认配置对应的空状态（附带清理过程中的问题）
   * @throws {Error} 链接清理未完成或数据库删除失败
   */
  // 只有受管链接全部完成安全清理后才删除数据库记录，避免遗留无法追踪的链接。
  clearData () {
    const config = readConfig()
    // 逐个 Agent 清理受管链接。
    const issues = config.agents.flatMap(cleanupAgentLinks)
    throwIfCleanupFailed(issues, '清除数据')
    // 处于只读保护时，只能清理仍然可识别的链接，提示用户其余内容已保留。
    if (config._syncLocked) {
      issues.push(createIssue('warning', '数据库配置异常，仅清理了仍可识别的受管链接；无法识别的现有文件和链接均已保留。'))
    }
    clearStoredConfig()
    return buildState(createDefaultConfig(), { skills: [] }, {}, issues)
  },

  /**
   * 设置某个 Agent 启用的分组，并按差集同步其目录下的链接。
   *
   * @param {string} agentId - 目标 Agent id
   * @param {Array<string>} groupIds - 启用的分组 id 列表
   * @returns {object} 刷新后的完整状态
   * @throws {Error} Agent 不存在或处于只读保护
   */
  setAgentGroups (agentId, groupIds) {
    const config = readConfig()
    assertConfigWritable(config)
    const agent = config.agents.find(item => item.id === agentId)
    if (!agent) throw new Error('未找到该 Agent，配置可能已被其他窗口更新')
    // 过滤掉不存在的分组 id，并对启用列表去重。
    const validIds = new Set(config.groups.map(group => group.id))
    config.enabledGroups[agentId] = [...new Set(Array.isArray(groupIds) ? groupIds.map(String) : [])].filter(groupId => validIds.has(groupId))
    return refreshState(config)
  }
}
