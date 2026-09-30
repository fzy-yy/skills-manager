/**
 * 模块 07：用户手动改动与外部环境变化（对应文档第七章）。
 * 运行：node test_dir/test/07-manual-changes.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_DIRS,
  REPO_DIR,
  TEST_DIR,
  createDanglingLink,
  createHarness,
  listLinks,
  removeDirectoryTree,
  renameWithRetry,
} = require("./helpers/harness.cjs");
const { createReporter, runModule } = require("./helpers/reporter.cjs");

const reporter = createReporter("07-manual-changes");
const [AGENT1, AGENT2] = AGENT_DIRS;

async function main() {
  const harness = createHarness("07-manual-changes");
  const { api } = harness;

  let state = await api.setRepository(REPO_DIR);
  state = await api.createAgent({ name: "手动改动 Agent", directory: AGENT1 });
  const agentId = state.agents[0].id;

  reporter.section("手动改动链接与文件");
  // [7.1] 手动删除链接后刷新重建
  await api.setAgentSkills(agentId, ["alpha"]);
  fs.unlinkSync(path.join(AGENT1, "alpha"));
  state = await api.refresh();
  reporter.check("7.1", "手动删除的链接被重建", listLinks(AGENT1).join(",") === "alpha");

  // [7.2] 链接被替换为普通目录：保留内容并提示冲突
  fs.unlinkSync(path.join(AGENT1, "alpha"));
  fs.mkdirSync(path.join(AGENT1, "alpha"));
  fs.writeFileSync(path.join(AGENT1, "alpha", "real-file.txt"), "内容", "utf8");
  state = await api.refresh();
  reporter.check(
    "7.2",
    "替换后的普通目录被保留",
    fs.existsSync(path.join(AGENT1, "alpha", "real-file.txt")),
  );
  reporter.check(
    "7.2",
    "提示目标位置已有同名目录",
    state.issues.some((issue) => issue.message.includes("已有同名的目录")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  removeDirectoryTree(path.join(AGENT1, "alpha"));

  // [7.3] 手动创建指向仓库外的链接：永不触碰（含悬空）
  fs.symlinkSync(AGENT2, path.join(AGENT1, "outside-link"), "junction");
  createDanglingLink(
    path.join(AGENT1, "dangling-link"),
    path.join(TEST_DIR, ".tmp-dangling-target"),
  );
  state = await api.refresh();
  reporter.check(
    "7.3",
    "指向仓库外的有效链接与悬空链接都被保留",
    fs.lstatSync(path.join(AGENT1, "outside-link")).isSymbolicLink() &&
      fs.lstatSync(path.join(AGENT1, "dangling-link")).isSymbolicLink(),
    JSON.stringify(listLinks(AGENT1)),
  );
  fs.unlinkSync(path.join(AGENT1, "outside-link"));
  fs.unlinkSync(path.join(AGENT1, "dangling-link"));

  // [7.4] 手动创建指向仓库内未启用 Skill 的链接：视为残留并删除
  await api.setAgentSkills(agentId, []);
  fs.symlinkSync(path.join(REPO_DIR, "beta"), path.join(AGENT1, "beta"), "junction");
  state = await api.refresh();
  reporter.check(
    "7.4",
    "仓库内未启用 Skill 的手动链接被清理",
    !listLinks(AGENT1).includes("beta"),
    JSON.stringify(listLinks(AGENT1)),
  );

  // [7.5] 手动创建指向仓库内已启用 Skill 的同名链接：保留且不重复创建
  await api.setAgentSkills(agentId, ["alpha"]);
  fs.unlinkSync(path.join(AGENT1, "alpha"));
  fs.symlinkSync(path.join(REPO_DIR, "alpha"), path.join(AGENT1, "alpha"), "junction");
  state = await api.refresh();
  reporter.check(
    "7.5",
    "已启用的同源链接被保留且只有一个",
    listLinks(AGENT1).join(",") === "alpha",
    JSON.stringify(listLinks(AGENT1)),
  );

  // [7.6] 普通文件永不删除
  fs.writeFileSync(path.join(AGENT1, "notes.txt"), "普通文件", "utf8");
  state = await api.refresh();
  reporter.check(
    "7.6",
    "目录中的普通文件被完整保留",
    fs.existsSync(path.join(AGENT1, "notes.txt")) &&
      !state.issues.some((issue) => issue.type === "error"),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  fs.unlinkSync(path.join(AGENT1, "notes.txt"));

  reporter.section("手动编辑 state.json");
  // [7.7] 未知字段被忽略并在下次写入时丢弃
  const stored = harness.readStoredState();
  stored.unknownField = { some: "data" };
  harness.writeStoredState(JSON.stringify(stored));
  state = await api.getState();
  reporter.check("7.7", "未知字段不影响读取", state.agents.length === 1);
  await api.setTheme("dark");
  reporter.check(
    "7.7",
    "写入后未知字段被丢弃",
    !("unknownField" in (harness.readStoredState() || {})),
    JSON.stringify(harness.readStoredState()),
  );

  // [7.8] 重复 id 记录被去重并提示
  const storedDuplicate = harness.readStoredState();
  storedDuplicate.agents = [
    storedDuplicate.agents[0],
    { ...storedDuplicate.agents[0], name: "重复项" },
  ];
  storedDuplicate.groups = [
    { id: "dup-group", name: "重复组", skillIds: [] },
    { id: "dup-group", name: "重复组 2", skillIds: [] },
  ];
  harness.writeStoredState(JSON.stringify(storedDuplicate));
  state = await api.getState();
  reporter.check(
    "7.8",
    "重复的 Agent 与分组被去重",
    state.agents.length === 1 && state.groups.length === 1,
    JSON.stringify({ agents: state.agents.length, groups: state.groups.length }),
  );
  reporter.check(
    "7.8",
    "给出“无效或重复”提示",
    state.issues.some((issue) => issue.message.includes("无效或重复")),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  await api.setTheme("light"); // 修复被重复数据污染的配置
  await api.refresh();

  // [7.9] 缺少 theme 字段时使用默认浅色
  const storedNoTheme = harness.readStoredState();
  delete storedNoTheme.theme;
  harness.writeStoredState(JSON.stringify(storedNoTheme));
  state = await api.getState();
  reporter.check("7.9", "缺少 theme 字段时默认为浅色", state.theme === "light");

  // [7.10] 手工修改 Agent 目录路径（已知局限：旧链接成为孤儿）
  state = await api.setAgentSkills(agentId, ["alpha"]);
  reporter.check("7.10", "旧目录链接存在", listLinks(AGENT1).join(",") === "alpha");
  const storedMoved = harness.readStoredState();
  storedMoved.agents[0].directory = AGENT2;
  harness.writeStoredState(JSON.stringify(storedMoved));
  state = await api.setAgentSkills(agentId, ["alpha", "beta"]);
  reporter.check(
    "7.10",
    "新目录按手工配置创建链接",
    listLinks(AGENT2).length === 2,
    JSON.stringify(listLinks(AGENT2)),
  );
  reporter.check(
    "7.10",
    "旧目录链接成为孤儿残留（已知局限）",
    listLinks(AGENT1).join(",") === "alpha",
    JSON.stringify(listLinks(AGENT1)),
  );

  reporter.section("外部环境变化");
  // [7.11] 移动 Agent 目录：刷新时该 Agent 报错且不清理（注意此时该 Agent 的目录是 AGENT2）
  const movedAgent = path.join(TEST_DIR, ".tmp-agent-moved");
  await renameWithRetry(AGENT2, movedAgent);
  state = await api.refresh();
  reporter.check(
    "7.11",
    "移动后的 Agent 目录报不可用",
    state.issues.some(
      (issue) => issue.type === "error" && issue.message.includes("目录不可用"),
    ),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  await renameWithRetry(movedAgent, AGENT2);

  // [7.12] 移动仓库目录：报错；重新设置新路径后收敛
  const movedRepo = path.join(TEST_DIR, ".tmp-repo-moved");
  await renameWithRetry(REPO_DIR, movedRepo);
  state = await api.refresh();
  reporter.check(
    "7.12",
    "仓库移动后刷新报错",
    state.issues.some((issue) => issue.type === "error"),
    JSON.stringify(state.issues.map((issue) => issue.message)),
  );
  state = await api.setRepository(movedRepo);
  reporter.check(
    "7.12",
    "重新设置新路径后扫描收敛",
    state.skills.length === 3 &&
      !state.issues.some((issue) => issue.type === "error"),
    JSON.stringify(state.skills.map((skill) => skill.id)),
  );
  await renameWithRetry(movedRepo, REPO_DIR);
  await api.setRepository(REPO_DIR);

  // [7.18] 仓库路径缺失时删除 Agent：无法识别受管链接，不删除任何链接
  state = await api.setAgentSkills(agentId, ["alpha"]);
  fs.symlinkSync(AGENT1, path.join(AGENT2, "user-link"), "junction");
  const storedNoRepo = harness.readStoredState();
  storedNoRepo.repositoryPath = "";
  harness.writeStoredState(JSON.stringify(storedNoRepo));
  state = await api.deleteAgent(agentId);
  reporter.check(
    "7.18",
    "仓库路径缺失时不删除目录中的任何链接",
    listLinks(AGENT2).join(",") === "alpha,user-link",
    JSON.stringify(listLinks(AGENT2)),
  );
  fs.unlinkSync(path.join(AGENT2, "alpha"));
  fs.unlinkSync(path.join(AGENT2, "user-link"));

  // 需要特殊环境或人工验证的场景
  reporter.skip("7.13", "需要可拔插磁盘环境，人工验证");
  reporter.skip("7.14", "需要构造只读目录权限，代码走查");
  reporter.skip("7.15", "多窗口并发属已知取舍，需真实多窗口环境");
  reporter.skip("7.16", "uTools 重装后数据保留，人工验证");
  reporter.skip("7.17", "清理数据目录后的行为属已知限制，人工验证");

  reporter.finish();
}

runModule(main);
