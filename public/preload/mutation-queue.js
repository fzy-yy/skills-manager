/**
 * 写操作串行队列：把一组方法包装成「串行 + 超时」的执行器。
 *
 * 与业务无关，因此单独成文件、可独立测试。两个目标相互独立：
 *  1. 串行：下一次操作必须等上一次「底层操作本身」结束，超时不解除串行，
 *     因此迟到的磁盘操作不会与新操作交叉；
 *  2. 超时：只让调用方停止等待，不锁死队列——底层操作结束后后续操作会自动继续
 *     （调用方的每次文件访问都有各自的操作级超时兜底，底层操作本身是有界的）。
 *
 * 超时计时从操作真正开始执行时起算，排队等待时间不计入预算。
 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 就地为指定方法挂上串行 + 超时包装。
 *
 * @param {object} api - 方法所在的对象（会被就地修改）
 * @param {string[]} methodNames - 需要串行化的方法名
 * @param {{timeoutMs?: number}} [options] - timeoutMs 为调用方等待上限
 * @returns {object} 同一个 api 对象，便于链式返回
 */
function serializeMutations(
  api,
  methodNames,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  let tail = Promise.resolve();

  function runWithTimeout(operation) {
    let timer;
    let markStarted;
    const started = new Promise((resolve) => (markStarted = resolve));
    const execution = tail.then(() => {
      markStarted();
      return operation();
    });
    tail = execution.catch(() => undefined);
    const timeout = started.then(
      () =>
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `文件操作超过 ${Math.round(timeoutMs / 1000)} 秒，已停止等待。操作可能仍在后台继续，请稍后查看结果；后续操作会在其结束后自动开始。`,
                ),
              ),
            timeoutMs,
          );
        }),
    );
    return Promise.race([execution, timeout]).finally(() =>
      clearTimeout(timer),
    );
  }

  methodNames.forEach((method) => {
    const operation = api[method].bind(api);
    api[method] = (...args) => runWithTimeout(() => operation(...args));
  });
  return api;
}

module.exports = { DEFAULT_TIMEOUT_MS, serializeMutations };
