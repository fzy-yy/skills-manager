/**
 * 测试断言与结果汇总工具。
 *
 * 输出格式约定：`PASS/FAIL/SKIP [文档编号] 场景描述`，
 * 编号与 `doc/用户操作与异常场景.md` 中的场景表格一一对应，便于定位与补测。
 */

/**
 * 创建当前模块的结果记录器。
 *
 * @param {string} moduleName - 模块名（用于汇总输出）
 * @returns {object} 记录器
 */
function createReporter(moduleName) {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  /** 打印分组标题。 */
  function section(title) {
    console.log(`\n-- ${title} --`);
  }

  /**
   * 记录一条断言。
   *
   * @param {string} id - 文档场景编号（如 "2.2.3"）
   * @param {string} label - 场景描述
   * @param {boolean} condition - 是否通过
   * @param {string} [extra] - 失败时的补充信息
   */
  function check(id, label, condition, extra = "") {
    if (condition) {
      passed += 1;
      console.log(`  PASS [${id}] ${label}`);
      return;
    }
    failed += 1;
    failures.push(`[${id}] ${label}`);
    console.log(`  FAIL [${id}] ${label}${extra ? `\n        ${extra}` : ""}`);
  }

  /**
   * 记录一个跳过项（无法自动化：权限、拔盘、多窗口、纯 UI 交互等）。
   *
   * @param {string} id - 文档场景编号
   * @param {string} reason - 跳过原因
   */
  function skip(id, reason) {
    skipped += 1;
    console.log(`  SKIP [${id}] ${reason}`);
  }

  /** 输出汇总并返回退出码（0 通过 / 1 失败）。 */
  function finish() {
    console.log(
      `\n[${moduleName}] 通过 ${passed}，失败 ${failed}，跳过 ${skipped}`,
    );
    if (failures.length) console.log(`失败项：\n  ${failures.join("\n  ")}`);
    process.exit(failed ? 1 : 0);
  }

  return { check, finish, section, skip };
}

module.exports = { createReporter };
