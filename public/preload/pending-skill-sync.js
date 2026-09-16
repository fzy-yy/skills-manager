/**
 * Agent「待生效 Skills」意图的跨窗口暂存。
 *
 * 渲染层对 Agent 的应用配置开关是「乐观更新 + 防抖提交」，因此从用户点选到真正
 * 写入磁盘链接之间存在一个窗口期。若此时 uTools 插件被隐藏或结束，尚未提交的选择
 * 就会丢失。本模块把这个窗口期内的意图落盘，供下次进入插件时识别并续跑。
 *
 * 设计约定（改动前请先读完）：
 *  1. 文件位于 uTools userData/skills-manager/pending-skill-sync.json，与本地配置
 *     同目录，便于随配置一起清理；
 *  2. 只保存 id/skillIds/token/updatedAt 四个字段，其余内容一律丢弃，避免把渲染层
 *     的临时状态无意持久化；
 *  3. 采用「同步写临时文件 → fsync → rename」的原子替换，避免主文件出现半截内容；
 *     任一步失败都清理本轮临时文件（open 因 EEXIST 失败时说明文件不是本轮创建的，
 *     绝不误删）；
 *  4. 所有对外方法都不抛异常：失败或文件损坏时返回带 issue/error 的结果，让调用方
 *     能诊断并决定是重试还是提示用户，而不是让 preload 直接崩溃；
 *  5. token 用于区分「同一 Agent 的同一轮意图」：clear 只在 token 一致时执行，
 *     防止旧窗口把新窗口刚写入的意图误清。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const FILE_NAME = "pending-skill-sync.json";
const LOCK_FILE_NAME = `${FILE_NAME}.lock`;
const STORAGE_VERSION = 1;
const LOCK_RETRY_COUNT = 20;
const LOCK_RETRY_MS = 5;
const STALE_LOCK_MS = 30_000;
/** 单文件 64 KiB 上限：pending 意图是短生命周期数据，超过说明调用方出了问题。 */
const MAX_BYTES = 64 * 1024;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function errorMessage(error) {
  if (!error) return "未知错误";
  const code = error.code ? `${error.code}：` : "";
  return `${code}${error.message || String(error)}`;
}

function createIssue(type, message) {
  return { type, message };
}

/** 统一的失败结果：既给出可展示的 issue，也保留原始 error 便于日志。 */
function failure(message, error) {
  return {
    ok: false,
    issue: createIssue("error", message),
    error: error instanceof Error ? error : new Error(String(error ?? message)),
  };
}

function normalizeAgentId(agentId) {
  return typeof agentId === "string" ? agentId.trim() : "";
}

/** 去重、转字符串并排序，保证同一组选择在任何窗口下都得到相同表示。 */
function normalizeSkillIds(skillIds) {
  if (!Array.isArray(skillIds)) return [];
  return [
    ...new Set(skillIds.map((id) => String(id)).filter((id) => id.length > 0)),
  ].sort();
}

function normalizeToken(token) {
  if (typeof token === "string" && token.length > 0) return token;
  if (token === undefined || token === null) return randomUUID();
  return String(token);
}

function normalizeUpdatedAt(updatedAt) {
  if (typeof updatedAt === "string" && updatedAt.length > 0) return updatedAt;
  return new Date().toISOString();
}

