// ===== 修炼参数：只交数据，不算结果 =====
//
// **修炼耗时不由程序预先计算**。
//   理由：耗时公式里含一项「运气」，每次闭关都在 0.8~1.2 之间摇。
//   程序在某一刻算出的「练满本层还要 X 年」只对那一刻摇到的运气成立，
//   把它写进卡片就是假精确 —— 换一场闭关，同一个存档又是另一个数。
// 职责划分：
//   程序 → 把存档里的**原始数字**读出来（境界、本档寿元、灵根倍率、灵气浓度、装备加速点数、世界因子），
//          并算好两件不掺运气的东西：**装备倍率**（加速合计**不封顶**）与
//          **自身修炼倍率 = 灵根倍率 × 装备倍率**（写回每个角色的快照 identity.cultivationRate）。
//   AI   → 按修炼协议里的公式（见 mortalProtocols.js 的「耗时怎么算」段），本轮现摇运气、现算耗时。
// 本文件仍然**不碰含运气的那一步**：灵气倍率、世界因子与「练满还要多久」都留给 AI 现算。

import { resolveRealmKey } from './realmBounds.js';
import { getEffectiveTables } from './numericTuning.js';
import { parseGrade } from './gradeUtils.js';
import { rootRateFromText } from './gameData.js';

/**
 * 公式里的常数。协议文本与这里同源（协议段由 cultivationFormulaLines 生成），
 * 改这里一处，注入给 AI 的说明与参数取值同时变。
 */
