import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createSkillsManagerApi } = require("../../public/preload/service-api.js");

function createConfig() {
  return {
    repositoryPath: "C:\\repo",
    groups: [],
    agents: [{ id: "agent", name: "Codex", directory: "C:\\agent", managedLinks: {} }],
    enabledSkills: { agent: [] },
    _cachedSkills: [
      {
        id: "alpha",
        name: "Alpha",
        relativePath: "alpha",
        folderName: "alpha",
        sourcePath: "C:\\repo\\alpha",
      },
    ],
    _orphanAgents: [],
    _issues: [],
  };
}

function createHarness(config = createConfig()) {
  const configStore = {
    MAX_ENTITY_NAME_LENGTH: 120,
    isSafeRecordKey: (value) => !["__proto__", "constructor", "prototype"].includes(value),
    normalizeCachedSkills: (value) => value,
    normalizeManagedLinks: (value) => value,
    readConfig: vi.fn(async () => config),
    writeConfig: vi.fn(async () => undefined),
    writeTheme: vi.fn(async () => undefined),
  };
  const state = { ...config, skills: config._cachedSkills, issues: [] };
  const stateService = {
    assertConfigWritable: vi.fn(),
    clearDataState: vi.fn(async () => ({})),
    deleteAgentState: vi.fn(async () => state),
    getCachedState: vi.fn(() => state),
    refreshState: vi.fn(async () => state),
    syncAgentSkillsState: vi.fn(async () => state),
    syncMovedAgentState: vi.fn(async () => state),
  };
  const pathSafety = {
    assertSafeAgentDirectory: vi.fn(async () => undefined),
    isInsideDirectory: vi.fn(async () => false),
    normalizeDirectory: vi.fn(async (value) => value),
    pathsEqual: vi.fn(async (left, right) => left === right),
  };
  return {
    api: createSkillsManagerApi({
      configStore,
      pathSafety,
      stateService,
      utools: { showOpenDialog: vi.fn(() => ["C:\\picked"]) },
    }),
    config,
    configStore,
    stateService,
  };
}

describe("preload 服务 API", () => {
  it("规范化分组并去重 Skill id 后保存", async () => {
    const { api, config, configStore } = createHarness();
    await api.saveGroups([
      { id: "group-1", name: " 前端 ", skillIds: ["alpha", "alpha", ""] },
    ]);
    expect(config.groups).toEqual([
      { id: "group-1", name: "前端", skillIds: ["alpha"] },
    ]);
    expect(configStore.writeConfig).toHaveBeenCalledWith(config);
  });

  it("拒绝重复分组标识与危险标识", async () => {
    const { api } = createHarness();
    await expect(
      api.saveGroups([
        { id: "same", name: "A", skillIds: [] },
        { id: "same", name: "B", skillIds: [] },
      ]),
    ).rejects.toThrow("分组标识重复");
    await expect(
      api.saveGroups([{ id: "__proto__", name: "A", skillIds: [] }]),
    ).rejects.toThrow("分组数据不完整");
  });

  it("过滤不存在的 Skill 并只同步目标 Agent", async () => {
    const { api, config, stateService } = createHarness();
    await api.setAgentSkills("agent", ["alpha", "missing", "alpha"]);
    expect(config.enabledSkills.agent).toEqual(["alpha"]);
    expect(stateService.syncAgentSkillsState).toHaveBeenCalledWith(
      config,
      config.agents[0],
      [],
    );
  });

  it("写操作按调用顺序串行执行", async () => {
    const { api, configStore } = createHarness();
    let release;
    const firstWrite = new Promise((resolve) => (release = resolve));
    configStore.writeConfig
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValueOnce(undefined);
    const first = api.saveGroups([{ id: "one", name: "One", skillIds: [] }]);
    const second = api.saveGroups([{ id: "two", name: "Two", skillIds: [] }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(configStore.writeConfig).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(configStore.writeConfig).toHaveBeenCalledTimes(2);
  });
});
