import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const { createLocalStorage } = require("../../public/preload/local-storage.js");
const workspaces = [];

async function createStorage() {
  const workspace = await createTempDirectory("skills-storage-");
  workspaces.push(workspace);
  return createLocalStorage({ getPath: () => workspace.directory });
}

async function listTemporaryFiles(directory) {
  const entries = await fs.readdir(directory).catch(() => []);
  return entries.filter((name) => name.endsWith(".tmp"));
}

/**
 * 拦截 open，让临时文件被真实创建，再返回一个可注入失败点的句柄。
 * 这样"失败后是否残留临时文件"是真实验证，而不是对 mock 的空断言。
 */
async function mockOpenWithFakeHandle({ writeError, syncError, closeError }) {
  const created = [];
  vi.spyOn(fs, "open").mockImplementation(async (filePath) => {
    await fs.writeFile(filePath, "", { encoding: "utf8", flag: "wx" });
    created.push(filePath);
    return {
      writeFile: async () => {
        if (writeError) throw writeError;
      },
      sync: async () => {
        if (syncError) throw syncError;
      },
      close: async () => {
        if (closeError) throw closeError;
      },
    };
  });
  return created;
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
      await fs.readFile(
        path.join(storage.directory, "state.backup.json"),
        "utf8",
      ),
    );
    expect(backup.value).toBe(1);
  });

  it("每次写入生成新的 revision，并在备份中保留上一版本", async () => {
    const storage = await createStorage();
    const first = await storage.commit({ value: 1 });
    const second = await storage.commit({ value: 2 });
    expect(first.revision).toBeTruthy();
    expect(second.revision).not.toBe(first.revision);
    await expect(storage.read()).resolves.toMatchObject({
      revision: second.revision,
    });
    // 备份保存的是上一版本，因此它携带的是上一轮的 revision
    const backup = JSON.parse(
      await fs.readFile(
        path.join(storage.directory, "state.backup.json"),
        "utf8",
      ),
    );
    expect(backup.revision).toBe(first.revision);
  });

  it("revision 与磁盘不一致时拒绝写入，避免覆盖其他窗口的改动", async () => {
    const storage = await createStorage();
    const stale = await storage.commit({ value: "mine" });
    // 模拟另一个窗口完成了一次写入
    await storage.commit({ value: "other" });
    await expect(
      storage.commit({ value: "overwrite" }, stale.revision),
    ).rejects.toMatchObject({ code: "ECONFLICT" });
    await expect(storage.read()).resolves.toMatchObject({
      data: { value: "other" },
    });
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
      revision: "",
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

describe("本地配置存储的原子写失败清理", () => {
  it("write 失败时清理本轮临时文件，且不产生主文件", async () => {
    const storage = await createStorage();
    const created = await mockOpenWithFakeHandle({
      writeError: new Error("write failed"),
    });

    await expect(storage.commit({ value: 1 })).rejects.toThrow("write failed");
    expect(created).toHaveLength(1);
    await expect(fs.access(created[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await listTemporaryFiles(storage.directory)).toEqual([]);
    await expect(fs.access(storage.statePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("sync 失败时清理本轮临时文件，且不产生主文件", async () => {
    const storage = await createStorage();
    const created = await mockOpenWithFakeHandle({
      syncError: new Error("sync failed"),
    });

    await expect(storage.commit({ value: 1 })).rejects.toThrow("sync failed");
    expect(created).toHaveLength(1);
    await expect(fs.access(created[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await listTemporaryFiles(storage.directory)).toEqual([]);
    await expect(fs.access(storage.statePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("close 失败时清理本轮临时文件，且不产生主文件", async () => {
    const storage = await createStorage();
    const created = await mockOpenWithFakeHandle({
      closeError: new Error("close failed"),
    });

    await expect(storage.commit({ value: 1 })).rejects.toThrow("close failed");
    expect(created).toHaveLength(1);
    expect(await listTemporaryFiles(storage.directory)).toEqual([]);
    await expect(fs.access(storage.statePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rename 失败时清理本轮临时文件，且保留最后可用主文件", async () => {
    const storage = await createStorage();
    await storage.commit({ value: "old" });
    const before = await fs.readFile(storage.statePath, "utf8");

    const originalRename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      // 只让主文件的替换失败，备份已成功落盘，主文件必须保持旧内容
      if (to === storage.statePath) throw new Error("rename failed");
      return originalRename(from, to);
    });
    await expect(storage.commit({ value: "new" })).rejects.toThrow(
      "rename failed",
    );

    expect(await listTemporaryFiles(storage.directory)).toEqual([]);
    expect(await fs.readFile(storage.statePath, "utf8")).toBe(before);
  });

  it("open 因 EEXIST 失败时不删除预先存在的文件", async () => {
    const storage = await createStorage();
    const preexisting = [];
    vi.spyOn(fs, "open").mockImplementation(async (filePath) => {
      // 模拟"同名临时文件已存在"：写入占位内容后以 EEXIST 失败
      await fs.writeFile(filePath, "preexisting", "utf8");
      preexisting.push(filePath);
      const error = new Error("EEXIST: file already exists");
      error.code = "EEXIST";
      throw error;
    });

    await expect(storage.commit({ value: 1 })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(preexisting).toHaveLength(1);
    await expect(fs.readFile(preexisting[0], "utf8")).resolves.toBe(
      "preexisting",
    );
  });
});
