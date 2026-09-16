/**
 * 配置读写门面。
 *
 * 分层约定（调用方只需要这一个入口，不必了解内部划分）：
 *  - config-schema.js：结构定义与纯函数（默认值、规范化、落盘结构组装）；
 *  - config-parser.js：把磁盘数据校验成可信配置，并收集可展示的问题；
 *  - 本文件：本地存储的原子写入、revision 并发校验与只读保护。
 */
const { createLocalStorage } = require("./local-storage");
const { errorMessage } = require("./runtime");
const {
  MAX_ENTITY_NAME_LENGTH,
  attachRuntime,
  buildStoredState,
  createDefaultConfig,
  isSafeRecordKey,
  normalizeCachedSkills,
  normalizeManagedLinks,
} = require("./config-schema");
const { parseStoredState } = require("./config-parser");

let cachedStorage;
function storage() {
  if (!cachedStorage) cachedStorage = createLocalStorage(window.utools);
  return cachedStorage;
}

/**
 * 写操作前的守卫：配置处于只读保护时，禁止任何会改动配置文件或链接的操作。
 *
 * @param {object} config - 当前配置
 * @throws {Error} 配置处于只读保护时抛出
 */
function assertConfigWritable(config) {
  if (config._syncLocked)
    throw new Error(
      "本地配置文件关键数据异常，当前处于只读保护。请先在设置页清除数据，再重新配置。",
    );
}

/** 写入时携带读取到的 revision，若磁盘已被其他窗口改动则本次写入失败而不覆盖。 */
async function writeConfig(config) {
  try {
    const { revision } = await storage().commit(
      buildStoredState(config),
      config._revision || "",
    );
    config._revision = revision;
  } catch (error) {
    throw new Error(`保存本地配置失败：${errorMessage(error)}`);
  }
}

/** 主题也是配置的一部分，因此与配置写入共用同一套只读保护与并发校验。 */
async function writeTheme(config) {
  assertConfigWritable(config);
  await writeConfig(config);
}

async function readConfig() {
  try {
    const result = await storage().read();
    if (!result.data)
      return attachRuntime(createDefaultConfig(), {
        _issues: [],
        _syncLocked: false,
        _orphanAgents: [],
        _cachedSkills: [],
        _revision: "",
      });
    return parseStoredState(result.data, result);
  } catch (error) {
    const wrapped = new Error(`读取本地配置失败：${errorMessage(error)}`);
    wrapped.code = "ECONFIGREAD";
    wrapped.cause = error;
    throw wrapped;
  }
}

async function clearStoredConfig() {
  try {
    await storage().clear();
  } catch (error) {
    throw new Error(`清除本地配置失败：${errorMessage(error)}`);
  }
}

module.exports = {
  MAX_ENTITY_NAME_LENGTH,
  assertConfigWritable,
  attachRuntime,
  clearStoredConfig,
  createDefaultConfig,
  isSafeRecordKey,
  normalizeCachedSkills,
  normalizeManagedLinks,
  readConfig,
  writeConfig,
  writeTheme,
};
