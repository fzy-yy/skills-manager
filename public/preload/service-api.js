/** 面向 Vue 前端的预加载 API，仅负责编排用户主动发起的操作。 */
const { serializeMutations } = require("./mutation-queue");
const { errorMessage } = require("./runtime");

/** 会改动配置或文件系统的方法：统一走串行 + 超时队列（见 mutation-queue.js）。 */
const MUTATION_METHODS = [
  "setTheme",
  "setRepository",
  "refreshSkills",
  "saveGroups",
  "upsertAgent",
  "deleteAgent",
  "clearData",
  "setAgentSkills",
];

function createSkillsManagerApi({
  configStore,
  pathSafety,
  pendingSkillSync,
  stateService,
  utools,
}) {
  const pendingIntents = pendingSkillSync || {
    record: () => ({ ok: true, issue: null }),
    read: () => ({ ok: true, records: [], issue: null }),
    clear: () => ({ ok: true, issue: null }),
    clearAll: () => ({ ok: true, issue: null }),
  };
  const {
    MAX_ENTITY_NAME_LENGTH,
    assertConfigWritable,
    isSafeRecordKey,
    normalizeCachedSkills,
    normalizeManagedLinks,
    readConfig,
    writeConfig,
    writeTheme,
  } = configStore;
  const {
    assertNotDiskRoot,
    assertSafeAgentDirectory,
    isInsideDirectory,
    normalizeDirectory,
    pathsEqualLexical,
  } = pathSafety;
  const {
    bindAgentDirectoryState,
    clearDataState,
    clearUnreadableDataState,
    deleteAgentState,
    getCachedState,
    refreshState,
    syncAgentSkillsState,
    syncMovedAgentState,
  } = stateService;

  const api = {
    chooseDirectory(defaultPath) {
      try {
        const result = utools.showOpenDialog({
          title: "选择目录",
          defaultPath: defaultPath || undefined,
          properties: ["openDirectory", "createDirectory"],
        });
        return result?.[0] || "";
      } catch (error) {
        throw new Error(`打开目录选择器失败：${errorMessage(error)}`);
      }
    },

    /** 待同步意图使用同步本机文件，不能放入下方 Promise 写队列。 */
    recordPendingSkillSync(agentId, skillIds, token) {
      return pendingIntents.record(agentId, skillIds, token);
    },

    readPendingSkillSync() {
      return pendingIntents.read();
    },

    clearPendingSkillSync(agentId, token) {
      return agentId
        ? pendingIntents.clear(agentId, token)
        : pendingIntents.clearAll();
    },

    /** 仅读取本地配置和扫描缓存，不隐式扫描或修改链接。 */
    async getState() {
      const config = await readConfig();
      return getCachedState(config);
    },

    async setTheme(theme) {
      const config = await readConfig();
      config.theme = theme === "dark" ? "dark" : "light";
      await writeTheme(config);
      return { theme: config.theme, issues: config._issues || [] };
    },

    async setRepository(repositoryPath) {
      const config = await readConfig();
      assertConfigWritable(config);
      const normalizedPath = await normalizeDirectory(
        repositoryPath,
        "Skills 仓库目录",
      );
      assertNotDiskRoot(normalizedPath, "Skills 仓库目录");

      for (const agent of config.agents) {
        if (
          agent.directory &&
          ((await isInsideDirectory(normalizedPath, agent.directory)) ||
            (await isInsideDirectory(agent.directory, normalizedPath)))
        )
          throw new Error(
            `Skills 仓库不能与 Agent“${agent.name}”的目录相同或互相包含，请调整其中一个路径`,
          );
      }
      for (const agent of config._orphanAgents || []) {
        if (
          agent.directory &&
          ((await isInsideDirectory(normalizedPath, agent.directory)) ||
            (await isInsideDirectory(agent.directory, normalizedPath)))
        )
          throw new Error(
            `Skills 仓库不能与仍有待清理链接的 Agent“${agent.name}”目录相同或互相包含，请先处理相关错误后再设置`,
          );
      }
      config.repositoryPath = normalizedPath;
      return refreshState(config);
    },

    async refreshSkills(options = {}) {
      const config = await readConfig();
      assertConfigWritable(config);
      if (!config.repositoryPath) throw new Error("请先配置 Skills 仓库目录");
      return refreshState(config, {
        allowEmptyRepository: options?.allowEmptyRepository === true,
      });
    },

    /** 分组只是选择模板，保存时不扫描仓库，也不修改任何链接。 */
    async saveGroups(groups) {
      const config = await readConfig();
      assertConfigWritable(config);
      if (!Array.isArray(groups)) throw new Error("分组数据格式无效");

      const normalized = groups.map((group) => {
        const id = String(group?.id || "").trim();
        const name = String(group?.name || "").trim();
        if (!id || !isSafeRecordKey(id) || !name)
          throw new Error("分组数据不完整，请重新创建该分组");
        if (name.length > MAX_ENTITY_NAME_LENGTH)
          throw new Error(`分组名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`);
        if (!Array.isArray(group.skillIds))
          throw new Error(`分组“${name}”的 Skills 配置格式无效`);
        return {
          id,
          name,
          skillIds: [...new Set(group.skillIds.map(String))].filter(Boolean),
        };
      });
      if (
        new Set(normalized.map((group) => group.id)).size !== normalized.length
      )
        throw new Error("分组标识重复，请重新创建分组");

      config.groups = normalized;
      await writeConfig(config);
      return getCachedState(config);
    },

    /** 新建、改名、首次绑定与目录迁移分别处理，避免无关文件系统访问。 */
    async upsertAgent(input) {
      const config = await readConfig();
      assertConfigWritable(config);
      const name = String(input?.name || "").trim();
      if (!name) throw new Error("请输入 Agent 名称");
      if (name.length > MAX_ENTITY_NAME_LENGTH)
        throw new Error(`Agent 名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`);
      const requestedDirectory = String(input?.directory || "").trim();
      const id = input?.id
        ? String(input.id)
        : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!isSafeRecordKey(id))
        throw new Error("Agent 标识无效，请重新创建 Agent");

      const existing = config.agents.find((agent) => agent.id === id);
      if (!existing) {
        const directory = await normalizeDirectory(
          requestedDirectory,
          "Agent Skills 目录",
        );
        await assertSafeAgentDirectory(config, directory, id);
        config.agents.push({ id, name, directory, managedLinks: {} });
        config.enabledSkills[id] = [];
        await writeConfig(config);
        return getCachedState(config);
      }

      if (pathsEqualLexical(existing.directory, requestedDirectory)) {
        existing.name = name;
        await writeConfig(config);
        return getCachedState(config);
      }
      if (existing.directory && !requestedDirectory)
        throw new Error("请选择有效的 Agent Skills 目录");

      const directory = await normalizeDirectory(
        requestedDirectory,
        "Agent Skills 目录",
      );
      if (pathsEqualLexical(existing.directory, directory)) {
        existing.name = name;
        existing.directory = directory;
        await writeConfig(config);
        return getCachedState(config);
      }
      await assertSafeAgentDirectory(config, directory, id);
      const firstBinding = !existing.directory;
      if (!firstBinding) {
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
      return firstBinding
        ? bindAgentDirectoryState(config, existing)
        : syncMovedAgentState(config, existing);
    },

    async deleteAgent(agentId) {
      const config = await readConfig();
      assertConfigWritable(config);
      const agent = config.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error("未找到要删除的 Agent，配置可能已经发生变化");

      config._orphanAgents.push({
        ...agent,
        managedLinks: normalizeManagedLinks(agent.managedLinks),
      });
      config.agents = config.agents.filter((item) => item.id !== agentId);
      delete config.enabledSkills[agentId];
      const state = await deleteAgentState(config);
      const clearedIntent = pendingIntents.clear(agentId);
      if (clearedIntent.issue)
        state.issues = [...(state.issues || []), clearedIntent.issue];
      return state;
    },

    async clearData() {
      let state;
      try {
        const config = await readConfig();
        state = await clearDataState(config);
      } catch (error) {
        if (error?.code !== "ECONFIGREAD") throw error;
        state = await clearUnreadableDataState();
      }
      const clearedIntents = pendingIntents.clearAll();
      if (clearedIntents.issue)
        state.issues = [...(state.issues || []), clearedIntents.issue];
      return state;
    },

    async setAgentSkills(agentId, skillIds) {
      const config = await readConfig();
      assertConfigWritable(config);
      const agent = config.agents.find((item) => item.id === agentId);
      if (!agent) throw new Error("未找到该 Agent，配置可能已经发生变化");

      const validIds = new Set(
        normalizeCachedSkills(config._cachedSkills).map((skill) => skill.id),
      );
      const previousSkillIds = [...(config.enabledSkills[agentId] || [])];
      config.enabledSkills[agentId] = [
        ...new Set(Array.isArray(skillIds) ? skillIds.map(String) : []),
      ].filter((skillId) => validIds.has(skillId));
      return syncAgentSkillsState(config, agent, previousSkillIds);
    },
  };

  return serializeMutations(api, MUTATION_METHODS);
}

module.exports = { createSkillsManagerApi };
