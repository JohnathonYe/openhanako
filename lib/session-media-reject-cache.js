/**
 * 服务端：按「会话路径 + 模型 id」记住上游曾拒绝的媒体大类（image / video / audio）
 * 仅内存，进程重启清空；与桌面 Zustand 并行维护相同规则。
 */

/** @type {Map<string, Map<string, Set<"image"|"video"|"audio">>>} */
const root = new Map();
const MAX_SESSIONS = 48;

function pruneSessions() {
  while (root.size > MAX_SESSIONS) {
    const first = root.keys().next().value;
    root.delete(first);
  }
}

/**
 * @param {string} sessionPath
 * @param {string} modelId
 * @param {"image"|"video"|"audio"} kind
 */
export function isSessionMediaKindRejected(sessionPath, modelId, kind) {
  if (!sessionPath || !modelId) return false;
  return root.get(sessionPath)?.get(modelId)?.has(kind) ?? false;
}

/**
 * @param {string} sessionPath
 * @param {string} modelId
 * @param {Iterable<"image"|"video"|"audio">} kinds
 */
export function recordSessionMediaKindsRejected(sessionPath, modelId, kinds) {
  if (!sessionPath || !modelId) return;
  const list = [...kinds];
  if (!list.length) return;
  if (!root.has(sessionPath)) {
    root.set(sessionPath, new Map());
    pruneSessions();
  }
  const midMap = root.get(sessionPath);
  if (!midMap.has(modelId)) midMap.set(modelId, new Set());
  const set = midMap.get(modelId);
  for (const k of list) set.add(k);
}

/** 测试或切换 agent 时可选清理 */
export function clearSessionMediaRejectCache(sessionPath) {
  if (sessionPath) root.delete(sessionPath);
}
