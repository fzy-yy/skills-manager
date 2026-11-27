/**
 * 模块 08：渲染层 Skill 开关队列与降级分支（对应文档 1.3 / 1.6 / 5.6-5.9 / 5.18）。
 * 运行：node test_dir/test/08-skill-queue.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { createReporter, runModule } = require("./helpers/reporter.cjs");

/** 路径解析：本文件位于 test_dir/test/ 下。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
const { createSkillQueue } = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "src", "stores", "skill-queue.js")).href
);
const { backend, hasBackend } = await import(
  pathToFileURL(path.join(PROJECT_ROOT, "src", "api", "backend.js")).href
);

const reporter = createReporter("08-skill-queue");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 创建一个不依赖 preload 的队列测试环境。
 *
 * @param {{submitDelay?: number, failTimes?: number}} [options] - 模拟提交延迟与前 N 次失败
 * @returns {object} 队列与观察数据
 */
function createQueueHarness(options = {}) {
  const { submitDelay = 0, failTimes = 0 } = options;
  const selections = new Map([["agent-1", ["alpha"]]]);
  const commits = [];
  const errors = [];
  const reportedIssues = [];
  let remainingFailures = failTimes;
  const queue = createSkillQueue({
    getSelection: (agentId) => selections.get(agentId) || [],
    applySelection: (agentId, skillIds) => selections.set(agentId, [...skillIds]),
    submit: async (agentId, skillIds) => {
      commits.push(`${agentId}:${[...skillIds].join(",")}`);
      if (submitDelay) await delay(submitDelay);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("模拟同步失败");
      }
      return {
        enabledSkills: { [agentId]: [...skillIds] },
        agentIssues: { [agentId]: [] },
        issues: options.topIssues || [],
      };
    },
    onIssues: (agentId, agentIssues, allIssues) =>
      reportedIssues.push({ agentId, agentIssues, allIssues }),
    onError: (error) => errors.push(error.message),
  });
  return { commits, errors, queue, reportedIssues, selections };
}

