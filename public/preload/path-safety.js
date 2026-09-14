/** 路径规范化与目录边界校验，集中承载所有可能影响链接安全的判断。 */
const fs = require("node:fs");
const path = require("node:path");
const { errorMessage, pathExists, withReadTimeout } = require("./runtime");

async function normalizeDirectory(directory, label = "目录") {
  if (typeof directory !== "string" || !directory.trim())
    throw new Error(`请选择有效的${label}`);
  const resolved = path.resolve(directory.trim());
  let stat;
  try {
    stat = await withReadTimeout(fs.promises.stat(resolved), `检查${label}`);
  } catch (error) {
    throw new Error(`${label}不存在或无法访问：${errorMessage(error)}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label}不是文件夹：${resolved}`);
  return resolved;
}

function comparablePath(target) {
  let normalized = path.normalize(
    path.resolve(String(target).replace(/^\\\\\?\\/, "")),
  );
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/, "");
}

async function pathsEqual(left, right) {
  try {
    if (comparablePath(left) === comparablePath(right)) return true;
    const [leftExists, rightExists] = await Promise.all([
      pathExists(left),
      pathExists(right),
    ]);
    if (leftExists && rightExists) {
      const [leftRealPath, rightRealPath] = await Promise.all([
        withReadTimeout(fs.promises.realpath(left), `解析路径 ${left}`),
        withReadTimeout(fs.promises.realpath(right), `解析路径 ${right}`),
      ]);
      return comparablePath(leftRealPath) === comparablePath(rightRealPath);
    }
  } catch (_) {}
  return false;
}

async function isInsideDirectory(parent, child) {
  const canonical = async (target) => {
    try {
      return await withReadTimeout(
        fs.promises.realpath(target),
        `解析路径 ${target}`,
      );
    } catch (_) {
      return path.resolve(target);
    }
  };
  const [canonicalParent, canonicalChild] = await Promise.all([
    canonical(parent),
    canonical(child),
  ]);
  const relative = path.relative(canonicalParent, canonicalChild);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function assertSafeAgentDirectory(
  config,
  directory,
  currentAgentId = "",
) {
  let canonicalDirectory = directory;
  try {
    canonicalDirectory = await withReadTimeout(
      fs.promises.realpath(directory),
      `解析 Agent Skills 目录 ${directory}`,
    );
  } catch (_) {}
  if (path.parse(canonicalDirectory).root === canonicalDirectory)
    throw new Error("Agent Skills 目录不能是磁盘根目录");
  if (
    config.repositoryPath &&
    ((await isInsideDirectory(config.repositoryPath, directory)) ||
      (await isInsideDirectory(directory, config.repositoryPath)))
  )
    throw new Error(
      "Agent Skills 目录不能与统一 Skills 仓库相同或互相包含，以免扫描和链接相互影响",
    );

  for (const agent of config.agents) {
    if (agent.id === currentAgentId || !agent.directory) continue;
    if (await pathsEqual(agent.directory, directory))
      throw new Error(
        `该 Skills 目录已由 Agent“${agent.name}”使用，请选择其他目录`,
      );
  }
  for (const agent of config._orphanAgents || []) {
    if (agent.directory && (await pathsEqual(agent.directory, directory)))
      throw new Error(
        `该目录仍有 Agent“${agent.name}”的受管链接等待清理，请处理相关错误后刷新再试`,
      );
  }
}

module.exports = {
  assertSafeAgentDirectory,
  comparablePath,
  isInsideDirectory,
  normalizeDirectory,
  pathsEqual,
};
