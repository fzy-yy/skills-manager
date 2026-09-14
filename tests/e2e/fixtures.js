import { test as base, expect } from "@playwright/test";

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
    await page.addInitScript(() => {
      const clone = (value) => JSON.parse(JSON.stringify(value));
      const state = {
        repositoryPath: "",
        skills: [],
        groups: [],
        agents: [],
        enabledSkills: {},
        theme: "light",
        issues: [],
      };
      const snapshot = () => clone(state);
      window.utools = { onPluginEnter: () => undefined };
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
        refreshSkills: async () => snapshot(),
        saveGroups: async (groups) => {
          state.groups = clone(groups);
          return snapshot();
        },
        upsertAgent: async (input) => {
          const existing = state.agents.find((agent) => agent.id === input.id);
          if (existing) Object.assign(existing, input);
          else {
            const id = `agent-${state.agents.length + 1}`;
            state.agents.push({ id, name: input.name, directory: input.directory });
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
          return snapshot();
        },
        setTheme: async (theme) => {
          state.theme = theme;
          return { theme, issues: [] };
        },
        clearData: async () => {
          Object.assign(state, {
            repositoryPath: "",
            skills: [],
            groups: [],
            agents: [],
            enabledSkills: {},
            theme: "light",
            issues: [],
          });
          return snapshot();
        },
      };
    });
    await use(page);
  },
});

export { expect };
