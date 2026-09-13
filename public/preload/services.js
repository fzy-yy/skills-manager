const fs = require('node:fs')
const path = require('node:path')

const CONFIG_VERSION = 1
const STORAGE_KEYS = Object.freeze({
  version: 'skills-manager/version',
  repositoryPath: 'skills-manager/repository-path',
  groups: 'skills-manager/groups',
  agents: 'skills-manager/agents',
  enabledGroups: 'skills-manager/enabled-groups',
  theme: 'skills-manager/theme'
})

// 配置只存入 uTools dbStorage；文件系统仅用于扫描 Skill 和维护链接。
function createDefaultConfig () {
  return { version: CONFIG_VERSION, repositoryPath: '', groups: [], agents: [], enabledGroups: {}, theme: 'light' }
}

function errorMessage (error) {
  if (!error) return '未知错误'
  const code = error.code ? `${error.code}：` : ''
  return `${code}${error.message || String(error)}`
}

function createIssue (type, message) {
  return { type: type === 'error' ? 'error' : type === 'info' ? 'info' : 'warning', message }
}

function uniqueIssues (issues) {
  const seen = new Set()
  return issues.filter(issue => {
    const key = `${issue.type}:${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function normalizeManagedLinks (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return Object.fromEntries(Object.entries(input).flatMap(([skillId, link]) => {
    if (!skillId || !link || typeof link !== 'object') return []
    if (typeof link.linkPath !== 'string' || typeof link.sourcePath !== 'string') return []
    const identity = link.identity && typeof link.identity === 'object'
      ? { dev: Number(link.identity.dev), ino: Number(link.identity.ino), birthtimeMs: Number(link.identity.birthtimeMs) }
      : null
    return [[String(skillId), { linkPath: link.linkPath, sourcePath: link.sourcePath, ...(identity ? { identity } : {}) }]]
  }))
}

function normalizeConfig (input) {
  const config = input && typeof input === 'object' ? input : {}
  const groups = []
  const groupIds = new Set()
  for (const item of Array.isArray(config.groups) ? config.groups : []) {
    const id = String(item?.id || '').trim()
    const name = String(item?.name || '').trim()
    if (!id || !name || groupIds.has(id)) continue
    groupIds.add(id)
    groups.push({ id, name, skillIds: [...new Set((Array.isArray(item.skillIds) ? item.skillIds : []).map(String))] })
  }

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

function database () {
  const storage = window.utools?.dbStorage
  if (!storage) throw new Error('uTools 本地数据库不可用，请在 uTools 插件环境中重新打开应用')
  return storage
}

function writeConfig (config) {
  const normalized = normalizeConfig(config)
  try {
    const storage = database()
    Object.entries(STORAGE_KEYS).forEach(([field, key]) => storage.setItem(key, normalized[field]))
  } catch (error) {
    throw new Error(`保存本地数据库失败：${errorMessage(error)}`)
  }
}

function readConfig () {
  try {
    const storage = database()
    const stored = {}
    Object.entries(STORAGE_KEYS).forEach(([field, key]) => { stored[field] = storage.getItem(key) })
    const hasDatabaseData = Object.values(stored).some(value => value !== null && value !== undefined)
    if (!hasDatabaseData) return createDefaultConfig()
    const issues = []
    const missingFields = Object.keys(STORAGE_KEYS).filter(field => stored[field] === null || stored[field] === undefined)
    const hasDependentData = (Array.isArray(stored.groups) && stored.groups.length > 0) ||
      (Array.isArray(stored.agents) && stored.agents.length > 0) ||
      (stored.enabledGroups && typeof stored.enabledGroups === 'object' && Object.keys(stored.enabledGroups).length > 0)
    const criticalMissing = missingFields.some(field => ['repositoryPath', 'groups', 'agents', 'enabledGroups'].includes(field))
    let syncLocked = criticalMissing && hasDependentData
    if (missingFields.length) issues.push(createIssue('warning', `本地数据库配置不完整，缺失项已使用默认值：${missingFields.join('、')}`))
    if (stored.groups != null && !Array.isArray(stored.groups)) {
      syncLocked = true
      issues.push(createIssue('error', '本地数据库中的分组数据格式异常，已进入只读保护。可在设置页清除数据后重新配置。'))
    }
    if (stored.agents != null && !Array.isArray(stored.agents)) {
      syncLocked = true
      issues.push(createIssue('error', '本地数据库中的 Agent 数据格式异常，已进入只读保护。可在设置页清除数据后重新配置。'))
    }
    if (stored.enabledGroups != null && (typeof stored.enabledGroups !== 'object' || Array.isArray(stored.enabledGroups))) {
      syncLocked = true
      issues.push(createIssue('error', '本地数据库中的应用配置格式异常，已进入只读保护。可在设置页清除数据后重新配置。'))
    }
    const config = normalizeConfig(stored)
    if (Array.isArray(stored.groups) && config.groups.length !== stored.groups.length) {
      issues.push(createIssue('warning', '部分分组记录无效或标识重复，已忽略异常记录。'))
    }
    if (Array.isArray(stored.agents) && config.agents.length !== stored.agents.length) {
      issues.push(createIssue('warning', '部分 Agent 记录无效或标识重复，已忽略异常记录。'))
    }
    if (stored.repositoryPath != null && typeof stored.repositoryPath !== 'string') {
      syncLocked = true
      issues.push(createIssue('error', '本地数据库中的仓库路径格式异常，已进入只读保护。可在设置页清除数据后重新配置。'))
    }
    if (stored.theme != null && stored.theme !== 'light' && stored.theme !== 'dark') {
      issues.push(createIssue('warning', '本地数据库中的主题值无效，已恢复为浅色主题。'))
    }
    Object.defineProperty(config, '_issues', { value: issues, enumerable: false })
    Object.defineProperty(config, '_syncLocked', { value: syncLocked, enumerable: false })
    return config
  } catch (error) {
    throw new Error(`读取本地数据库失败：${errorMessage(error)}`)
  }
}

function clearStoredConfig () {
  const failures = []
  const storage = database()
  Object.values(STORAGE_KEYS).forEach(key => {
    try { storage.removeItem(key) } catch (error) { failures.push(`${key}（${errorMessage(error)}）`) }
  })
  if (failures.length) throw new Error(`清除本地数据库失败：${failures.join('；')}`)
}

function normalizeDirectory (directory, label = '目录') {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error(`请选择有效的${label}`)
  const resolved = path.resolve(directory.trim())
  let stat
  try { stat = fs.statSync(resolved) } catch (error) { throw new Error(`${label}不存在或无法访问：${errorMessage(error)}`) }
  if (!stat.isDirectory()) throw new Error(`${label}不是文件夹：${resolved}`)
  return resolved
}

// 所有路径比较都兼容 Windows 大小写、目录链接和 \\?\ 命名空间前缀。
function comparablePath (target) {
  let normalized = path.normalize(path.resolve(String(target).replace(/^\\\\\?\\/, '')))
  if (process.platform === 'win32') normalized = normalized.toLowerCase()
  return normalized.replace(/[\\/]+$/, '')
}

function pathsEqual (left, right) {
  try {
    if (comparablePath(left) === comparablePath(right)) return true
    if (fs.existsSync(left) && fs.existsSync(right)) return comparablePath(fs.realpathSync(left)) === comparablePath(fs.realpathSync(right))
  } catch (_) {}
  return false
}

function isInsideDirectory (parent, child) {
  const canonical = target => {
    try { return fs.realpathSync(target) } catch (_) { return path.resolve(target) }
  }
  const relative = path.relative(canonical(parent), canonical(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function assertSafeAgentDirectory (config, directory, currentAgentId = '') {
  let canonicalDirectory = directory
  try { canonicalDirectory = fs.realpathSync(directory) } catch (_) {}
  if (path.parse(canonicalDirectory).root === canonicalDirectory) throw new Error('Agent Skills 目录不能是磁盘根目录')
  if (config.repositoryPath && (isInsideDirectory(config.repositoryPath, directory) || isInsideDirectory(directory, config.repositoryPath))) {
    throw new Error('Agent Skills 目录不能与统一 Skills 仓库相同或互相包含，以免扫描和链接相互影响')
  }
  const duplicate = config.agents.find(agent => agent.id !== currentAgentId && pathsEqual(agent.directory, directory))
  if (duplicate) throw new Error(`该 Skills 目录已由 Agent“${duplicate.name}”使用，请选择其他目录`)
}

function readSkillNameDetailed (skillFile) {
  let content
  try { content = fs.readFileSync(skillFile, 'utf8') } catch (error) {
    return { name: '', error: `无法读取 ${skillFile}：${errorMessage(error)}` }
  }
  const frontmatter = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
  if (!frontmatter) return { name: '', error: `${skillFile} 缺少有效的 YAML 元数据` }
  const nameLine = frontmatter[1].split(/\r?\n/).find(line => /^\s*name\s*:/.test(line))
  if (!nameLine) return { name: '', error: `${skillFile} 的元数据缺少 name 字段` }
  const rawValue = nameLine.replace(/^\s*name\s*:\s*/, '').trim()
  let name = ''
  try {
    if (rawValue.startsWith('"')) {
      const quoted = rawValue.match(/^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/)
      if (!quoted) throw new Error('双引号未正确闭合')
      name = JSON.parse(quoted[1])
    } else if (rawValue.startsWith("'")) {
      const quoted = rawValue.match(/^'((?:''|[^'])*)'\s*(?:#.*)?$/)
      if (!quoted) throw new Error('单引号未正确闭合')
      name = quoted[1].replace(/''/g, "'")
    } else {
      name = rawValue.replace(/\s+#.*$/, '').trim()
    }
  } catch (error) {
    return { name: '', error: `${skillFile} 的 name 字段无效：${errorMessage(error)}` }
  }
  name = String(name).trim()
  return name ? { name, error: '' } : { name: '', error: `${skillFile} 的 name 字段为空` }
}

// 扫描会记录每个可见错误；只要任一子目录不可读，complete 就为 false。
function scanSkills (repositoryPath) {
  if (!repositoryPath) return { skills: [], issues: [], complete: true }
  const root = normalizeDirectory(repositoryPath, 'Skills 仓库目录')
  const skills = []
  const issues = []
  let complete = true

  function visit (directory) {
    let entries
    try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch (error) {
      complete = false
      issues.push(createIssue('error', `无法扫描目录 ${directory}：${errorMessage(error)}。为防止误删，本次不会清理缺失项。`))
      return
    }
    const skillEntry = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md')
    if (skillEntry) {
      const skillFile = path.join(directory, skillEntry.name)
      const result = readSkillNameDetailed(skillFile)
      if (result.name) {
        const relativePath = path.relative(root, directory).split(path.sep).join('/') || '.'
        skills.push({ id: relativePath, name: result.name, relativePath, folderName: path.basename(directory), sourcePath: directory })
        return
      }
      issues.push(createIssue('warning', `${result.error}，该目录已忽略。`))
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name.startsWith('.git')) continue
      visit(path.join(directory, entry.name))
    }
  }

  visit(root)
  skills.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  return { skills, issues: uniqueIssues(issues), complete }
}

function scanConfiguredRepository (config) {
  const hasDependentData = config.groups.some(group => group.skillIds.length) || config.agents.some(agent => Object.keys(agent.managedLinks).length)
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
    if (config._syncLocked) scan.locked = true
    return scan
  } catch (error) {
    return {
      skills: [],
      complete: false,
      locked: Boolean(config._syncLocked),
      issues: [createIssue('error', `${error.message}。现有配置和链接已保留，请恢复目录后重新扫描。`)]
    }
  }
}

function inspectLink (linkPath, expectedSource) {
  let stat
  try { stat = fs.lstatSync(linkPath) } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'error', error }
  }
  if (!stat.isSymbolicLink()) return { kind: stat.isDirectory() ? 'directory' : 'file' }
  try {
    const rawTarget = fs.readlinkSync(linkPath)
    const targetPath = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(linkPath), rawTarget)
    return {
      kind: 'link',
      targetPath,
      sameTarget: expectedSource ? pathsEqual(targetPath, expectedSource) : false,
      dangling: !fs.existsSync(targetPath),
      identity: { dev: Number(stat.dev), ino: Number(stat.ino), birthtimeMs: Number(stat.birthtimeMs) }
    }
  } catch (error) {
    return { kind: 'error', error }
  }
}

// 只有路径、目标和创建时文件标识都匹配，才认定链接仍归本应用管理。
function identitiesEqual (stored, current) {
  if (!stored) return true
  return stored.dev === current.dev && stored.ino === current.ino && stored.birthtimeMs === current.birthtimeMs
}

function isDirectChild (parent, child) {
  return comparablePath(path.dirname(child)) === comparablePath(parent)
}

function removeOwnedLink (link, label, allowedDirectory) {
  if (!link?.linkPath || !link?.sourcePath) return { removed: false, relinquished: true, issues: [] }
  if (allowedDirectory && !isDirectChild(allowedDirectory, link.linkPath)) {
    return { removed: false, relinquished: true, issues: [createIssue('warning', `${label}超出 Agent 目录，记录已忽略且不会删除该路径。`)] }
  }
  const inspected = inspectLink(link.linkPath, link.sourcePath)
  if (inspected.kind === 'missing') return { removed: false, relinquished: true, issues: [] }
  if (inspected.kind === 'error') {
    return { removed: false, relinquished: false, issues: [createIssue('error', `无法检查${label}：${errorMessage(inspected.error)}`)] }
  }
  if (inspected.kind !== 'link' || !inspected.sameTarget || !identitiesEqual(link.identity, inspected.identity)) {
    return {
      removed: false,
      relinquished: true,
      issues: [createIssue('warning', `${label}已被外部替换，已停止管理并保留当前内容。`)]
    }
  }
  try {
    fs.unlinkSync(link.linkPath)
    return { removed: true, relinquished: true, issues: [] }
  } catch (error) {
    return { removed: false, relinquished: false, issues: [createIssue('error', `无法移除${label}：${errorMessage(error)}`)] }
  }
}

function describeConflict (skill, linkPath, inspected) {
  if (inspected.kind === 'directory') return `“${skill.name}”无法链接：目标位置已有普通目录 ${linkPath}，已保留原目录。`
  if (inspected.kind === 'file') return `“${skill.name}”无法链接：目标位置已有文件 ${linkPath}，已保留原文件。`
  if (inspected.kind === 'error') return `“${skill.name}”无法检查目标位置 ${linkPath}：${errorMessage(inspected.error)}`
  if (inspected.kind === 'link' && inspected.dangling) return `“${skill.name}”无法链接：目标位置已有失效的手动链接 ${linkPath}，请手动处理后重试。`
  return `“${skill.name}”无法链接：目标位置已有指向其他位置的手动链接 ${linkPath}，已保留原链接。`
}

function hasValidSkillFile (directory) {
  try {
    const files = fs.readdirSync(directory, { withFileTypes: true })
    const entry = files.find(item => item.isFile() && item.name.toLowerCase() === 'skill.md')
    return Boolean(entry && readSkillNameDetailed(path.join(directory, entry.name)).name)
  } catch (_) {
    return false
  }
}

function auditUnmanagedLinks (agent, knownPaths) {
  const issues = []
  let entries
  try { entries = fs.readdirSync(agent.directory, { withFileTypes: true }) } catch (error) {
    return [createIssue('error', `无法检查 Agent“${agent.name}”目录：${errorMessage(error)}`)]
  }
  entries.filter(entry => entry.isSymbolicLink()).forEach(entry => {
    const linkPath = path.join(agent.directory, entry.name)
    if (knownPaths.has(comparablePath(linkPath))) return
    const inspected = inspectLink(linkPath)
    if (inspected.kind !== 'link' || inspected.dangling || !hasValidSkillFile(inspected.targetPath)) {
      issues.push(createIssue('warning', `Agent“${agent.name}”中发现非 Skill 或失效的手动链接 ${linkPath}，已忽略并保留。`))
    }
  })
  return issues
}

// 同步遵循“只删除自己创建的链接”原则，任何手动文件、目录和链接都只提示不改动。
function syncAgent (config, agent, scan) {
  const issues = []
  const enabled = new Set(config.enabledGroups[agent.id] || [])
  const desiredSkillIds = new Set()
  config.groups.forEach(group => {
    if (enabled.has(group.id)) (group.skillIds || []).forEach(skillId => desiredSkillIds.add(skillId))
  })
  const skillById = new Map(scan.skills.map(skill => [skill.id, skill]))
  const previousLinks = normalizeManagedLinks(agent.managedLinks)
  const nextLinks = {}
  const linked = []
  const external = []
  const createdLinks = []

  let targetUsable = true
  try {
    const stat = fs.statSync(agent.directory)
    if (!stat.isDirectory()) throw new Error('该路径不是文件夹')
  } catch (error) {
    targetUsable = false
    issues.push(createIssue('error', `Agent“${agent.name}”的 Skills 目录不可用：${errorMessage(error)}。未创建或删除任何链接。`))
  }
  if (!targetUsable) {
    agent.managedLinks = previousLinks
    return { linked, external, createdLinks, issues }
  }
  // 数据库关键结构异常时只做观察，不根据兜底后的空值改动任何文件。
  if (scan.locked) {
    Object.entries(previousLinks).forEach(([skillId, link]) => {
      if (!isDirectChild(agent.directory, link.linkPath)) return
      const inspected = inspectLink(link.linkPath, link.sourcePath)
      if (inspected.kind === 'link' && inspected.sameTarget && identitiesEqual(link.identity, inspected.identity)) linked.push(skillId)
    })
    agent.managedLinks = previousLinks
    const knownPaths = new Set(Object.values(previousLinks).map(link => comparablePath(link.linkPath)))
    issues.push(...auditUnmanagedLinks(agent, knownPaths))
    return { linked, external, createdLinks, issues: uniqueIssues(issues) }
  }

  Object.entries(previousLinks).forEach(([skillId, link]) => {
    const skill = skillById.get(skillId)
    if (!isDirectChild(agent.directory, link.linkPath)) {
      issues.push(createIssue('warning', `Agent“${agent.name}”存在超出其 Skills 目录的异常受管记录，已停止管理且不会删除该路径：${link.linkPath}`))
      return
    }
    // 扫描不完整时，无法确认 Skill 是否真的被删除，因此保留仍被启用的受管链接。
    const shouldKeep = desiredSkillIds.has(skillId) && (skill || !scan.complete)
    const currentSource = skill?.sourcePath || link.sourcePath
    const inspected = inspectLink(link.linkPath, link.sourcePath)
    const stillOwned = inspected.kind === 'link' && inspected.sameTarget && identitiesEqual(link.identity, inspected.identity)
    if (shouldKeep && stillOwned && pathsEqual(link.sourcePath, currentSource)) {
      nextLinks[skillId] = link
      linked.push(skillId)
      return
    }
    if (shouldKeep && !scan.complete && stillOwned) {
      nextLinks[skillId] = link
      linked.push(skillId)
      return
    }
    const removal = removeOwnedLink(link, `Agent“${agent.name}”中的受管链接 ${link.linkPath}`, agent.directory)
    issues.push(...removal.issues)
    if (!removal.relinquished) nextLinks[skillId] = link
    if (scan.complete && !skill && removal.removed) {
      issues.push(createIssue('info', `Skill“${skillId}”已不在主仓库中，对应的受管链接已移除。`))
    }
  })

  const desiredSkills = [...desiredSkillIds].map(skillId => skillById.get(skillId)).filter(Boolean)
  const folderCounts = desiredSkills.reduce((counts, skill) => counts.set(skill.folderName, (counts.get(skill.folderName) || 0) + 1), new Map())
  desiredSkills.forEach(skill => {
    if (nextLinks[skill.id]) return
    if (folderCounts.get(skill.folderName) > 1) {
      issues.push(createIssue('error', `多个已启用 Skills 使用同一目录名“${skill.folderName}”，为避免覆盖，Agent“${agent.name}”未创建这些链接。`))
      return
    }
    const linkPath = path.join(agent.directory, skill.folderName)
    const inspected = inspectLink(linkPath, skill.sourcePath)
    if (inspected.kind !== 'missing') {
      if (inspected.kind === 'link' && inspected.sameTarget) {
        external.push(skill.id)
        issues.push(createIssue('info', `Agent“${agent.name}”已存在“${skill.name}”的手动同源链接，已直接使用但不会由本应用删除。`))
      } else {
        issues.push(createIssue(inspected.kind === 'error' ? 'error' : 'warning', describeConflict(skill, linkPath, inspected)))
      }
      return
    }
    try {
      fs.symlinkSync(skill.sourcePath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      let identity
      try {
        const created = fs.lstatSync(linkPath)
        identity = { dev: Number(created.dev), ino: Number(created.ino), birthtimeMs: Number(created.birthtimeMs) }
      } catch (error) {
        issues.push(createIssue('warning', `“${skill.name}”链接已创建，但无法记录文件标识：${errorMessage(error)}。后续仍会按链接目标安全管理。`))
      }
      nextLinks[skill.id] = { linkPath, sourcePath: skill.sourcePath, ...(identity ? { identity } : {}) }
      createdLinks.push(nextLinks[skill.id])
      linked.push(skill.id)
    } catch (error) {
      issues.push(createIssue('error', `创建“${skill.name}”链接失败：${errorMessage(error)}`))
    }
  })

  const knownPaths = new Set([
    ...Object.values(nextLinks).map(link => comparablePath(link.linkPath)),
    ...desiredSkills.map(skill => comparablePath(path.join(agent.directory, skill.folderName)))
  ])
  issues.push(...auditUnmanagedLinks(agent, knownPaths))
  agent.managedLinks = nextLinks
  return { linked, external, createdLinks, issues: uniqueIssues(issues) }
}

function syncAllAgents (config, scan) {
  const results = {}
  config.agents.forEach(agent => { results[agent.id] = syncAgent(config, agent, scan) })
  return results
}

function reconcileDeletedSkills (config, scan) {
  if (!scan.complete || scan.locked) return []
  const validSkillIds = new Set(scan.skills.map(skill => skill.id))
  const issues = []
  config.groups.forEach(group => {
    const missing = group.skillIds.filter(skillId => !validSkillIds.has(skillId))
    if (!missing.length) return
    group.skillIds = group.skillIds.filter(skillId => validSkillIds.has(skillId))
    issues.push(createIssue('warning', `分组“${group.name}”中有 ${missing.length} 个 Skill 已从主仓库删除，失效引用已自动清理。`))
  })
  return issues
}

function collectIssues (scan, syncResults, extra = []) {
  return uniqueIssues([
    ...(scan?.issues || []),
    ...extra,
    ...Object.values(syncResults || {}).flatMap(result => result.issues || [])
  ])
}

function publicAgent (agent, syncResult) {
  const managedLinkedCount = syncResult ? syncResult.linked.length : Object.keys(agent.managedLinks || {}).length
  const externalLinkedCount = syncResult?.external.length || 0
  return { id: agent.id, name: agent.name, directory: agent.directory, linkedCount: managedLinkedCount + externalLinkedCount, managedLinkedCount, externalLinkedCount }
}

function buildState (config, scan = { skills: [] }, syncResults = {}, issues = []) {
  return {
    repositoryPath: config.repositoryPath,
    skills: scan.skills || [],
    groups: config.groups,
    agents: config.agents.map(agent => publicAgent(agent, syncResults[agent.id])),
    enabledGroups: config.enabledGroups,
    theme: config.theme === 'dark' ? 'dark' : 'light',
    issues: uniqueIssues(issues)
  }
}

function refreshState (config) {
  const scan = scanConfiguredRepository(config)
  const reconciledIssues = reconcileDeletedSkills(config, scan)
  const syncResults = syncAllAgents(config, scan)
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
      const detail = rollbackIssues.length ? `；部分链接回滚失败：${rollbackIssues.map(issue => issue.message).join('；')}` : '；本轮新建链接已回滚'
      throw new Error(`${error.message}${detail}`)
    }
  }
  return buildState(config, scan, syncResults, collectIssues(scan, syncResults, [...(config._issues || []), ...reconciledIssues]))
}

function cleanupAgentLinks (agent) {
  const issues = []
  const remaining = {}
  Object.entries(normalizeManagedLinks(agent.managedLinks)).forEach(([skillId, link]) => {
    const removal = removeOwnedLink(link, `Agent“${agent.name}”中的受管链接 ${link.linkPath}`, agent.directory)
    issues.push(...removal.issues)
    if (!removal.relinquished) remaining[skillId] = link
  })
  agent.managedLinks = remaining
  return uniqueIssues(issues)
}

function throwIfCleanupFailed (issues, action) {
  const failures = issues.filter(issue => issue.type === 'error')
  if (failures.length) throw new Error(`${action}未完成：${failures.map(issue => issue.message).join('；')}`)
}

function assertConfigWritable (config) {
  if (config._syncLocked) throw new Error('本地数据库关键配置异常，当前处于只读保护。请先在设置页清除数据，再重新配置。')
}

window.skillsManager = {
  chooseDirectory (defaultPath) {
    try {
      const result = window.utools.showOpenDialog({ title: '选择目录', defaultPath: defaultPath || undefined, properties: ['openDirectory', 'createDirectory'] })
      return result && result.length ? result[0] : ''
    } catch (error) {
      throw new Error(`打开目录选择器失败：${errorMessage(error)}`)
    }
  },

  getState () {
    return refreshState(readConfig())
  },

  // 主题保存不依赖文件系统，主仓库暂时离线时仍可正常切换。
  setTheme (theme) {
    const config = readConfig()
    config.theme = theme === 'dark' ? 'dark' : 'light'
    try { database().setItem(STORAGE_KEYS.theme, config.theme) } catch (error) {
      throw new Error(`保存主题失败：${errorMessage(error)}`)
    }
    return { theme: config.theme, issues: config._issues || [] }
  },

  setRepository (repositoryPath) {
    const config = readConfig()
    assertConfigWritable(config)
    const normalizedPath = normalizeDirectory(repositoryPath, 'Skills 仓库目录')
    const nestedAgent = config.agents.find(agent => isInsideDirectory(normalizedPath, agent.directory) || isInsideDirectory(agent.directory, normalizedPath))
    if (nestedAgent) throw new Error(`Skills 仓库不能与 Agent“${nestedAgent.name}”的目录相同或互相包含，请调整其中一个路径`)
    config.repositoryPath = normalizedPath
    return refreshState(config)
  },

  refreshSkills () {
    const config = readConfig()
    assertConfigWritable(config)
    if (!config.repositoryPath) throw new Error('请先配置 Skills 仓库目录')
    return refreshState(config)
  },

  saveGroups (groups) {
    const config = readConfig()
    assertConfigWritable(config)
    config.groups = (Array.isArray(groups) ? groups : []).map(group => ({
      id: String(group.id || '').trim(),
      name: String(group.name || '').trim(),
      skillIds: [...new Set(Array.isArray(group.skillIds) ? group.skillIds.map(String) : [])]
    })).filter(group => group.id && group.name)
    if (new Set(config.groups.map(group => group.id)).size !== config.groups.length) throw new Error('分组标识重复，请重新创建分组')
    const validIds = new Set(config.groups.map(group => group.id))
    Object.keys(config.enabledGroups).forEach(agentId => {
      config.enabledGroups[agentId] = (config.enabledGroups[agentId] || []).filter(groupId => validIds.has(groupId))
    })
    return refreshState(config)
  },

  upsertAgent (input) {
    const config = readConfig()
    assertConfigWritable(config)
    const name = String(input?.name || '').trim()
    if (!name) throw new Error('请输入 Agent 名称')
    const directory = normalizeDirectory(String(input?.directory || ''), 'Agent Skills 目录')
    const id = input?.id ? String(input.id) : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    assertSafeAgentDirectory(config, directory, id)
    const existing = config.agents.find(agent => agent.id === id)
    const cleanupIssues = []
    if (existing) {
      if (!pathsEqual(existing.directory, directory)) {
        cleanupIssues.push(...cleanupAgentLinks(existing))
        throwIfCleanupFailed(cleanupIssues, '更换 Agent 目录')
        existing.managedLinks = {}
      }
      existing.name = name
      existing.directory = directory
    } else {
      config.agents.push({ id, name, directory, managedLinks: {} })
      config.enabledGroups[id] = []
    }
    const state = refreshState(config)
    state.issues = uniqueIssues([...cleanupIssues, ...state.issues])
    return state
  },

  deleteAgent (agentId) {
    const config = readConfig()
    assertConfigWritable(config)
    const agent = config.agents.find(item => item.id === agentId)
    if (!agent) throw new Error('未找到要删除的 Agent，配置可能已被其他窗口更新')
    const issues = cleanupAgentLinks(agent)
    throwIfCleanupFailed(issues, '删除 Agent')
    config.agents = config.agents.filter(item => item.id !== agentId)
    delete config.enabledGroups[agentId]
    const state = refreshState(config)
    state.issues = uniqueIssues([...issues, ...state.issues])
    return state
  },

  // 只有受管链接全部完成安全清理后才删除数据库记录，避免遗留无法追踪的链接。
  clearData () {
    const config = readConfig()
    const issues = config.agents.flatMap(cleanupAgentLinks)
    throwIfCleanupFailed(issues, '清除数据')
    if (config._syncLocked) {
      issues.push(createIssue('warning', '数据库配置异常，仅清理了仍可识别的受管链接；无法识别的现有文件和链接均已保留。'))
    }
    clearStoredConfig()
    return buildState(createDefaultConfig(), { skills: [] }, {}, issues)
  },

  setAgentGroups (agentId, groupIds) {
    const config = readConfig()
    assertConfigWritable(config)
    const agent = config.agents.find(item => item.id === agentId)
    if (!agent) throw new Error('未找到该 Agent，配置可能已被其他窗口更新')
    const validIds = new Set(config.groups.map(group => group.id))
    config.enabledGroups[agentId] = [...new Set(Array.isArray(groupIds) ? groupIds.map(String) : [])].filter(groupId => validIds.has(groupId))
    return refreshState(config)
  }
}
