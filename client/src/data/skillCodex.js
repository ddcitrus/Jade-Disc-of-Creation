// ===== 技能系数法典（skillCodex）=====
// 2026-09-18 晚 v4：技能强度**直接由品阶决定**，且要求「每高一品，差距必须看得出来」。
//
//   品阶（1~36 品）是唯一决定强度的东西：
//       伤害倍率 = 1.2^品阶   →  1 品 1.20 倍，5 品 2.49 倍，12 品 8.92 倍，36 品 708.8 倍
//       耗灵力   = 灵力上限 × 占池比例（1 品 1/30，36 品 全池；特攻类封顶四分之一池）
//       回复量   = 对应池上限 × 比例（1 品 1/12，36 品 回满）
//   「基础 / 精妙 / 绝学 / 禁术」四段名降级为**纯展示标签**（每 9 品一段）：
//     不参与任何数值，AI 也不必写。它只帮玩家一眼判断这门功法大概在什么档次。
//
//   为什么是「每品 ×1.2」而不是别的：
//     · 旧版 ×1.1135（1 品 1.00 → 36 品 43.1 倍）每档只涨 11%，而当时骰子的最小步子
//       就值 0.55 倍 ⇒ 1/2/3 品被四舍五入抹成同一个数，玩家看不出品阶差别。
//     · ×1.2 就是「高一品，强两成」，一步顶过去两步，肉眼可辨；
//       且骰子已经改成只管运气（平均正好 1.00，见 battleDice），不会再抹平品阶。
//     · 低品段才是主战场：实测存档里 AI 发出去的功法几乎全在 1~5 品
//       （一品 149 / 二品 74 / 三品 38 / 四品 47 / 五品 31，六品以上寥寥），
//       1.20 / 1.44 / 1.73 / 2.07 / 2.49 正好把这一段的差距拉开。
//   另注：普攻固定 1.0 倍，所以 1 品也比空手强两成 —— 有功法就一定比没有强。
//   同境界的「一击定生死」线在倍率 3.2 附近（约 7 品）。实际出现的功法几乎都在 5 品以下，
//   所以日常打斗仍是拉锯；真拿到 7 品以上的绝学，那就是压箱底的杀手锏，本该一招生死。
//
// 耗灵力 / 回复量一律按**角色自身池的比例**算，但写进快照的是**绝对数字**（AI 不做除法）：
//   耗灵力 = 灵力上限 × 品阶比例｜回血 = 气血上限 × 品阶比例｜回蓝 = 灵力上限 × 品阶比例
//   比例由本模块给；绝对值由调用方传入角色池上限现算 —— 所有输出函数都接一个
//   `ctx = { hpMax, mpMax }`。角色晋阶、池变大后，下一次注入会自动给出新的绝对数字，
//   不需要改技能本身（这正是「示例与表漂移」的根治办法）。
//
// 依赖：只 import gradeUtils.js（零依赖模块），因此服务端也可直接引。

import { parseGrade, gradeToText } from './gradeUtils.js';
import { parseDice, diceText } from './battleDice.js';

// ---------- 技能类型（三选一，唯一口径） ----------
//   伤害 = 造成伤害，用「伤害倍率」
//   恢复 = 回复气血/法力，用「回血」「回蓝」
//   特攻 = 特殊效果（隐形、传送、禁制等），不直接造成伤害或恢复，只有耗蓝与效果描述
export const SKILL_TYPES = ['伤害', '恢复', '特攻'];
export const SKILL_TYPE_DEFAULT = '伤害';

// ---------- 伤害属性（物 / 法） ----------
// 只有「伤害」类技能需要：物 → 算式取「生效物攻 / 生效物防」；法 → 取「生效法攻 / 生效法防」。
// 由 AI 在生成技能时手写，程序**不做任何推断**——写不出合法值就留空。
// 空串 = 未标注（历史数据与 AI 漏写）；协议要求 AI 遇空值时按「效果」描述自行判定。
export const DMG_KINDS = ['物', '法'];

// ---------- 品阶 → 强度（唯一数值出处） ----------
export const GRADE_MIN = 1;
export const GRADE_MAX = 36;

