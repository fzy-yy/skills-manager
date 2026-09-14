/**
 * uTools 文档数据库适配层。
 *
 * 业务层只传入“基线文档”和“期望文档”，本模块负责 revision 校验、冲突检测与批量写入，
 * 避免不同窗口或设备基于旧快照静默覆盖对方刚保存的数据。
 */

/** 去除 uTools 文档元字段，得到可稳定比较的业务内容。 */
function documentPayload(document) {
  if (!document) return undefined;
  const { _id, _rev, _attachments, ...payload } = document;
  return payload;
}

/** 递归稳定化对象键顺序，用于判断结构化数据是否真正发生变化。 */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function equalPayload(left, right) {
  return (
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right))
  );
}

/** 创建带冲突保护的文档仓库。 */
function createDocumentRepository(utools, prefix) {
  const db = utools?.db;
  if (!db)
    throw new Error(
      "uTools 本地数据库不可用，请在 uTools 插件环境中重新打开应用",
    );

  function readAll() {
    const documents = db.allDocs(prefix) || [];
    return new Map(documents.map((document) => [document._id, document]));
  }

  /**
   * 只写入相对基线真正发生变化的文档。若数据库已被其他窗口更新，则拒绝覆盖并要求重试。
   */
  function commit(baseline, desired) {
    const changedIds = [
      ...new Set([...baseline.keys(), ...desired.keys()]),
    ].filter((id) => !equalPayload(baseline.get(id), desired.get(id)));
    if (!changedIds.length) return new Map(desired);

    const latestDocuments = new Map(
      (db.allDocs(changedIds) || []).map((document) => [
        document._id,
        document,
      ]),
    );
    const writes = [];
    const removals = [];
    for (const id of changedIds) {
      const latest = latestDocuments.get(id);
      const latestPayload = documentPayload(latest);
      const baselinePayload = baseline.get(id);
      const desiredPayload = desired.get(id);
      if (
        !equalPayload(latestPayload, baselinePayload) &&
        !equalPayload(latestPayload, desiredPayload)
      ) {
        throw new Error("配置已被其他窗口或设备更新，请等待同步完成后重试");
      }
      if (desiredPayload === undefined) {
        if (latest) removals.push(latest);
      } else if (!equalPayload(latestPayload, desiredPayload)) {
        writes.push({
          _id: id,
          ...(latest?._rev ? { _rev: latest._rev } : {}),
          ...desiredPayload,
        });
      }
    }

    if (writes.length) {
      const results = db.bulkDocs(writes) || [];
      if (results.length !== writes.length)
        throw new Error("批量写入数据库返回结果不完整");
      const failed = results.find((result) => !result?.ok);
      if (failed)
        throw new Error(failed.message || failed.name || "批量写入数据库失败");
    }
    for (const document of removals) {
      const result = db.remove(document);
      if (!result?.ok)
        throw new Error(
          result?.message || result?.name || "删除数据库文档失败",
        );
    }
    return new Map(desired);
  }

  return { readAll, commit, documentPayload };
}

module.exports = { createDocumentRepository, documentPayload };
