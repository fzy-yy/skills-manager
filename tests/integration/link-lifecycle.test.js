import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSkill,
  createTempDirectory,
} from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const { createLinkManager } = require("../../public/preload/link-manager.js");
const {
  normalizeManagedLinks,
} = require("../../public/preload/config-store.js");
const { inspectLink } = require("../../public/preload/link-ownership.js");
const workspaces = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

describe("Agent 链接生命周期", () => {
  it("创建、保留并在关闭 Skill 后安全移除受管链接", async () => {
    const root = await createTempDirectory("skills-links-");
    workspaces.push(root);
    const sourcePath = await createSkill(root.resolve("repo"), "alpha", "Alpha");
    const agentDirectory = root.resolve("agent");
    await fs.mkdir(agentDirectory, { recursive: true });
    const writeConfig = vi.fn().mockResolvedValue(undefined);
    const manager = createLinkManager({ normalizeManagedLinks, writeConfig });
    const agent = {
      id: "agent",
      name: "Codex",
      directory: agentDirectory,
      managedLinks: {},
    };
    const config = { enabledSkills: { agent: ["alpha"] }, agents: [agent] };
    const scan = {
      complete: true,
      skills: [
        {
          id: "alpha",
          name: "Alpha",
          folderName: "alpha",
          sourcePath,
        },
      ],
    };

    const created = await manager.syncAgent(config, agent, scan);
    expect(created.linked).toEqual(["alpha"]);
    expect(writeConfig).toHaveBeenCalledTimes(1);
    expect((await inspectLink(agent.managedLinks.alpha.linkPath, sourcePath)).sameTarget).toBe(true);

    const kept = await manager.syncAgent(config, agent, scan);
    expect(kept.linked).toEqual(["alpha"]);
    config.enabledSkills.agent = [];
    const removedPath = agent.managedLinks.alpha.linkPath;
    await manager.syncAgent(config, agent, scan);
    await expect(fs.lstat(removedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(agent.managedLinks).toEqual({});
  });

  it("遇到普通目录冲突时保留用户内容且返回提示", async () => {
    const root = await createTempDirectory("skills-conflict-");
    workspaces.push(root);
    const sourcePath = await createSkill(root.resolve("repo"), "alpha", "Alpha");
    const agentDirectory = root.resolve("agent");
    await fs.mkdir(root.resolve("agent", "alpha"), { recursive: true });
    await fs.writeFile(root.resolve("agent", "alpha", "user.txt"), "keep", "utf8");
    const manager = createLinkManager({
      normalizeManagedLinks,
      writeConfig: vi.fn().mockResolvedValue(undefined),
    });
    const agent = {
      id: "agent",
      name: "Codex",
      directory: agentDirectory,
      managedLinks: {},
    };
    const result = await manager.syncAgent(
      { enabledSkills: { agent: ["alpha"] }, agents: [agent] },
      agent,
      {
        complete: true,
        skills: [{ id: "alpha", name: "Alpha", folderName: "alpha", sourcePath }],
      },
    );
    expect(result.issues[0].message).toContain("已有普通目录");
    await expect(fs.readFile(root.resolve("agent", "alpha", "user.txt"), "utf8")).resolves.toBe("keep");
    expect(agent.managedLinks).toEqual({});
  });

  it("identity 缺失时放弃管理但绝不删除现有链接", async () => {
    const root = await createTempDirectory("skills-identity-");
    workspaces.push(root);
    const sourcePath = await createSkill(root.resolve("repo"), "alpha", "Alpha");
    const agentDirectory = root.resolve("agent");
    await fs.mkdir(agentDirectory, { recursive: true });
    const linkPath = root.resolve("agent", "alpha");
    await fs.symlink(sourcePath, linkPath, process.platform === "win32" ? "junction" : "dir");
    const manager = createLinkManager({
      normalizeManagedLinks,
      writeConfig: vi.fn().mockResolvedValue(undefined),
    });
    const agent = {
      id: "agent",
      name: "Codex",
      directory: agentDirectory,
      managedLinks: { alpha: { linkPath, sourcePath } },
    };
    const result = await manager.syncAgent(
      { enabledSkills: { agent: [] }, agents: [agent] },
      agent,
      { complete: true, skills: [] },
    );
    expect(result.issues[0].message).toContain("已被外部替换");
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(agent.managedLinks).toEqual({});
  });
});
