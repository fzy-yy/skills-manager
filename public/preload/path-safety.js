/** 路径规范化与目录边界校验，集中承载所有可能影响链接安全的判断。 */
const fs = require("node:fs");
const path = require("node:path");
const { errorMessage, pathExists, withReadTimeout } = require("./runtime");

/**
 * 词法规范化：统一为绝对路径、去掉 Windows \\?\ 前缀、统一大小写（win32）与尾随分隔符。
 * 只做字符串处理，不访问文件系统。
 */
function comparablePath(target) {
  let normalized = path.normalize(
    path.resolve(String(target).replace(/^\\\\\?\\/, "")),
  );
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return normalized.replace(/[\\/]+$/, "");
}

/**
 * 纯词法比较两个路径是否等价（大小写、分隔符、尾随分隔符、\\?\ 前缀均归一化）。
 * 不访问文件系统，因此不会出现“realpath 失败后静默回退到另一个结论”的风险，
 * 适合用于只有字符串信息时的判断（例如 Agent 仅改名、目录未变的等价性比较）。
 *
 * @param {string} left - 左路径
 * @param {string} right - 右路径
 * @returns {boolean} 纯词法上是否等价
 */
function pathsEqualLexical(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (!left.trim() || !right.trim()) return false;
  return comparablePath(left) === comparablePath(right);
}

/**
 * 判断目标是不是磁盘根目录（Windows 盘符根 C:\\、UNC 共享根 \\server\share）。
 * 纯词法比较，不访问文件系统。
 *
 * @param {string} target - 待判断路径
 * @returns {boolean} 是否为磁盘根目录
 */
function isDiskRoot(target) {
  if (typeof target !== "string" || !target.trim()) return false;
  const resolved = path.normalize(
    path.resolve(String(target).replace(/^\\\\\?\\/, "")),
  );
  if (!path.isAbsolute(resolved)) return false;
  // 必须在去掉尾随分隔符之前取 root：否则 "C:\" 会被 path.parse 当作盘符相对路径。
  const root = path.parse(resolved).root;
  return root !== "" && comparablePath(root) === comparablePath(resolved);
}

/**
 * 断言目标不是磁盘根目录。
 *
 * 传入的必须是 canonical（realpath 之后的）绝对路径：这样“指向磁盘根的 junction /
 * 符号链接”会因 realpath 得到根路径而被一并拦下；UNC 共享根与盘符根都会被识别。
 * 安全判断在无法解析真实路径时应由调用方 fail closed（拒绝操作），而不是退回词法路径。
 *
 * @param {string} target - canonical 绝对路径
 * @param {string} [label] - 错误信息中使用的名称
 * @throws {Error} 目标为空、不是绝对路径或是磁盘根目录时抛出
 */
function assertNotDiskRoot(target, label = "目录") {
  if (typeof target !== "string" || !target.trim())
    throw new Error(`请选择有效的${label}`);
  if (!path.isAbsolute(target))
    throw new Error(`${label}必须是绝对路径，请重新选择`);
  if (isDiskRoot(target))
    throw new Error(`${label}不能是磁盘根目录，请选择专用的文件夹`);
}

/**
 * 把路径解析为 canonical 真实路径（realpath）。
 * 无法解析时直接抛出，绝不回退到词法路径——所有安全判断必须基于真实路径且 fail closed。
 *
 * @param {string} directory - 待解析路径
 * @param {string} [label] - 错误信息中使用的名称
 * @returns {Promise<string>} canonical 绝对路径
 * @throws {Error} 路径不存在、无权限或解析超时
 */
async function canonicalDirectory(directory, label = "目录") {
  const resolved = path.resolve(String(directory));
  try {
    return await withReadTimeout(
      fs.promises.realpath(resolved),
      `解析${label}真实路径 ${resolved}`,
    );
  } catch (error) {
    throw new Error(
      `无法解析${label}的真实路径（${resolved}）：${errorMessage(error)}`,
    );
  }
}

/**
 * 校验并规范化目录：必须存在、是文件夹，并返回 canonical（realpath）路径。
 *
 * 关键点：返回值始终是真实路径，符号链接 / junction 会被解析到真实目标，
 * 保存与后续所有根目录、互包含、去重判断都基于该 canonical 路径。
 *
 * @param {string} directory - 用户输入目录
 * @param {string} [label] - 错误信息中使用的名称
 * @returns {Promise<string>} canonical 绝对路径
 */
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
  return canonicalDirectory(resolved, label);
}

/**
 * 判断两个路径是否指向同一位置（先词法，再比较真实路径）。
 *
 * fail closed：无法解析真实路径时返回 false（“无法证明相等”），
 * 调用方因此不会执行任何基于“同一条链接 / 同一个目录”的删除或替换动作。
 *
 * @param {string} left - 左路径
 * @param {string} right - 右路径
 * @returns {Promise<boolean>} 是否能证明二者相同
 */
