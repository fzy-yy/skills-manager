/**
 * 当前设备的本地 JSON 存储。
 *
 * 插件已配置为单实例，因此只保留临时文件、原子替换和上一版本备份，
 * 不再维护跨窗口锁与 revision。
 */
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { errorMessage, withReadTimeout } = require("./runtime");

const STORAGE_VERSION = 1;

function isMissing(error) {
  return error?.code === "ENOENT";
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

  /** 主文件不可用时回退到上一版本备份。 */
  async function read() {
    try {
      return { data: await readFile(statePath), recovered: false };
    } catch (primaryError) {
      try {
        return { data: await readFile(backupPath), recovered: true };
      } catch (backupError) {
        if (isMissing(primaryError) && isMissing(backupError))
          return { data: null, recovered: false };
        throw new Error(
          `本地配置文件损坏：${errorMessage(primaryError)}；备份恢复失败：${errorMessage(backupError)}`,
        );
      }
    }
  }

  async function writeTemporary(data) {
    await fs.promises.mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `state.${randomUUID()}.tmp`);
    const handle = await fs.promises.open(temporaryPath, "wx");
    try {
      await handle.writeFile(`${JSON.stringify(data)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporaryPath;
  }

  /** 原子提交配置，并保留一个可恢复的旧版本。 */
  async function commit(payload) {
    let temporaryPath;
    let rotatedPrimary = false;
    try {
      const current = await read();
      temporaryPath = await writeTemporary({
        ...payload,
        storageVersion: STORAGE_VERSION,
      });

      if (current.recovered) {
        await fs.promises.unlink(statePath).catch((error) => {
          if (!isMissing(error)) throw error;
        });
      } else {
        await fs.promises.unlink(backupPath).catch((error) => {
          if (!isMissing(error)) throw error;
        });
        await fs.promises.rename(statePath, backupPath).then(
          () => {
            rotatedPrimary = true;
          },
          (error) => {
            if (!isMissing(error)) throw error;
          },
        );
      }

      try {
        await fs.promises.rename(temporaryPath, statePath);
        temporaryPath = undefined;
      } catch (error) {
        if (rotatedPrimary)
          await fs.promises.rename(backupPath, statePath).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      throw new Error(`写入本地配置失败：${errorMessage(error)}`);
    } finally {
      if (temporaryPath)
        await fs.promises.unlink(temporaryPath).catch(() => undefined);
    }
  }

  async function clear() {
    try {
      await Promise.all(
        [statePath, backupPath].map((filePath) =>
          fs.promises.unlink(filePath).catch((error) => {
            if (!isMissing(error)) throw error;
          }),
        ),
      );
    } catch (error) {
      throw new Error(`清除本地配置失败：${errorMessage(error)}`);
    }
  }

  return { clear, commit, directory, read, statePath };
}

module.exports = { createLocalStorage };
