// ===== 修炼参数：只交数据，不算结果 =====
//
// 2026-09-22 重构（按要求）：**修炼耗时不再由程序预先计算**。
//   理由：耗时公式里含一项「运气」，每次闭关都在 0.8~1.2 之间摇。
//   程序在某一刻算出的「练满本层还要 X 年」只对那一刻摇到的运气成立，
//   把它写进卡片就是假精确 —— 换一场闭关，同一个存档又是另一个数。
// 职责划分：
//   程序 → 把存档里的**原始数字**读出来：境界、本档寿元、灵根倍率、灵气浓度、装备加速点数、世界因子；
//   AI   → 按修炼协议里的公式（见 mortalProtocols.js 的「耗时怎么算」段），本轮现摇运气、现算耗时。
// 本文件只读表、求和、拼字，**不做任何乘法结果** —— 灵气倍率、装备倍率都不在这里算。

import { resolveRealmKey } from './realmBounds.js';
import { getEffectiveTables } from './numericTuning.js';
import { parseGrade } from './gradeUtils.js';

/**
 * 公式里的常数。协议文本与这里同源（协议段由 cultivationFormulaLines 生成），
 * 改这里一处，注入给 AI 的说明与参数取值同时变。
 */
export const CULTIVATION_RULES = {
  baseAura: 100,          // 灵气基准：浓度 100 = 不增不减
  stepPercent: 5,         // 每层基准耗时 = 本档寿元 × 5%
  openingStepYears: 0.25, // 凡人开窍固定 3 个月
  gearBonusCap: 100,      // 装备加速合计封顶 100 点（= 最多 +100%）
  luckMin: 0.8,
  luckMax: 1.2,
};

/** 本档寿元（年）；查不到返回 null。 */
export function realmLifespan(realmText, tables) {
  const t = tables || getEffectiveTables();
  const rp = t?.realmProfiles;
  if (!rp || typeof rp !== 'object') return null;
  const key = resolveRealmKey(realmText, Object.keys(rp));
  if (!key) return null;
  const n = Number(rp[key]?.lifespan);
  return Number.isFinite(n) ? n : null;
}

/** 境界文字 → 数值表里的档位名；查不到返回 null。 */
export function realmKeyOf(realmText, tables) {
  const t = tables || getEffectiveTables();
  const rp = t?.realmProfiles;
  if (!rp || typeof rp !== 'object') return null;
  return resolveRealmKey(realmText, Object.keys(rp));
}

/**
 * 单件装备的「修炼加速」点数。
 * 取值优先级：① 物品 mods 里显式写的「修炼速度」；② 按品阶查 equipmentBaseByGrade。
 * 两者取其一，不叠加 —— 同一件装备不会既算品阶又算词条。
 */
export function itemSpeedPoints(item, tables) {
  if (!item || typeof item !== 'object') return 0;
  const mods = item.mods && typeof item.mods === 'object' ? item.mods : null;
  if (mods) {
    for (const k of ['修炼速度', '修炼加速']) {
      const n = Number(mods[k]);
      if (Number.isFinite(n) && n) return n;
    }
  }
  const g = parseGrade(item.grade);
  if (g == null) return 0;
  const t = tables || getEffectiveTables();
  const row = t?.equipmentBaseByGrade?.[String(g)];
  const n = Number(row?.cultivationSpeedBase);
  return Number.isFinite(n) ? n : 0;
}

/** 装备槽（对象，值为物品或名称）→ 合计点数。 */
export function gearPoints(equipment, tables) {
  if (!equipment || typeof equipment !== 'object') return 0;
  let sum = 0;
  for (const v of Object.values(equipment)) sum += itemSpeedPoints(v, tables);
  return sum;
}

/** 世界因子名列表。 */
export function factorNames(save) {
  const fs = save?.world?.factors;
  return (Array.isArray(fs) ? fs : [])
    .map(f => (typeof f === 'string' ? f : f?.name))
    .filter(Boolean);
}

/**
 * 拼出「本轮修炼参数」的若干行。主角快照缺失时返回空数组（调用方据此不注入）。
 * @returns {string[]}
 */
