import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSkill,
  createTempDirectory,
} from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const { createScanner } = require("../../public/preload/scanner.js");
const { normalizeCachedSkills } = require("../../public/preload/config-store.js");
const workspaces = [];
const scanner = createScanner({ normalizeCachedSkills });

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

async function workspace() {
  const item = await createTempDirectory("skills-scanner-");
  workspaces.push(item);
  return item;
}

describe("Skills 仓库扫描", () => {
  it("递归识别合法 Skill、按名称排序并跳过无关目录", async () => {
    const root = await workspace();
    await createSkill(root.directory, "zeta", "Zeta");
    await createSkill(root.resolve("nested"), "alpha", "Alpha");
    await fs.mkdir(root.resolve("node_modules", "ignored"), { recursive: true });
    await createSkill(root.resolve("node_modules"), "ignored", "Ignored");

    const result = await scanner.scanConfiguredRepository({
      repositoryPath: root.directory,
      groups: [],
      agents: [],
      _cachedSkills: [],
      _syncLocked: false,
    });
    expect(result.complete).toBe(true);
    expect(result.skills.map((skill) => skill.name)).toEqual(["Alpha", "Zeta"]);
    expect(result.skills[0]).toMatchObject({
      id: "nested/alpha",
      folderName: "alpha",
    });
  });

  it("元数据损坏时标记扫描不完整，阻止危险清理", async () => {
    const root = await workspace();
    const broken = root.resolve("broken");
    await fs.mkdir(broken, { recursive: true });
    await fs.writeFile(root.resolve("broken", "SKILL.md"), "# no metadata", "utf8");
    const result = await scanner.scanConfiguredRepository({
      repositoryPath: root.directory,
      groups: [],
      agents: [],
      _cachedSkills: [
        {
          id: "old",
          name: "Old",
          relativePath: "old",
          folderName: "old",
          sourcePath: root.resolve("old"),
        },
      ],
      _syncLocked: false,
    });
    expect(result.complete).toBe(false);
    expect(result.issues.some((issue) => issue.type === "error")).toBe(true);
    expect(result.issues.map((issue) => issue.message).join(" ")).toContain(
      "不会清理缺失项",
    );
  });

  it("定向校验只接受仓库内仍有效的缓存 Skill", async () => {
    const root = await workspace();
    const alpha = await createSkill(root.directory, "alpha", "Alpha");
    const cached = {
      id: "alpha",
      name: "Alpha",
      relativePath: "alpha",
      folderName: "alpha",
      sourcePath: alpha,
    };
    const result = await scanner.inspectEnabledCachedSkills(
      {
        repositoryPath: root.directory,
        enabledSkills: { agent: ["alpha", "missing"] },
        _cachedSkills: [cached],
      },
      { id: "agent" },
      [],
    );
    expect(result.skills).toEqual([cached]);
    expect(result.complete).toBe(false);
    expect(result.issues[0].message).toContain("missing");
  });
});