async function pathsEqual(left, right) {
  if (pathsEqualLexical(left, right)) return true;
  if (typeof left !== "string" || typeof right !== "string") return false;
  try {
    const [leftExists, rightExists] = await Promise.all([
      pathExists(left),
      pathExists(right),
    ]);
    if (!leftExists || !rightExists) return false;
    const [leftRealPath, rightRealPath] = await Promise.all([
      withReadTimeout(fs.promises.realpath(left), `解析路径 ${left}`),
      withReadTimeout(fs.promises.realpath(right), `解析路径 ${right}`),
    ]);
    return pathsEqualLexical(leftRealPath, rightRealPath);
  } catch (_) {
    // 无法解析真实路径时不能断言“不相等”：返回 false 表示无法证明相等，
    // 避免把不同路径当成同一条链接而误删内容。
    return false;
  }
}

/**
 * 纯词法判断 child 是否位于 parent 之内（含相等）。
 *
 * @param {string} parent - 父目录
 * @param {string} child - 子路径
 * @returns {boolean} 词法上是否被 parent 包含
 */
function isInsideDirectoryLexical(parent, child) {
  if (typeof parent !== "string" || typeof child !== "string") return false;
  if (!parent.trim() || !child.trim()) return false;
  const relative = path.relative(comparablePath(parent), comparablePath(child));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/**
 * 判断 child 是否位于 parent 之内（含相等），基于真实路径。
 *
 * fail closed 约定：父目录或子路径任一无法解析时都返回 true（保守认定可能包含），
 * 以“重叠即拒绝”为条件的调用方会因此拒绝操作，不用较弱的词法结论授权写入。
 *
 * @param {string} parent - 父目录
 * @param {string} child - 子路径
 * @returns {Promise<boolean>} 是否（可能）被 parent 包含
 */
async function isInsideDirectory(parent, child) {
  let canonicalParent;
  try {
    canonicalParent = await canonicalDirectory(parent, "父目录");
  } catch (_) {
    return true;
  }
  let canonicalChild;
  try {
    canonicalChild = await canonicalDirectory(child, "子目录");
  } catch (_) {
    return true;
  }
  return isInsideDirectoryLexical(canonicalParent, canonicalChild);
}

/**
 * 找出列表中第一个与其他项指向同一目录的重复项。
 * 使用“真实路径 → 规范化”的键做单次遍历，避免两两比较带来的重复 IO。
 * 某一目录无法解析真实路径时退回词法键：仍能拦下字符串完全相同的重复，
 * 且不会因为其中一个目录暂时离线就让整份配置无法读取。
 *
 * @param {string[]} directories - 待检查的目录列表
 * @returns {Promise<string>} 重复出现的目录；没有重复时返回空字符串
 */
async function findDuplicateDirectory(directories) {
  const seen = new Set();
  for (const directory of directories) {
    let key;
    try {
      key = comparablePath(await canonicalDirectory(directory));
    } catch (_) {
      key = comparablePath(directory);
    }
    if (seen.has(key)) return directory;
    seen.add(key);
  }
  return "";
}

/**
 * 校验 Agent 目录是否可以安全使用：不是磁盘根目录、不与仓库互相包含、
 * 未被其他 Agent 或待清理 Agent 占用。
 *
 * directory 会被解析为 canonical 路径，无法解析时直接拒绝（fail closed）。
 *
 * @param {object} config - 当前配置
 * @param {string} directory - 待校验的 Agent 目录
 * @param {string} [currentAgentId] - 当前正在编辑的 Agent id（允许与其自身目录相同）
 * @throws {Error} 目录不安全时抛出
 */
async function assertSafeAgentDirectory(
  config,
  directory,
  currentAgentId = "",
) {
  const canonicalTarget = await canonicalDirectory(
    directory,
    "Agent Skills 目录",
  );
  assertNotDiskRoot(canonicalTarget, "Agent Skills 目录");

  // 先做“已被占用”判断：与已有 Agent 目录等价时优先给出更具体的提示。
  for (const agent of config.agents) {
    if (agent.id === currentAgentId || !agent.directory) continue;
    if (await pathsEqual(agent.directory, canonicalTarget))
      throw new Error(
        `该 Skills 目录已由 Agent“${agent.name}”使用，请选择其他目录`,
      );
  }
  for (const agent of config._orphanAgents || []) {
    if (agent.directory && (await pathsEqual(agent.directory, canonicalTarget)))
      throw new Error(
        `该目录仍有 Agent“${agent.name}”的受管链接等待清理，请处理相关错误后刷新再试`,
      );
  }

  if (
    config.repositoryPath &&
    ((await isInsideDirectory(config.repositoryPath, canonicalTarget)) ||
      (await isInsideDirectory(canonicalTarget, config.repositoryPath)))
  )
    throw new Error(
      "Agent Skills 目录不能与统一 Skills 仓库相同或互相包含，以免扫描和链接相互影响",
    );
}

module.exports = {
  assertNotDiskRoot,
  assertSafeAgentDirectory,
  canonicalDirectory,
  findDuplicateDirectory,
  isDiskRoot,
  isInsideDirectory,
  isInsideDirectoryLexical,
  normalizeDirectory,
  pathsEqual,
  pathsEqualLexical,
};
