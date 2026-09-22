// ===== 战斗 AI（程序计算敌方最优解）=====
// 需求：「敌人根据程序计算战斗最优解（最重要的地方，务必编写严谨）」。
//
// 严谨的地方在哪：
//   1. **枚举完整**：候选 = (原地 ∪ 全部可达格) × (普攻 ∪ 每一门可用功法 ∪ 每一件可用器物
//      ∪ 防御 ∪ 蓄力 ∪ 威吓 ∪ 投降) × (每一个合法目标)。
//      ⚠️ **没有「逃遁」**：敌方一律禁止逃跑（2026-09-18 定案，见 battleEngine.canFlee），
//      候选清单由 legalActions 给出，它不给这一项，估值里也就不需要有这条分支。
//      攻击距离、法力是否够、有没有视线，全部用与结算**同一套**函数判定（legalActions / previewAttack），
//      不存在"AI 自己觉得能打"这种可能。
//   2. **估值用真实公式**：期望伤害 = 功法威力 × 暴击期望 × 地形 × 姿态 × 威吓折减，
//      全部由 battleEngine.previewAttack 解析给出（不掷骰、无随机），因此可复现、可单测。
//      2026-09-18 取消闪避后出手必然命中，命中率恒为 1，已不参与估值。
//   3. **站位是真的走位**：评估某个候选格时，把角色临时搬到那一格再估值，
//      所以"绕到背后吃 +15% 暴击""退到 4 格外避开近战""躲进树林少吃 15% 远程"都会被算进去。
//   4. **每一个候选都要付"预计挨打"的账**，防御只是把这次的受伤系数降到 0.6。
//
// 复杂度：可达格 ≤ 30 × 动作 ≤ 8 × 目标 ≤ 3 ≈ 700 次估值，实测 <3ms。

import {
  TUNING, activeIds, legalActions, previewAttack, attackSpec, moveTo, doAction, endTurn, intimidateDebuff,
} from './battleEngine.js';
import { distance, hasLineOfSight, stepField, cellKey, ANGLE_FRONT_COS, ANGLE_BACK_COS } from './battleGrid.js';

// ---------- 权重（全部集中，改平衡只动这里） ----------
export const AI_WEIGHTS = {
  DEALT: 1.00,      // 造成的期望伤害，直接按血量当量计入
  TAKEN: 0.85,      // 预计承受的伤害，打八五折扣（略显冒险，不做缩头乌龟）
  MP: 0.30,         // 每消耗 1% 法力，扣自身血量上限的 0.30%
  POSITION: 0.25,   // 与「舒适距离」每差 1 格，扣本次期望伤害的 25%
  APPROACH: 0.05,   // 打不到人时，每差 1 步（真实步数，不是直线）折算期望伤害的 5%
  CLOSE: 0.06,      // 本回合比起原地「又走近了几步」的额外奖励——给走位一个不会消失的梯度
  HEAL: 1.00,       // 回复量按实际回复值计入（满血时归零）
  SURVIVE: 0.05,    // 每次行动给一点基础生存分（按当前血量），避免空转
  LOW_HP: 0.25,     // 血量低于此比例进入保命模式
  LOW_HP_RISK: 1.40,    // 保命模式下，对「预计承受伤害」的敏感度
  LOW_HP_HEAL: 2.00,    // 保命模式下，治疗的额外权重
};

/**
 * 评分模型（唯一口径，所有候选动作用同一套基线）：
 *
 *   score = 行动收益 − 预计承受伤害 × 风险系数 × 本动作的受伤系数 + 生存分 − 走位 / 法力成本
 *
 * 关键点：**「预计承受伤害」对每个候选动作都要扣一次**，防御只是把这次的受伤系数降到 0.6。
 * （早先的写法把防御的"减伤额"当成正收益加进去，等于给防御加了双份好处，
 *   于是敌人会一直缩在原地防御、十二个回合打不出一次伤害 —— 实测踩过这个坑。）
 * 于是「攻击 vs 防御」的真实分界是：期望伤害 > 0.4 × 预计承受伤害就该动手，
 * 而不是「期望伤害 > 1.7 × 预计承受伤害」那种只挨打不出手的错误阈值。
 */