// 伤害倍率：每品 ×1.2 —— 1 品 1.20 倍，36 品 708.80 倍
export const GRADE_MULT_RATIO = 1.2;
// 耗灵力占灵力池：1 品 1/30（能放 30 次），36 品 全池（只能放 1 次）
export const COST_RATIO_MIN = 1 / 30;
export const COST_RATIO_MAX = 1;
// 特攻类（遁术/隐形/温养功法…）耗灵力**单独封顶四分之一池**：
// 这类法门的价值在「效果本身」，品阶只表示稀有与叙事分量，数值上没有回报，
// 若也按全池封顶就会出现「三十品遁术用一次就空蓝」这种惩罚玩家的设计。
export const COST_RATIO_MAX_SPECIAL = 1 / 4;
// 回复量占对应池：1 品 1/12，36 品 回满
export const RECOVER_RATIO_MIN = 1 / 12;
export const RECOVER_RATIO_MAX = 1;

// 双耗（同时消耗气血与法力）技能的资源伤害占比
export const RESOURCE_DAMAGE_RATIO = { 单耗: 1, 双耗: 0.35 };

// ---------- 段位标签（纯展示，不参与数值） ----------
export const SKILL_BANDS = ['基础', '精妙', '绝学', '禁术'];
export const BAND_SPAN = 9;

// ---------- 品阶换算 ----------

/** 品阶归一：整数 1~36；解析不出或越界一律返回 null。 */
export function clampGrade(v) {
  const n = typeof v === 'number' ? Math.round(v) : parseGrade(v);
  if (n == null || !Number.isFinite(n)) return null;
  if (n < GRADE_MIN || n > GRADE_MAX) return null;
  return n;
}

/** 几何插值：t=0 取 lo，t=1 取 hi。高跨度用几何而非线性，低品阶才不会挤成一团。 */
function lerpGeo(lo, hi, t) {
  const k = Math.min(1, Math.max(0, t));
  return lo * (hi / lo) ** k;
}

/**
 * 品阶 → 伤害倍率（就是卡面上写的那个「威力」）。每高一品 ×1.2。
 * 保留两位小数（避免快照里出现长尾小数）。品阶非法按 1 品算。
 * 空手 = 0 品 = 1.00 倍，故 1 品（1.20）已经比空手强两成。
 */
export function gradeMult(grade) {
  const n = clampGrade(grade);
  if (n == null) return gradeMult(GRADE_MIN);
  return Math.round(GRADE_MULT_RATIO ** n * 100) / 100;
}

/** 品阶 → 耗灵力占灵力池的比例。特攻类封顶更低（见 COST_RATIO_MAX_SPECIAL）。 */
export function gradeCostRatio(grade, type = SKILL_TYPE_DEFAULT) {
  const n = clampGrade(grade);
  const hi = type === '特攻' ? COST_RATIO_MAX_SPECIAL : COST_RATIO_MAX;
  if (n == null) return COST_RATIO_MIN;
  return lerpGeo(COST_RATIO_MIN, hi, (n - GRADE_MIN) / (GRADE_MAX - GRADE_MIN));
}

/** 品阶 → 回复量占对应池的比例。 */
export function gradeRecoverRatio(grade) {
  const n = clampGrade(grade);
  if (n == null) return RECOVER_RATIO_MIN;
  return lerpGeo(RECOVER_RATIO_MIN, RECOVER_RATIO_MAX, (n - GRADE_MIN) / (GRADE_MAX - GRADE_MIN));
}

/** 品阶 → 段位标签。只看品阶，**不影响任何数值**，供界面提示用。 */
export function bandOf(grade) {
  const n = clampGrade(grade);
  const i = n == null ? 0 : Math.floor((n - 1) / BAND_SPAN);
  return SKILL_BANDS[Math.min(SKILL_BANDS.length - 1, Math.max(0, i))];
}

