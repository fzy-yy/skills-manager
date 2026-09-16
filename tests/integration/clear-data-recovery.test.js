import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const configStore = require("../../public/preload/config-store.js");
const pathSafety = require("../../public/preload/path-safety.js");
const { createScanner } = require("../../public/preload/scanner.js");
const { createLinkManager } = require("../../public/preload/link-manager.js");
const { createStateService } = require("../../public/preload/state-service.js");
const {
  createSkillsManagerApi,
} = require("../../public/preload/service-api.js");
const {
  createPendingSkillSync,
} = require("../../public/preload/pending-skill-sync.js");

const workspaces = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

describe("配置损坏恢复", () => {
  it("主配置和备份均损坏时仍可清除并恢复默认状态", async () => {
    const workspace = await createTempDirectory("skills-clear-recovery-");
    workspaces.push(workspace);
    globalThis.window = {
      utools: {
        getPath: () => workspace.directory,
        showOpenDialog: () => [],
      },
    };
    const scanner = createScanner({
      normalizeCachedSkills: configStore.normalizeCachedSkills,
    });
    const linkManager = createLinkManager({
      normalizeManagedLinks: configStore.normalizeManagedLinks,
      writeConfig: configStore.writeConfig,
    });
    const stateService = createStateService({ scanner, linkManager });
    const pendingSkillSync = createPendingSkillSync(window.utools);
    const api = createSkillsManagerApi({
      configStore,
      pathSafety,
      pendingSkillSync,
      stateService,
      utools: window.utools,
    });

    await configStore.writeConfig(
      configStore.attachRuntime(configStore.createDefaultConfig(), {
        _issues: [],
        _syncLocked: false,
        _orphanAgents: [],
        _cachedSkills: [],
        _revision: "",
      }),
    );
    const storageDirectory = path.join(workspace.directory, "skills-manager");
    await fs.writeFile(
      path.join(storageDirectory, "state.json"),
      "broken",
      "utf8",
    );
    await fs.writeFile(
      path.join(storageDirectory, "state.backup.json"),
      "also-broken",
      "utf8",
    );
    pendingSkillSync.record("agent", ["alpha"], "token");

    await expect(api.getState()).rejects.toMatchObject({ code: "ECONFIGREAD" });
    const cleared = await api.clearData();
    expect(cleared).toMatchObject({
      repositoryPath: "",
      skills: [],
      groups: [],
      agents: [],
      enabledSkills: {},
      emptyRepository: false,
    });
    expect(cleared.issues[0].message).toContain(
      "未删除任何 Agent 目录中的内容",
    );
    await expect(api.getState()).resolves.toMatchObject({
      repositoryPath: "",
      agents: [],
      enabledSkills: {},
    });
    expect(pendingSkillSync.read().records).toEqual([]);
  });
});
