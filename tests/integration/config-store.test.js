import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const {
  readConfig,
  writeConfig,
} = require("../../public/preload/config-store.js");
const workspaces = [];
let statePath;

/**
 * config-store 会缓存本地存储实例（同一进程内 userData 目录固定不变），
 * 因此整个文件共用一个临时 userData 目录，用例之间只清空配置文件。
 */
beforeAll(async () => {
  const workspace = await createTempDirectory("skills-config-");
  workspaces.push(workspace);
  globalThis.window = { utools: { getPath: () => workspace.directory } };
  statePath = path.join(workspace.directory, "skills-manager", "state.json");
});

beforeEach(async () => {
  await Promise.all(
    [statePath, path.join(path.dirname(statePath), "state.backup.json")].map(
      (filePath) => fs.unlink(filePath).catch(() => undefined),
    ),
  );
});

afterAll(async () => {
  delete globalThis.window;
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

describe("配置读写与并发校验", () => {
  it("首次读取返回默认配置，写入后记录 revision 并能继续保存", async () => {
    const config = await readConfig();
    expect(config).toMatchObject({ repositoryPath: "", theme: "light" });
    expect(config._revision).toBe("");

    config.repositoryPath = "C:\\repo";
    await writeConfig(config);
    expect(config._revision).toBeTruthy();

    const reloaded = await readConfig();
    expect(reloaded.repositoryPath).toBe("C:\\repo");
    expect(reloaded._revision).toBe(config._revision);

    reloaded.theme = "dark";
    await writeConfig(reloaded);
    expect(reloaded._revision).not.toBe(config._revision);
  });

  it("其他窗口改过配置后，本次写入被拒绝而不是覆盖对方", async () => {
    const mine = await readConfig();
    mine.repositoryPath = "C:\\mine";
    await writeConfig(mine);

    // 模拟另一个插件窗口基于同一份快照写入
    const other = await readConfig();
    other.repositoryPath = "C:\\other";
    await writeConfig(other);

    // mine 的 revision 已经过期，再次保存必须失败
    mine.theme = "dark";
    await expect(writeConfig(mine)).rejects.toThrow("已被其他窗口修改");

    await expect(readConfig()).resolves.toMatchObject({
      repositoryPath: "C:\\other",
    });
  });

  it("主文件损坏时从备份恢复并给出提示", async () => {
    const first = await readConfig();
    first.repositoryPath = "C:\\old";
    await writeConfig(first);
    const second = await readConfig();
    second.repositoryPath = "C:\\new";
    await writeConfig(second);

    await fs.writeFile(statePath, "broken", "utf8");

    const recovered = await readConfig();
    expect(recovered.repositoryPath).toBe("C:\\old");
    expect(recovered._issues.map((issue) => issue.message).join(" ")).toContain(
      "已从本地备份恢复",
    );
  });
});
