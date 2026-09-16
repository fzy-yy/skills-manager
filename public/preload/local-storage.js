/**
 * 当前设备的本地 JSON 存储。
 *
 * 一致性策略（不依赖"插件一定单实例"这一前提，因为 uTools 允许分离窗口后再次创建）：
 *  1. 主文件永远通过"写临时文件 → 原子替换"更新，任何时刻磁盘上都存在完整的主文件，
 *     不会出现"主文件被移走、新文件还没到位"的空窗期；
 *  2. 每次写入都生成新的 revision，写入前比对调用方读取到的 revision；
 *     不一致说明另一个窗口已经改过配置，本次写入直接失败而不是覆盖对方内容。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { errorMessage, withReadTimeout } = require("./runtime");

const STORAGE_VERSION = 1;

function isMissing(error) {
  return error?.code === "ENOENT";
}

function revisionOf(data) {
  return typeof data?.revision === "string" ? data.revision : "";
}

function createLocalStorage(utools, folderName = "skills-manager") {
  const userDataPath = utools?.getPath?.("userData");
  if (!userDataPath)
    throw new Error("无法获取 uTools 用户数据目录，请在 uTools 中重新打开插件");

  const directory = path.join(userDataPath, folderName);
  const statePath = path.join(directory, "state.json");
  const backupPath = path.join(directory, "state.backup.json");

  async function readFile(filePath) {
    const content = await withReadTimeout(
      fs.promises.readFile(filePath, "utf8"),
      `读取本地配置 ${filePath}`,
    );
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("配置文件内容不是有效对象");
    return parsed;
  }

  /**
   * 读取配置，主文件不可用时回退到上一版本备份。
   *
   * @returns {Promise<{data: object|null, recovered: boolean, revision: string}>}
   *          revision 用于写入前比对，判断配置是否已被其他窗口修改
   */
  async function read() {
    try {
      const data = await readFile(statePath);
      return { data, recovered: false, revision: revisionOf(data) };
    } catch (primaryError) {
      try {
        const data = await readFile(backupPath);
        return { data, recovered: true, revision: revisionOf(data) };
      } catch (backupError) {
        if (isMissing(primaryError) && isMissing(backupError))
          return { data: null, recovered: false, revision: "" };
        throw new Error(
          `本地配置文件损坏：${errorMessage(primaryError)}；备份恢复失败：${errorMessage(backupError)}`,
        );
      }
    }
  }

  /**
   * 写入临时文件并返回其路径。
   *
   * 清理边界：只有 open 成功（说明文件是本轮创建的）之后才可能清理；
   * open 因 EEXIST 失败时文件属于其他人，绝不能删除。
   * write/sync/close 任一步失败都会删除本轮临时文件再抛出，避免临时文件堆积。
   */
  async function writeTemporary(data, fileName) {
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, fileName);
    const handle = await fs.promises.open(temporaryPath, "wx");
    let failure;
    try {
      await handle.writeFile(`${JSON.stringify(data)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (error) {
      if (!failure) failure = error;
    }
    if (failure) {
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
      throw failure;
    }
    return temporaryPath;
  }

  /** 先写临时文件再原子替换目标文件，失败时清理临时文件。 */
  async function writeFileAtomically(targetPath, data, temporaryName) {
    const temporaryPath = await writeTemporary(data, temporaryName);
    try {
      await fs.promises.rename(temporaryPath, targetPath);
    } catch (error) {
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  /**
   * 原子提交配置，并保留一个可恢复的旧版本。
   *
   * 顺序固定为"先刷新备份，再替换主文件"：主文件在任何时刻都是完整的，
   * 备份也只是被覆盖而不是被移走，因此不会出现两份文件同时不可用的情况。
   *
   * @param {object} payload - 待写入的业务数据
   * @param {string} [expectedRevision] - 调用方读取到的 revision；与磁盘不一致时拒绝写入
   * @returns {Promise<{revision: string}>} 本次写入产生的新 revision
   */
  async function commit(payload, expectedRevision) {
    const current = await read();
    if (
      expectedRevision !== undefined &&
      expectedRevision !== current.revision
    ) {
      const error = new Error(
        "本地配置已被其他窗口修改。为避免覆盖对方的改动，本次保存已取消，请关闭多余的插件窗口后重试",
      );
      error.code = "ECONFLICT";
      throw error;
    }
    const revision = randomUUID();
    if (current.data)
      await writeFileAtomically(
        backupPath,
        current.data,
        `state.backup.${randomUUID()}.tmp`,
      );
    await writeFileAtomically(
      statePath,
      { ...payload, storageVersion: STORAGE_VERSION, revision },
      `state.${randomUUID()}.tmp`,
    );
    return { revision };
  }

  async function clear() {
    await Promise.all(
      [statePath, backupPath].map((filePath) =>
        fs.promises.unlink(filePath).catch((error) => {
          if (!isMissing(error)) throw error;
        }),
      ),
    );
  }

  return { clear, commit, directory, read, statePath };
}

module.exports = { createLocalStorage };
