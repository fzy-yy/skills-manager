/**
 * 模块 03：分组管理（对应文档第三章，preload 侧行为）。
 * 运行：node test_dir/test/03-groups.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const {
  AGENT_DIRS,
  REPO_DIR,
  captureError,
  createHarness,
  listLinks,
  removeDirectoryTree,
} = require("./helpers/harness.cjs");
const { createReporter } = require("./helpers/reporter.cjs");

const reporter = createReporter("03-groups");
const AGENT1 = AGENT_DIRS[0];

async function main() {
  const harness = createHarness("03-groups");
  const { api } = harness;

  let state = await api.setRepository(REPO_DIR);
  state = await api.createAgent({ name: "Group Agent", directory: AGENT1 });
  const agentId = state.agents[0].id;
  await api.refresh();
  state = await api.getState();

  reporter.section("分组的保存与校验");
  // [3.4] 保存分组成功
  state = await api.saveGroups([
    { id: "group-1", name: "前端开发", skillIds: ["alpha", "beta"] },
  ]);
  reporter.check(
    "3.4",
    "分组保存成功且内容正确",
    state.groups.length === 1 &&
      state.groups[0].name === "前端开发" &&
      state.groups[0].skillIds.length === 2,
    JSON.stringify(state.groups),
  );

  // [3.5] 分组名为空
  let error = await captureError(() =>
    api.saveGroups([{ id: "group-2", name: "   ", skillIds: [] }]),
  );
  reporter.check(
    "3.5",
    "空名称被拒绝",
    Boolean(error?.message.includes("请输入分组名称")),
    error?.message,
  );

  // [3.6] 分组名超长
  error = await captureError(() =>
    api.saveGroups([{ id: "group-3", name: "长".repeat(121), skillIds: [] }]),
  );
  reporter.check(
    "3.6",
    "超过 120 字符的名称被拒绝",
    Boolean(error?.message.includes("不能超过")),
    error?.message,
  );

  // [3.7] 保存时自动过滤仓库中不存在的 Skill
  state = await api.saveGroups([
    { id: "group-4", name: "含失效引用", skillIds: ["alpha", "不存在的技能"] },
  ]);
  reporter.check(
    "3.7",
    "失效 Skill 引用被自动过滤",
    state.groups[0].skillIds.length === 1 && state.groups[0].skillIds[0] === "alpha",
    JSON.stringify(state.groups[0]),
  );

  // [3.9] 允许重名分组
  state = await api.saveGroups([
    { id: "group-5", name: "同名组", skillIds: [] },
    { id: "group-6", name: "同名组", skillIds: [] },
  ]);
  reporter.check(
    "3.9",
    "两个同名分组可以共存",
    state.groups.filter((group) => group.name === "同名组").length === 2,
  );

  // [3.4 补充] 重复 id 被拒绝
  error = await captureError(() =>
    api.saveGroups([
      { id: "group-7", name: "A", skillIds: [] },
      { id: "group-7", name: "B", skillIds: [] },
    ]),
  );
  reporter.check(
    "3.4",
    "重复的分组 id 被拒绝",
    Boolean(error?.message.includes("分组标识重复")),
    error?.message,
  );

  reporter.section("分组与链接的关系");
  // [3.8] 删除分组不影响 Agent 已开启的 Skills 与链接
  await api.setAgentSkills(agentId, ["alpha", "beta"]);
  reporter.check("3.8", "启用两个 Skill 后链接存在", listLinks(AGENT1).length === 2);
  state = await api.saveGroups([
    { id: "group-8", name: "仅保留的组", skillIds: ["alpha", "beta"] },
  ]);
  reporter.check(
    "3.8",
    "删除其他分组后链接不受影响",
    listLinks(AGENT1).length === 2 &&
      state.enabledSkills[agentId].length === 2,
    JSON.stringify({ links: listLinks(AGENT1), enabled: state.enabledSkills }),
  );

  // [3.10] 分组的 Skill 被删除后刷新：引用清理 + 提示
  removeDirectoryTree(path.join(REPO_DIR, "beta"));
  state = await api.refresh();
  reporter.check(
    "3.10",
    "分组中的失效引用被清理并提示",
    state.groups[0].skillIds.length === 1 &&
      state.groups[0].skillIds[0] === "alpha" &&
      state.issues.some((issue) => issue.message.includes("分组“仅保留的组”")),
    JSON.stringify({ groups: state.groups, issues: state.issues }),
  );

  // 前端状态机（新建草稿、脏检查、切换确认）与空状态属 UI，人工验证
  reporter.skip("3.1", "新建按钮禁用与空状态属前端行为，人工验证");
  reporter.skip("3.2", "分组草稿状态机属前端行为，人工验证");
  reporter.skip("3.3", "未保存修改的确认框属前端行为，人工验证");
  reporter.skip("3.11", "应用配置页空状态属前端行为，人工验证");

  reporter.finish();
}

main().catch((error) => {
  console.error("测试脚本异常：", error);
  process.exit(1);
});
