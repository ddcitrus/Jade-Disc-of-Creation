// ===== 行动条速度表（2026-09-18 定案）=====
// 需求：「根据脚力值计算行动条，安排行动顺序」。
//
// 为什么不是一条公式，而是一张分段表？
//   起因是旧的公式（间隔 = 100/(1+0.25·log₂(1+脚力/40)) 且不小于 25）在高境界会**撞死在一个下限上**：
//   脚力超过 16.38 万以后间隔恒为 25，于是化神以上 26 个境界出手速度完全一样 ——
//   脚力差 10⁹ 倍也是 1.00 倍出手，先手退回「谁先出场」。根因是把曲线拿中低段（炼气~金丹）调，
//   从没往表的高段看一眼；而境界表的脚力是几何阶梯，凡人 → 道祖跨了 13.5 个数量级。
//
// 现在改成**按境界档位定速度**（凡人 = 第 0 档 … 道祖 = 第 48 档，共 49 档）：
//   · 档位 → 倍速，倍速含义＝「凡人出一手的时间里，他能出几手」；
//   · 出手间隔 = 基准间隔 ÷ 倍速，间隔越小动得越频繁；
//   · 每个档位一格，低段到高段都有确定的值，不存在撞线。
//
// 分段（每段是一条等比线，段与段之间按用户给定的锚点衔接）：
//   第 0~14 档   凡人 → 筑基初期   每档 ×1.05076（凡人慢一倍）      ← 暂定值
//   第 14~20 档  筑基初期 → 元婴初期 每档 ×1.41421（6 档翻 8 倍）
//   第 20~23 档  元婴初期 → 化神初期 每档 ×1.25992（3 档翻 2 倍）
//   第 23~26 档  化神初期 → 炼虚初期 每档 ×1.25992（3 档翻 2 倍）
//   第 26~29 档  炼虚初期 → 合体初期 每档 ×1.44225（3 档翻 3 倍）
//   第 29~32 档  合体初期 → 大乘初期 每档 ×1.27718（3 档翻 2.08 倍）
//   第 32~48 档  大乘初期 → 道祖    每档 ×1.10                    ← 暂定值
//
// 注：锚点之间并非等比（每档倍率在 1.26~1.44 之间跳动），所以只能分段；
//     若硬压成一条「每档乘同一个数」，那个数是 1.34225，但元婴会掉到 5.85（要 8）、合体 82.7（要 96）。

import { resolveRealmKey } from './realmBounds.js';

/** 筑基初期的出手间隔。间隔本身没有绝对单位，只有相对意义，取此值以贴近旧手感。 */
export const SPEED_BASE_INTERVAL = 44.61;

/** 最低档（凡人）与最高档（道祖）的档位号。 */
export const TIER_MIN = 0;
export const TIER_MAX = 48;

/**
 * 分段等比表。每段：从 from 档开始、起点倍速 start，往后每档乘 rate。
 * 段边界处两段算出的值相同（刻意对齐），所以「第一个匹配段」就是唯一答案。
 */
export const SPEED_SEGMENTS = [
  { from: 0, to: 14, start: 0.5, rate: Math.pow(2, 1 / 14), note: '凡人 → 筑基初期' },
  { from: 14, to: 20, start: 1, rate: Math.pow(8, 1 / 6), note: '筑基初期 → 元婴初期' },
  { from: 20, to: 23, start: 8, rate: Math.pow(2, 1 / 3), note: '元婴初期 → 化神初期' },
  { from: 23, to: 26, start: 16, rate: Math.pow(2, 1 / 3), note: '化神初期 → 炼虚初期' },
  { from: 26, to: 29, start: 32, rate: Math.pow(3, 1 / 3), note: '炼虚初期 → 合体初期' },
  { from: 29, to: 32, start: 96, rate: Math.pow(200 / 96, 1 / 3), note: '合体初期 → 大乘初期' },
  { from: 32, to: 48, start: 200, rate: 1.1, note: '大乘初期 → 道祖' },
];

const clampTier = (tier) => {
  const n = Math.round(Number(tier));
  if (!Number.isFinite(n)) return TIER_MIN;
  return Math.min(TIER_MAX, Math.max(TIER_MIN, n));
};

/** 档位 → 倍速（以筑基初期 = 1 计）。 */
export function speedMultiplier(tier) {
  const i = clampTier(tier);
  for (const s of SPEED_SEGMENTS) {
    if (i >= s.from && i <= s.to) return s.start * Math.pow(s.rate, i - s.from);
  }
  return 1;
}

/**
 * 档位 → 出手间隔（越小动得越频繁）。
 * 不做四舍五入：高档位的间隔本身很小（道祖 ≈ 0.049），若截到两位小数，
 * 相邻档位会并列成同一个值（0.05 / 0.05），白丢了区分度。显示时再格式化。
 */
export function intervalForTier(tier) {
  return SPEED_BASE_INTERVAL / speedMultiplier(tier);
}

/**
 * 境界文本 → 档位号。
 * 认不出返回 null（由调用方退回「按脚力就近定位」）。
 * @param {string} realmText 例如「筑基初期」「炼气四层」
 * @param {string[]|object} realmProfiles 数值表的境界表（键即档位名，顺序即档位序）
 */
export function tierFromRealm(realmText, realmProfiles) {
  const keys = Array.isArray(realmProfiles) ? realmProfiles : Object.keys(realmProfiles || {});
  if (!keys.length) return null;
  const key = resolveRealmKey(realmText, keys);
  if (!key) return null;
  const i = keys.indexOf(key);
  return i >= 0 ? i : null;
}

/**
 * 脚力数值 → 档位号（就近落档）。
 * 用途：AI 编了一个表里没有的境界名时的兜底 —— 脚力与档位强相关，按对数距离找最近的一档。
 */
export function tierFromSpeed(speed, realmProfiles) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return null;
  const keys = Array.isArray(realmProfiles) ? realmProfiles : Object.keys(realmProfiles || {});
  if (!keys.length) return null;
  const bases = keys.map(k => (typeof realmProfiles[k] === 'object' ? Number(realmProfiles[k].speedBase) : NaN));
  let best = null;
  let bestD = Infinity;
  bases.forEach((b, i) => {
    if (!Number.isFinite(b) || b <= 0) return;
    const d = Math.abs(Math.log(s / b));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/**
 * 参战单位 → 出手间隔。这是引擎唯一入口。
 * 顺序：境界名认表 → 脚力就近落档 → 兜底按筑基初期。
 * @param {object} unit 至少含 { realm, speed }
 * @param {object} realmProfiles 数值表（缺省时只能按脚力，仍优于随机）
 */
export function intervalForUnit(unit, realmProfiles) {
  const keys = realmProfiles ? Object.keys(realmProfiles) : [];
  let tier = tierFromRealm(unit?.realm, keys);
  let via = '境界';
  if (tier == null) {
    tier = tierFromSpeed(unit?.speed, realmProfiles);
    via = tier == null ? '兜底' : '脚力';
  }
  if (tier == null) tier = 14; // 筑基初期
  return { tier, interval: intervalForTier(tier), multiplier: speedMultiplier(tier), via };
}
