/**
 * uTools preload 入口：装配配置、扫描、链接和业务 API。
 *
 * 安全原则：只删除能同时证明「这条链接由本应用创建」与「它现在仍是同一条链接」的路径——
 * 前者靠受管记录（文件标识，或创建链接前写入的 pending 检查点），
 * 后者靠"仍在 Agent 目录第一层 + 仍是符号链接 + 目标未变"。
 */
const configStore = require("./config-store");
const pathSafety = require("./path-safety");
const { createScanner } = require("./scanner");
const { createLinkManager } = require("./link-manager");
const { createStateService } = require("./state-service");
const { createSkillsManagerApi } = require("./service-api");
const { createPendingSkillSync } = require("./pending-skill-sync");

const scanner = createScanner({
  normalizeCachedSkills: configStore.normalizeCachedSkills,
});
const linkManager = createLinkManager({
  normalizeManagedLinks: configStore.normalizeManagedLinks,
  writeConfig: configStore.writeConfig,
});
const stateService = createStateService({ scanner, linkManager });
const pendingSkillSync = createPendingSkillSync(window.utools);

const skillsManager = createSkillsManagerApi({
  configStore,
  pathSafety,
  pendingSkillSync,
  stateService,
  utools: window.utools,
});
Object.freeze(skillsManager);
Object.defineProperty(window, "skillsManager", {
  value: skillsManager,
  writable: false,
  configurable: false,
});
