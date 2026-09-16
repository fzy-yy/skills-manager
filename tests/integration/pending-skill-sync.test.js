import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirectory } from "../helpers/temp-directory";

const require = createRequire(import.meta.url);
const {
  createPendingSkillSync,
  MAX_BYTES,
} = require("../../public/preload/pending-skill-sync.js");

const workspaces = [];

async function createSync() {
  const workspace = await createTempDirectory("pending-skill-sync-");
  workspaces.push(workspace);
  const sync = createPendingSkillSync({ getPath: () => workspace.directory });
  return { sync, workspace };
}

function listTemporaryFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith(".tmp"));
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((item) => item.cleanup()));
});

describe("待生效 Skills 意图暂存", () => {
  it("记录后可按 round trip 读回，并只保留约定字段", async () => {
    const { sync } = await createSync();
    const result = sync.record(
      " agent-a ",
      ["s2", "s1", "s1"],
      "token-1",
      "2026-01-02T03:04:05.000Z",
    );
    expect(result).toMatchObject({
      ok: true,
      record: {
        id: "agent-a",
        skillIds: ["s1", "s2"],
        token: "token-1",
        updatedAt: "2026-01-02T03:04:05.000Z",
      },
    });

    const read = sync.read();
    expect(read).toMatchObject({ ok: true, exists: true, issue: null });
    expect(read.records).toEqual([
      {
        id: "agent-a",
        skillIds: ["s1", "s2"],
        token: "token-1",
        updatedAt: "2026-01-02T03:04:05.000Z",
      },
    ]);

    // 磁盘上也不得出现未约定字段
    const raw = JSON.parse(fs.readFileSync(sync.filePath, "utf8"));
    expect(raw).toMatchObject({ version: 1 });
    expect(Object.keys(raw.records[0]).sort()).toEqual([
      "id",
      "skillIds",
      "token",
      "updatedAt",
    ]);
  });

  it("缺省 token 自动生成，缺省 updatedAt 使用可解析的当前时间", async () => {
    const { sync } = await createSync();
    const result = sync.record("agent-a", ["s1"]);
    expect(result.record.token).toBeTruthy();
    expect(Number.isNaN(Date.parse(result.record.updatedAt))).toBe(false);
  });

  it("同一 Agent 覆盖写入，其他 Agent 保持不变", async () => {
    const { sync } = await createSync();
    sync.record("agent-b", ["s9"], "tb");
    sync.record("agent-a", ["s1"], "ta1");
    sync.record("agent-a", ["s2"], "ta2");
    const read = sync.read();
    expect(read.records).toEqual([
      {
        id: "agent-a",
        skillIds: ["s2"],
        token: "ta2",
        updatedAt: expect.any(String),
      },
      {
        id: "agent-b",
        skillIds: ["s9"],
        token: "tb",
        updatedAt: expect.any(String),
      },
    ]);
  });

  it("文件缺失时读为空状态且不报错", async () => {
    const { sync } = await createSync();
    expect(sync.read()).toEqual({
      ok: true,
      records: [],
      exists: false,
      issue: null,
      error: null,
    });
  });

  it("token 不匹配时拒绝清除，旧窗口无法清掉新意图", async () => {
    const { sync } = await createSync();
    sync.record("agent-a", ["s1"], "fresh-token");

    const refused = sync.clear("agent-a", "stale-token");
    expect(refused).toMatchObject({ ok: false, cleared: false });
    expect(refused.issue).toMatchObject({ type: "warning" });
    expect(refused.code).toBe("ETOKENMISMATCH");
    expect(sync.read().records).toHaveLength(1);

    const cleared = sync.clear("agent-a", "fresh-token");
    expect(cleared).toMatchObject({ ok: true, cleared: true });
    expect(sync.read().records).toHaveLength(0);
  });

  it("未提供 token 时按 Agent 无条件清除，且清除不存在项是幂等的", async () => {
    const { sync } = await createSync();
    sync.record("agent-a", ["s1"], "ta");
    sync.record("agent-b", ["s2"], "tb");

    expect(sync.clear("agent-a")).toMatchObject({ ok: true, cleared: true });
    expect(sync.read().records.map((entry) => entry.id)).toEqual(["agent-b"]);
    expect(sync.clear("agent-a")).toMatchObject({ ok: true, cleared: false });
  });

  it("clearAll 删除整个文件，重复调用仍成功", async () => {
    const { sync } = await createSync();
    sync.record("agent-a", ["s1"], "ta");
    expect(sync.clearAll()).toMatchObject({ ok: true, cleared: true });
    expect(fs.existsSync(sync.filePath)).toBe(false);
    expect(sync.clearAll()).toMatchObject({ ok: true, cleared: false });
  });

  it("文件损坏时不抛出，返回可诊断问题且不覆盖原文件", async () => {
    const { sync } = await createSync();
    fs.mkdirSync(path.dirname(sync.filePath), { recursive: true });
    fs.writeFileSync(sync.filePath, "{not-json", "utf8");

    const read = sync.read();
    expect(read.ok).toBe(false);
    expect(read.records).toEqual([]);
    expect(read.issue).toMatchObject({ type: "error" });
    expect(read.issue.message).toContain("损坏");
    expect(read.error).toBeInstanceOf(Error);

    const recorded = sync.record("agent-a", ["s1"], "ta");
    expect(recorded.ok).toBe(false);
    expect(recorded.issue.type).toBe("error");
    // 损坏文件必须原样保留，不能被静默清空
    expect(fs.readFileSync(sync.filePath, "utf8")).toBe("{not-json");
  });

  it("超出 64 KiB 上限时拒绝写入且不产生残留文件", async () => {
    const { sync } = await createSync();
    const huge = Array.from(
      { length: 6000 },
      (_, index) => `skill-${index}-${"x".repeat(32)}`,
    );
    const result = sync.record("agent-a", huge, "ta");
    expect(result.ok).toBe(false);
    expect(result.issue.message).toContain(String(MAX_BYTES));
    expect(fs.existsSync(sync.filePath)).toBe(false);
    expect(listTemporaryFiles(path.dirname(sync.filePath))).toEqual([]);
  });

  it("写临时文件失败时清理临时文件并保留上一版本", async () => {
    const { sync } = await createSync();
    sync.record("agent-a", ["s1"], "ta");
    const before = fs.readFileSync(sync.filePath, "utf8");

    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const result = sync.record("agent-b", ["s2"], "tb");

    expect(result.ok).toBe(false);
    expect(result.issue.message).toContain("disk full");
    expect(result.error).toBeInstanceOf(Error);
    expect(listTemporaryFiles(path.dirname(sync.filePath))).toEqual([]);
    expect(fs.readFileSync(sync.filePath, "utf8")).toBe(before);
  });

  it("fsync 失败时清理临时文件并保留上一版本", async () => {
    const { sync } = await createSync();
    sync.record("agent-a", ["s1"], "ta");
    const before = fs.readFileSync(sync.filePath, "utf8");

    vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw new Error("sync failed");
    });
    const result = sync.record("agent-b", ["s2"], "tb");

    expect(result.ok).toBe(false);
    expect(result.issue.message).toContain("sync failed");
    expect(listTemporaryFiles(path.dirname(sync.filePath))).toEqual([]);
    expect(fs.readFileSync(sync.filePath, "utf8")).toBe(before);
  });

  it("rename 失败时清理临时文件并保留上一版本", async () => {
    const { sync } = await createSync();
    sync.record("agent-a", ["s1"], "ta");
    const before = fs.readFileSync(sync.filePath, "utf8");

    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });
    const result = sync.record("agent-b", ["s2"], "tb");

    expect(result.ok).toBe(false);
    expect(result.issue.message).toContain("rename failed");
    expect(listTemporaryFiles(path.dirname(sync.filePath))).toEqual([]);
    expect(fs.readFileSync(sync.filePath, "utf8")).toBe(before);
  });

  it("open EEXIST 时不清除预先存在的文件", async () => {
    const { sync } = await createSync();
    const preexisting = [];
    const openSync = fs.openSync.bind(fs);
    vi.spyOn(fs, "openSync").mockImplementation((targetPath, flags) => {
      if (String(targetPath).endsWith(".lock"))
        return openSync(targetPath, flags);
      // 模拟"同名数据临时文件已存在"：写入占位内容后以 EEXIST 失败
      fs.writeFileSync(targetPath, "preexisting", "utf8");
      preexisting.push(targetPath);
      const error = new Error("EEXIST: file already exists");
      error.code = "EEXIST";
      throw error;
    });

    const result = sync.record("agent-a", ["s1"], "ta");

    expect(result.ok).toBe(false);
    expect(preexisting).toHaveLength(1);
    expect(fs.readFileSync(preexisting[0], "utf8")).toBe("preexisting");
  });

  it("锁被其他窗口持有时拒绝覆盖现有记录", async () => {
    const { sync } = await createSync();
    sync.record("agent-a", ["s1"], "ta");
    const before = fs.readFileSync(sync.filePath, "utf8");
    const lockPath = `${sync.filePath}.lock`;
    fs.writeFileSync(lockPath, "locked", "utf8");

    const result = sync.record("agent-b", ["s2"], "tb");
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toMatchObject({ code: "EBUSY" });
    expect(fs.readFileSync(sync.filePath, "utf8")).toBe(before);
    expect(sync.read().records.map((record) => record.id)).toEqual(["agent-a"]);
  });

  it("缺少 userData 路径时立即抛出可诊断错误", () => {
    expect(() => createPendingSkillSync({ getPath: () => undefined })).toThrow(
      "无法获取 uTools 用户数据目录",
    );
  });
});
