/** preload 通用运行时工具：错误归一化、问题去重、超时与受控并发。 */
const fs = require("node:fs");

const DEFAULT_READ_TIMEOUT_MS = 15_000;

function errorMessage(error) {
  if (!error) return "未知错误";
  const code = error.code ? `${error.code}：` : "";
  return `${code}${error.message || String(error)}`;
}

function createIssue(type, message) {
  return {
    type: type === "error" ? "error" : type === "info" ? "info" : "warning",
    message,
  };
}

function uniqueIssues(issues) {
  const seen = new Set();
  return issues.filter((issue) => {
    const key = `${issue.type}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withReadTimeout(
  operation,
  label,
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label}超时（${timeoutMs / 1000} 秒）`);
      error.code = "ETIMEDOUT";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), items.length) },
      worker,
    ),
  );
  return results;
}

async function pathExists(target) {
  try {
    await withReadTimeout(fs.promises.access(target), `访问路径 ${target}`);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  createIssue,
  errorMessage,
  mapWithConcurrency,
  pathExists,
  uniqueIssues,
  withReadTimeout,
};
