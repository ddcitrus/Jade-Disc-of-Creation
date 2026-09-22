// ===== 前缀缓存用量统计 + 上游请求封装 =====
//
// 为什么单独一个文件：这两件事都有「容易写错但很难发现」的分支——
// 上游字段名不统一、上游不回传缓存字段、上游 400 拒绝 stream_options。
// 抽成零依赖模块后探针可以直接 import 验证（见 dev/__tmp_usage_probe.jsx），
// 而 index.js 只负责接线。
//
// 关键口径（错了会让界面显示假的 0%）：
//   cached === null  → 接口压根没给这个字段（界面显示「—」）
//   cached === 0     → 给了字段，就是没命中（界面显示「0.0%」）
//   两者含义完全不同，绝不能把 null 当成 0。

// node:fs —— 仅用于把统计落盘；纯函数（pickUsage / toUsageEntry）不碰它
import fs from 'node:fs';

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const EMPTY_STATS = {
  calls: 0,              // 成功取到 usage 的调用次数
  promptTokens: 0,       // 累计输入 token
  cachedTokens: 0,       // 累计命中缓存的输入 token
  completionTokens: 0,   // 累计输出 token
  latencies: [],         // 最近 10 次的「首字延迟」秒数（缓存没有数据时用它兜底判断）
  last: null,            // 最近一次调用（含 rate / hasCacheField / firstTokenSec）
  updatedAt: null,
};

const LATENCY_KEEP = 10; // 只留最近 10 个样本，够看趋势又不至于把过时数据拖平均

/**
 * 从上游 usage 对象里抠出 { 输入, 命中缓存, 输出 }。
 * 字段名兼容四种主流写法：
 *   OpenAI / 多数中转 —— prompt_tokens_details.cached_tokens
 *   DeepSeek         —— prompt_cache_hit_tokens
 *   Anthropic 兼容层  —— cache_read_input_tokens
 *   Gemini 原生       —— cachedContentTokenCount
 * 四者都没有时 cached 返回 null（≠ 0），界面据此区分「没命中」与「没数据」。
 * 整个 usage 都没有有效字段时返回 null（调用方据此跳过记账）。
 */
export function pickUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const prompt = numOrNull(u.prompt_tokens ?? u.input_tokens);
  const cached = numOrNull(
    u.prompt_tokens_details?.cached_tokens
    ?? u.prompt_cache_hit_tokens
    ?? u.cache_read_input_tokens
    ?? u.cachedContentTokenCount
  );
  const completion = numOrNull(u.completion_tokens ?? u.output_tokens);
  if (prompt === null && cached === null && completion === null) return null;
  return { prompt, cached, completion, hasCacheField: cached !== null };
}

/** 把一次用量折成界面要的条目（rate = 命中 / 输入；输入为 0 或缺缓存字段时为 null） */
export function toUsageEntry(kind, usageObj, at = new Date().toISOString(), extra = {}) {
  const picked = pickUsage(usageObj);
  if (!picked) return null;
  const { prompt, cached, completion } = picked;
  const firstTokenSec = numOrNull(extra.firstTokenSec);
  return {
    kind,
    prompt,
    cached,
    completion,
    rate: (prompt !== null && prompt > 0 && cached !== null) ? cached / prompt : null,
    hasCacheField: picked.hasCacheField,
    // 首字延迟（秒）：接口不给缓存字段时，靠它间接判断前缀有没有命中
    firstTokenSec: firstTokenSec === null ? null : Number(firstTokenSec.toFixed(1)),
    at,
  };
}

/** 一行中文日志（服务端 ai-debug.log 用，方便事后翻账） */
export function formatUsageLine(entry, state) {
  const rateTxt = entry.rate === null ? '未回传缓存字段' : `${(entry.rate * 100).toFixed(1)}%`;
  const total = state && state.promptTokens > 0
    ? `${state.cachedTokens}/${state.promptTokens}(${((state.cachedTokens / state.promptTokens) * 100).toFixed(1)}%)`
    : '—';
  const src = entry.hasCacheField ? '' : '（本接口未回传缓存字段）';
  const lat = entry.firstTokenSec === null || entry.firstTokenSec === undefined ? '' : ` 首字=${entry.firstTokenSec}s`;
  return `用量[${entry.kind}] 输入=${entry.prompt ?? '?'} 命中缓存=${entry.cached ?? '—'} 输出=${entry.completion ?? '?'} 本轮命中率=${rateTxt}${src}${lat} 累计=${total}`;
}