// ---------- 品阶 → 骰子（2026-09-18 战斗系统新增，当晚改口径） ----------
// 技能伤害要掷 aDb 骰子（b ∈ 4/6/8/10/12/20/100，a 不限）。
// 本模块只负责「什么品阶配什么骰子」；**骰子管运气、品阶管威力**，两件事分开：
//     实际倍率 = gradeMult(品阶) × 运气（运气 = 掷值 ÷ 平均掷值，平均恒为 1.00）
// 所以骰子颗数这里只调「稳不稳」，不参与威力大小 —— 这也是为什么能保证
// 「每高一品，倍率就高出两成」而不被骰子的整数粒度抹平。
//   六段（每 6 品一段），面数固定十面，颗数 1 → 12：
//     1~6 品 1d10（一颗骰，忽高忽低）｜7~12 品 2d10｜13~18 品 3d10
//     19~24 品 5d10｜25~30 品 8d10｜31~36 品 12d10（十二颗，稳如老狗）
export const DICE_FACES_DEFAULT = 10;
export const DICE_COUNT_BANDS = [1, 2, 3, 5, 8, 12];
// 骰子段宽**独立于段位标签**（BAND_SPAN = 9 那是「基础/精妙/绝学/禁术」四个标签用的，
// 两者曾经共用一个常量，导致骰子只走出前四段、末尾的 8d10 与 12d10 成了死代码）。
export const DICE_BAND_SPAN = 6;

/** 品阶 → 这颗骰子该有几颗（只管运气的稳定度，不管威力）。 */
export function diceCountForGrade(grade) {
  const n = clampGrade(grade) ?? GRADE_MIN;
  const band = Math.min(DICE_COUNT_BANDS.length - 1, Math.floor((n - 1) / DICE_BAND_SPAN));
  return DICE_COUNT_BANDS[band];
}

/** 品阶 → 骰子对象 { count, faces }。 */
export function diceForGrade(grade) {
  return parseDice({ count: diceCountForGrade(grade), faces: DICE_FACES_DEFAULT });
}

/** 品阶 → 骰子文本（'3d10'）。 */
export function diceTextForGrade(grade) {
  return diceText(diceForGrade(grade));
}

// ---------- 攻击距离（战斗系统新增） ----------
// 需求：「人物的技能需要继续精细化，攻击距离需要加入。攻击距离的安排需要考虑较小的地图。」
// 15×15 的地图对角约 14 格，故上限取 8（超过半个地图就没有"距离"的意义了）。
// 攻击距离由 AI 手写（近身 1 / 中程 2-3 / 远程 4-6 / 超远 7-8），程序只做钳制，不推断。
export const ATTACK_RANGE_MIN = 1;
export const ATTACK_RANGE_MAX = 8;

/** 攻击距离归一：解析不出或越界一律返回 fallback（默认 1 = 近身）。 */
export function normalizeAttackRange(v, fallback = ATTACK_RANGE_MIN) {
  const t = String(v ?? '').trim();
  if (!t) return fallback;
  const m = t.match(/\d{1,2}/);
  if (!m) return fallback;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n < ATTACK_RANGE_MIN || n > ATTACK_RANGE_MAX) return fallback;
  return Math.round(n);
}

/** 距离档位的人话标签（界面与提示词共用）。 */
export function rangeLabel(range) {
  const n = normalizeAttackRange(range);
  if (n <= 1) return '近身';
  if (n <= 3) return '中程';
  if (n <= 6) return '远程';
  return '超远';
}

/** 「三品 / 3 / 十品」→ 3；无法解析返回 null。 */
export function gradeIndex(grade) {
  return parseGrade(grade);
}

// ---------- 技能对象 ----------

// 「类型」缺失或不合法时，按效果文本猜一次（AI 写技能时常省掉类型，开局入库与演化都走这里）
// 恢复优先判：只有明写「回气血/回法力」才算恢复
const RECOVER_HINTS = /恢复|回复|疗伤|治愈|回血|回气|补血|补气|续命|止血|复原|养伤/;
// 特攻：隐形、传送这类改变自身状态的法门，以及温养/吐纳/凝练「不直接伤人」的修炼功法
const SPECIAL_HINTS = /隐形|隐身|隐匿|传送|挪移|遁|禁制|阵法|幻术|结界|封印|探查|搜魂|传音|敛息|温养|养生|吐纳|凝练|锤炼|修炼|修习|御物|驱物|神识/;

/** 类型归一：只认三档；空值/未知值时按效果文本猜，再兜底「伤害」。 */
export function normalizeSkillType(type, effectText = '') {
  const t = String(type ?? '').trim();
  if (SKILL_TYPES.includes(t)) return t;
  const e = String(effectText ?? '');
  if (RECOVER_HINTS.test(e)) return '恢复';
  if (SPECIAL_HINTS.test(e)) return '特攻';
  return SKILL_TYPE_DEFAULT;
}

