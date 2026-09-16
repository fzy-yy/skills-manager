import { describe, expect, it } from "vitest";
import {
  assertStateContract,
  createStateSnapshot,
} from "../helpers/state-fixture";

describe("状态测试契约", () => {
  it("创建满足契约的完整默认状态", () => {
    const state = createStateSnapshot();
    expect(assertStateContract(state)).toBe(state);
    expect(state.emptyRepository).toBe(false);
  });

  it("拒绝缺失字段和未知字段", () => {
    const missingTheme = createStateSnapshot();
    delete missingTheme.theme;
    expect(() => assertStateContract(missingTheme)).toThrow(
      "状态缺少字段：theme",
    );
    expect(() =>
      assertStateContract(createStateSnapshot({ unexpected: true })),
    ).toThrow("状态包含未知字段：unexpected");
  });
});
