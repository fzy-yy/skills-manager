import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkill, createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const nodeFs = require("node:fs");
const {
  isDirectChild,
  isOwnedLink,
  removeOwnedLink,
} = require("../../public/preload/link-ownership.js");

const workspaces = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

async function workspace(prefix = "skills-ownership-") {
  const item = await createTempDirectory(prefix);
  workspaces.push(item);
  return item;
}

async function linkRecord(root, name = "alpha") {
  const sourcePath = await createSkill(root.resolve("repo"), name, name);
  const agentDirectory = root.resolve("agent");
  await fs.mkdir(agentDirectory, { recursive: true });
  const linkPath = path.join(agentDirectory, name);
  await fs.symlink(
    sourcePath,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  const stat = await fs.lstat(linkPath);
  return {
    sourcePath,
    agentDirectory,
    linkPath,
    record: {
      linkPath,
      sourcePath,
      identity: {
        dev: Number(stat.dev),
        ino: Number(stat.ino),
        birthtimeMs: Number(stat.birthtimeMs),
      },
    },
  };
}

async function quarantineEntries(agentDirectory) {
  return (await fs.readdir(agentDirectory)).filter((name) =>
    name.includes(".quarantine-"),
  );
}

describe("受管链接归属与安全移除", () => {
  it("isOwnedLink 统一归属判定：同源且 identity 一致或为 pending", () => {
    const identity = { dev: 1, ino: 2, birthtimeMs: 3 };
    const link = { kind: "link", sameTarget: true, identity };
    expect(isOwnedLink({ identity }, link)).toBe(true);
    expect(isOwnedLink({ pending: true }, link)).toBe(true);
    expect(
      isOwnedLink({ identity: { dev: 9, ino: 2, birthtimeMs: 3 } }, link),
    ).toBe(false);
    expect(isOwnedLink({ identity }, { kind: "file" })).toBe(false);
    expect(
      isOwnedLink({ identity }, { kind: "link", sameTarget: false, identity }),
    ).toBe(false);
    expect(isOwnedLink(null, link)).toBe(false);
    expect(isOwnedLink({ identity }, undefined)).toBe(false);
  });

  it("归属确认后通过同目录隔离删除链接且不残留隔离文件", async () => {
    const root = await workspace();
    const { record, agentDirectory, linkPath } = await linkRecord(root);
    const result = await removeOwnedLink(record, "受管链接", agentDirectory);
    expect(result).toMatchObject({ removed: true, relinquished: true });
    await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await quarantineEntries(agentDirectory)).toEqual([]);
  });

  it("目标不同的链接绝不删除，直接放弃管理", async () => {
    const root = await workspace();
    const { agentDirectory, linkPath } = await linkRecord(root);
    const otherSource = await createSkill(
      root.resolve("other"),
      "alpha",
      "Alpha",
    );
    const result = await removeOwnedLink(
      {
        linkPath,
        sourcePath: otherSource,
        identity: { dev: 0, ino: 0, birthtimeMs: 0 },
      },
      "受管链接",
      agentDirectory,
    );
    expect(result).toMatchObject({ removed: false, relinquished: true });
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("普通文件绝不删除", async () => {
    const root = await workspace();
    const agentDirectory = root.resolve("agent");
    await fs.mkdir(agentDirectory, { recursive: true });
    const filePath = path.join(agentDirectory, "alpha");
    await fs.writeFile(filePath, "keep", "utf8");
    const result = await removeOwnedLink(
      { linkPath: filePath, sourcePath: root.resolve("repo", "alpha") },
      "受管链接",
      agentDirectory,
    );
    expect(result).toMatchObject({ removed: false, relinquished: true });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("keep");
  });

  it("隔离后 unlink 失败时恢复原路径并保留记录供继续追踪", async () => {
    const root = await workspace();
    const { record, agentDirectory, linkPath } = await linkRecord(root);
    const unlink = vi
      .spyOn(nodeFs.promises, "unlink")
      .mockRejectedValueOnce(
        Object.assign(new Error("EPERM"), { code: "EPERM" }),
      );

    const result = await removeOwnedLink(record, "受管链接", agentDirectory);
    expect(result.removed).toBe(false);
    expect(result.relinquished).toBe(false);
    expect(result.remainingLink).toEqual(record);
    expect(await isDirectChild(agentDirectory, linkPath)).toBe(true);
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(result.issues[0].message).toContain("已恢复原链接");

    unlink.mockRestore();
    const cleanup = await removeOwnedLink(
      result.remainingLink,
      "受管链接",
      agentDirectory,
    );
    expect(cleanup).toMatchObject({ removed: true, relinquished: true });
    await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await quarantineEntries(agentDirectory)).toEqual([]);
  });

  it("隔离 rename 失败时绝不 unlink 原路径，保留记录", async () => {
    const root = await workspace();
    const { record, agentDirectory, linkPath } = await linkRecord(root);
    vi.spyOn(nodeFs.promises, "rename").mockRejectedValueOnce(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );
    const unlink = vi.spyOn(nodeFs.promises, "unlink");

    const result = await removeOwnedLink(record, "受管链接", agentDirectory);
    expect(result).toMatchObject({ removed: false, relinquished: false });
    expect(result.remainingLink).toBeUndefined();
    expect(unlink).not.toHaveBeenCalled();
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it("隔离后复核发现已被替换为普通文件：不覆盖地恢复且绝不删除", async () => {
    const root = await workspace();
    const { record, agentDirectory, linkPath } = await linkRecord(root);
    vi.spyOn(nodeFs.promises, "rename").mockImplementationOnce(
      async (from, to) => {
        // 模拟检查—执行竞态：原链接被移除，隔离位置出现普通文件
        await fs.unlink(from);
        await fs.writeFile(to, "raced-content", "utf8");
      },
    );

    const result = await removeOwnedLink(record, "受管链接", agentDirectory);
    expect(result).toMatchObject({ removed: false, relinquished: true });
    expect(result.remainingLink).toBeUndefined();
    await expect(fs.readFile(linkPath, "utf8")).resolves.toBe("raced-content");
    expect(await quarantineEntries(agentDirectory)).toEqual([]);
  });

  it("复核失败且原位置已被占用时返回 remainingLink，绝不覆盖也不删除", async () => {
    const root = await workspace();
    const { record, agentDirectory, linkPath } = await linkRecord(root);
    vi.spyOn(nodeFs.promises, "rename").mockImplementationOnce(
      async (from, to) => {
        await fs.unlink(from);
        await fs.writeFile(from, "occupier", "utf8");
        await fs.writeFile(to, "quarantined-file", "utf8");
      },
    );

    const result = await removeOwnedLink(record, "受管链接", agentDirectory);
    expect(result).toMatchObject({ removed: false, relinquished: false });
    expect(result.remainingLink).toBeDefined();
    await expect(fs.readFile(linkPath, "utf8")).resolves.toBe("occupier");
    await expect(
      fs.readFile(result.remainingLink.linkPath, "utf8"),
    ).resolves.toBe("quarantined-file");
    expect(result.issues[0].message).toContain("无法恢复原位置");
  });
});
