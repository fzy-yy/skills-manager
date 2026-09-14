import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const {
  assertSafeAgentDirectory,
  isInsideDirectory,
  normalizeDirectory,
  pathsEqual,
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
      path.resolve(directory),
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
    await expect(isInsideDirectory(root.resolve("parent"), child)).resolves.toBe(
      true,
    );
    await expect(isInsideDirectory(child, root.resolve("parent"))).resolves.toBe(
      false,
    );
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
          agents: [
            { id: "existing", name: "Codex", directory: sharedAgent },
          ],
          _orphanAgents: [],
        },
        sharedAgent,
        "new-agent",
      ),
    ).rejects.toThrow("已由 Agent“Codex”使用");
  });
});
