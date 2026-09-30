/**
 * 模块 04：Agents 管理（对应文档第四章，preload 侧行为）。
 * 运行：node test_dir/test/04-agents.cjs
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

const reporter = createReporter("04-agents");
const [AGENT1, AGENT2, AGENT3] = AGENT_DIRS;

async function main() {
  const harness = createHarness("04-agents");
  const { api } = harness;

  let state = await api.setRepository(REPO_DIR);
  await api.refresh();

  reporter.section("Agent 创建校验");
  // [4.1] 名称缺失
  let error = await captureError(() =>
    api.createAgent({ name: "   ", directory: AGENT1 }),
  );
  reporter.check("4.1", "空名称被拒绝", Boolean(error?.message.includes("请输入 Agent 名称")), error?.message);

  // [4.2] 名称超长
  error = await captureError(() =>
    api.createAgent({ name: "长".repeat(121), directory: AGENT1 }),
  );
  reporter.check("4.2", "超长名称被拒绝", Boolean(error?.message.includes("不能超过")), error?.message);

  // [4.3] 目录含其他文件：允许创建，已有文件与目录保持不动
  fs.writeFileSync(path.join(AGENT1, "existing.txt"), "占位", "utf8");
  fs.mkdirSync(path.join(AGENT1, "existing-folder"));
  state = await api.createAgent({ name: "非空目录", directory: AGENT1 });
  reporter.check(
    "4.3",
    "含其他内容的目录可以创建 Agent",
    state.agents.length === 1,
    JSON.stringify(state.agents),
  );
  state = await api.refresh();
  reporter.check(
    "4.3",
    "刷新同步后已有文件与目录保持不动",
    fs.existsSync(path.join(AGENT1, "existing.txt")) &&
      fs.existsSync(path.join(AGENT1, "existing-folder")) &&
      !state.issues.some((issue) => issue.type === "error"),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  await api.deleteAgent(state.agents[0].id);
  fs.unlinkSync(path.join(AGENT1, "existing.txt"));
  fs.rmdirSync(path.join(AGENT1, "existing-folder"));

  // [4.8] 正常创建
  state = await api.createAgent({ name: "Agent One", directory: AGENT1 });
  reporter.check(
    "4.8",
    "创建成功且初始启用为空",
    state.agents.length === 1 && state.enabledSkills[state.agents[0].id].length === 0,
    JSON.stringify(state.agents),
  );
  const agentOne = state.agents[0];

  // [4.4] 目录已被占用（含大小写变体写法）
  error = await captureError(() =>
    api.createAgent({ name: "重复目录", directory: AGENT1.toUpperCase() }),
  );
  reporter.check(
    "4.4",
    "重复目录（大小写变体）被拒绝",
    Boolean(error?.message.includes("已由 Agent")),
    error?.message,
  );

  // [4.5] 目录与仓库互相包含
  error = await captureError(() =>
    api.createAgent({ name: "仓库内目录", directory: path.join(REPO_DIR, "alpha") }),
  );
  reporter.check(
    "4.5",
    "仓库内目录被拒绝",
    Boolean(error?.message.includes("互相包含")),
    error?.message,
  );

  // [4.6] 磁盘根目录
  error = await captureError(() =>
    api.createAgent({ name: "磁盘根", directory: path.parse(TEST_DIR).root }),
  );
  reporter.check("4.6", "磁盘根目录被拒绝", Boolean(error?.message.includes("磁盘根目录")), error?.message);

  // [4.7] 目录不存在
  error = await captureError(() =>
    api.createAgent({ name: "不存在", directory: path.join(TEST_DIR, "no-such-dir") }),
  );
  reporter.check("4.7", "不存在的目录被拒绝", Boolean(error?.message.includes("不存在或无法访问")), error?.message);

  // [4.14] 重名 Agent：自动追加递增序号
  state = await api.createAgent({ name: "Agent One", directory: AGENT2 });
  reporter.check(
    "4.14",
    "重名 Agent 自动追加递增序号",
    state.agents.filter((agent) => agent.name.startsWith("Agent One")).length === 2 &&
      state.agents.some((agent) => agent.name === "Agent One (2)"),
    JSON.stringify(state.agents.map((agent) => agent.name)),
  );
  reporter.check(
    "4.14",
    "给出自动重命名提示",
    state.issues.some((issue) => issue.message.includes("已自动重命名为")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  const agentTwo = state.agents.find((agent) => agent.directory.toLowerCase().includes("agents2"));

  reporter.section("Agent 删除与清理");
  // [4.10] 删除 Agent 时清理链接
  state = await api.setAgentSkills(agentOne.id, ["alpha", "beta"]);
  reporter.check("4.10", "删除前链接已建立", listLinks(AGENT1).length === 2);
  state = await api.deleteAgent(agentOne.id);
  reporter.check(
    "4.10",
    "删除后 Agent 消失、链接被清理",
    !state.agents.some((agent) => agent.id === agentOne.id) &&
      listLinks(AGENT1).length === 0,
    JSON.stringify({ agents: state.agents.length, links: listLinks(AGENT1) }),
  );
  reporter.check(
    "4.10",
    "删除后启用记录被移除",
    state.enabledSkills[agentOne.id] === undefined,
  );

  // [4.13] 删除 Agent 时保留目录中的普通文件与指向仓库外的链接
  fs.writeFileSync(path.join(AGENT2, "keep-me.txt"), "保留内容", "utf8");
  fs.symlinkSync(AGENT1, path.join(AGENT2, "outside-link"), "junction");
  createDanglingLink(
    path.join(AGENT2, "dangling-link"),
    path.join(TEST_DIR, ".tmp-dangling-target"),
  );
  state = await api.deleteAgent(agentTwo.id);
  reporter.check(
    "4.13",
    "普通文件与外部链接（含悬空）未被删除",
    fs.existsSync(path.join(AGENT2, "keep-me.txt")) &&
      fs.lstatSync(path.join(AGENT2, "outside-link")).isSymbolicLink() &&
      fs.lstatSync(path.join(AGENT2, "dangling-link")).isSymbolicLink(),
    JSON.stringify(listLinks(AGENT2)),
  );
  fs.unlinkSync(path.join(AGENT2, "keep-me.txt"));
  fs.unlinkSync(path.join(AGENT2, "outside-link"));
  fs.unlinkSync(path.join(AGENT2, "dangling-link"));

  // [4.11] Agent 目录已被删除时仍可删除 Agent
  state = await api.createAgent({ name: "临时 Agent", directory: AGENT3 });
  const agentThree = state.agents[0];
  removeDirectoryTree(AGENT3);
  state = await api.deleteAgent(agentThree.id);
  reporter.check(
    "4.11",
    "目录已被删除时删除 Agent 成功（静默跳过链接清理）",
    !state.agents.some((agent) => agent.id === agentThree.id),
    JSON.stringify(state.agents),
  );
  fs.mkdirSync(AGENT3, { recursive: true });

  // [4.17] 历史配置中的重名 Agent：读取时自动重命名并提示
  const legacyStored = harness.readStoredState();
  legacyStored.agents = [
    { id: "legacy-a1", name: "历史 Agent", directory: AGENT1 },
    { id: "legacy-a2", name: "历史 Agent", directory: AGENT2 },
  ];
  harness.writeStoredState(JSON.stringify(legacyStored));
  const legacyState = await api.getState();
  reporter.check(
    "4.17",
    "历史配置中的重名 Agent 读取时自动重命名",
    legacyState.agents.map((agent) => agent.name).join("|") ===
      "历史 Agent|历史 Agent (2)",
    JSON.stringify(legacyState.agents.map((agent) => agent.name)),
  );
  reporter.check(
    "4.17",
    "并给出自动重命名提示",
    legacyState.issues.some((issue) => issue.message.includes("已自动添加序号")),
    JSON.stringify(legacyState.issues.map((issue) => issue.message)),
  );

  // [4.18] 打开 Agent 目录（卡片按钮）
  state = await api.createAgent({ name: "目录 Agent", directory: AGENT3 });
  const folderAgent = state.agents.find((agent) => agent.name === "目录 Agent");
  await api.openAgentFolder(folderAgent.id);
  reporter.check(
    "4.18",
    "打开的是该 Agent 的 Skills 目录",
    harness.openedPaths.at(-1) === folderAgent.directory,
    JSON.stringify({
      opened: harness.openedPaths.at(-1),
      expected: folderAgent.directory,
    }),
  );
  const movedForOpen = path.join(TEST_DIR, ".tmp-agent-open");
  await renameWithRetry(AGENT3, movedForOpen);
  const openAgentError = await captureError(() => api.openAgentFolder(folderAgent.id));
  reporter.check(
    "4.18",
    "目录被移走时提示不存在",
    Boolean(openAgentError?.message.includes("不存在或已被移动")),
    openAgentError?.message,
  );
  await renameWithRetry(movedForOpen, AGENT3);
  await api.deleteAgent(folderAgent.id);

  reporter.section("绑定前已有内容的收敛语义");
  // [4.19] 绑定前已有指向仓库的链接：未启用被清理、启用后保留复用
  fs.symlinkSync(path.join(REPO_DIR, "beta"), path.join(AGENT3, "beta"), "junction");
  state = await api.createAgent({ name: "接管链接", directory: AGENT3 });
  const takeoverAgent = state.agents.find((agent) => agent.name === "接管链接");
  state = await api.refresh();
  reporter.check(
    "4.19",
    "绑定前已有、未启用的仓库内链接被清理",
    !listLinks(AGENT3).includes("beta"),
    JSON.stringify(listLinks(AGENT3)),
  );
  fs.symlinkSync(path.join(REPO_DIR, "beta"), path.join(AGENT3, "beta"), "junction");
  state = await api.setAgentSkills(takeoverAgent.id, ["beta"]);
  state = await api.refresh();
  reporter.check(
    "4.19",
    "绑定前已有的同名同源链接在启用后被保留复用",
    listLinks(AGENT3).join(",") === "beta",
    JSON.stringify(listLinks(AGENT3)),
  );

  // [4.20] 绑定前已有指向仓库外的链接（有效 / 悬空）：一律保留
  fs.symlinkSync(AGENT2, path.join(AGENT3, "outside-link"), "junction");
  createDanglingLink(
    path.join(AGENT3, "dangling-link"),
    path.join(TEST_DIR, ".tmp-dangling-target"),
  );
  state = await api.refresh();
  reporter.check(
    "4.20",
    "指向仓库外的有效链接与悬空链接都被保留",
    fs.lstatSync(path.join(AGENT3, "outside-link")).isSymbolicLink() &&
      fs.lstatSync(path.join(AGENT3, "dangling-link")).isSymbolicLink(),
    JSON.stringify(listLinks(AGENT3)),
  );
  fs.unlinkSync(path.join(AGENT3, "outside-link"));
  fs.unlinkSync(path.join(AGENT3, "dangling-link"));
  await api.deleteAgent(takeoverAgent.id);

  // [4.12] 单个链接删除失败：需要构造权限错误，代码走查
  reporter.skip("4.12", "需要构造删除权限错误，代码走查");
  // [4.9] 无编辑入口属前端行为
  reporter.skip("4.9", "创建后不可修改属前端行为（无编辑入口），人工验证");
  // [4.15]/[4.16] 前端问题面板与空状态
  reporter.skip("4.15", "渲染层遗留问题清理由 appStore 处理，人工验证");
  reporter.skip("4.16", "前端空状态属 UI 行为，人工验证");

  reporter.finish();
}

runModule(main);