export const CULTIVATION_RULES = {
  baseAura: 100,          // 灵气基准：浓度 100 = 不增不减
  stepPercent: 5,         // 每层基准耗时 = 本档寿元 × 5%
  openingStepYears: 0.25, // 凡人开窍固定 3 个月
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
 * 「加速点 → 装备倍率」的换算：每 100 点 +1 倍（不封顶）。
 * 界面（snapshotSchema.attrRowView）把装备修炼词条也按这个口径显示成倍率，
 * 与这里的公式**必须同源**，否则同一件装备会在界面上出现两个倍率。
 */
export const SPEED_POINTS_PER_RATE = 100;

/** 装备词条里表示「修炼加速点数」的键。取值与界面显示共用这一处。 */
export const SPEED_MOD_KEYS = ['修炼速度', '修炼加速'];

/**
 * 单件装备的「修炼加速」点数。
 * 取值优先级：① 物品 mods 里显式写的「修炼速度」；② 按品阶查 equipmentBaseByGrade。
 * 两者取其一，不叠加 —— 同一件装备不会既算品阶又算词条。
 */
export function itemSpeedPoints(item, tables) {
  if (!item || typeof item !== 'object') return 0;
  const mods = item.mods && typeof item.mods === 'object' ? item.mods : null;
  if (mods) {
    for (const k of SPEED_MOD_KEYS) {
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

// 装备槽的**真格**清单。装备是分层的，物品都住在里层：
//   weapon: right/left ｜ armor: head/inner/armor/hands/legs/feet/cloak ｜ accessory/treasure/technique: 数组 6 格
// ⚠ 旧实现拿最外层这几个大格**当物品**去取点数，两个方向都错（2026-09-26 实测）：
//   ① NPC 一件都数不到（他们的槽位是干净嵌套，全部返回 0）；
//   ② 主角读到 800 点，来自槽位容器**自己身上**残留的一份字段，不是佩戴物品的合计 ——
//      那份残留是历史数据事故，摘掉装备它也不会变。
const GEAR_SLOTS = {
  weapon: ['right', 'left'],
  armor: ['head', 'inner', 'armor', 'hands', 'legs', 'feet', 'cloak'],
  accessory: null,   // null = 数组槽（6 格）
  treasure: null,
  technique: null,
};

// 「这真的是一件物品吗」：必须有**字符串** name。
// 判据故意卡死 —— 被写坏的槽位容器身上，name 字段是一整个对象（不是字符串），
// 靠这条把它挡在门外，否则那份残留会被当成一件装备数进去。
const isItemLike = (v) => !!v && typeof v === 'object' && typeof v.name === 'string' && v.name;

/**
 * 随身穿戴的装备加速合计。只数真格里的物品，绝不读槽位容器自己身上的字段。
 * **不封顶**（2026-09-26 用户拍板）：合计多少，装备倍率就是 1 + 合计 ÷ 100。
 */
export function gearPoints(equipment, tables) {
  if (!equipment || typeof equipment !== 'object') return 0;
  let sum = 0;
  const take = (v) => { if (isItemLike(v)) sum += itemSpeedPoints(v, tables); };
  for (const [group, keys] of Object.entries(GEAR_SLOTS)) {
    const g = equipment[group];
    if (g == null || g === '') continue;
    if (keys === null) {                                // 数组槽
      if (Array.isArray(g)) { for (const v of g) take(v); continue; }
      take(g);                                          // 旧结构：整格就是一件物品
      continue;
    }
    if (typeof g !== 'object') { take(g); continue; }    // 旧结构：整格是物品名
    for (const k of keys) take(g[k]);
  }
  return sum;
}

/** 装备倍率 = 1 + 装备加速合计 ÷ SPEED_POINTS_PER_RATE（**不封顶**）。 */
export function gearMultiplier(equipment, tables) {
  return 1 + gearPoints(equipment, tables) / SPEED_POINTS_PER_RATE;
}

/**
 * 角色的灵根倍率。先按**灵根文字**反查（NPC 只有一行文字、没有建档档位，全靠这一步），
 * 认不出才沿用档案里已有的倍率；两者都没有按 1.0。
 * 副作用是修好了「改灵根只改名字」：现在改文字会真的带动倍率。
 */
export function rootMultiplierOf(snap) {
  const idt = snap?.identity || {};
  const fromText = rootRateFromText(idt.linggen);
  if (fromText != null) return fromText;
  const stored = Number(idt.linggenCultivationSpeedMultiplier);
  return Number.isFinite(stored) && stored > 0 ? stored : 1;
}

/**
 * 角色**自身修炼倍率** = 灵根倍率 × 装备倍率。
 * 不含当地灵气、世界因子与运气 —— 那三项每场都不一样，不能落盘。
 */
export function cultivationRate(snap, tables) {
  return Math.round(rootMultiplierOf(snap) * gearMultiplier(snap?.equipment, tables) * 100) / 100;
}

/**
 * 按当前灵根文字与随身装备重算，把「灵根倍率」「自身修炼倍率」写回快照。
 * 程序权威（2026-09-26 用户拍板）：灵根或装备一变就跟着变，手改会被下一次落盘覆盖。
 */
export function syncCultivationFields(snap, tables) {
  if (!snap || typeof snap !== 'object') return snap;
  if (!snap.identity || typeof snap.identity !== 'object') snap.identity = {};
  snap.identity.linggenCultivationSpeedMultiplier = rootMultiplierOf(snap);
  snap.identity.cultivationRate = cultivationRate(snap, tables);
  return snap;
}

/** 对整份存档的每个角色（主角 + 全部 NPC）重算并写回上面两格。 */
export function syncCultivationRates(save, tuning) {
  const snaps = save?.charSnapshots;
  if (!snaps || typeof snaps !== 'object') return save;
  const tables = getEffectiveTables(tuning);
  for (const snap of Object.values(snaps)) syncCultivationFields(snap, tables);
  return save;
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
  // 本层进度必须给出来（2026-09-29 补）。
  //   此前参数段只给境界名，AI 拿不到结算前的进度，卡上的 old 只能靠叙事记忆猜 ——
  //   实测塔夫档快照是「炼气六层 100%」，AI 却在卡里写 old:0，把一整轮的涨幅算成了半层。
  //   算式协议（protocols.js 修炼段）第一步就要用这个数，缺了它算式只能编。
  //   取值口径与落盘一致（applyCultivationCards 同样把缺失当 0），钳在 0~100。
  const progRaw = Number(idt.realmProgress);
  const prog = Number.isFinite(progRaw) ? Math.max(0, Math.min(100, Math.round(progRaw))) : 0;
  lines.push(`- ${name}${realm ? `｜当前境界：${realm}` : '｜当前境界：未知'}｜本层进度：${prog}%`);

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
  const rootMul = rootMultiplierOf(snap);
  const rootKnown = rootRateFromText(rootName) != null;
  lines.push(`- 灵根：${rootName || '未记录'}（修炼速度倍率 ×${rootMul}${rootKnown ? '' : '，按档案里的记录沿用'}）`);

  const loc = w.location || {};
  lines.push(Number.isFinite(Number(loc.aura)) && Number(loc.aura) > 0
    ? `- 所在地：${loc.name || '未知'}｜灵气浓度：${loc.aura}`
    : `- 所在地：${loc.name || '未知'}｜灵气浓度：未记录（按 ${CULTIVATION_RULES.baseAura} 计）`);

  const points = gearPoints(snap.equipment, tables);
  lines.push(`- 随身穿戴的装备加速合计：${points} 点（**不封顶**：装备倍率直接按它算，不要自行压缩）`);

  // 灵根 × 装备 的乘积直接给出，AI 不必自己乘；含运气的后半程仍然由它现算。
  lines.push(`- 自身修炼倍率（灵根 × 装备；不含当地灵气、世界因子、运气）：×${cultivationRate(snap, tables)}`);

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
    '- 装备倍率 = 1 + 装备加速合计 ÷ 100（**合计不封顶**：装备加速多少点，装备倍率就是多少）',
    '- 世界因子：无因子取 1.0；「灵气断绝」取 0.5；「血月当空」取 1.3；**这一行没列到的因子一律取 1.0（不参与计算）**',
    `- 运气：每次闭关自己在 ${r.luckMin}~${r.luckMax} 之间取一个数，同一场闭关内保持不变，下一场重新取`,
    '- 修炼速度 = 灵根倍率 × 灵气倍率 × 装备倍率 × 世界因子 × 运气',
    '- 练满本层所需时间 = 每层基准耗时 ÷ 修炼速度',
    '- 照当前进度练满本层还需 = 练满本层所需时间 × (1 - 当前进度 ÷ 100)',
  ];
}
