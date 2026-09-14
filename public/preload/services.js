/**
 * uTools preload 入口：装配配置、扫描、链接和业务 API。
 *
 * 安全原则：只删除能通过路径、目标和文件标识共同确认归属的链接。
 */
const configStore = require("./config-store");
const pathSafety = require("./path-safety");
const { createScanner } = require("./scanner");
const { createLinkManager } = require("./link-manager");
const { createStateService } = require("./state-service");
const { createSkillsManagerApi } = require("./service-api");

const scanner = createScanner({
  normalizeCachedSkills: configStore.normalizeCachedSkills,
});
const linkManager = createLinkManager({
  normalizeManagedLinks: configStore.normalizeManagedLinks,
  writeConfig: configStore.writeConfig,
});
const stateService = createStateService({ scanner, linkManager });

window.skillsManager = createSkillsManagerApi({
  configStore,
  pathSafety,
  stateService,
  utools: window.utools,
});