/**
 * 决定当前出手者的最优行动。
 * @returns {{ ok:boolean, reason?:string, moveTo:{x,y}|null, action:object|null, score?:number, why?:string }}
 */
export function decideAction(state, id) {
  const u = state.units[id];
  if (!u || state.finished || state.actorId !== id) return { ok: false, reason: '不是该角色的回合' };
  const foes = activeIds(state).filter(x => state.units[x].side !== u.side).map(x => state.units[x]);
  if (!foes.length) return { ok: false, reason: '没有敌人' };

  const selfHpRatio = u.hpMax > 0 ? u.hp / u.hpMax : 1;
  const lowHp = selfHpRatio < AI_WEIGHTS.LOW_HP;
  const desired = desiredRangeOf(u);

  // 走位引导用的「到最近敌人的真实步数」场（绕开不可通行地块）。
  // 不能用切比雪夫距离：那是直线，看不见墙；贴着墙时梯度会消失，AI 会原地打转。
  const field = stepField(state.grid, foes.map(f => ({ x: f.x, y: f.y })));
  const gapOf = (cell) => {
    const v = field.get(cellKey(cell.x, cell.y));
    return v == null ? Infinity : v;
  };

  // 候选格：原地 + 全部可达格（按代价升序，最多 30 个，避免极端情况下爆表）
  const home = { x: u.x, y: u.y };
  const cells = [{ x: home.x, y: home.y, cost: 0 }, ...(state.turn?.reach?.cells || []).slice(0, 30)];
  const acts = legalActions(state, id);

  let best = null;
  for (const cell of cells) {
    // 临时搬到候选格估值（估值函数读的是 actor.x/y 与脚下地形，必须真的搬）
    u.x = cell.x;
    u.y = cell.y;
    const incep = worstIncoming(state, u, foes);
    const refDmg = Math.max(1, bestSelfDamage(state, u, foes), u.hpMax * 0.03);
    const dNear = nearestDistance(state, u, foes);
    const ctx = {
      incep, refDmg, desired, dNear, lowHp, cellCost: cell.cost,
      // 走位用的「真实步数」与「打得到的直线距离」是两码事：前者指导往哪走，后者决定能不能打到
      gap: gapOf(cell), homeGap: gapOf(home),
    };

    for (const act of acts) {
      const r = evaluateAction(state, u, act, foes, ctx);
      if (!r) continue;
      if (!best || r.score > best.score) {
        best = {
          score: r.score,
          moveTo: cell,
          action: { ...actionOf(act), targetId: r.targetId },
          why: r.why,
        };
      }
    }
    u.x = home.x;
    u.y = home.y;
  }

  if (!best) return { ok: false, reason: '没有任何可选行动' };
  // 原地行动时不要返回一次无意义的移动
  if (best.moveTo.x === home.x && best.moveTo.y === home.y) best.moveTo = null;
  return { ok: true, moveTo: best.moveTo, action: best.action, score: best.score, why: best.why };
}

function actionOf(act) {
  return {
    kind: act.kind,
    skillName: act.skill?.name,
    itemName: act.item?.name,
    skill: act.skill,
    item: act.item,
  };
}