async function main() {
  reporter.section("降级分支（无 preload 环境）");
  // [1.6] hasBackend / backend 的浏览器降级行为
  globalThis.window = {};
  reporter.check("1.6", "无 preload 时 hasBackend 为 false", hasBackend() === false);
  let backendError = null;
  try {
    backend();
  } catch (error) {
    backendError = error;
  }
  reporter.check(
    "1.6",
    "无 preload 时 backend() 抛出可读错误",
    Boolean(backendError?.message.includes("uTools")),
    backendError?.message,
  );
  globalThis.window = { skillsManager: {} };
  reporter.check("1.6", "有 preload 时 hasBackend 为 true", hasBackend() === true);

  reporter.section("防抖合并与提交顺序");
  // [5.6] 300ms 内连续点击合并为一次提交
  {
    const h = createQueueHarness();
    h.queue.setSkills("agent-1", ["alpha", "beta"]);
    h.queue.setSkills("agent-1", ["alpha", "beta", "gamma"]);
    reporter.check(
      "5.6",
      "乐观更新立即生效",
      h.selections.get("agent-1").join(",") === "alpha,beta,gamma",
      JSON.stringify([...h.selections]),
    );
    await delay(500);
    reporter.check(
      "5.6",
      "多次点击只提交一次且为最终选择",
      h.commits.length === 1 && h.commits[0] === "agent-1:alpha,beta,gamma",
      JSON.stringify(h.commits),
    );
  }

  // [5.7] 提交期间的新选择按顺序提交，不被旧结果覆盖
  {
    const h = createQueueHarness({ submitDelay: 200 });
    h.queue.setSkills("agent-1", ["alpha"]);
    await delay(350);
    h.queue.setSkills("agent-1", ["alpha", "beta"]);
    reporter.check(
      "5.7",
      "提交期间界面保留最新选择",
      h.selections.get("agent-1").join(",") === "alpha,beta",
      JSON.stringify([...h.selections]),
    );
    await delay(700);
    reporter.check(
      "5.7",
      "两轮提交且最后一轮为最新选择",
      h.commits.length === 2 && h.commits[1] === "agent-1:alpha,beta",
      JSON.stringify(h.commits),
    );
    reporter.check(
      "5.7",
      "最终界面与提交结果一致",
      h.selections.get("agent-1").join(",") === "alpha,beta",
    );
  }

  reporter.section("失败回滚");
  // [5.8] 提交失败：回滚到已确认值并提示
  {
    const h = createQueueHarness({ failTimes: 1 });
    h.queue.setSkills("agent-1", ["gamma"]);
    await delay(500);
    reporter.check(
      "5.8",
      "失败后回滚到已确认值",
      h.selections.get("agent-1").join(",") === "alpha",
      JSON.stringify([...h.selections]),
    );
    reporter.check(
      "5.8",
      "失败已通过 onError 提示",
      h.errors.length === 1 && h.errors[0] === "模拟同步失败",
      JSON.stringify(h.errors),
    );
    reporter.check("5.8", "只尝试了一次提交", h.commits.length === 1);
  }

  // [5.9] 失败时若已有新选择：不回滚，继续提交新值
  {
    const h = createQueueHarness({ submitDelay: 120, failTimes: 1 });
    h.queue.setSkills("agent-1", ["beta"]);
    await delay(350);
    h.queue.setSkills("agent-1", ["gamma"]);
    await delay(800);
    reporter.check(
      "5.9",
      "失败后继续提交新选择",
      h.commits.join("|") === "agent-1:beta|agent-1:gamma",
      JSON.stringify(h.commits),
    );
    reporter.check(
      "5.9",
      "最终保留新选择",
      h.selections.get("agent-1").join(",") === "gamma",
      JSON.stringify([...h.selections]),
    );
    reporter.check("5.9", "新一轮成功时不提示旧失败", h.errors.length === 0);
  }

  reporter.section("立即提交与取消");
  // [1.3 + 5.18] flushNow：插件隐藏时跳过防抖立即提交
  {
    const h = createQueueHarness();
    h.queue.setSkills("agent-1", ["beta"]);
    h.queue.flushNow();
    await delay(150);
    reporter.check(
      "5.18",
      "flushNow 立即提交待提交选择",
      h.commits.length === 1 && h.commits[0] === "agent-1:beta",
      JSON.stringify(h.commits),
    );
  }

  // [4.10 前端] cancel：删除 Agent 前取消其待提交选择
  {
    const h = createQueueHarness();
    h.queue.setSkills("agent-1", ["beta"]);
    h.queue.cancel("agent-1");
    await delay(500);
    reporter.check("4.10", "取消后不再提交该 Agent 的选择", h.commits.length === 0);
  }

  // [5.8 / 5.11 回归] syncCommitted 更新回滚基线，且透传顶层 issues
  {
    const h = createQueueHarness({
      topIssues: [{ type: "warning", message: "部分选择已失效并自动忽略" }],
    });
    h.queue.setSkills("agent-1", ["alpha", "beta"]);
    await delay(450);
    reporter.check(
      "5.11",
      "onIssues 透传服务端顶层 issues（含失效选择警告）",
      h.reportedIssues.at(-1)?.allIssues?.some((i) =>
        i.message.includes("部分选择已失效"),
      ),
      JSON.stringify(h.reportedIssues),
    );
  }
  {
    const h = createQueueHarness({ failTimes: 1 });
    // 模拟外部刷新把 agent-1 的已启用列表清空为 []
    h.selections.set("agent-1", []);
    h.queue.syncCommitted({ "agent-1": [] });
    h.queue.setSkills("agent-1", ["gamma"]);
    await delay(450);
    reporter.check(
      "5.8",
      "外部同步后提交失败会回滚到最新基线（而非刷新前旧值）",
      h.selections.get("agent-1").length === 0,
      JSON.stringify(h.selections.get("agent-1")),
    );
  }

  reporter.finish();
}

runModule(main);