/**
 * 创建统计存储器。
 * - filePath：落盘位置（省略则只放内存，探针用）
 * - log：每记一笔调一次（服务端传 aiLog）
 * 读取失败（首次运行 / 文件损坏）不抛异常，回退到空统计。
 */
export function createUsageStats({ filePath = null, log = () => {} } = {}) {
  const state = { ...EMPTY_STATS, latencies: [] }; // 数组必须复制，不能与 EMPTY_STATS 共享引用
  if (filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') Object.assign(state, parsed);
    } catch { /* 首次运行 / 文件损坏：用空统计 */ }
  }
  const save = () => {
    if (!filePath) return;
    try { fs.writeFileSync(filePath, JSON.stringify(state, null, 2)); }
    catch { /* 磁盘异常不影响主流程 */ }
  };
  return {
    state,
    /**
     * 记一笔；usage 无效时返回 null 且不改动任何计数。
     * extra.firstTokenSec：本轮首字延迟（秒），接口不给缓存字段时作为替代信号。
     */
    record(kind, usageObj, extra = {}) {
      const entry = toUsageEntry(kind, usageObj, new Date().toISOString(), extra);
      if (!entry) return null;
      state.calls += 1;
      if (entry.prompt) state.promptTokens += entry.prompt;
      if (entry.cached) state.cachedTokens += entry.cached;
      if (entry.completion) state.completionTokens += entry.completion;
      if (entry.firstTokenSec !== null) {
        state.latencies = [...(Array.isArray(state.latencies) ? state.latencies : []), entry.firstTokenSec].slice(-LATENCY_KEEP);
      }
      state.last = entry;
      state.updatedAt = entry.at;
      save();
      log(formatUsageLine(entry, state));
      return entry;
    },
    /** 清零（界面上的「清零统计」按钮）；flag 一并复位 */
    reset() {
      Object.assign(state, EMPTY_STATS, { latencies: [] });
      save();
      return state;
    },
    /** 界面用：附带累计命中率与首字延迟均值（无样本时为 null） */
    snapshot(extra = {}) {
      const lat = Array.isArray(state.latencies) ? state.latencies : [];
      return {
        ...state,
        totalRate: state.promptTokens > 0 ? state.cachedTokens / state.promptTokens : null,
        avgFirstTokenSec: lat.length ? Number((lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(1)) : null,
        ...extra,
      };
    },
  };
}

// node:fs 见文件顶部 import；纯函数（pickUsage / toUsageEntry）不碰文件系统

const STREAM_OPT_REJECT = /stream_options|include_usage/i;

/**
 * 上游请求封装：默认附带 stream_options.include_usage，好让上游在最后一包回传 token 用量。
 * 若上游以 400 明确拒绝该字段（部分中转/代理不认），自动去掉它重试一次，并把 blocked 置位——
 * 此后不再带（省掉每轮一次的额外往返）。
 *
 * ⚠️ 被拒绝时已经读过一次 response body，所以这里必须把 errText 一起返回，
 *    调用方**不要**再 resp.text() 一遍（会拿到空串，错误文案就丢了）。
 *
 * 返回 { resp, errText }；resp.ok 时 errText 恒为 ''。
 */
export function createChatPoster({ fetchImpl, log = () => {} } = {}) {
  let blocked = false;
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);
  return {
    isBlocked: () => blocked,
    setBlocked: (v) => { blocked = !!v; },
    async post(url, headers, body, signal) {
      const payload = blocked ? body : { ...body, stream_options: { include_usage: true } };
      let resp = await doFetch(url, {
        method: 'POST', headers, signal, body: JSON.stringify(payload),
      });
      if (resp.ok) return { resp, errText: '' };
      let errText = await resp.text().catch(() => '');
      if (resp.status === 400 && !blocked && STREAM_OPT_REJECT.test(errText)) {
        blocked = true;
        log('上游拒绝 stream_options.include_usage → 已关闭该字段（此后不再请求用量；若上游默认回传则照样有数）');
        resp = await doFetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) });
        if (resp.ok) return { resp, errText: '' };
        errText = await resp.text().catch(() => '');
      }
      return { resp, errText };
    },
  };
}
