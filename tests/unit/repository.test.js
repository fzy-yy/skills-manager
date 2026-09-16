// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRepositoryController } from "../../src/stores/repository";

function createHarness() {
  window.skillsManager = {
    getState: vi.fn(),
    readPendingSkillSync: vi.fn(() => ({ ok: true, records: [], issue: null })),
    recordPendingSkillSync: vi.fn(() => ({ ok: true })),
    clearPendingSkillSync: vi.fn(() => ({ ok: true })),
    setAgentSkills: vi.fn(),
  };
  const reportIssues = vi.fn();
  const execute = vi.fn(async (operation, options = {}) => {
    try {
      const value = await operation();
      options.applyResult?.(value);
      return { ok: true, reason: "ok", value, error: null };
    } catch (error) {
      return { ok: false, reason: "error", value: null, error };
    }
  });
  const controller = createRepositoryController({
    execute,
    isInFlight: () => false,
    notify: vi.fn(),
    reportIssues,
    applyTheme: vi.fn(),
  });
  return { controller, execute, reportIssues };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("仓库控制器", () => {
  it("非扫描状态省略 emptyRepository 时保留上一次判定", () => {
    const { controller } = createHarness();
    controller.applyState({ emptyRepository: true });
    controller.applyState({ skills: [] });
    expect(controller.emptyRepository.value).toBe(true);
  });

  it("完整状态中的 agentIssues 会替换旧问题并清除已恢复 Agent 的提示", () => {
    const { controller } = createHarness();
    controller.applyState({
      agents: [{ id: "agent", name: "Codex", directory: "C:\\agent" }],
      agentIssues: {
        agent: [{ type: "error", message: "旧错误" }],
      },
    });
    expect(controller.agentSyncIssues.value.agent).toHaveLength(1);
    controller.applyState({ agentIssues: { agent: [] } });
    expect(controller.agentSyncIssues.value.agent).toEqual([]);
  });

  it("启动重放只提交仍存在且与磁盘不同的 Agent 意图", async () => {
    vi.useFakeTimers();
    const { controller } = createHarness();
    controller.applyState({
      agents: [
        { id: "agent", name: "Codex", directory: "C:\\agent" },
        { id: "same", name: "Same", directory: "C:\\same" },
      ],
      enabledSkills: { agent: ["base"], same: ["ready"] },
    });
    window.skillsManager.readPendingSkillSync.mockReturnValue({
      ok: true,
      issue: null,
      records: [
        { id: "agent", skillIds: ["next"], token: "new", updatedAt: "1" },
        { id: "same", skillIds: ["ready"], token: "same", updatedAt: "1" },
        { id: "gone", skillIds: ["x"], token: "gone", updatedAt: "1" },
      ],
    });
    window.skillsManager.setAgentSkills.mockResolvedValue({
      repositoryPath: "",
      skills: [],
      groups: [],
      agents: controller.agents.value,
      enabledSkills: { agent: ["next"], same: ["ready"] },
      theme: "light",
      issues: [],
      agentIssues: { agent: [] },
    });

    const completions = controller.replayPendingSkillSync();
    expect(completions).toHaveLength(1);
    expect(window.skillsManager.clearPendingSkillSync).toHaveBeenCalledWith(
      "same",
      "same",
    );
    expect(window.skillsManager.clearPendingSkillSync).toHaveBeenCalledWith(
      "gone",
      "gone",
    );
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(completions);
    expect(window.skillsManager.setAgentSkills).toHaveBeenCalledWith("agent", [
      "next",
    ]);
  });
});
