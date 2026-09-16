import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createSkillsManagerApi,
} = require("../../public/preload/service-api.js");

function createConfig() {
  return {
    repositoryPath: "C:\\repo",
    groups: [],
    agents: [
      { id: "agent", name: "Codex", directory: "C:\\agent", managedLinks: {} },
    ],
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
    assertConfigWritable: vi.fn(),
    isSafeRecordKey: (value) =>
      !["__proto__", "constructor", "prototype"].includes(value),
    normalizeCachedSkills: (value) => value,
    normalizeManagedLinks: (value) => value,
    readConfig: vi.fn(async () => config),
    writeConfig: vi.fn(async () => undefined),
    writeTheme: vi.fn(async () => undefined),
    clearStoredConfig: vi.fn(async () => undefined),
  };
  const state = { ...config, skills: config._cachedSkills, issues: [] };
  const stateService = {
    bindAgentDirectoryState: vi.fn(async () => state),
    clearDataState: vi.fn(async () => state),
    clearUnreadableDataState: vi.fn(async () => state),
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
    pathsEqualLexical: vi.fn((left, right) => left === right),
    assertNotDiskRoot: vi.fn(),
  };
  const pendingSkillSync = {
    record: vi.fn(() => ({ ok: true, issue: null })),
    read: vi.fn(() => ({ ok: true, records: [], issue: null })),
    clear: vi.fn(() => ({ ok: true, issue: null })),
    clearAll: vi.fn(() => ({ ok: true, issue: null })),
  };
  return {
    api: createSkillsManagerApi({
      configStore,
      pathSafety,
      pendingSkillSync,
      stateService,
      utools: { showOpenDialog: vi.fn(() => ["C:\\picked"]) },
    }),
    config,
    configStore,
    pathSafety,
    pendingSkillSync,
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

  it("首次绑定目录会同步已有选择，离线目录原样提交时只改名", async () => {
    const unbound = createConfig();
    unbound.agents[0].directory = "";
    unbound.enabledSkills.agent = ["alpha"];
    const first = createHarness(unbound);
    await first.api.upsertAgent({
      id: "agent",
      name: "Codex",
      directory: "C:\\agent",
    });
    expect(first.stateService.bindAgentDirectoryState).toHaveBeenCalledWith(
      unbound,
      unbound.agents[0],
    );
    expect(first.stateService.syncMovedAgentState).not.toHaveBeenCalled();

    const offline = createHarness();
    offline.pathSafety.normalizeDirectory.mockRejectedValue(
      new Error("目录离线"),
    );
    await expect(
      offline.api.upsertAgent({
        id: "agent",
        name: "Codex New",
        directory: "C:\\agent",
      }),
    ).resolves.toBeDefined();
    expect(offline.config.agents[0].name).toBe("Codex New");
    expect(offline.pathSafety.normalizeDirectory).not.toHaveBeenCalled();
  });

  it("配置无法读取时清除数据仍可恢复且不吞清理错误", async () => {
    const unreadable = createHarness();
    unreadable.configStore.readConfig.mockRejectedValue(
      Object.assign(new Error("读取失败"), { code: "ECONFIGREAD" }),
    );
    await expect(unreadable.api.clearData()).resolves.toBeDefined();
    expect(
      unreadable.stateService.clearUnreadableDataState,
    ).toHaveBeenCalledTimes(1);
    expect(unreadable.pendingSkillSync.clearAll).toHaveBeenCalledTimes(1);

    const cleanupFailure = createHarness();
    cleanupFailure.stateService.clearDataState.mockRejectedValue(
      new Error("清理链接失败"),
    );
    await expect(cleanupFailure.api.clearData()).rejects.toThrow(
      "清理链接失败",
    );
    expect(cleanupFailure.pendingSkillSync.clearAll).not.toHaveBeenCalled();
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

  it("操作超时只结束等待，不会让后续操作被永久拒绝", async () => {
    vi.useFakeTimers();
    const { api, configStore } = createHarness();
    let releaseFirst;
    configStore.writeConfig.mockImplementationOnce(
      () => new Promise((resolve) => (releaseFirst = resolve)),
    );
    const timedOut = api.saveGroups([{ id: "one", name: "One", skillIds: [] }]);
    const timeoutAssertion = expect(timedOut).rejects.toThrow("已停止等待");
    await vi.advanceTimersByTimeAsync(60_000);
    await timeoutAssertion;

    // 队列跟随的是底层操作：第一次写入仍未结束时，第二次不会提前开始
    const second = api.saveGroups([{ id: "two", name: "Two", skillIds: [] }]);
    let secondSettled = false;
    void second.then(() => (secondSettled = true));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(secondSettled).toBe(false);

    // 第一次真正结束后，第二次照常执行（旧实现在这里会永久拒绝所有写操作）
    releaseFirst();
    await expect(second).resolves.toBeDefined();
    expect(configStore.writeConfig).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
