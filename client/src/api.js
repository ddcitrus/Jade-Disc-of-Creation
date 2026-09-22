// ===== 后端 API 封装 =====
const BASE = '/api';

// 请求超时：服务端一旦假死（进程卡住、socket 不断开），fetch 会**永远 pending**——
// 界面就会一直转圈，玩家看不到任何理由。给它一个上限，宁可报错也不要无声挂死。
// 注意：AI 类接口本身耗时较长，各自单独给时限（见文件末尾 api 对象）。
const DEFAULT_TIMEOUT = 30000;

function timeoutError(ms, what) {
  return new DOMException(`${what}超过 ${Math.round(ms / 1000)} 秒无响应`, 'TimeoutError');
}

/**
 * 把「外部中止信号」与「超时」合并成一个控制器。
 * 返回 { signal, abort, cleanup }：abort 供看门狗主动中止，cleanup 收尾（务必在 finally 调用）。
 */
function makeController(external, timeoutMs, what) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(external?.reason);
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', onAbort);
  }
  const timer = timeoutMs > 0
    ? setTimeout(() => ctrl.abort(timeoutError(timeoutMs, what)), timeoutMs)
    : null;
  return {
    signal: ctrl.signal,
    abort: (reason) => ctrl.abort(reason),
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (external) external.removeEventListener('abort', onAbort);
    },
  };
}

// 导出以便探针用自定义 timeoutMs 验证超时兜底（见 dev/__tmp_timeout_probe.jsx）
export async function req(path, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT, ...rest } = options;
  const ctl = makeController(rest.signal, timeoutMs, '服务端');
  try {
    const resp = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...rest,
      signal: ctl.signal,
      body: rest.body ? JSON.stringify(rest.body) : undefined
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { const e = await resp.json(); msg = e.error || msg; } catch {}
      throw new Error(msg);
    }
    return resp.json();
  } finally {
    ctl.cleanup();
  }
}

// SSE 流式读取（用于 AI 正文生成）
// 返回 async generator，逐 chunk yield { type, text?, error? }
// signal：AbortSignal，用于中途停止生成
// idleMs：多久收不到任何字节就判服务端假死（服务端每 90 秒停滞会先自报重试，故 200 秒足够宽）
// totalMs：整条流的最长存活时间（服务端整体上限 5 分钟 + 重试退避余量）
export async function* sseStream(path, body, signal, { idleMs = 200000, totalMs = 360000 } = {}) {
  const ctl = makeController(signal, totalMs, '正文生成（整条流）');
  let idleTimer = null;
  const idleError = () => new DOMException(
    `服务端超过 ${Math.round(idleMs / 1000)} 秒没有任何响应（进程可能已卡死），已中止等待`,
    'TimeoutError',
  );
  const bumpIdle = () => {
    if (!(idleMs > 0)) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctl.abort(idleError()), idleMs);
  };
  try {
    const resp = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { const e = await resp.json(); msg = e.error || msg; } catch {}
      throw new Error(msg);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      bumpIdle();
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data) continue;
        try { yield JSON.parse(data); }
        catch { /* 跳过 */ }
      }
    }
  } finally {
    clearTimeout(idleTimer);
    ctl.cleanup();
  }
}

export const api = {
  listSaves: () => req('/saves'),
  getSave: (id) => req(`/saves/${id}`),
  saveGame: (save) => req('/saves', { method: 'POST', body: save }),
  appendMemory: (id, body) => req(`/saves/${id}/memories`, { method: 'POST', body }),
  deleteSave: (id) => req(`/saves/${id}`, { method: 'DELETE' }),
  getSettings: () => req('/settings'),
  putSettings: (s) => req('/settings', { method: 'PUT', body: s }),
  // 世界因子库（跨存档共享：自定义因子定义 + 因子组合）
  getFactorLibrary: () => req('/factor-library'),
  putFactorLibrary: (lib) => req('/factor-library', { method: 'PUT', body: lib }),
  // 世界书（跨存档共用：一个文件装全部条目，所有存档共用同一份）
  getWorldbook: () => req('/worldbook'),
  putWorldbook: (list) => req('/worldbook', { method: 'PUT', body: list }),
  // AI 双阶段
  aiGenerate: (messages) => req('/ai/generate', { method: 'POST', body: { messages }, timeoutMs: 120000 }),
  aiStoryStream: (messages, signal) => sseStream('/ai/story', { messages }, signal), // 流式正文（可中断）
  // 演化接口自带多轮打回重写，给足 5 分钟；用户点停止时仍由 signal 立即中断
  aiEvolve: (messages, presetType, signal, extra) => req('/ai/evolve', { method: 'POST', body: { messages, presetType, ...(extra || {}) }, signal, timeoutMs: 300000 }),
  aiTest: (ai) => req('/ai/test', { method: 'POST', body: ai ? { ai } : {}, timeoutMs: 60000 }),
  aiModels: (baseUrl, apiKey) => req('/ai/models', { method: 'POST', body: { baseUrl, apiKey }, timeoutMs: 60000 }),
  // 前缀缓存命中统计（设置页「缓存命中」面板）
  aiStats: () => req('/ai/stats'),
  aiStatsReset: () => req('/ai/stats/reset', { method: 'POST' }),
  // 人生快照（旧：完整载荷）
  listSnapshots: (saveId) => req(`/saves/${saveId}/snapshots`),
  createSnapshot: (saveId, body) => req(`/saves/${saveId}/snapshots`, { method: 'POST', body }),
  getSnapshot: (snapId) => req(`/snapshots/${snapId}`),
  updateSnapshot: (snapId, body) => req(`/snapshots/${snapId}`, { method: 'PUT', body }),
  deleteSnapshot: (snapId) => req(`/snapshots/${snapId}`, { method: 'DELETE' }),
  // 各角色独立快照（角色名册每人一份）
  listCharSnapshots: (saveId) => req(`/saves/${saveId}/characters/snapshots`),
  batchSaveCharSnapshots: (saveId, snapshots) => req(`/saves/${saveId}/characters/snapshots`, { method: 'POST', body: { snapshots } }),
  // 按集合对齐：以 snapshots 为全集，服务端多出来的角色文件会被删除（回滚后清理孤儿）
  replaceCharSnapshots: (saveId, snapshots) => req(`/saves/${saveId}/characters/snapshots`, { method: 'PUT', body: { snapshots } }),
  getCharSnapshot: (saveId, charId) => req(`/saves/${saveId}/characters/${charId}/snapshot`),
  putCharSnapshot: (saveId, charId, snapshot) => req(`/saves/${saveId}/characters/${charId}/snapshot`, { method: 'PUT', body: { snapshot } }),
  deleteCharSnapshot: (saveId, charId) => req(`/saves/${saveId}/characters/${charId}/snapshot`, { method: 'DELETE' }),
};
