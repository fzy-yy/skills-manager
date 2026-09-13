const fs = require('node:fs')
const path = require('node:path')

const CONFIG_VERSION = 1
const CONFIG_FILE = path.join(window.utools.getPath('userData'), 'skills-manager', 'config.json')

function createDefaultConfig () {
  return { version: CONFIG_VERSION, repositoryPath: '', groups: [], agents: [], enabledGroups: {}, theme: 'light' }
}

function readConfig () {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return createDefaultConfig()
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return {
      ...createDefaultConfig(),
      ...parsed,
      groups: Array.isArray(parsed.groups) ? parsed.groups : [],
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      enabledGroups: parsed.enabledGroups && typeof parsed.enabledGroups === 'object' ? parsed.enabledGroups : {}
    }
  } catch (error) {
    throw new Error(`读取配置失败：${error.message}`)
  }
}

function writeConfig (config) {
  const directory = path.dirname(CONFIG_FILE)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryFile = `${CONFIG_FILE}.tmp`
  fs.writeFileSync(temporaryFile, JSON.stringify(config, null, 2), 'utf8')
  fs.renameSync(temporaryFile, CONFIG_FILE)
}

function normalizeDirectory (directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('请选择有效的目录')
  const resolved = path.resolve(directory.trim())
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('目录不存在或无法访问')
  return resolved
}

function readSkillName (skillFile) {
  try {
    const content = fs.readFileSync(skillFile, 'utf8')
    const frontmatter = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/)
    if (!frontmatter) return ''
    const nameLine = frontmatter[1].split(/\r?\n/).find(line => /^\s*name\s*:/.test(line))
    if (!nameLine) return ''
    return nameLine
      .replace(/^\s*name\s*:\s*/, '')
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted || singleQuoted || '')
      .trim()
  } catch (_) {
    return ''
  }
}

function scanSkills (repositoryPath) {
  if (!repositoryPath) return []
  const root = normalizeDirectory(repositoryPath)
  const skills = []

  function visit (directory) {
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (_) {
      return
    }
    const skillEntry = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md')
    if (skillEntry) {
      const name = readSkillName(path.join(directory, skillEntry.name))
      if (name) {
        const relativePath = path.relative(root, directory).split(path.sep).join('/') || '.'
        skills.push({ id: relativePath, name, relativePath, folderName: path.basename(directory), sourcePath: directory })
      }
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name.startsWith('.git')) continue
      visit(path.join(directory, entry.name))
    }
  }

  visit(root)
  return skills.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
}

function isSameLink (linkPath, sourcePath) {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return false
    return path.resolve(fs.realpathSync(linkPath)) === path.resolve(fs.realpathSync(sourcePath))
  } catch (_) {
    return false
  }
}

function removeManagedLink (link) {
  if (!link || !link.linkPath) return
  try {
    if (fs.lstatSync(link.linkPath).isSymbolicLink()) fs.unlinkSync(link.linkPath)
  } catch (_) {}
}