/**
 * 伤害属性归一：只认「物」「法」。
 * 其余值（含空、错字、其它词）一律返回空串——**不推断**，留空由 AI 在战斗时按效果判定。
 */
export function normalizeDmgKind(v) {
  const t = String(v ?? '').trim();
  return DMG_KINDS.includes(t) ? t : '';
}

/**
 * 生成/归一一条技能（唯一入口）。
 * 接受：
 *   · 字符串（老数据的裸技能名）
 *   · v2 中文键对象 { 名称, 类型, 品阶, 伤害属性, 攻击距离, 骰子, 效果 }
 *   · 内部结构 { name, type, grade, dmgKind, range, dice, effect }
 *   · 更老的 { name, grade, description }（含已废弃的「档次」字段——直接忽略）
 * 返回内部结构：
 *   { name, type, grade, band, dmgKind, range, dice, effect, dmgMult, costRatio, recoverRatio }
 *   · range  —— 攻击距离（1~8 格），AI 手写，程序只钳制
 *   · dice   —— 运气骰（'3d10'）。AI 手写的照用（面数非法则丢弃）；没写就按品阶生成
 *   · dmgMult —— 伤害倍率 = gradeMult(品阶)，即这门功法的「威力」；
 *                骰子只给它乘一个平均为 1 的运气，不改变这个数（见 battleDice.rollLuck）
 *   名称为空返回 null。品阶非法时按 1 品算，不阻断落库。
 */
export function buildSkill(input) {
  const src = (typeof input === 'string') ? { 名称: input } : (input && typeof input === 'object' ? input : null);
  if (!src) return null;
  const name = String(src.名称 ?? src.name ?? '').trim();
  if (!name) return null;

  const gradeRaw = src.品阶 ?? src.grade ?? '';
  // 非法品阶一律清空（守 1~36 品口径），不把「999品」这类原文带进快照
  const gradeNum = clampGrade(gradeRaw);
  const grade = gradeToText(gradeNum);
  const effect = String(src.效果 ?? src.effect ?? src.说明 ?? src.description ?? '').trim();
  // 名称也参与类型判断：「吐纳诀」「土遁术」「敛息术」这类线索只写在名字里
  const type = normalizeSkillType(src.类型 ?? src.type, `${name} ${effect}`);
  // 伤害属性由 AI 手填，程序只清洗取值，不猜
  const dmgKind = normalizeDmgKind(src.伤害属性 ?? src.dmgKind);
  // 攻击距离：AI 手写，程序钳制
  const range = normalizeAttackRange(src.攻击距离 ?? src.range ?? src.射程);
  // 骰子（只管运气）：AI 手写的合法骰子优先；没写或写坏了 → 按品阶程序生成
  const diceRaw = diceText(src.骰子 ?? src.dice);
  const dice = type === '伤害' ? (diceRaw || diceTextForGrade(gradeNum)) : (diceRaw || '');
  // 威力只看品阶，与骰子无关 —— 这样每一品都必然比上一品高两成，不会被骰子粒度抹平
  const dmgMult = type === '伤害' ? gradeMult(gradeNum) : null;

  return {
    name, type, grade, band: bandOf(gradeNum), dmgKind, range, dice, effect,
    dmgMult,
    costRatio: gradeCostRatio(gradeNum, type),
    recoverRatio: type === '恢复' ? gradeRecoverRatio(gradeNum) : null,
  };
}

/** buildSkill 的数组版：过滤空项。 */
export function buildSkillList(list) {
  return (Array.isArray(list) ? list : []).map(buildSkill).filter(Boolean);
}

/**
 * 技能的**绝对数值**（要照抄进快照的那些数字）。
 * @param skill 技能（任意形态，内部走 buildSkill）
 * @param ctx   { hpMax, mpMax } 角色自身池上限；缺哪项就哪项算不出来（返回 null）
 * @returns {{ dmgMult:number|null, dice:string, range:number, mpCost:number|null, hpRecover:number|null, mpRecover:number|null }}
 * 例：灵力上限 530、三品 → 耗蓝 24；气血上限 890、三品恢复 → 回血 148
 */
