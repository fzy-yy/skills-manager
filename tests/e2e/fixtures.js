import { test as base, expect } from "@playwright/test";
import { createStateSnapshot } from "../helpers/state-fixture";

/**
 * 在浏览器加载 Vue 之前注入 uTools preload API 的内存实现。
 * E2E 只验证前端真实路由和用户交互；文件系统链接由集成测试覆盖。
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    page.on("pageerror", (error) =>
      console.error(`[browser error] ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() === "error")
        console.error(`[browser console] ${message.text()}`);
    });
    await page.addInitScript((initialState) => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const state = clone(initialState);
      const pendingSkillSync = {};
      const pluginCallbacks = {};
      const snapshot = () => clone(state);
      window.utools = {
        onPluginEnter: (callback) => (pluginCallbacks.enter = callback),
        onPluginOut: (callback) => (pluginCallbacks.out = callback),
      };
      window.__skillsManagerTest = {
        pendingSkillSync,
        setEmptyRepository: (value) => (state.emptyRepository = value === true),
        triggerPluginEnter: (action = {}) => pluginCallbacks.enter?.(action),
        triggerPluginOut: (isKill = false) => pluginCallbacks.out?.(isKill),
      };
      window.skillsManager = {
        chooseDirectory: () => "C:\\picked",
        getState: async () => snapshot(),
        setRepository: async (directory) => {
          if (directory.includes("invalid")) throw new Error("仓库目录不可用");
          state.repositoryPath = directory;
          state.skills = [
            {
              id: "alpha",
              name: "Alpha",
              relativePath: "alpha",
              folderName: "alpha",
              sourcePath: `${directory}\\alpha`,
            },
            {
              id: "beta",
              name: "Beta",
              relativePath: "beta",
              folderName: "beta",
              sourcePath: `${directory}\\beta`,
            },
          ];
          return snapshot();
        },
        refreshSkills: async (options = {}) => {
          if (options.allowEmptyRepository) state.emptyRepository = false;
          return snapshot();
        },
        saveGroups: async (groups) => {
          state.groups = clone(groups);
          return snapshot();
        },
        upsertAgent: async (input) => {
          const existing = state.agents.find((agent) => agent.id === input.id);
          if (existing) Object.assign(existing, input);
          else {
            const id = `agent-${state.agents.length + 1}`;
            state.agents.push({
              id,
              name: input.name,
              directory: input.directory,
            });
            state.enabledSkills[id] = [];
          }
          return snapshot();
        },
        deleteAgent: async (id) => {
          state.agents = state.agents.filter((agent) => agent.id !== id);
          delete state.enabledSkills[id];
          return snapshot();
        },
        setAgentSkills: async (id, skillIds) => {
          state.enabledSkills[id] = clone(skillIds);
          const result = snapshot();
          delete result.emptyRepository;
          result.agentIssues = { [id]: [] };
          return result;
        },
        recordPendingSkillSync: (id, skillIds, token) => {
          pendingSkillSync[id] = {
            agentId: id,
            skillIds: clone(skillIds),
            token,
            updatedAt: Date.now(),
          };
          return { ok: true };
        },
        readPendingSkillSync: () => ({
          ok: true,
          records: clone(
            Object.values(pendingSkillSync).map((entry) => ({
              id: entry.agentId,
              skillIds: entry.skillIds,
              token: entry.token,
              updatedAt: new Date(entry.updatedAt).toISOString(),
            })),
          ),
          issue: null,
        }),
        clearPendingSkillSync: (id, token) => {
          if (!id) {
            Object.keys(pendingSkillSync).forEach(
              (agentId) => delete pendingSkillSync[agentId],
            );
          } else if (!token || pendingSkillSync[id]?.token === token) {
            delete pendingSkillSync[id];
          }
          return { ok: true };
        },
        setTheme: async (theme) => {
          state.theme = theme;
          return { theme, issues: [] };
        },
        clearData: async () => {
          Object.assign(state, clone(initialState));
          return snapshot();
        },
      };
    }, createStateSnapshot());
    await use(page);
  },
});

export { expect };