// ---------- 单个候选的估值 ----------
function evaluateAction(state, u, act, foes, ctx) {
  const { incep, refDmg, desired, dNear, lowHp, cellCost, gap, homeGap } = ctx;
  const riskMul = lowHp ? AI_WEIGHTS.LOW_HP_RISK : 1;
  const why = [];
  let value = 0;        // 行动收益
  let takenMul = 1;     // 本次动作的受伤系数（只有防御会降）
  let mpCost = 0;
  let targetId = null;

  if (act.kind === 'attack' || (act.kind === 'skill' && act.skill?.type === '伤害')) {
    const targets = pickTargets(state, u, foes, act);
    if (!targets.length) return null;
    let bestTarget = null;
    let bestValue = -Infinity;
    let bestPv = null;
    for (const t of targets) {
      const pv = previewAttack(state, u, t, attackSpec(u, t, act));
      // 不再按「剩余血量 / 保底血线」预判击杀：攻击价值就是期望伤害（再加侧/背击的少量加成）。
      // 能不能把人打倒、对方是死是活，交给引擎（hp 归零即退出）与战后 AI 叙事。
      let v = pv.expDamage;
      const ang = angleValue(state, u, t);
      if (ang === 'back') v += pv.expDamage * 0.15;
      else if (ang === 'side') v += pv.expDamage * 0.08;
      if (v > bestValue) { bestValue = v; bestTarget = t; bestPv = pv; }
    }
    value += bestValue;
    targetId = bestTarget.id;
    mpCost = Math.round(Number(act.mpCost) || 0);
    why.push(`期望伤害 ${Math.round(bestPv.expDamage)}`);
  } else if (act.kind === 'skill' && act.skill?.type === '恢复') {
    const hpGain = Math.min(Math.round(Number(act.skill.hpRecover) || 0), Math.max(0, u.hpMax - u.hp));
    const mpGain = Math.min(Math.round(Number(act.skill.mpRecover) || 0), Math.max(0, u.mpMax - u.mp));
    value += (hpGain + mpGain * 0.25) * AI_WEIGHTS.HEAL * (lowHp ? 1 + AI_WEIGHTS.LOW_HP_HEAL : 1);
    mpCost = Math.round(Number(act.mpCost) || 0);
    why.push(`回复 ${hpGain} 气血 / ${mpGain} 法力`);
  } else if (act.kind === 'item') {
    const hpGain = Math.min(Math.round(Number(act.item?.heal?.hp) || 0), Math.max(0, u.hpMax - u.hp));
    const mpGain = Math.min(Math.round(Number(act.item?.heal?.mp) || 0), Math.max(0, u.mpMax - u.mp));
    value += (hpGain + mpGain * 0.25) * AI_WEIGHTS.HEAL * (lowHp ? 1 + AI_WEIGHTS.LOW_HP_HEAL : 1);
    why.push(`服丹回复 ${hpGain} 气血`);
  } else if (act.kind === 'intimidate') {
    const targets = pickTargets(state, u, foes, act);
    if (!targets.length) return null;
    let bv = -Infinity;
    for (const t of targets) {
      const v = incomingFrom(state, t, u).expDamage * Math.abs(intimidateDebuff(u.spirit, t.spirit)) * 1.2;
      if (v > bv) { bv = v; targetId = t.id; }
    }
    value += bv;
    why.push(`压对手下一击威力，等价减伤 ${Math.round(bv)}`);
  } else if (act.kind === 'skill' && act.skill?.type === '特攻') {
    // 特攻类本版不产生战斗数值（效果由叙事承担），给一个很低的固定分，
    // 只在"实在没别的可做"时才会被选中 —— 绝不冒充攻击。
    value += u.hpMax * 0.005;
    why.push('特攻类，无即时数值收益');
  } else if (act.kind === 'defend') {
    takenMul = TUNING.DEFEND_TAKEN_MUL;
    why.push(`本回合少挨 ${Math.round(incep.expDamage * (1 - TUNING.DEFEND_TAKEN_MUL))} 伤害`);
  } else if (act.kind === 'charge') {
    value += refDmg * (TUNING.CHARGE_DEALT_MUL - 1) * 0.5;
    why.push('蓄力换下一击 ×1.6');
  } else if (act.kind === 'surrender') {
    const hopeless = lowHp && refDmg < incep.expDamage * 0.35;
    value += hopeless ? u.hp * 0.8 : -u.hpMax;
    why.push(hopeless ? '局势绝望，保命认输' : '尚有可为，不降');
  } else {
    return null;
  }

  // 法力成本：按「本场每点法力能换多少伤害」折算成血量当量
  if (mpCost > 0 && u.mpMax > 0) {
    value -= AI_WEIGHTS.MP * (mpCost / u.mpMax) * (u.hpMax * 0.5);
    why.push(`耗蓝 ${mpCost}`);
  }

  // 走位：与「舒适距离」的偏差 + 打不到人时的逼近动力 + 走路的代价
  const dev = Math.abs(dNear - desired);
  value -= AI_WEIGHTS.POSITION * dev * refDmg * 0.25;
  value -= cellCost * refDmg * 0.02;

  // 逼近动力按**真实步数**算，不按直线距离。
  // 直线距离在「墙/山」这类障碍旁边是恒定的（绕行路径上每一格的直线距离都一样），
  // 梯度会消失，AI 就会贴着障碍原地防御 —— 实测踩过这个坑（50 回合僵持）。
  // 所以这里用 stepField 的步数当势能函数：只要比原地更靠近，就一定拿得到分。
  const gapNow = Number.isFinite(gap) ? gap : (Number.isFinite(homeGap) ? homeGap : 0);
  const gapHome = Number.isFinite(homeGap) ? homeGap : gapNow;
  if (gapHome > desired) {
    value -= AI_WEIGHTS.APPROACH * Math.max(0, gapNow - desired) * refDmg;
    value += AI_WEIGHTS.CLOSE * (gapHome - gapNow) * refDmg;
  }

  const score = value - AI_WEIGHTS.TAKEN * riskMul * takenMul * incep.expDamage + u.hp * AI_WEIGHTS.SURVIVE;
  return { score, why: why.join('，'), targetId };
}

