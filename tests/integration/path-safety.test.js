import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const {
  assertNotDiskRoot,
  assertSafeAgentDirectory,
  isInsideDirectory,
  normalizeDirectory,
  pathsEqual,
  pathsEqualLexical,
} = require("../../public/preload/path-safety.js");
const workspaces = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

async function workspace() {
  const item = await createTempDirectory("skills-paths-");
  workspaces.push(item);
  return item;
}

describe("路径安全边界", () => {
  it("规范化已有目录并拒绝文件路径", async () => {
    const root = await workspace();
    const directory = root.resolve("folder");
    const file = root.resolve("file.txt");
    await fs.mkdir(directory);
    await fs.writeFile(file, "content", "utf8");
    await expect(normalizeDirectory(`  ${directory}  `)).resolves.toBe(
      await fs.realpath(directory),
    );
    await expect(normalizeDirectory(file)).rejects.toThrow("不是文件夹");
    await expect(normalizeDirectory(root.resolve("missing"))).rejects.toThrow(
      "不存在或无法访问",
    );
  });

  it("正确识别目录包含关系与等价路径", async () => {
    const root = await workspace();
    const child = root.resolve("parent", "child");
    await fs.mkdir(child, { recursive: true });
    await expect(
      isInsideDirectory(root.resolve("parent"), child),
    ).resolves.toBe(true);
    await expect(
      isInsideDirectory(child, root.resolve("parent")),
    ).resolves.toBe(false);
    await expect(pathsEqual(child, path.join(child, "."))).resolves.toBe(true);
  });

  it("拒绝 Agent 目录与仓库嵌套或被其他 Agent 重复使用", async () => {
    const root = await workspace();
    const repository = root.resolve("repo");
    const nestedAgent = root.resolve("repo", "agent");
    const sharedAgent = root.resolve("shared-agent");
    await fs.mkdir(nestedAgent, { recursive: true });
    await fs.mkdir(sharedAgent);

    await expect(
      assertSafeAgentDirectory(
        { repositoryPath: repository, agents: [], _orphanAgents: [] },
        nestedAgent,
      ),
    ).rejects.toThrow("互相包含");
    await expect(
      assertSafeAgentDirectory(
        {
          repositoryPath: repository,
          agents: [{ id: "existing", name: "Codex", directory: sharedAgent }],
          _orphanAgents: [],
        },
        sharedAgent,
        "new-agent",
      ),
    ).rejects.toThrow("已由 Agent“Codex”使用");
  });

  it("normalizeDirectory 返回 realpath 后的 canonical 路径", async (ctx) => {
    const root = await workspace();
    const target = root.resolve("real-target");
    await fs.mkdir(target);
    const link = root.resolve("dir-link");
    try {
      await fs.symlink(
        target,
        link,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      return ctx.skip();
    }
    const canonical = await normalizeDirectory(link);
    expect(canonical).toBe(await fs.realpath(target));
    expect(await pathsEqual(canonical, link)).toBe(true);
  });

  it("pathsEqualLexical 只做词法比较且忽略分隔符/尾随斜杠差异", () => {
    if (process.platform === "win32") {
      expect(pathsEqualLexical("C:\\A\\b", "c:/a/B/")).toBe(true);
      expect(pathsEqualLexical("\\\\?\\C:\\A", "C:\\A")).toBe(true);
      expect(pathsEqualLexical("C:\\A", "C:\\B")).toBe(false);
    } else {
      expect(pathsEqualLexical("/a/b", "/a/b/")).toBe(true);
      expect(pathsEqualLexical("/a/b", "/a/c")).toBe(false);
    }
    expect(pathsEqualLexical("", "C:\\a")).toBe(false);
  });

  it("assertNotDiskRoot 拒绝磁盘根与 UNC 共享根，接受普通目录", async () => {
    const root = await workspace();
    expect(() => assertNotDiskRoot(root.directory, "仓库")).not.toThrow();
    expect(() =>
      assertNotDiskRoot(path.parse(process.cwd()).root, "仓库"),
    ).toThrow("根目录");
    expect(() => assertNotDiskRoot("relative/path", "仓库")).toThrow(
      "绝对路径",
    );
    if (process.platform === "win32") {
      expect(() => assertNotDiskRoot("\\\\server\\share", "仓库")).toThrow(
        "根目录",
      );
      expect(() =>
        assertNotDiskRoot("\\\\server\\share\\sub", "仓库"),
      ).not.toThrow();
    }
  });

  it("拒绝指向磁盘根的 junction（Windows）", async (ctx) => {
    if (process.platform !== "win32") return ctx.skip();
    const root = await workspace();
    const junction = root.resolve("root-link");
    try {
      await fs.symlink(path.parse(process.cwd()).root, junction, "junction");
    } catch {
      return ctx.skip();
    }
    const canonical = await normalizeDirectory(junction);
    expect(() => assertNotDiskRoot(canonical, "Skills 仓库")).toThrow("根目录");
  });

  it("安全判断无法解析真实路径时 fail closed", async () => {
    const root = await workspace();
    const child = root.resolve("child");
    await fs.mkdir(child);
    // 父目录不存在：无法证明子路径不在其中，保守返回 true（以重叠为拒绝条件的调用方会拒绝）。
    await expect(
      isInsideDirectory(root.resolve("missing-parent"), child),
    ).resolves.toBe(true);
    // 无法比较真实路径时不声称相等，避免据此删除/替换内容。
    await expect(
      pathsEqual(root.resolve("missing-a"), root.resolve("missing-b")),
    ).resolves.toBe(false);
  });
});
