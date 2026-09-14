import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createDefaultConfig,
  isSafeRecordKey,
  normalizeCachedSkills,
  normalizeManagedLinks,
} = require("../../public/preload/config-store.js");

describe("配置规范化", () => {
  it("默认配置之间互不共享可变对象", () => {
    const first = createDefaultConfig();
    const second = createDefaultConfig();
    first.groups.push({ id: "group-1" });
    expect(second.groups).toEqual([]);
    expect(second).toMatchObject({ version: 4, theme: "light" });
  });

  it("拒绝原型污染键名", () => {
    expect(isSafeRecordKey("normal-id")).toBe(true);
    expect(isSafeRecordKey("__proto__")).toBe(false);
    expect(isSafeRecordKey("constructor")).toBe(false);
  });

  it("过滤重复、缺字段和非法目录名的缓存", () => {
    const sourcePath = path.resolve("repo", "alpha");
    const valid = {
      id: "alpha",
      name: "Alpha",
      relativePath: "alpha",
      folderName: "alpha",
      sourcePath,
    };
    expect(
      normalizeCachedSkills([
        valid,
        { ...valid },
        { ...valid, id: "unsafe", folderName: "../unsafe" },
        null,
      ]),
    ).toEqual([valid]);
  });

  it("仅保留结构完整且 identity 有效的受管链接", () => {
    const links = normalizeManagedLinks({
      alpha: {
        linkPath: "C:\\agent\\alpha",
        sourcePath: "C:\\repo\\alpha",
        identity: { dev: 1, ino: 2, birthtimeMs: 3 },
        pending: true,
      },
      broken: {
        linkPath: "C:\\agent\\broken",
        sourcePath: "C:\\repo\\broken",
        identity: { dev: 1, ino: Number.NaN, birthtimeMs: 3 },
      },
    });
    expect(links).toEqual({
      alpha: {
        linkPath: "C:\\agent\\alpha",
        sourcePath: "C:\\repo\\alpha",
        identity: { dev: 1, ino: 2, birthtimeMs: 3 },
        pending: true,
      },
    });
  });
});