export function skillNumbers(skill, ctx = {}) {
  const s = buildSkill(skill);
  if (!s) return null;
  const hpMax = Math.round(Number(ctx?.hpMax) || 0);
  const mpMax = Math.round(Number(ctx?.mpMax) || 0);
  const of = (max, ratio) => (max > 0 && ratio > 0 ? Math.max(1, Math.round(max * ratio)) : null);
  return {
    dmgMult: s.dmgMult,
    dice: s.dice,
    range: s.range,
    mpCost: of(mpMax, s.costRatio),
    hpRecover: s.recoverRatio != null ? of(hpMax, s.recoverRatio) : null,
    mpRecover: s.recoverRatio != null ? of(mpMax, s.recoverRatio) : null,
  };
}

/** 从角色快照对象里取「气血上限 / 灵力上限」（接受 v2 文本或 {current,max} 或数字）。 */
export function poolCtxOf(src) {
  if (!src || typeof src !== 'object') return { hpMax: 0, mpMax: 0 };
  const pick = (v) => {
    if (v == null) return 0;
    if (typeof v === 'number') return Math.round(v);
    if (typeof v === 'object') return Math.round(Number(v.max ?? v.current) || 0);
    const t = String(v);
    const parts = t.split('/');
    const n = Number(parts[parts.length - 1]);
    return Number.isFinite(n) ? Math.round(n) : 0;
  };
  const stats = src.stats || src;
  return { hpMax: pick(stats.hp ?? src.气血), mpMax: pick(stats.mp ?? src.法力) };
}

/** 内部结构 → v2 中文键对象（写进快照的形态）。不适用该类型的字段写 null。 */
export function skillToV2(skill, ctx = {}) {
  const s = buildSkill(skill);
  if (!s) return null;
  const n = skillNumbers(s, ctx);
  const row = {
    名称: s.name,
    类型: s.type,
    品阶: s.grade,
  };
  // 攻击距离所有类型都写（恢复类也要知道够不够得着队友）
  row.攻击距离 = s.range;
  // 伤害属性由 AI 手填；未标注就不写这个键（不塞空串进快照）
  if (s.dmgKind) row.伤害属性 = s.dmgKind;
  row.效果 = s.effect;
  if (s.type === '伤害') {
    row.伤害倍率 = n.dmgMult;   // ＝ gradeMult(品阶)，卡片与旧数据都读它
    if (n.dice) row.骰子 = n.dice; // 战斗时掷的运气骰（只决定这一击的浮动，不决定威力）
  }
  if (s.type === '恢复') { row.回血 = n.hpRecover; row.回蓝 = n.mpRecover; }
  row.耗蓝 = n.mpCost;
  return row;
}

/** v2 中文键对象 → 内部结构（读快照用）。旧数据里的「档次」字段直接忽略。 */
export function skillFromV2(v2Skill) {
  if (v2Skill == null) return null;
  if (typeof v2Skill === 'string') return buildSkill(v2Skill);
  return buildSkill({
    name: v2Skill.名称 ?? v2Skill.name,
    type: v2Skill.类型 ?? v2Skill.type,
    grade: v2Skill.品阶 ?? v2Skill.grade,
    dmgKind: v2Skill.伤害属性 ?? v2Skill.dmgKind,
    range: v2Skill.攻击距离 ?? v2Skill.range,
    dice: v2Skill.骰子 ?? v2Skill.dice ?? v2Skill.伤害骰,
    effect: v2Skill.效果 ?? v2Skill.effect ?? v2Skill.说明 ?? v2Skill.description,
  });
}