export function buildCultivationParamLines(save, opts = {}) {
  const snap = opts.snapshot || save?.charSnapshots?.B1 || null;
  if (!snap) return [];
  // opts.tables 优先；否则按 opts.settings 取生效表（getEffectiveTables 支持直接吃整份 settings）
  const tables = opts.tables || getEffectiveTables(opts.settings);
  const idt = snap.identity || {};
  const w = save?.world || {};
  const lines = [];

  const name = idt.name || '主角';
  const realm = idt.realm || '';
  lines.push(`- ${name}${realm ? `｜当前境界：${realm}` : '｜当前境界：未知'}`);

  const life = realmLifespan(realm, tables);
  // 数值表第 0 档叫「凡人」（项目内不译，见 MEMORY）；这一档跨入炼气按「开窍」计，固定 3 个月。
  // 实测的真实存档里主角正好停在凡人档 —— 只给「寿元 80 年」，AI 会算出 4 年，与开窍特例打架，
  // 所以在这一行里把特例点明（仍然只给数据与口径，数字还是 AI 自己算）。
  const isMortalTier = realmKeyOf(realm, tables) === '凡人';
  lines.push(life != null
    ? (isMortalTier
      ? `- 本档寿元：${life} 年（当前在凡人档 → 跨入炼气那一步按「开窍」计，固定 ${CULTIVATION_RULES.openingStepYears * 12} 个月，不看寿元）`
      : `- 本档寿元：${life} 年（数字取自内置数值表的境界基准表，玩家改过表则以存档设置为准）`)
    : '- 本档寿元：表中未收录（练满本层的基准耗时按上一档估）');

  const rootName = idt.linggen || '';
  const rootMul = Number(idt.linggenCultivationSpeedMultiplier);
  if (Number.isFinite(rootMul) && rootMul > 0) {
    lines.push(`- 灵根：${rootName || '未记录'}（修炼速度倍率 ×${Math.round(rootMul * 100) / 100}）`);
  } else {
    lines.push(`- 灵根：${rootName || '未记录'}（无倍率记录，按 ×1.0 计）`);
  }

  const loc = w.location || {};
  lines.push(Number.isFinite(Number(loc.aura)) && Number(loc.aura) > 0
    ? `- 所在地：${loc.name || '未知'}｜灵气浓度：${loc.aura}`
    : `- 所在地：${loc.name || '未知'}｜灵气浓度：未记录（按 ${CULTIVATION_RULES.baseAura} 计）`);

  const points = gearPoints(snap.equipment, tables);
  lines.push(`- 随身穿戴的装备加速合计：${points} 点`);

  const names = factorNames(save);
  lines.push(`- 当前世界因子：${names.length ? names.join('、') : '无'}`);

  return lines;
}

/** 参数段全文（带标题）；无可注入内容时返回空串。 */
export function cultivationParamsText(save, opts = {}) {
  const lines = buildCultivationParamLines(save, opts);
  if (!lines.length) return '';
  return ['【本轮修炼参数】（数据取自存档现状；用法见上文「耗时怎么算」）', ...lines].join('\n');
}

/**
 * 公式说明行（协议文本用它拼「耗时怎么算」段，避免公式在协议里写死第二份）。
 * @returns {string[]}
 */
export function cultivationFormulaLines() {
  const r = CULTIVATION_RULES;
  return [
    // ⚠ 用整数百分数（stepPercent）而不是小数比例：0.05 * 100 === 5.000000000000001，
    //   拼进协议就是「寿元 × 5.000000000000001%」—— AI 会照抄成正文里的怪数字。
    `- 每层基准耗时 = 本档寿元 × ${r.stepPercent}%（凡人开窍固定 ${r.openingStepYears * 12} 个月，不看寿元）`,
    `- 灵气倍率 = 所在地灵气浓度 ÷ ${r.baseAura}`,
    `- 装备倍率 = 1 + 装备加速合计 ÷ 100（合计封顶 ${r.gearBonusCap} 点，即最多 +${r.gearBonusCap}%）`,
    '- 世界因子：无因子取 1.0；「灵气断绝」取 0.5；「血月当空」取 1.3；**这一行没列到的因子一律取 1.0（不参与计算）**',
    `- 运气：每次闭关自己在 ${r.luckMin}~${r.luckMax} 之间取一个数，同一场闭关内保持不变，下一场重新取`,
    '- 修炼速度 = 灵根倍率 × 灵气倍率 × 装备倍率 × 世界因子 × 运气',
    '- 练满本层所需时间 = 每层基准耗时 ÷ 修炼速度',
    '- 照当前进度练满本层还需 = 练满本层所需时间 × (1 - 当前进度 ÷ 100)',
  ];
}