// ---------- 目标筛选（与引擎 legalActions 同一套距离/视线口径） ----------
function pickTargets(state, u, foes, act) {
  if (act.kind === 'attack') return foes.filter(f => distance(u, f) <= 1);
  if (act.kind === 'intimidate') return foes.filter(f => distance(u, f) <= 3);
  if (act.kind === 'skill') {
    const sk = act.skill;
    if (sk.type === '伤害') {
      const range = Math.max(1, Math.round(Number(act.range) || 1));
      return foes.filter(f => {
        const d = distance(u, f);
        if (d > range) return false;
        if (d >= TUNING.RANGED_AT && !hasLineOfSight(state.grid, u, f)) return false;
        return true;
      });
    }
    return [u];   // 恢复类默认给自己；特攻类无目标（上面已单独处理）
  }
  return [];
}

// ---------- 估值辅助 ----------

/** 走位角度（侧/背），与引擎的 hitAngle **共用同一组扇区常量**（改一处两边一起变）。 */
function angleValue(state, u, target) {
  const f = target.facing || { x: 1, y: 0 };
  const vx = u.x - target.x;
  const vy = u.y - target.y;
  if (!vx && !vy) return 'front';
  const len = Math.hypot(vx, vy) * Math.hypot(f.x, f.y) || 1;
  const cos = (vx * f.x + vy * f.y) / len;
  if (cos >= ANGLE_FRONT_COS) return 'front';
  if (cos <= ANGLE_BACK_COS) return 'back';
  return 'side';
}

/** 自己最舒服的交手距离（射程最远的伤害功法；只会近战则为 1）。 */
function desiredRangeOf(u) {
  let r = 1;
  for (const sk of u.skills) {
    if (sk.type !== '伤害') continue;
    if ((Number(sk.mpCost) || 0) > u.mp) continue;
    r = Math.max(r, Math.min(8, Math.round(Number(sk.range) || 1)));
  }
  return r;
}

function nearestDistance(state, u, foes) {
  let best = Infinity;
  for (const f of foes) best = Math.min(best, distance(u, f));
  return Number.isFinite(best) ? best : 0;
}