function sortRecords(records) {
  return [...records].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function createPendingSkillSync(utools, folderName = "skills-manager") {
  const userDataPath = utools?.getPath?.("userData");
  if (!userDataPath)
    throw new Error("无法获取 uTools 用户数据目录，请在 uTools 中重新打开插件");

  const directory = path.join(userDataPath, folderName);
  const filePath = path.join(directory, FILE_NAME);
  const lockPath = path.join(directory, LOCK_FILE_NAME);

  function waitForLock() {
    Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_MS);
  }

  function acquireLock() {
    fs.mkdirSync(directory, { recursive: true });
    for (let attempt = 0; attempt <= LOCK_RETRY_COUNT; attempt += 1) {
      try {
        return fs.openSync(lockPath, "wx");
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > STALE_LOCK_MS) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch (inspectionError) {
          if (inspectionError?.code === "ENOENT") continue;
          throw inspectionError;
        }
        if (attempt === LOCK_RETRY_COUNT) {
          const busy = new Error(
            "另一个插件窗口正在更新待同步意图，请稍后重试",
          );
          busy.code = "EBUSY";
          throw busy;
        }
        waitForLock();
      }
    }
  }

  function withLock(operation) {
    const handle = acquireLock();
    try {
      return operation();
    } finally {
      try {
        fs.closeSync(handle);
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch (_) {
          // 锁文件会在超过 STALE_LOCK_MS 后由下一次操作回收
        }
      }
    }
  }

  function serialize(records) {
    return `${JSON.stringify({ version: STORAGE_VERSION, records })}\n`;
  }

  /**
   * 读取并规范化磁盘上的意图。
   *
   * @returns {{records: Array, exists: boolean, issue: object|null, error: Error|null}}
   *          不抛出；文件缺失视为正常空状态，损坏或超限写入 issue
   */
  function loadRawState() {
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT")
        return { records: [], exists: false, issue: null, error: null };
      return {
        records: [],
        exists: false,
        issue: createIssue(
          "error",
          `读取待同步意图 ${filePath} 失败：${errorMessage(error)}`,
        ),
        error,
      };
    }

    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      const error = new Error(
        `待同步意图文件超过 ${MAX_BYTES} 字节上限，已忽略其内容`,
      );
      return {
        records: [],
        exists: true,
        issue: createIssue("error", error.message),
        error,
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        records: [],
        exists: true,
        issue: createIssue(
          "error",
          `待同步意图文件损坏：${errorMessage(error)}`,
        ),
        error,
      };
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Array.isArray(parsed.records)
    ) {
      const error = new Error("待同步意图文件内容不是有效对象");
      return {
        records: [],
        exists: true,
        issue: createIssue("error", error.message),
        error,
      };
    }

    const records = [];
    for (const entry of parsed.records) {
      if (!entry || typeof entry !== "object") continue;
      const id = normalizeAgentId(entry.id);
      if (!id) continue;
      records.push({
        id,
        skillIds: normalizeSkillIds(entry.skillIds),
        token: typeof entry.token === "string" ? entry.token : "",
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
      });
    }
    return {
      records: sortRecords(records),
      exists: true,
      issue: null,
      error: null,
    };
  }

  function removeFile() {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  /**
   * 同步原子替换：写临时文件 → fsync → rename。
   *
   * open 失败（含 EEXIST）时本轮没有创建任何文件，直接抛出且不做清理；
   * open 成功后任何一步失败，都关闭句柄并删除本轮临时文件，避免残留。
   */
  function writeAtomically(text) {
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    let handle;
    let opened = false;
    try {
      handle = fs.openSync(temporaryPath, "wx");
      opened = true;
      fs.writeFileSync(handle, text, "utf8");
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = undefined;
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (opened) {
        if (handle !== undefined) {
          try {
            fs.closeSync(handle);
          } catch (_) {
            // 句柄关闭失败不掩盖原始错误
          }
        }
        try {
          fs.unlinkSync(temporaryPath);
        } catch (_) {
          // 临时文件已不存在或无法删除时保持原始错误
        }
      }
      throw error;
    }
  }

  function writeRecords(records) {
    const text = serialize(sortRecords(records));
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      throw new Error(`待同步意图超出 ${MAX_BYTES} 字节上限，未写入`);
    }
    writeAtomically(text);
  }

  /** 记录/覆盖一个 Agent 的待生效选择，同时补齐 token 与 updatedAt。 */
  function record(agentId, skillIds, token, updatedAt) {
    const id = normalizeAgentId(agentId);
    if (!id) return failure("agentId 必须是非空字符串");

    try {
      return withLock(() => {
        const loaded = loadRawState();
        if (loaded.issue) {
          // 文件损坏时保持只读：宁可拒绝本次记录，也不覆盖可能可恢复的数据
          return { ok: false, issue: loaded.issue, error: loaded.error };
        }

        const next = {
          id,
          skillIds: normalizeSkillIds(skillIds),
          token: normalizeToken(token),
          updatedAt: normalizeUpdatedAt(updatedAt),
        };
        const records = [
          ...loaded.records.filter((entry) => entry.id !== id),
          next,
        ];
        writeRecords(records);
        return { ok: true, record: next, issue: null, error: null };
      });
    } catch (error) {
      return failure(`保存待同步意图失败：${errorMessage(error)}`, error);
    }
  }

  /** 读取全部意图；损坏或超限时返回 ok:false 与可诊断的 issue。 */
  function read() {
    const loaded = loadRawState();
    if (loaded.issue)
      return {
        ok: false,
        records: [],
        exists: loaded.exists,
        issue: loaded.issue,
        error: loaded.error,
      };
    return {
      ok: true,
      records: loaded.records,
      exists: loaded.exists,
      issue: null,
      error: null,
    };
  }

  /**
   * 清除指定 Agent 的意图。
   *
   * @param {string} agentId
   * @param {string} [token] 传入时要求与磁盘上的 token 一致，否则拒绝清除，
   *                         避免旧窗口清掉新窗口刚写入的意图
   * @returns {{ok: boolean, cleared: boolean, issue: object|null, error: Error|null}}
   */
  function clear(agentId, token) {
    const id = normalizeAgentId(agentId);
    if (!id) return failure("agentId 必须是非空字符串");

    try {
      return withLock(() => {
        const loaded = loadRawState();
        if (loaded.issue)
          return {
            ok: false,
            cleared: false,
            issue: loaded.issue,
            error: loaded.error,
          };

        const target = loaded.records.find((entry) => entry.id === id);
        if (!target)
          return { ok: true, cleared: false, issue: null, error: null };

        if (token !== undefined && target.token !== String(token)) {
          return {
            ok: false,
            cleared: false,
            code: "ETOKENMISMATCH",
            issue: createIssue(
              "warning",
              `待同步意图已被更新（token 不匹配），拒绝清除 ${id}`,
            ),
            error: null,
          };
        }

        const records = loaded.records.filter((entry) => entry.id !== id);
        if (records.length === 0) removeFile();
        else writeRecords(records);
        return { ok: true, cleared: true, issue: null, error: null };
      });
    } catch (error) {
      return failure(`清除待同步意图失败：${errorMessage(error)}`, error);
    }
  }

  /** 清空全部意图（用于配置清除/重置等场景），缺失文件视为成功。 */
  function clearAll() {
    try {
      return withLock(() => {
        const existed = fs.existsSync(filePath);
        removeFile();
        return { ok: true, cleared: existed, issue: null, error: null };
      });
    } catch (error) {
      return failure(`清空待同步意图失败：${errorMessage(error)}`, error);
    }
  }

  return { clear, clearAll, directory, filePath, read, record };
}

module.exports = { createPendingSkillSync, FILE_NAME, MAX_BYTES };
