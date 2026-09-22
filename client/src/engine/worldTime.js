// ---------- 世界时间：由 AI 自主规划 ----------
// 已取消「每回合固定推进 N 小时」的机制：世界时间只在本轮正文真正写出新时间时才前进。
// 取值依据 Mortal 状态栏协议（mortalProtocols 的「正文内时间/地点跨越」段）：
//   1) 正文内最后一个有效 <scene_checkpoint data-time="绝对时间">；同一轮可有多条，取最后一条；
//   2) 正文内没有任何 checkpoint 时，取正文开头 <ui_sys> 状态栏的时间（协议：无跨越时以 ui_sys 为准）；
//   3) 两者都取不到（没按协议输出 / 生成失败 / 本地旁白模式）→ 返回 null，时间保持不变，
//      由代码绝不替 AI 猜时间。

// 简化历法：每月 30 天、每年 12 月（与原 advanceTime 一致）
const SEASONS = ['冬', '春', '春', '夏', '夏', '夏', '秋', '秋', '秋', '冬', '冬', '冬'];
const pad = (n, len = 2) => String(n).padStart(len, '0');

export function seasonOfMonth(mo) {
  return SEASONS[(Number(mo) - 1 + 12) % 12];
}

// 解析绝对时间字符串："1年01月01日 14:00" / "0032年8月6日 14:30" / "0032-08-06 14:30"
// 返回 { y, mo, d, h, mi, label }；识别不出日期即返回 null（宁可不动也不猜）
export function parseWorldTime(str) {
  const s = String(str || '').replace(/\u3000/g, ' ').trim();
  if (!s) return null;
  const m = s.match(/(\d{1,4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  // 时刻只允许出现在日期之后（避免把地点/环境里的数字当时刻）
  const tail = s.slice(m.index + m[0].length);
  const tm = tail.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  const h = tm ? Math.min(23, Number(tm[1])) : 0;
  const mi = tm ? Math.min(59, Number(tm[2])) : 0;
  return { y, mo, d, h, mi, label: `${y}年${pad(mo)}月${pad(d)}日 ${pad(h)}:${pad(mi)}` };
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, ' ');

// 从本轮正文提取 AI 写下的「本轮最终世界时间」
export function extractStoryTime(text) {
  const src = String(text || '');
  if (!src) return null;
  // 1) 最后一个 <scene_checkpoint data-time="…">（协议指定：最终时间取最后一个有效 checkpoint）
  const cps = [...src.matchAll(/<scene_checkpoint\b[^>]*\bdata-time\s*=\s*["']([^"']*)["']/gi)];
  for (let i = cps.length - 1; i >= 0; i--) {
    const t = parseWorldTime(cps[i][1]);
    if (t) return t;
  }
  // 2) 正文开头 <ui_sys> 状态栏的时间（取该区块内第一处日期）
  const ui = src.match(/<ui_sys>([\s\S]*?)<\/ui_sys>/i);
  if (ui) {
    const t = parseWorldTime(stripTags(ui[1]));
    if (t) return t;
  }
  return null;
}

// 把 AI 规划的时间写回存档（结构化时间 + 时间标签 + 季节）；t 为空则原样返回
export function applyWorldTime(save, t) {
  if (!t) return save;
  const s = { ...save, world: { ...(save.world || {}) } };
  s.world.time = { y: t.y, mo: t.mo, d: t.d, h: t.h, mi: t.mi };
  s.world.timeLabel = t.label;
  s.world.season = seasonOfMonth(t.mo);
  return s;
}