/** 数字加千分位，避免大数在注入文本里数不清位数。 */
function fmt(n) {
  if (n == null) return '';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * 系数摘要文本，供注入与界面共用。绝对值部分需要 ctx（角色池上限）才算得出。
 * 例：伤害类 → 「伤害倍率×1.73（运气骰 2d10），距离 2，耗蓝24」
 *     恢复类 → 「回血148，回蓝89，距离 1，耗蓝12」
 *     特攻类 → 「距离 1，耗蓝12」
 * 没给 ctx 时省略耗蓝/回复段，只留倍率与距离（宁缺勿错）。
 * 前缀「伤害倍率×N」是**给 AI 照抄的口径**（mortalProtocols 明写「写着伤害倍率×1.5 就抄 1.5」），
 * 改字眼前先确认协议同步改过。
 */
export function skillCoefText(skill, ctx = {}) {
  const s = buildSkill(skill);
  if (!s) return '';
  const n = skillNumbers(s, ctx);
  const parts = [];
  if (s.type === '伤害') {
    if (n.dmgMult != null) {
      // 骰子只管这一击的运气，不改变平均威力 —— 所以写在括号里当附注，不进算式
      parts.push(n.dice ? `伤害倍率×${n.dmgMult}（运气骰 ${n.dice}）` : `伤害倍率×${n.dmgMult}`);
    }
  }
  if (s.type === '恢复') {
    if (n.hpRecover != null) parts.push(`回血${fmt(n.hpRecover)}`);
    if (n.mpRecover != null) parts.push(`回蓝${fmt(n.mpRecover)}`);
  }
  parts.push(`距离 ${s.range}`);
  if (n.mpCost != null) parts.push(`耗蓝${fmt(n.mpCost)}`);
  return parts.join('，');
}

/**
 * 状态栏 / 注入用的整行技能文本（唯一格式出处，注入与界面共用）。
 * 括号内顺序固定为「类型·伤害属性·品阶」——**属性永远是第 2 段**，战斗协议据此取值。
 * 例：`火弹术（伤害·法·三品）：伤害倍率×1.73（运气骰 2d10），距离 3，耗蓝24`
 * 伤害属性未标注时省略该段：`火弹术（伤害·三品）：伤害倍率×1.73（运气骰 2d10），距离 3，耗蓝24`
 * 攻击距离是**战斗接管的必需字段**（程序按它判够不够得着），故写在系数段里。
 */
export function skillLineText(skill, ctx = {}) {
  const s = buildSkill(skill);
  if (!s) return '';
  const head = [s.type, s.dmgKind, s.grade].filter(Boolean).join('·');
  const coef = skillCoefText(s, ctx);
  return `${s.name}（${head}）：${coef}`;
}

/**
 * 拆解「名称｜类型｜品阶｜伤害属性｜攻击距离｜效果」的竖线分段（唯一实现，校验与落地共用）。
 * 三种长度都认，判据是**段的内容**而不是段数：
 *   · 6 段：火弹术｜伤害｜三品｜法｜3｜凝法力为火弹射出
 *   · 5 段：火弹术｜伤害｜三品｜法｜凝法力为火弹射出  （第 5 段不是纯数字 → 归入效果，攻击距离留空）
 *   · 4 段：火弹术｜伤害｜三品｜凝法力为火弹射出      （伤害属性也留空，留待 AI 战斗时按效果判定）
 * 写错段序时整段归入效果，不会误吞。
 */
export function parseSkillLine(segments) {
  const seg = (Array.isArray(segments) ? segments : []).map(x => String(x ?? '').trim());
  // 纯距离数字：'3' / '3格' / '4 格'（只认整段就是它，避免把「3 秒内」当距离）
  const isRange = (v) => /^\d{1,2}\s*格?$/.test(String(v ?? '').trim());
  const fourth = seg[3] ?? '';
  if (DMG_KINDS.includes(fourth)) {
    const fifth = seg[4] ?? '';
    const hasRange = isRange(fifth);
    return {
      name: seg[0] ?? '', type: seg[1] ?? '', grade: seg[2] ?? '',
      dmgKind: fourth,
      range: hasRange ? normalizeAttackRange(fifth) : undefined,
      effect: seg.slice(hasRange ? 5 : 4).join('｜').trim(),
    };
  }
  return { name: seg[0] ?? '', type: seg[1] ?? '', grade: seg[2] ?? '', dmgKind: '', effect: seg.slice(3).join('｜').trim() };
}

/** 技能项的格式契约文案（校验报错、提示词共用，避免多处手写不一致）。 */
export const SKILL_WRITE_HINT = `名称｜类型｜品阶｜伤害属性｜攻击距离｜效果（类型只能写 伤害 / 恢复 / 特攻；品阶写 1~36 品，如「三品」，品阶越高威力越大；伤害属性只有「伤害」类要写，取值 物 或 法，不写就留空；**攻击距离**写 1~8 的整数，表示战斗中隔着几格能打到——近身武器写 1，掌风剑气写 2~3，法器飞剑写 4~6，超远距离神通最多写 8，战场只有 15×15 格，写大没有意义；效果写一句用途）。骰子、伤害倍率与耗灵力由程序按品阶算好，不要自己写数字。`;
