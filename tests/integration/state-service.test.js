import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertStateContract } from "../helpers/state-fixture";
import { createSkill, createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const configStoreModule = require("../../public/preload/config-store.js");
const { createScanner } = require("../../public/preload/scanner.js");
const { createLinkManager } = require("../../public/preload/link-manager.js");
const { createStateService } = require("../../public/preload/state-service.js");

const workspaces = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

async function workspace(prefix = "skills-state-") {
  const item = await createTempDirectory(prefix);
  workspaces.push(item);
  return item;
}

function cachedSkill(sourcePath, id = "alpha", name = "Alpha") {
  return {
    id,
    name,
    relativePath: id,
    folderName: id,
    sourcePath,
  };
}

function baseConfig(overrides = {}) {
  return {
    version: 4,
    repositoryPath: "",
    groups: [],
    agents: [],
    enabledSkills: {},
    theme: "light",
    _issues: [],
    _syncLocked: false,
    _orphanAgents: [],
    _cachedSkills: [],
    _revision: "",
    ...overrides,
  };
}

/** 注入脱离 uTools 存储的 configStore，直接验证 state-service 编排逻辑。 */
function createHarness() {
  const writeConfig = vi.fn(async () => undefined);
  const clearStoredConfig = vi.fn(async () => undefined);
  const configStore = {
    attachRuntime: (config, context) => Object.assign(config, context),
    clearStoredConfig,
    createDefaultConfig: configStoreModule.createDefaultConfig,
    normalizeCachedSkills: configStoreModule.normalizeCachedSkills,
    normalizeManagedLinks: configStoreModule.normalizeManagedLinks,
    writeConfig,
  };
  const scanner = createScanner({
    normalizeCachedSkills: configStore.normalizeCachedSkills,
  });
  const linkManager = createLinkManager({
    normalizeManagedLinks: configStore.normalizeManagedLinks,
    writeConfig,
  });
  return {
    stateService: createStateService({ scanner, linkManager, configStore }),
    writeConfig,
    clearStoredConfig,
  };
}

async function createAgentLink(root, folderName, name = folderName) {
  const sourcePath = await createSkill(root, folderName, name);
  return sourcePath;
}

async function linkIdentity(linkPath) {
  const stat = await fs.lstat(linkPath);
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtimeMs: Number(stat.birthtimeMs),
  };
}