function syncAgent (config, agent, skills) {
  const enabled = new Set(config.enabledGroups[agent.id] || [])
  const desiredSkillIds = new Set()
  config.groups.forEach(group => {
    if (enabled.has(group.id)) (group.skillIds || []).forEach(skillId => desiredSkillIds.add(skillId))
  })
  const skillById = new Map(skills.map(skill => [skill.id, skill]))
  const previousLinks = agent.managedLinks && typeof agent.managedLinks === 'object' ? agent.managedLinks : {}
  const nextLinks = {}
  const conflicts = []
  const linked = []

  Object.entries(previousLinks).forEach(([skillId, link]) => {
    const skill = skillById.get(skillId)
    const shouldKeep = desiredSkillIds.has(skillId) && skill && isSameLink(link.linkPath, skill.sourcePath)
    if (shouldKeep) {
      nextLinks[skillId] = link
      linked.push(skillId)
    } else removeManagedLink(link)
  })

  if (desiredSkillIds.size > 0) fs.mkdirSync(agent.directory, { recursive: true })
  desiredSkillIds.forEach(skillId => {
    if (nextLinks[skillId]) return
    const skill = skillById.get(skillId)
    if (!skill) return
    const linkPath = path.join(agent.directory, skill.folderName)
    if (fs.existsSync(linkPath)) {
      // 只管理本应用亲自创建并记录的链接，绝不接管已有目录或链接。
      conflicts.push({ skillId, skillName: skill.name, linkPath })
      return
    }
    try {
      fs.symlinkSync(skill.sourcePath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      nextLinks[skillId] = { linkPath, sourcePath: skill.sourcePath }
      linked.push(skillId)
    } catch (error) {
      conflicts.push({ skillId, skillName: skill.name, linkPath, reason: error.message })
    }
  })
  agent.managedLinks = nextLinks
  return { linked, conflicts }
}

function syncAllAgents (config, skills) {
  const results = {}
  config.agents.forEach(agent => { results[agent.id] = syncAgent(config, agent, skills) })
  return results
}

function publicAgent (agent) {
  return { id: agent.id, name: agent.name, directory: agent.directory, linkedCount: Object.keys(agent.managedLinks || {}).length }
}

function buildState (config, skills = scanSkills(config.repositoryPath)) {
  return {
    repositoryPath: config.repositoryPath,
    skills,
    groups: config.groups,
    agents: config.agents.map(publicAgent),
    enabledGroups: config.enabledGroups,
    theme: config.theme === 'dark' ? 'dark' : 'light'
  }
}

window.skillsManager = {
  chooseDirectory (defaultPath) {
    const result = window.utools.showOpenDialog({ title: '选择目录', defaultPath: defaultPath || undefined, properties: ['openDirectory', 'createDirectory'] })
    return result && result.length ? result[0] : ''
  },

  getState () {
    return buildState(readConfig())
  },

  // 保存界面主题，确保下次打开插件时保持用户选择。
  setTheme (theme) {
    const config = readConfig()
    config.theme = theme === 'dark' ? 'dark' : 'light'
    writeConfig(config)
    return buildState(config)
  },

  setRepository (repositoryPath) {
    const config = readConfig()
    config.repositoryPath = normalizeDirectory(repositoryPath)
    const skills = scanSkills(config.repositoryPath)
    const syncResults = syncAllAgents(config, skills)
    writeConfig(config)
    return { ...buildState(config, skills), syncResults }
  },

  refreshSkills () {
    const config = readConfig()
    const skills = scanSkills(config.repositoryPath)
    const syncResults = syncAllAgents(config, skills)
    writeConfig(config)
    return { ...buildState(config, skills), syncResults }
  },

  saveGroups (groups) {
    const config = readConfig()
    config.groups = (Array.isArray(groups) ? groups : []).map(group => ({
      id: String(group.id),
      name: String(group.name || '').trim(),
      skillIds: [...new Set(Array.isArray(group.skillIds) ? group.skillIds.map(String) : [])]
    })).filter(group => group.id && group.name)
    const validIds = new Set(config.groups.map(group => group.id))
    Object.keys(config.enabledGroups).forEach(agentId => {
      config.enabledGroups[agentId] = (config.enabledGroups[agentId] || []).filter(groupId => validIds.has(groupId))
    })
    const skills = scanSkills(config.repositoryPath)
    const syncResults = syncAllAgents(config, skills)
    writeConfig(config)
    return { ...buildState(config, skills), syncResults }
  },

  upsertAgent (input) {
    const config = readConfig()
    const name = String(input && input.name || '').trim()
    const directory = normalizeDirectory(String(input && input.directory || ''))
    if (!name) throw new Error('请输入 Agent 名称')
    const id = input && input.id ? String(input.id) : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const existing = config.agents.find(agent => agent.id === id)
    if (existing) {
      if (path.resolve(existing.directory) !== path.resolve(directory)) {
        Object.values(existing.managedLinks || {}).forEach(removeManagedLink)
        existing.managedLinks = {}
      }
      existing.name = name
      existing.directory = directory
    } else {
      config.agents.push({ id, name, directory, managedLinks: {} })
      config.enabledGroups[id] = []
    }
    const agent = existing || config.agents[config.agents.length - 1]
    const skills = scanSkills(config.repositoryPath)
    const syncResult = syncAgent(config, agent, skills)
    writeConfig(config)
    return { ...buildState(config, skills), syncResult }
  },

  deleteAgent (agentId) {
    const config = readConfig()
    const agent = config.agents.find(item => item.id === agentId)
    if (agent) Object.values(agent.managedLinks || {}).forEach(removeManagedLink)
    config.agents = config.agents.filter(item => item.id !== agentId)
    delete config.enabledGroups[agentId]
    writeConfig(config)
    return buildState(config)
  },

  setAgentGroups (agentId, groupIds) {
    const config = readConfig()
    const agent = config.agents.find(item => item.id === agentId)
    if (!agent) throw new Error('未找到该 Agent')
    const validIds = new Set(config.groups.map(group => group.id))
    config.enabledGroups[agentId] = [...new Set(Array.isArray(groupIds) ? groupIds : [])].filter(groupId => validIds.has(groupId))
    const skills = scanSkills(config.repositoryPath)
    const syncResult = syncAgent(config, agent, skills)
    writeConfig(config)
    return { ...buildState(config, skills), syncResult }
  }
}