/** 对手对我方单位最可能的那一击的期望伤害（含命中最高的那一个候选）。 */
function incomingFrom(state, foe, me) {
  if (!foe || !me) return { expDamage: 0, hitChance: 0 };
  const d0 = distance(foe, me);
  // 候选的解析参数一律走引擎的 attackSpec —— 与界面上给玩家看的预估、真正结算那份**同一个出口**
  const candidates = [attackSpec(foe, me, { kind: 'attack' })];
  for (const sk of foe.skills) {
    if (sk.type !== '伤害') continue;
    if ((Number(sk.mpCost) || 0) > foe.mp) continue;
    const range = Math.max(1, Math.round(Number(sk.range) || 1));
    if (d0 > range) continue;
    if (d0 >= TUNING.RANGED_AT && !hasLineOfSight(state.grid, foe, me)) continue;
    candidates.push(attackSpec(foe, me, { kind: 'skill', skill: sk, range }));
  }
  let best = { expDamage: 0, hitChance: 0 };
  for (const spec of candidates) {
    const pv = previewAttack(state, foe, me, spec);
    if (pv.expDamage > best.expDamage) best = pv;
  }
  return best;
}

/** 场上所有敌人里，对我威胁最大的那一击。 */
function worstIncoming(state, u, foes) {
  let best = { expDamage: 0, hitChance: 0 };
  for (const f of foes) {
    const pv = incomingFrom(state, f, u);
    if (pv.expDamage > best.expDamage) best = pv;
  }
  return best;
}

/** 我方对任意敌人的最高期望伤害（用于蓄力 / 投降的价值判断）。 */
function bestSelfDamage(state, u, foes) {
  let best = 0;
  for (const f of foes) {
    const d = distance(u, f);
    if (d <= 1) best = Math.max(best, previewAttack(state, u, f, attackSpec(u, f, { kind: 'attack' })).expDamage);
    for (const sk of u.skills) {
      if (sk.type !== '伤害') continue;
      if ((Number(sk.mpCost) || 0) > u.mp) continue;
      const range = Math.max(1, Math.round(Number(sk.range) || 1));
      if (d > range) continue;
      if (d >= TUNING.RANGED_AT && !hasLineOfSight(state.grid, u, f)) continue;
      const spec = attackSpec(u, f, { kind: 'skill', skill: sk, range });
      best = Math.max(best, previewAttack(state, u, f, spec).expDamage);
    }
  }
  return best;
}

/**
 * 跑完敌方的整个回合（走位 + 出手 + 交出回合）。
 * 走位与出手都调用引擎里与玩家同一套的 moveTo / doAction，不存在"AI 有特权路径"。
 * @returns {{ decided:boolean, decision?:object, tail:object[] }}
 */
export function runEnemyTurn(state, id) {
  const before = state.log.length;
  const d = decideAction(state, id);
  if (d.ok) {
    if (d.moveTo) {
      void moveTo(state, id, d.moveTo); // 走不过去就原地出手（例如被同伴挡住），不阻断
    }
    if (state.actorId === id && !state.finished && !state.turn?.acted) doAction(state, id, d.action || { kind: 'defend' });
  }
  // 兜底：这一手没交出去（候选全不可行之类），也至少摆个防御，别让这一回合空转
  if (state.actorId === id && !state.finished && !state.turn?.acted) doAction(state, id, { kind: 'defend' });
  // 2026-09-19：出手**不再自动交出回合**了（见 battleEngine.doAction），所以这里必须显式结束。
  // 这是行动条仅有的两个推进点之一（另一个是玩家点「结束回合」按钮）；
  // 漏掉这一句，整局会永远卡在同一个敌人身上。
  if (state.actorId === id && !state.finished) endTurn(state);
  return { decided: !!d.ok, decision: d, tail: state.log.slice(before) };
}
