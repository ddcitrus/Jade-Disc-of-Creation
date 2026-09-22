// ===== 参战单位的数据整形 =====
// 把角色快照里的「技能」「物品」翻译成战斗引擎看得懂的结构。
// 单独成一个文件的原因：battleTrigger 要 import snapshotSchema（较重），
// 而 skillCodex 是叶子；把整形逻辑放这里，两边的依赖方向都干净。
//
// 口径与正文协议完全一致：
//   · 技能倍率、耗灵力、回复量**照抄快照里已有的数字**，不另算
//   · 骰子若无（历史数据）则按品阶现场补一份，绝不改快照
//   · 攻击距离快照里没有就按 1（近身），宁可保守也不凭空放大射程
//
// 2026-09-18 晚：技能的「威力」（mult）与「运气骰」（dice）分开了 ——
//   mult  ＝ 品阶定死的伤害倍率（含装备加成后的攻击力由引擎再乘它）
//   dice  ＝ 战斗时掷的骰子，只给这一击一个平均为 1 的运气，不改变平均强度

import { skillFromV2, skillNumbers } from './skillCodex.js';

/**
 * 快照技能（v2 中文键）→ 战斗用技能。
 * @param v2Skill 快照 skills 里的一项
 * @param {{ hpMax:number, mpMax:number }} ctx 该角色的气血/灵力上限（算回复量与耗蓝用）
 */
export function buildSkillFromSnapshot(v2Skill, ctx = {}) {
  const s = skillFromV2(v2Skill);
  if (!s) return null;
  const n = skillNumbers(s, ctx);
  return {
    name: s.name,
    type: s.type,
    dmgKind: s.dmgKind,
    grade: s.grade,
    band: s.band,
    range: s.range,
    dice: s.dice,
    mult: s.dmgMult,        // 威力：品阶定死（骰子只在其上乘一个平均为 1 的运气）
    mpCost: n?.mpCost ?? 0,
    hpRecover: n?.hpRecover ?? 0,
    mpRecover: n?.mpRecover ?? 0,
    effect: s.effect,
  };
}

/**
 * 从物品的加成文本/字段里读出战斗回复量。
 * 支持：mods { 气血:+50 } / { 气血上限:+50 } / { 回血:50 } / { 法力:+20 } / { 回蓝:.., 回蓝:.. }
 */
export function itemHealOf(item) {
  const mods = item?.mods && typeof item.mods === 'object' ? item.mods : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const n = Number(mods[k]);
      if (Number.isFinite(n) && n) return Math.abs(n);
    }
    return 0;
  };
  return {
    hp: pick('气血', '回血', '气血上限', '恢复气血', '生命'),
    mp: pick('法力', '回蓝', '法力上限', '灵力', '恢复法力'),
  };
}