describe("state-service 编排", () => {
  it("emptyRepository 只在真实仓库扫描结果中出现，定向读取不覆盖", async () => {
    const root = await workspace();
    const { stateService } = createHarness();
    const config = baseConfig({
      repositoryPath: root.directory,
      _cachedSkills: [cachedSkill(root.resolve("alpha"))],
    });

    const cached = stateService.getCachedState(config);
    assertStateContract(cached);
    expect("emptyRepository" in cached).toBe(false);
    expect(cached.agentIssues).toBeUndefined();

    const blocked = await stateService.refreshState(config);
    assertStateContract(blocked);
    expect(blocked.emptyRepository).toBe(true);
    expect(blocked.skills).toHaveLength(1);

    const confirmed = await stateService.refreshState(config, {
      allowEmptyRepository: true,
    });
    expect(confirmed.emptyRepository).toBe(false);
    expect(confirmed.skills).toEqual([]);
    expect(confirmed.agentIssues).toEqual({});
  });

  it("定向同步把问题只归属到目标 Agent 的 agentIssues", async () => {
    const root = await workspace();
    const sourcePath = await createSkill(
      root.resolve("repo"),
      "alpha",
      "Alpha",
    );
    const agentDirectory = root.resolve("agent");
    await fs.mkdir(agentDirectory, { recursive: true });
    const { stateService } = createHarness();
    const agent = {
      id: "agent",
      name: "Codex",
      directory: agentDirectory,
      managedLinks: {},
    };
    const config = baseConfig({
      repositoryPath: root.resolve("repo"),
      agents: [agent],
      enabledSkills: { agent: ["alpha", "missing"] },
      _cachedSkills: [cachedSkill(sourcePath)],
      _issues: [{ type: "warning", message: "全局配置问题" }],
    });

    const state = await stateService.syncAgentSkillsState(config, agent, []);
    assertStateContract(state);
    expect(Object.keys(state.agentIssues)).toEqual(["agent"]);
    const agentMessages = state.agentIssues.agent
      .map((issue) => issue.message)
      .join(" ");
    expect(agentMessages).toContain("missing");
    expect(agentMessages).not.toContain("全局配置问题");
    expect(state.issues.some((issue) => issue.message === "全局配置问题")).toBe(
      true,
    );
    expect("emptyRepository" in state).toBe(false);
    expect(agent.managedLinks.alpha).toBeDefined();
    await expect(fs.realpath(agent.managedLinks.alpha.linkPath)).resolves.toBe(
      await fs.realpath(sourcePath),
    );
  });

  it("首次绑定目录会同步已启用 Skill 且不清理孤儿", async () => {
    const root = await workspace();
    const sourcePath = await createSkill(
      root.resolve("repo"),
      "alpha",
      "Alpha",
    );
    await createAgentLink(root.resolve("repo"), "beta", "Beta");
    const agentDirectory = root.resolve("agent");
    await fs.mkdir(agentDirectory, { recursive: true });
    const orphanDir = root.resolve("orphan-agent");
    await fs.mkdir(orphanDir, { recursive: true });
    const orphanSource = root.resolve("repo", "beta");
    const orphanLinkPath = path.join(orphanDir, "beta");
    await fs.symlink(
      orphanSource,
      orphanLinkPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const { stateService } = createHarness();
    const agent = {
      id: "agent",
      name: "Codex",
      directory: agentDirectory,
      managedLinks: {},
    };
    const config = baseConfig({
      repositoryPath: root.resolve("repo"),
      agents: [agent],
      enabledSkills: { agent: ["alpha"] },
      _cachedSkills: [cachedSkill(sourcePath)],
      _orphanAgents: [
        {
          id: "orphan",
          name: "Old",
          directory: orphanDir,
          managedLinks: {
            beta: {
              linkPath: orphanLinkPath,
              sourcePath: orphanSource,
              identity: await linkIdentity(orphanLinkPath),
            },
          },
        },
      ],
    });

    const state = await stateService.bindAgentDirectoryState(config, agent);
    assertStateContract(state);
    expect(Object.keys(state.agentIssues)).toEqual(["agent"]);
    expect(agent.managedLinks.alpha).toBeDefined();
    await expect(fs.realpath(agent.managedLinks.alpha.linkPath)).resolves.toBe(
      await fs.realpath(sourcePath),
    );
    // 孤儿链接必须原样保留，首次绑定不得触发孤儿清理
    expect((await fs.lstat(orphanLinkPath)).isSymbolicLink()).toBe(true);
    expect(config._orphanAgents).toHaveLength(1);
  });

  it("syncMovedAgentState 会清理孤儿链接", async () => {
    const root = await workspace();
    const sourcePath = await createSkill(
      root.resolve("repo"),
      "alpha",
      "Alpha",
    );
    await createAgentLink(root.resolve("repo"), "beta", "Beta");
    const agentDirectory = root.resolve("agent");
    await fs.mkdir(agentDirectory, { recursive: true });
    const orphanDir = root.resolve("orphan-agent");
    await fs.mkdir(orphanDir, { recursive: true });
    const orphanSource = root.resolve("repo", "beta");
    const orphanLinkPath = path.join(orphanDir, "beta");
    await fs.symlink(
      orphanSource,
      orphanLinkPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const { stateService } = createHarness();
    const agent = {
      id: "agent",
      name: "Codex",
      directory: agentDirectory,
      managedLinks: {},
    };
    const config = baseConfig({
      repositoryPath: root.resolve("repo"),
      agents: [agent],
      enabledSkills: { agent: ["alpha"] },
      _cachedSkills: [cachedSkill(sourcePath)],
      _orphanAgents: [
        {
          id: "orphan",
          name: "Old",
          directory: orphanDir,
          managedLinks: {
            beta: {
              linkPath: orphanLinkPath,
              sourcePath: orphanSource,
              identity: await linkIdentity(orphanLinkPath),
            },
          },
        },
      ],
    });

    await stateService.syncMovedAgentState(config, agent);
    await expect(fs.lstat(orphanLinkPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(config._orphanAgents).toHaveLength(0);
  });

  it("clearDataState 显式输出 emptyRepository:false 并清除存储", async () => {
    const { stateService, clearStoredConfig } = createHarness();
    const state = await stateService.clearDataState(baseConfig());
    assertStateContract(state);
    expect(state.emptyRepository).toBe(false);
    expect(state.repositoryPath).toBe("");
    expect(state.skills).toEqual([]);
    expect(clearStoredConfig).toHaveBeenCalledTimes(1);
  });

  it("clearUnreadableDataState 不依赖解析配置即可恢复", async () => {
    const { stateService, clearStoredConfig, writeConfig } = createHarness();
    const state = await stateService.clearUnreadableDataState();
    assertStateContract(state);
    expect(clearStoredConfig).toHaveBeenCalledTimes(1);
    expect(writeConfig).not.toHaveBeenCalled();
    expect(state.emptyRepository).toBe(false);
    expect(state.repositoryPath).toBe("");
    expect(
      state.issues.some((issue) => issue.message.includes("无法解析")),
    ).toBe(true);
  });
});
