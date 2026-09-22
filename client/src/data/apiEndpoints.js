// ===== 接口库（多接口保存 + 通道选用）=====
// 设计：settings.apiEndpoints 是接口数组，正文与快照两个通道各自从中选一条。
//   storyEndpointId    '' = 用库里第一条可用接口
//   snapshotEndpointId '' = 与正文相同
// 注意：服务端 server/index.js 里有一份等价的解析规则（storyEndpoint/snapshotEndpoint），
//      改这里务必同步改那边（服务端不能 import 前端源码，客户端也不能 import 服务端）。

export const DEFAULT_ENDPOINT = {
  id: '',
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.9,
};

// 稳定且不必全局唯一的 id（只在本机 settings.json 内区分接口）
export function newEndpointId() {
  return 'ep-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function normalizeEndpoint(ep, i = 0) {
  const e = ep && typeof ep === 'object' ? ep : {};
  const t = Number(e.temperature);
  return {
    id: String(e.id || 'ep-' + (i + 1)),
    name: String(e.name || '接口 ' + (i + 1)),
    baseUrl: String(e.baseUrl || ''),
    apiKey: String(e.apiKey || ''),
    model: String(e.model || ''),
    temperature: Number.isFinite(t) ? Math.min(1.5, Math.max(0, t)) : 0.9,
  };
}

// 归一化整个接口库：补默认值 + id 去重（重复 id 会让选择项错位）
export function normalizeEndpointList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach((ep, i) => {
    const n = normalizeEndpoint(ep, i);
    let id = n.id;
    let k = 2;
    while (seen.has(id)) { id = n.id + '-' + k; k += 1; }
    seen.add(id);
    out.push({ ...n, id });
  });
  return out;
}

export function endpointHost(ep) {
  const url = String(ep?.baseUrl || '').trim();
  if (!url) return '';
  try { return new URL(url).host; } catch { return url; }
}

export function endpointSummary(ep) {
  const parts = [endpointHost(ep) || '未填地址'];
  if (ep?.model) parts.push(ep.model);
  return parts.join(' · ');
}

export function findEndpoint(list, id) {
  if (!id) return null;
  return list.find(e => e.id === id) || null;
}

// 正文通道：选中的 → 库里第一条已填地址的 → 库中第一条（未填地址也返回，便于界面提示）
export function storyEndpointOf(settings) {
  const list = normalizeEndpointList(settings?.apiEndpoints);
  const want = findEndpoint(list, settings?.storyEndpointId);
  if (want && want.baseUrl.trim()) return want;
  return list.find(e => e.baseUrl.trim()) || want || list[0] || null;
}

// 快照通道：单独指定的 → 回退正文通道
export function snapshotEndpointOf(settings) {
  const list = normalizeEndpointList(settings?.apiEndpoints);
  const want = findEndpoint(list, settings?.snapshotEndpointId);
  if (want && want.baseUrl.trim()) return want;
  return storyEndpointOf(settings);
}
