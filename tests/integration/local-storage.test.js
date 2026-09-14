import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const { createLocalStorage } = require("../../public/preload/local-storage.js");
const workspaces = [];

async function createStorage() {
  const workspace = await createTempDirectory("skills-storage-");
  workspaces.push(workspace);
  return createLocalStorage({ getPath: () => workspace.directory });
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

describe("本地配置存储", () => {
  it("原子提交并保留上一版本备份", async () => {
    const storage = await createStorage();
    await storage.commit({ value: 1 });
    await storage.commit({ value: 2 });
    await expect(storage.read()).resolves.toMatchObject({
      data: { value: 2, storageVersion: 1 },
      recovered: false,
    });
    const backup = JSON.parse(
      await fs.readFile(path.join(storage.directory, "state.backup.json"), "utf8"),
    );
    expect(backup.value).toBe(1);
  });

  it("主文件损坏时从备份恢复，清除时删除两份文件", async () => {
    const storage = await createStorage();
    await storage.commit({ value: "old" });
    await storage.commit({ value: "new" });
    await fs.writeFile(storage.statePath, "not-json", "utf8");
    await expect(storage.read()).resolves.toMatchObject({
      data: { value: "old" },
      recovered: true,
    });
    await storage.clear();
    await expect(storage.read()).resolves.toEqual({
      data: null,
      recovered: false,
    });
  });

  it("主文件和备份均损坏时给出可诊断错误", async () => {
    const storage = await createStorage();
    await fs.mkdir(storage.directory, { recursive: true });
    await fs.writeFile(storage.statePath, "[]", "utf8");
    await fs.writeFile(
      path.join(storage.directory, "state.backup.json"),
      "broken",
      "utf8",
    );
    await expect(storage.read()).rejects.toThrow("本地配置文件损坏");
  });
});
