/**
 * 模块 05：应用配置与链接同步（对应文档第五章，preload 侧行为）。
 * 运行：node test_dir/test/05-applications.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_DIRS,
  REPO_DIR,
  TEST_DIR,
  captureError,
  createDanglingLink,
  createHarness,
  listLinks,
  removeDirectoryTree,
  renameWithRetry,
} = require("./helpers/harness.cjs");
const { createReporter, runModule } = require("./helpers/reporter.cjs");

const reporter = createReporter("05-applications");
const [AGENT1, AGENT2] = AGENT_DIRS;

async function main() {
  const harness = createHarness("05-applications");
  const { api } = harness;

  reporter.section("前置校验");
  // [5.10a] 未配置仓库时更新选择
  let state = await api.createAgent({ name: "应用 Agent", directory: AGENT1 });
  const agentId = state.agents[0].id;
  let error = await captureError(() => api.setAgentSkills(agentId, ["alpha"]));
  reporter.check(
    "5.10",
    "未配置仓库时拒绝开关",
    Boolean(error?.message.includes("请先配置 Skills 仓库目录")),
    error?.message,
  );

  // [5.10b] 已配置仓库但缓存为空（手工模拟去扫描缓存的状态）
  harness.writeStoredState(
    JSON.stringify({
      repositoryPath: REPO_DIR,
      groups: [],
      agents: [{ id: agentId, name: "应用 Agent", directory: AGENT1 }],
      enabledSkills: { [agentId]: [] },
      cachedSkills: [],
      theme: "light",
    }),
  );
  error = await captureError(() => api.setAgentSkills(agentId, ["alpha"]));
  reporter.check(
    "5.10",
    "未扫描（缓存为空）时拒绝开关",
    Boolean(error?.message.includes("完成目录扫描")),
    error?.message,
  );

  reporter.section("链接创建与冲突");
  state = await api.setRepository(REPO_DIR);
  state = await api.setAgentSkills(agentId, ["alpha"]);
  reporter.check("5.12", "启用后链接创建成功", listLinks(AGENT1).join(",") === "alpha", listLinks(AGENT1).join(","));

  // [5.12] 手动删除链接后刷新重建
  fs.unlinkSync(path.join(AGENT1, "alpha"));
  reporter.check("5.12", "手动删除后链接消失", listLinks(AGENT1).length === 0);
  state = await api.refresh();
  reporter.check(
    "5.12",
    "刷新后自动重建链接",
    listLinks(AGENT1).join(",") === "alpha",
    listLinks(AGENT1).join(","),
  );

  // [5.13] 目标位置已有同名普通文件：保留文件并提示
  fs.writeFileSync(path.join(AGENT1, "beta"), "同名文件", "utf8");
  state = await api.setAgentSkills(agentId, ["alpha", "beta"]);
  reporter.check(
    "5.13",
    "同名文件被保留",
    fs.existsSync(path.join(AGENT1, "beta")) && fs.statSync(path.join(AGENT1, "beta")).isFile(),
  );
  reporter.check(
    "5.13",
    "提示目标位置已有同名文件",
    state.issues.some((issue) => issue.message.includes("已有同名的文件")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  fs.unlinkSync(path.join(AGENT1, "beta"));

  // [5.14] 目标位置是异源链接（指向仓库外）：保留并提示
  fs.symlinkSync(AGENT2, path.join(AGENT1, "gamma"), "junction");
  state = await api.setAgentSkills(agentId, ["alpha", "gamma"]);
  reporter.check(
    "5.14",
    "异源链接被保留",
    fs.lstatSync(path.join(AGENT1, "gamma")).isSymbolicLink(),
  );
  reporter.check(
    "5.14",
    "提示目标位置已被其他链接占用",
    state.issues.some((issue) => issue.message.includes("被其他链接占用")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  fs.unlinkSync(path.join(AGENT1, "gamma"));

  reporter.section("失效选择与异常源");
  // [5.11] 缓存中已不存在的 Skill id 被过滤并提示
  const stored = harness.readStoredState();
  stored.cachedSkills = stored.cachedSkills.filter((skill) => skill.id !== "gamma");
  stored.enabledSkills[agentId] = [...stored.enabledSkills[agentId], "gamma"];
  harness.writeStoredState(JSON.stringify(stored));
  state = await api.setAgentSkills(agentId, ["alpha", "gamma"]);
  reporter.check(
    "5.11",
    "失效 id 被过滤且给出提示",
    state.enabledSkills[agentId].join(",") === "alpha" &&
      state.issues.some((issue) => issue.message.includes("部分选择已失效")),
    JSON.stringify({ enabled: state.enabledSkills, issues: state.issues }),
  );

  // [5.15] 启用一个源目录不存在的缓存 Skill：创建链接失败并报错
  const ghost = {
    id: "ghost",
    name: "Ghost",
    sourcePath: path.join(REPO_DIR, "ghost"),
  };
  const storedWithGhost = harness.readStoredState();
  storedWithGhost.cachedSkills = [...storedWithGhost.cachedSkills, ghost];
  harness.writeStoredState(JSON.stringify(storedWithGhost));
  state = await api.setAgentSkills(agentId, ["ghost"]);
  reporter.check(
    "5.15",
    "源目录不存在时拒绝创建并报错",
    state.issues.some(
      (issue) => issue.type === "error" && issue.message.includes("源目录不存在"),
    ),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  reporter.check(
    "5.15",
    "失败后未产生无效链接",
    !listLinks(AGENT1).includes("ghost"),
    JSON.stringify(listLinks(AGENT1)),
  );

  reporter.section("目录不可用与悬空清理");
  // [5.16] Agent 目录被移走：报错且不创建任何链接
  const storedFinal = harness.readStoredState();
  storedFinal.cachedSkills = storedFinal.cachedSkills.filter((skill) => skill.id !== "ghost");
  storedFinal.enabledSkills[agentId] = ["alpha"];
  harness.writeStoredState(JSON.stringify(storedFinal));
  const movedAgentDir = path.join(TEST_DIR, ".tmp-agent-moved");
  await renameWithRetry(AGENT1, movedAgentDir);
  state = await api.setAgentSkills(agentId, ["alpha", "beta"]);
  reporter.check(
    "5.16",
    "目录不可用时给出错误且不创建链接",
    state.issues.some((issue) => issue.type === "error" && issue.message.includes("目录不可用")) &&
      listLinks(movedAgentDir).length === 0,
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  await renameWithRetry(movedAgentDir, AGENT1);

  // [5.19] 源目录被删除（未刷新）：链接成为悬空；刷新后被清理
  state = await api.setAgentSkills(agentId, ["alpha"]);
  reporter.check(
    "5.19",
    "重建 alpha 链接成功",
    listLinks(AGENT1).join(",") === "alpha",
    JSON.stringify(listLinks(AGENT1)),
  );
  removeDirectoryTree(path.join(REPO_DIR, "alpha"));
  reporter.check(
    "5.19",
    "源目录删除后链接暂时悬空（未刷新时不变动）",
    listLinks(AGENT1).join(",") === "alpha",
  );
  state = await api.refresh();
  reporter.check(
    "5.19",
    "刷新后悬空链接被清理",
    listLinks(AGENT1).length === 0,
    JSON.stringify(listLinks(AGENT1)),
  );
  reporter.check(
    "5.19",
    "启用记录同步清理",
    state.enabledSkills[agentId].length === 0,
    JSON.stringify(state.enabledSkills),
  );

  // [5.20] 目标位置是已悬空的、指向仓库外的链接：保留并提示占用
  createDanglingLink(
    path.join(AGENT1, "beta"),
    path.join(TEST_DIR, ".tmp-dangling-target"),
  );
  state = await api.setAgentSkills(agentId, ["beta"]);
  reporter.check(
    "5.20",
    "悬空的外部链接被保留",
    fs.lstatSync(path.join(AGENT1, "beta")).isSymbolicLink(),
  );
  reporter.check(
    "5.20",
    "提示目标位置已被其他链接占用",
    state.issues.some((issue) => issue.message.includes("被其他链接占用")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  fs.unlinkSync(path.join(AGENT1, "beta"));

  // 前端交互与队列
  reporter.skip("5.1", "下拉选择与统计属前端行为，人工验证");
  reporter.skip("5.2", "分组开关联动属前端行为，人工验证");
  reporter.skip("5.3", "部分开启时的补齐语义属前端行为，人工验证");
  reporter.skip("5.4", "分组全开时的关闭语义属前端行为，人工验证");
  reporter.skip("5.5", "单独开关与联动属前端行为，人工验证");
  reporter.skip("5.6", "防抖合并由 08-skill-queue.mjs 覆盖");
  reporter.skip("5.7", "提交期间的新选择由 08-skill-queue.mjs 覆盖");
  reporter.skip("5.8", "失败回滚由 08-skill-queue.mjs 覆盖");
  reporter.skip("5.9", "失败时保留新选择由 08-skill-queue.mjs 覆盖");
  reporter.skip("5.17", "问题面板展示属前端行为，人工验证");
  reporter.skip("5.18", "插件隐藏时提交由 08-skill-queue.mjs 覆盖");

  reporter.finish();
}

runModule(main);
