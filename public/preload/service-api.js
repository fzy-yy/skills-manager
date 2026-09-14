/** 面向 Vue 前端的预加载 API，仅负责编排用户主动发起的操作。 */
const path = require("node:path");
const { errorMessage } = require("./runtime");

const MUTATION_TIMEOUT_MS = 60_000;

function createSkillsManagerApi({
  configStore,
  pathSafety,
  stateService,
  utools,
}) {
  const {
    MAX_ENTITY_NAME_LENGTH,
    isSafeRecordKey,
    normalizeCachedSkills,
    normalizeManagedLinks,
    readConfig,
    writeConfig,
    writeTheme,
  } = configStore;
  const {
    assertSafeAgentDirectory,
    isInsideDirectory,
    normalizeDirectory,
    pathsEqual,
  } = pathSafety;
  const {
    assertConfigWritable,
    clearDataState,
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
      if (path.parse(normalizedPath).root === normalizedPath)
        throw new Error(
          "Skills 仓库不能是磁盘根目录，请选择专用的 Skills 文件夹",
        );

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
      config.repositoryPath = normalizedPath;
      return refreshState(config);
    },

    async refreshSkills() {
      const config = await readConfig();
      assertConfigWritable(config);
      if (!config.repositoryPath) throw new Error("请先配置 Skills 仓库目录");
      return refreshState(config);
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
          throw new Error(
            `分组名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`,
          );
        if (!Array.isArray(group.skillIds))
          throw new Error(`分组“${name}”的 Skills 配置格式无效`);
        return {
          id,
          name,
          skillIds: [...new Set(group.skillIds.map(String))].filter(Boolean),
        };
      });
      if (new Set(normalized.map((group) => group.id)).size !== normalized.length)
        throw new Error("分组标识重复，请重新创建分组");

      config.groups = normalized;
      await writeConfig(config);
      return getCachedState(config);
    },

    /** 改名和新建只保存配置；仅目录变更时处理对应 Agent 的链接。 */
    async upsertAgent(input) {
      const config = await readConfig();
      assertConfigWritable(config);
      const name = String(input?.name || "").trim();
      if (!name) throw new Error("请输入 Agent 名称");
      if (name.length > MAX_ENTITY_NAME_LENGTH)
        throw new Error(
          `Agent 名称不能超过 ${MAX_ENTITY_NAME_LENGTH} 个字符`,
        );
      const directory = await normalizeDirectory(
        String(input?.directory || ""),
        "Agent Skills 目录",
      );
      const id = input?.id
        ? String(input.id)
        : `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!isSafeRecordKey(id))
        throw new Error("Agent 标识无效，请重新创建 Agent");
      await assertSafeAgentDirectory(config, directory, id);

      const existing = config.agents.find((agent) => agent.id === id);
      if (!existing) {
        config.agents.push({ id, name, directory, managedLinks: {} });
        config.enabledSkills[id] = [];
        await writeConfig(config);
        return getCachedState(config);
      }

      const directoryChanged =
        existing.directory && !(await pathsEqual(existing.directory, directory));
      if (directoryChanged) {
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
      if (directoryChanged) return syncMovedAgentState(config, existing);

      await writeConfig(config);
      return getCachedState(config);
    },

    async deleteAgent(agentId) {
      const config = await readConfig();
      assertConfigWritable(config);
      const agent = config.agents.find((item) => item.id === agentId);
      if (!agent)
        throw new Error("未找到要删除的 Agent，配置可能已经发生变化");

      config._orphanAgents.push({
        ...agent,
        managedLinks: normalizeManagedLinks(agent.managedLinks),
      });
      config.agents = config.agents.filter((item) => item.id !== agentId);
      delete config.enabledSkills[agentId];
      return deleteAgentState(config);
    },

    async clearData() {
      return clearDataState(await readConfig());
    },

    async setAgentSkills(agentId, skillIds) {
      const config = await readConfig();
      assertConfigWritable(config);
      const agent = config.agents.find((item) => item.id === agentId);
      if (!agent)
        throw new Error("未找到该 Agent，配置可能已经发生变化");

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

  let mutationTail = Promise.resolve();
  let mutationTimedOut = false;
  const mutationMethods = [
    "setTheme",
    "setRepository",
    "refreshSkills",
    "saveGroups",
    "upsertAgent",
    "deleteAgent",
    "clearData",
    "setAgentSkills",
  ];

  function runWithTimeout(operation) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        mutationTimedOut = true;
        reject(
          new Error(
            "文件操作超过 60 秒，已停止等待。为避免迟到的磁盘操作与新操作交叉，请重新打开插件后再继续。",
          ),
        );
      }, MUTATION_TIMEOUT_MS);
    });
    return Promise.race([operation(), timeout]).finally(() =>
      clearTimeout(timer),
    );
  }

  mutationMethods.forEach((method) => {
    const operation = api[method].bind(api);
    api[method] = (...args) => {
      const run = mutationTail.then(() => {
        if (mutationTimedOut)
          throw new Error(
            "上一次文件操作已经超时，请重新打开插件后再继续。",
          );
        return runWithTimeout(() => operation(...args));
      });
      mutationTail = run.catch(() => undefined);
      return run;
    };
  });

  return api;
}

module.exports = { createSkillsManagerApi };
