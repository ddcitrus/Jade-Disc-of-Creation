// ===== 战斗引擎（程序完全接管战斗）=====
// 需求：「程序完全接管战斗」「根据脚力值计算行动条，安排行动顺序」「程序把战斗日志返回 AI」。
//
// 三层职责，本文件是唯一的真理来源：
//   1. 行动条 —— 按境界档位查出出手间隔（表见 battleSpeed.js），谁先动由程序定，不由 AI 说
//   2. 结算   —— 命中 / 骰子 / 伤害 / 暴击 / 地形 / 姿态，全部走 resolveAttack
//   3. 裁定   —— 伤亡（hp 归零即退出战斗）、逃遁、投降、回合上限，只有程序能判
//
// 关键约定：
//   · 引擎状态是**可变对象**（含 Map），UI 每步之后取一次快照渲染即可；
//   · 所有随机走 state.rng（可播种），同一 seed 可复现同一局，便于排查与单测；
//   · AI 不参与任何一步 —— 敌方决策在 battleAI.js，它只调用本文件的 dryRun 接口估值。

import {
  MAP_SIZE, terrainOf, bakeMap, defaultBattleMap, spawnPositions, DEFAULT_TERRAIN_ID,
} from './battleTerrain.js';
import {
  reachable, pathTo, distance, cellKey, hitAngle, facingFromMove, hasLineOfSight,
} from './battleGrid.js';
import { makeRng, parseDice, rollLuck, diceText, diceExpected } from './battleDice.js';

// ---------- 调参常量（全部集中在此，改平衡只动这里） ----------
export const TUNING = {
  // 行动条：出手间隔**不在这里算**了 —— 按境界档位查表，见 battleSpeed.js。
  // 下面三个 ACTION_* 只服务 actionInterval()，那是「单位没带 interval 字段」时的回退公式。
  ACTION_BASE: 100,
  ACTION_W: 0.25,
  ACTION_S0: 40,
  ACTION_MIN_INTERVAL: 25,          // 回退公式的下限（旧口径：再快不快过凡人的 1/3.5）

  // 每回合行动格 = 9 ~ 16，按脚力对数插值（见 moveBudget）。
  // 2026-09-20：地图边长由 15 扩到 27，预算同步上调，保证约 2 回合可接战、又不至于一次走太多。
  MOVE_MIN: 9,
  MOVE_MAX: 16,
  MOVE_SPEED_LO: 20,                    // 凡人脚力
  MOVE_SPEED_HI: 5.7075826223144e14,    // 道祖脚力

  // 闪避：已于 2026-09-18 整体取消 —— 出手不再掷命中判定，攻击必然命中。
  // 脚力现在只管两件事：出手间隔（battleSpeed.js 的档位表）与每回合走位格数。
  // 原先闪避的三个来源（脚力比值、地形 dodge、威吓 aimDebuff）分别被删除 / 迁移。

  // 暴击
  // 2026-09-18：暴击底子改成角色的「会心」属性（单位＝百分点，见 snapshotSchema 的 ATTR_LABELS）。
  // 下面这个常量只是**兜底**：单位没带会心时按 5 算，正好等于改版前的基础暴击率 5%。
  CRIT_DEFAULT: 5,
  CRIT_LUCK_COEF: 0.40,             // 气运满值（100）时贡献的暴击率：线性，一点气运 0.4 个百分点
  CRIT_LUCK_MAX_LUCK: 100,          // 气运属性的硬上限（与 attrClamp 的 FIXED_BOUNDS.luck 同值，探针锁死两处）
  CRIT_SIDE: 0.08,
  CRIT_BACK: 0.15,
  CRIT_MAX: 1.00,                   // 暴击率上限：100%（必暴）
  CRIT_MUL: 1.5,                    // 基础暴击伤害倍率
  CRIT_OVERFLOW_TO_MUL: 1,          // 会心溢出：暴击率超过上限后，每多 1 个百分点 → 暴击伤害 +1 个百分点

  // 伤害
  DMG_FLOOR_RATIO: 0.10,            // 保底伤害 = 攻击 × 倍率 × 10%
  DEFEND_TAKEN_MUL: 0.6,            // 防御姿态：受到伤害 ×0.6
  CHARGE_DEALT_MUL: 1.6,            // 蓄力：下一击伤害 ×1.6
  CHARGE_COST_MUL: 0.5,             // 蓄力：下一手法力消耗 ×0.5
  INTIMIDATE_DMG: -0.15,            // 威吓：被压者下一击威力 −15%（1 回合）
  RANGED_AT: 4,                     // 距离 ≥ 此值算远程（受树林遮蔽影响）

  MAX_ROUNDS: 50,                   // 超过判僵持
};

// ---------- 小工具 ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
// 战报里的小数一律保留三位。曾经用两位，于是「威力 1.73 × 运气 0.55 → 倍率 0.94」
// 读起来像算错了（1.73 × 0.55 = 0.95）—— 那只是两个因子各自被四舍五入过。
// 三位之后写出来就是 1.728 × 0.545 ≈ 0.942，玩家能自己验算。
const r3 = (v) => Math.round(num(v, 0) * 1000) / 1000;

/**
 * 脚力 → 出手间隔。**回退公式**，只在单位没带 interval 字段时才用
 * （引擎可脱离数值表单独跑）。正式口径按境界档位查表：battleSpeed.js。
 */
export function actionInterval(speed) {
  const s = Math.max(0, num(speed));
  const raw = TUNING.ACTION_BASE / (1 + TUNING.ACTION_W * Math.log2(1 + s / TUNING.ACTION_S0));
  return Math.max(TUNING.ACTION_MIN_INTERVAL, Math.round(raw * 100) / 100);
}

/**
 * 脚力 → 每回合行动格预算（9 ~ 16 格）。
 * 做法：把脚力取对数后在「凡人 ~ 道祖」区间上等分——
 *   凡人脚力 20 → 9 格，道祖脚力 ≈5.71e14 → 16 格。
 * 为什么用对数：脚力是几何阶梯（凡人到道祖跨 13.5 个数量级），
 * 直接按数值线性分的话，炼气以下全挤在 9 格、大乘以上全挤在 16 格。
 */
export function moveBudget(speed) {
  const s = Math.max(0, num(speed));
  const lo = Math.log(Math.max(1, TUNING.MOVE_SPEED_LO));
  const hi = Math.log(Math.max(TUNING.MOVE_SPEED_LO * 2, TUNING.MOVE_SPEED_HI));
  const t = clamp((Math.log(Math.max(s, 1)) - lo) / (hi - lo), 0, 1);
  const raw = TUNING.MOVE_MIN + Math.round((TUNING.MOVE_MAX - TUNING.MOVE_MIN) * t);
  return clamp(raw, TUNING.MOVE_MIN, TUNING.MOVE_MAX);
}

// ============================================================
// 1. 建局
// ============================================================

/**
 * 创建一局战斗。
 * @param {object} cfg
 * @param {object[]} cfg.units 参战单位（已归一化，见 battleTrigger.unitsFromSnapshots）
 * @param {object} [cfg.mapRecipe] AI 给的地图配方；缺省用默认战场
 * @param {'normal'|'deathmatch'} [cfg.kind]
 * @param {number} [cfg.seed]
 * @returns {object} 战斗状态
 */
export function createBattle(cfg = {}) {
  const seed = Number.isFinite(Number(cfg.seed)) ? Number(cfg.seed) : Math.floor(Math.random() * 1e9);
  const rng = makeRng(seed);
  const grid = cfg.mapRecipe ? bakeMap(cfg.mapRecipe) : defaultBattleMap();
  const kind = cfg.kind === 'deathmatch' ? 'deathmatch' : 'normal';
  const allowDeath = cfg.allowDeath != null ? !!cfg.allowDeath : kind === 'deathmatch';

  const units = {};
  const order = [];
  for (const raw of (Array.isArray(cfg.units) ? cfg.units : [])) {
    if (!raw || !raw.id) continue;
    const u = normalizeCombatant(raw, kind, allowDeath);
    units[u.id] = u;
    order.push(u.id);
  }
  if (!order.length) throw new Error('战斗没有任何参战单位');

  // 出生点：**一人一格，绝不允许叠在同格**。
  // spawnPositions 内部已经避开重复，这里是最后一道闸 —— 万一它没分出位置
  // （地图上可站人的格子比参战者还少），也绝不让两个人一起落在同一个 (0,0) 上。
  const left = order.filter(id => units[id].side === 'left');
  const right = order.filter(id => units[id].side !== 'left');
  const pos = spawnPositions(grid, left, right);
  const used = new Set();
  const cramped = [];
  for (const id of order) {
    let p = pos[id];
    if (p && (used.has(cellKey(p.x, p.y)) || !terrainOf(grid[p.y][p.x]).passable)) p = null;
    if (!p) {
      const free = firstFreeCell(grid, used);
      if (free) { p = { x: free.x, y: free.y }; if (free.cleared) cramped.push(units[id].name); }
    }
    if (!p) p = { x: 0, y: 0 };   // 理论上到不了：225 格全被占满（参战者比格子多）
    used.add(cellKey(p.x, p.y));
    units[id].x = p.x;
    units[id].y = p.y;
  }

  // 行动条初值：**先手由境界档位决定**——间隔短的人先到出手线，所以初值就取各自的间隔。
  // 同间隔时用下标做极小偏移，保证顺序可复现（不同 seed 也不会改变谁先手）。
  const clock = {};
  const start = (list, eps) => {
    list.forEach((id, i) => {
      const u = units[id];
      u.facing = u.side === 'left' ? { x: 1, y: 0 } : { x: -1, y: 0 }; // 面朝敌方半场
      clock[id] = u.interval + eps + i * 0.001;
    });
  };
  start(left, 0);
  start(right, 0);

  const state = {
    seed, rng, grid, size: MAP_SIZE, kind, allowDeath,
    units, order, clock,
    turnIndex: 0,
    round: 1,
    actorId: null,
    turn: null,
    log: [],
    finished: false,
    result: null,
    resultText: '',
    startedAt: Date.now(),
  };
  pushLog(state, { kind: 'system', text: `战斗开始（${kind === 'deathmatch' ? '死斗' : '寻常交手'}）：${order.map(id => units[id].name).join('、')}` });
  // 战场小到站不下所有人（极罕见，通常是 AI 把地图铺满石头）：如实记一笔，
  // 不要把「两人挤在同一格」这种画面问题藏起来。
  if (cramped.length) {
    pushLog(state, { kind: 'note', text: `战场几乎没有落脚处，为 ${cramped.join('、')} 就地清出了一块空地 —— 建议换个开阔些的场地。` });
  }
  // 开局气血已是 0 的人（极罕见，通常是带致命伤被强行拉入战）：点明一句并直接判其退出。
  const spent0 = order.map(id => units[id]).filter(u => u.hp <= 0);
  for (const u of spent0) {
    pushLog(state, { kind: 'note', text: `注意：${u.name} 开局气血已是 0（${u.hpMax} 上限），再无战力。` });
    markOut(state, u, '失去战力', '开局');
  }
  beginTurn(state);
  checkEnd(state);
  return state;
}

function normalizeCombatant(raw, kind, allowDeath) {
  const s = raw.stats || {};
  const pick = (k, d = 0) => {
    const v = s[k];
    if (v == null) return d;
    if (typeof v === 'object') return num(v.current ?? v.max, d);
    return num(v, d);
  };
  const hpMax = Math.round(num(raw.hpMax ?? pick('hp'), 100));
  const mpMax = Math.round(num(raw.mpMax ?? pick('mp'), 0));
  const hp = clamp(Math.round(num(raw.hp ?? hpMax, hpMax)), 0, hpMax);
  const mp = clamp(Math.round(num(raw.mp ?? mpMax, mpMax)), 0, mpMax);
  // 「保底血量」机制已于 2026-09-20 取消：不再有「打到某条血线就停手」，hp 一路可扣到 0。
  // 仍保留 floorHpPercent / floorHp 两个字段（恒为 0）以兼容旧存档与界面，但不再参与任何计算。
  const floorPct = 0;
  const floorHp = 0;

  // 行动条：出手间隔**按境界档位查表**得来（见 battleSpeed.js），由 battleTrigger 算好塞进 raw.interval。
  // 没有该字段时退回旧的脚力公式 —— 引擎可以脱离数值表单独跑（单测就直接构造单位）。
  const speed = num(raw.speed ?? pick('speed'), 20);
  const interval = Number.isFinite(Number(raw.interval)) && Number(raw.interval) > 0
    ? Number(raw.interval)
    : actionInterval(speed);

  return {
    id: String(raw.id),
    name: String(raw.name || raw.id),
    gender: String(raw.gender || ''),
    side: raw.side === 'right' ? 'right' : 'left',
    realm: String(raw.realm || ''),
    hp, hpMax, mp, mpMax,
    atk: { phys: num(raw.atk?.phys ?? pick('physAtk'), 10), mag: num(raw.atk?.mag ?? pick('magAtk'), 10) },
    def: { phys: num(raw.def?.phys ?? pick('physDef'), 10), mag: num(raw.def?.mag ?? pick('magDef'), 10) },
    pen: { phys: num(raw.pen?.phys ?? pick('physPen'), 0), mag: num(raw.pen?.mag ?? pick('magPen'), 0) },
    speed,
    interval,
    speedTier: Number.isFinite(Number(raw.speedTier)) ? Number(raw.speedTier) : null,
    spirit: num(raw.spirit ?? pick('spirit'), 10),
    luck: num(raw.luck ?? pick('luck'), 5),
    crit: num(raw.crit ?? pick('crit', TUNING.CRIT_DEFAULT), TUNING.CRIT_DEFAULT),   // 会心（百分点）
    skills: Array.isArray(raw.skills) ? raw.skills : [],
    items: Array.isArray(raw.items) ? raw.items : [],
    floorHpPercent: floorPct,
    floorHp,
    x: 0, y: 0,
    facing: { x: 1, y: 0 },
    stance: null,          // null | 'defend' | 'charge'
    damageDebuff: 0,       // 威吓：被压者下一击的威力折减（负数）
    out: false,
    outReason: '',
    dealt: 0, taken: 0,
    title: String(raw.title || ''),
  };
}

// ============================================================
// 2. 行动条
// ============================================================

/** 存活且未离场的单位 id。 */
export function activeIds(state) {
  return state.order.filter(id => !state.units[id].out);
}

/** 推进到下一个出手者（若上一个已结束则取 clock 最小者）。 */
export function beginTurn(state) {
  if (state.finished) return null;
  const ids = activeIds(state);
  if (!ids.length) { checkEnd(state); return null; }
  let next = ids[0];
  for (const id of ids) if (state.clock[id] < state.clock[next]) next = id;
  const u = state.units[next];
  // 上一轮摆的防御姿态只护住「别人行动的这一轮」，轮到自己就撤掉
  if (u.stance === 'defend') u.stance = null;
  // 威吓留下的折减不在这里清 —— 否则「被威吓 → 轮到自己 → 出手」这一串里，
  // 折减会在出手之前就被抹掉，威吓永远打不出效果。清零改在 endTurn（自己回合结束时）。
  state.actorId = next;
  // 一个回合的两笔额度，起手都是满的，而且**互不锁死**：
  //   · 走位额度 = budget / spent（花完就走不动了）
  //   · 出手额度 = acted（出手一次就用掉）
  // 出手之后走位额度照样能用，反之亦然 —— 这就是「走→打→走」。见 currentReach / moveTo。
  state.turn = {
    actorId: next,
    budget: moveBudget(u.speed),
    spent: 0,
    moved: 0,
    acted: false,
    reach: null,
    from: { x: u.x, y: u.y },
  };
  state.turn.reach = reachable(state.grid, u, state.turn.budget, occupiedCells(state, next));
  return next;
}

/**
 * 哪些格被「别人」占着（不可停留、不可穿越）。
 *
 * ⚠️ **倒地者照样算占格**。他退出的是出手序列，不是这个位置 —— 人还躺在那一格上
 * （见 BattleView 的倒地渲染），如果只把活人算进来，活人就能一步踩到他身上，
 * 两个小人当场重叠成一坨。既然他在场上，这一格就得挡住。
 * 代价是倒地者可能堵住一条窄路 —— 战斗到有人倒下时基本已近尾声，
 * 且远程功法不受阻，僵持还有 MAX_ROUNDS 兜底，这个取舍是划算的。
 */
export function occupiedCells(state, exceptId = null) {
  const out = [];
  for (const id of state.order) {
    if (id === exceptId) continue;
    const u = state.units[id];
    if (!u) continue;
    out.push(cellKey(u.x, u.y));
  }
  return out;
}

/**
 * 从某个坐标起找个落脚处：先找「没被占 + 能站人」的，实在找不到就把一格铲平。
 * 两趟扫描是为了「宁可不重叠，也不让人堆成一坨」—— 225 格的地图挤到连一块空地都没有，
 * 说明战场被铺成了死图（AI 有可能写出这种地图），就地开出一块平地比叠着强，
 * 这也守住了「开局永不卡死」那条不变量。
 * @returns {{x:number,y:number,cleared:boolean}|null}
 */
function firstFreeCell(grid, used) {
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        const k = cellKey(x, y);
        if (used.has(k)) continue;
        if (pass === 0 && !terrainOf(grid[y][x]).passable) continue;
        const cleared = pass === 1;
        if (cleared) grid[y][x] = DEFAULT_TERRAIN_ID;
        return { x, y, cleared };
      }
    }
  }
  return null;
}

/**
 * 交出回合、推进行动条 —— **整个回合里唯一会换手的地方**。
 *
 * 2026-09-19 起它不再由「出手」顺手触发（那版是「出手即交出回合」，已作废）：
 *   · 玩家侧：走完、打完之后自己点「结束回合」（BattleView 底部那个按钮）。
 *   · 敌方侧：battleAI.runEnemyTurn 在收尾时显式调用。
 * 地形回合结算（沼泽流失 / 灵脉回复）与威吓折减的清除都挂在这里，
 * 所以它必须恰好在这一回合真正结束的那一刻被调用**一次**；重复调用是安全的（下面第一行就返回）。
 */
export function endTurn(state) {
  if (!state.turn || !state.actorId) return;
  const u = state.units[state.actorId];
  if (!u) return;
  // 地形回合结算（沼泽流失 / 灵脉回复）
  applyTerrainTurn(state, u);
  u.damageDebuff = 0;                              // 威吓的折减只压住这一回合
  state.clock[u.id] += u.interval;
  state.turnIndex += 1;
  state.round = Math.floor(state.turnIndex / Math.max(1, activeIds(state).length)) + 1;
  state.actorId = null;
  state.turn = null;
  if (checkEnd(state)) return;
  if (state.round > TUNING.MAX_ROUNDS) {
    finish(state, 'draw', `僵持 ${TUNING.MAX_ROUNDS} 回合，双方各自退开`);
    return;
  }
  beginTurn(state);
}

function applyTerrainTurn(state, u) {
  const t = terrainOf(state.grid[u.y][u.x]);
  if (!t.turn) return;
  let healedHp = 0;
  let healedMp = 0;
  if (t.turn.hpPct) {
    const delta = Math.round(u.hpMax * t.turn.hpPct);
    if (delta < 0) {
      const dmg = Math.min(u.hp - 1 > 0 ? u.hp - 1 : 0, -delta);
      if (dmg > 0) applyHpLoss(state, u, dmg, `${t.id}侵蚀`);
    } else {
      healedHp = Math.min(u.hpMax - u.hp, delta);
      if (healedHp > 0) u.hp += healedHp;
    }
  }
  if (t.turn.mpPct && u.mpMax > 0) {
    const delta = Math.round(u.mpMax * t.turn.mpPct);
    if (delta > 0) {
      healedMp = Math.min(u.mpMax - u.mp, delta);
      if (healedMp > 0) u.mp += healedMp;
    }
  }
  // 气血与法力合并成一条战报，免得灵脉（两者都回）刷两行
  if (healedHp || healedMp) {
    const parts = [healedHp ? `${healedHp} 气血` : '', healedMp ? `${healedMp} 法力` : ''].filter(Boolean);
    pushLog(state, { kind: 'terrain', actorId: u.id, text: `${u.name} 立于${t.id}，回复 ${parts.join('与')}` });
  }
}

// ============================================================
// 3. 移动
// ============================================================

/**
 * 本回合当前可达格（每次移动后重算，代价累计）。
 *
 * ⚠️ 2026-09-19 起：**出过手也照样能走**。移动与出手是两笔独立的额度，
 * 互不锁死 —— 玩家可以「走两步 → 打一拳 → 再退开」，这正是他要的「移动、攻击、移动」。
 * 走位额度单看 moved/budget，不再看 acted。改成「出手后不许动」那版已经作废。
 */
export function currentReach(state) {
  const u = state.units[state.actorId];
  if (!u || !state.turn) return { dist: new Map(), prev: new Map(), cells: [] };
  return reachable(state.grid, u, state.turn.budget - state.turn.spent, occupiedCells(state, u.id));
}

/**
 * 移动（玩家点击可达格）。只走一段，**不结束回合** —— 走完还能出手、出手后还能再走。
 * 想收手得自己点「结束回合」（见 endTurn）。
 * @returns {{ok:boolean, reason?:string, path?:object[]}}
 */
export function moveTo(state, id, target) {
  if (state.finished) return { ok: false, reason: '战斗已结束' };
  const u = state.units[id];
  if (!u || state.actorId !== id) return { ok: false, reason: '现在不是该角色的回合' };
  const budgetLeft = state.turn.budget - state.turn.spent;
  const reach = reachable(state.grid, u, budgetLeft, occupiedCells(state, id));
  const tk = cellKey(target.x, target.y);
  // 双保险：可达表本来就排除了有人的格，再问一次是为了防「表是移动前算的」这类陈旧数据。
  // 「踩到别人（含倒地者）身上」必须在引擎层挡住，不能指望界面永远不去点那一格。
  if (occupiedCells(state, id).includes(tk)) return { ok: false, reason: '那一格上有人，走不进去' };
  if (!reach.dist.has(tk)) return { ok: false, reason: '该格本回合走不到' };
  const cost = reach.dist.get(tk);
  if (cost <= 0) return { ok: false, reason: '已经站在那里了' };
  const path = pathTo(reach, target) || [];
  const from = { x: u.x, y: u.y };
  u.x = target.x; u.y = target.y;
  const f = facingFromMove(from, target);
  if (f) u.facing = f;
  state.turn.spent += cost;
  state.turn.moved += cost;
  state.turn.reach = currentReach(state);
  pushLog(state, {
    kind: 'move', actorId: id, from, to: { x: u.x, y: u.y }, cost,
    text: `${u.name} 移动 ${cost} 格至 (${u.x},${u.y})${terrainOf(state.grid[u.y][u.x]).id !== '平地' ? `·${terrainOf(state.grid[u.y][u.x]).id}` : ''}［剩余 ${state.turn.budget - state.turn.spent} 格］`,
  });
  checkEnd(state);
  return { ok: true, path, cost };
}

// ============================================================
// 4. 动作清单（玩家界面与敌方 AI 共用同一份判定）
// ============================================================

/**
 * 列出当前出手者可用的动作。
 * 移动是独立一步（见 moveTo），这里返回的是「出手」项。
 * @returns {object[]} 每项 { kind, label, enabled, reason, mpCost, skill?, item?, range? }
 */
export function legalActions(state, id) {
  const u = state.units[id];
  if (!u || state.actorId !== id || state.turn?.acted) return [];
  const foes = activeIds(state).filter(x => state.units[x].side !== u.side);
  const nearest = nearestDistance(state, u, foes);
  const out = [];

  // 普通攻击：距离 1
  out.push({
    kind: 'attack', label: '普通攻击', range: 1, mpCost: 0,
    enabled: nearest <= 1, reason: nearest <= 1 ? '' : '近身 1 格内才有目标',
  });

  // 功法（技能）
  for (const sk of u.skills) {
    const range = clamp(Math.round(num(sk.range, 1)), 1, 8);
    const cost = Math.max(0, Math.round(num(sk.mpCost, 0)));
    const enough = u.mp >= cost;
    const inRange = foes.some(fid => {
      const f = state.units[fid];
      return distance(u, f) <= range && (distance(u, f) < TUNING.RANGED_AT || hasLineOfSight(state.grid, u, f));
    });
    out.push({
      kind: 'skill', skill: sk, label: sk.name, range, mpCost: cost,
      enabled: enough && (inRange || sk.type === '恢复' || sk.type === '特攻'),
      reason: !enough ? `法力不足（需 ${cost}，现有 ${u.mp}）` : (inRange ? '' : `${range} 格内没有目标`),
    });
  }

  // 器物（消耗品）：只列出「真能在战斗中生效」的（有回血/回蓝数值、且身上还有货）
  for (const it of u.items) {
    if (!it) continue;
    const qty = num(it.quantity, 0);
    const healable = healsSomething(u, it);
    const hasEffect = num(it.heal?.hp, 0) > 0 || num(it.heal?.mp, 0) > 0;
    if (!hasEffect) continue;
    out.push({
      kind: 'item', item: it, label: `用 ${it.name}`, mpCost: 0, range: 0,
      enabled: qty > 0 && healable,
      reason: qty <= 0 ? '已用尽' : (healable ? '' : '气血与法力都已满'),
    });
  }

  // 通用动作
  out.push({ kind: 'defend', label: '防御', mpCost: 0, range: 0, enabled: true, reason: '' });
  out.push({ kind: 'charge', label: '蓄力', mpCost: 0, range: 0, enabled: true, reason: '' });
  out.push({
    kind: 'intimidate', label: '威吓', mpCost: 0, range: 3,
    enabled: nearest <= 3, reason: nearest <= 3 ? '' : '3 格内没有目标',
  });
  // 逃遁只给玩家一方（见 canFlee）；敌方候选里干脆不列出这一项，AI 也就无从选中它。
  if (canFlee(state, u)) {
    out.push({
      kind: 'flee', label: '逃遁', mpCost: 0, range: 0,
      enabled: true, reason: '',
      hint: `成功率约 ${Math.round(fleeChance(state, u) * 100)}%`,
    });
  }
  out.push({ kind: 'surrender', label: '投降', mpCost: 0, range: 0, enabled: true, reason: '' });
  return out;
}

/**
 * 谁能在战场上脱身：**只有玩家所在的一方（side === 'left'）**。
 *
 * 2026-09-18 玩家定案：**敌方一律禁止逃跑**。原因是实测数据 —— 敌方 AI 对「逃遁」的估值里
 * 有一项「保命价值」，而它对低血量之外的场合权重给得过高，导致敌人在**满血开局的第 1~2 回合**
 * 就把「逃」评为最高分：三组对阵各 20 局，以逃跑收场的分别占 13 / 17 / 15 局，
 * 逃跑时血量全是 100%，玩家的感受是「好没意思」。
 * 与其调权重（那只是让它「稍微晚一点跑」，且以后改平衡又会复发），不如直接取消这项能力：
 * 敌人只会打到分出结果（被打退出场 / 投降）。
 *
 * 玩家自己的逃遁按钮**保留原样**，且逃遁失败不加任何额外惩罚（玩家定的）。
 * 这里是唯一的判据出口，动作清单与结算各读它一次，两处不会漂。
 */
export function canFlee(state, u) {
  return !!u && u.side === 'left';
}

function healsSomething(u, item) {
  const h = item?.heal || {};
  const hp = num(h.hp, 0);
  const mp = num(h.mp, 0);
  return (hp > 0 && u.hp < u.hpMax) || (mp > 0 && u.mp < u.mpMax);
}

function nearestDistance(state, u, foes) {
  let best = Infinity;
  for (const fid of foes) {
    const f = state.units[fid];
    best = Math.min(best, distance(u, f));
  }
  return best;
}

/**
 * 某个动作的合法目标（界面点选与 AI 估值共用同一套距离/视线判定，避免两处口径漂移）。
 * @returns {object[]} 目标单位数组（特攻类返回空数组）
 */
export function validTargets(state, id, act) {
  const u = state.units[id];
  if (!u || !act) return [];
  const foes = activeIds(state).filter(x => state.units[x].side !== u.side).map(x => state.units[x]);
  if (act.kind === 'attack') return foes.filter(f => distance(u, f) <= 1);
  if (act.kind === 'intimidate') return foes.filter(f => distance(u, f) <= 3);
  if (act.kind === 'skill') {
    if (act.skill?.type === '恢复') return [u];
    if (act.skill?.type !== '伤害') return [];
    const range = clamp(Math.round(num(act.range, 1)), 1, 8);
    return foes.filter(f => {
      const d = distance(u, f);
      if (d > range) return false;
      if (d >= TUNING.RANGED_AT && !hasLineOfSight(state.grid, u, f)) return false;
      return true;
    });
  }
  return [];
}

/** 逃遁成功率：脚力^0.5 / (自身^0.5 + 对手最高^0.5)。 */
export function fleeChance(state, u) {
  const foes = activeIds(state).filter(x => state.units[x].side !== u.side).map(x => state.units[x]);
  if (!foes.length) return 1;
  const fastest = Math.max(...foes.map(f => Math.sqrt(Math.max(0, f.speed))));
  const mine = Math.sqrt(Math.max(0, u.speed));
  if (mine + fastest <= 0) return 0.5;
  return mine / (mine + fastest);
}

// ============================================================
// 5. 伤害管线（玩家与敌方共用的唯一结算入口）
// ============================================================

/**
 * 把「选中的动作 + 选中的目标」拼成一次攻击的解析参数。
 *
 * 这是**唯一出口**：界面上的伤害预估、敌方 AI 的估值、以及真正结算时喂给 resolveAttack 的那一份，
 * 全都从这里取。三处读同一份，就不会出现「界面上写预计 120、真打出来 80」这种对不上账的事。
 * @returns {{ kind, dice?, mult?, fixedMult?, distance, range }}
 */
export function attackSpec(actor, target, act) {
  const d = distance(actor, target);
  if (!act || act.kind === 'attack') return { kind: 'phys', fixedMult: 1, distance: d, range: 1 };
  const sk = act.skill || {};
  return {
    kind: sk.dmgKind === '法' ? 'mag' : 'phys',
    dice: sk.dice,
    mult: sk.mult,          // 威力（品阶定死）；骰子的运气平均为 1，不抬高期望
    distance: d,
    range: act.range || 1,
  };
}

/**
 * 解析期望（不掷骰、不改状态）—— 敌方 AI 估值就用它。
 * 技能：期望倍率就是该功法的「威力」（品阶定死），骰子的运气平均为 1.00，不抬高期望。
 * 无闪避：命中率恒为 1，估值只看威力、暴击与各乘区。
 * @param {object} spec { kind, dice, mult, fixedMult, distance }  dice + mult = 功法；fixedMult = 普攻
 * @returns {{ hitChance, expDamage, critChance, minDamage, maxDamage }}
 */
export function previewAttack(state, actor, target, spec = {}) {
  const kind = spec.kind === 'mag' ? 'mag' : 'phys';
  const multExp = spec.dice ? num(spec.mult, 1) : num(spec.fixedMult, 1);
  const atk = actor.atk[kind];
  const def = Math.max(0, target.def[kind] - actor.pen[kind]);
  const base = Math.max(atk * multExp - def, atk * multExp * TUNING.DMG_FLOOR_RATIO);
  const cp = critProfile(state, actor, target);
  const mul = takenMultipliers(state, actor, target, kind, spec.distance).mul;
  const stance = target.stance === 'defend' ? TUNING.DEFEND_TAKEN_MUL : 1;
  const charge = actor.stance === 'charge' ? TUNING.CHARGE_DEALT_MUL : 1;
  const debuff = damageDebuffOf(actor);
  const expDamage = base * (1 + cp.chance * (cp.mul - 1)) * mul * stance * charge * debuff;
  return {
    hitChance: 1,                                     // 取消闪避：必定命中
    expDamage: Math.max(0, expDamage),
    critChance: cp.chance,
    critMul: cp.mul,                                  // 会心溢出后暴击伤害会高于 CRIT_MUL
    minDamage: Math.max(1, base * charge * 0.5 * debuff),
    maxDamage: base * cp.mul * charge * debuff,
  };
}

/** 威吓造成的威力折减系数（1 = 未受影响，0.85 = 这一击打八五折）。 */
function damageDebuffOf(u) {
  return 1 + num(u.damageDebuff, 0);
}

/**
 * 威吓压给对方的威力折减（负数）：神识差越大压得越狠，最多 −15%（TUNING.INTIMIDATE_DMG）。
 * 结算与敌方 AI 估值共用这一处，避免两边口径漂移
 * （此前 AI 侧引用了早已改名的 INTIMIDATE_AIM，估值恒为 NaN）。
 */
export function intimidateDebuff(actorSpirit, targetSpirit) {
  const a = num(actorSpirit, 0);
  const t = num(targetSpirit, 0);
  const factor = clamp((a - t) / Math.max(1, a + t), 0, 0.3);
  return TUNING.INTIMIDATE_DMG * (0.4 + factor * 2);
}

/**
 * 这一击的暴击档案：暴击率 + 暴击伤害。
 * 三路来源：会心（角色自身的暴击底子，装备与特质都能加）+ 气运 + 走位（侧击/背击）。
 * **会心无上限** —— 三路相加超过 100% 的部分不浪费，按 CRIT_OVERFLOW_TO_MUL 折算成暴击伤害加成，
 * 所以会心堆过头只会让暴击更狠，不会变成死数值。
 * 气运先按 CRIT_LUCK_MAX_LUCK 钳住（属性值本身也由 attrClamp 钳），满值 100 正好贡献 40%。
 * @returns {{ chance:number, mul:number, overflow:number, angle:string }}
 */
export function critProfile(state, actor, target) {
  const luck = clamp(num(actor.luck, 0), 0, TUNING.CRIT_LUCK_MAX_LUCK);
  const critBase = Math.max(0, num(actor.crit, TUNING.CRIT_DEFAULT)) / 100;   // 会心按百分点存，这里换算成概率
  const luckPart = TUNING.CRIT_LUCK_COEF * (luck / TUNING.CRIT_LUCK_MAX_LUCK);
  const angle = hitAngle(actor, target, target.facing);
  const anglePart = angle === 'side' ? TUNING.CRIT_SIDE : angle === 'back' ? TUNING.CRIT_BACK : 0;
  const raw = critBase + luckPart + anglePart;
  const chance = clamp(raw, 0, TUNING.CRIT_MAX);
  const overflow = Math.max(0, raw - TUNING.CRIT_MAX);
  return {
    chance,
    mul: TUNING.CRIT_MUL + overflow * TUNING.CRIT_OVERFLOW_TO_MUL,
    overflow,
    angle,
  };
}

/** 暴击率（0~1）。critProfile 的薄封装，供只关心概率的调用方使用。 */
export function critRate(state, actor, target) {
  return critProfile(state, actor, target).chance;
}

/**
 * 地形造成的伤害倍率（不含姿态）。
 * 守方脚下地形决定「挨打」，攻方脚下地形决定「打人」，两段再叠乘：
 *   守方 takenMul（通用）× rangedTakenMul（距离 ≥ 4 才算）× magTakenMul（法术才算）
 *   攻方 dealtMul（通用）× magicDealtMul（法术才算）
 * 每种地形的字段都由 battleTerrain 预置、AI 只能选不能造，故这里只做乘算。
 * @returns {{ mul:number, parts:string[] }} parts 是「谁在起作用」的人话清单（战报明细用）
 */
function takenMultipliers(state, actor, target, kind, dist) {
  let mul = 1;
  const parts = [];
  const push = (v, why) => {
    const n = num(v, 1);
    if (n === 1) return;
    mul *= n;
    parts.push(`${why} ×${r3(n)}`);
  };
  const td = terrainOf(state.grid[target.y][target.x]);
  push(td.takenMul, `${target.name}立在${td.id}`);
  if (dist >= TUNING.RANGED_AT) push(td.rangedTakenMul, `${td.id}遮远程`);
  if (kind === 'mag') push(td.magTakenMul, `${td.id}湿身受法`);
  const ta = terrainOf(state.grid[actor.y][actor.x]);
  push(ta.dealtMul, `${actor.name}借${ta.id}之势`);
  if (kind === 'mag') push(ta.magicDealtMul, `${ta.id}增幅法术`);
  return { mul, parts };
}

/**
 * 真正打一下。
 * @param {object} spec { label, kind:'phys'|'mag', dice, mult, fixedMult, distance, mpCost, skillName, dryRun }
 *   dice + mult —— 功法：mult 是品阶定死的威力，dice 掷出的运气平均为 1.00，只左右浮动
 *   fixedMult    —— 普攻等固定倍率（不走骰子）
 * @returns {object} 结算明细（含 dmg/hit/crit/rolled/luck/mult/angle），dryRun 时不改状态
 */
export function resolveAttack(state, actor, target, spec = {}) {
  const kind = spec.kind === 'mag' ? 'mag' : 'phys';
  const dist = Number.isFinite(spec.distance) ? spec.distance : distance(actor, target);
  // 蓄力时耗蓝减半 —— 取整一次，别把 42.5 这种「半点法力」写进角色卡（显示与落档都会难堪）
  const rawMpCost = Math.max(0, num(spec.mpCost, 0));
  const mpCost = rawMpCost <= 0 ? 0
    : Math.max(1, Math.round(rawMpCost * (actor.stance === 'charge' ? TUNING.CHARGE_COST_MUL : 1)));
  if (state.finished || actor.out || target.out) return { hit: false, dmg: 0, reason: '战斗已结束' };

  // 这一击的威力 = 功法威力（品阶定死）× 运气（骰子只在这里起作用）
  let rolled = null;
  let luck = 1;
  let mult;
  if (spec.dice) {
    const r = rollLuck(spec.dice, state.rng);
    rolled = r.rolled;
    luck = r.luck;
    mult = num(spec.mult, 1) * luck;
  } else {
    mult = num(spec.fixedMult, 1);
  }

  // 取消闪避：不掷命中判定，出手必然命中。角度仍然要算 —— 侧击/背击会加成暴击。
  const angle = hitAngle(actor, target, target.facing);

  // 蓄力：攒下的势，在这一记兑现（×1.6），兑现完就清掉。
  // 2026-09-18 修：这个乘区此前**只在 AI 估值（previewAttack）里算过，真结算时漏了** ——
  // 玩家点「蓄力」白白让出一次出手机会，下一击却一点没变强，
  // 界面和战报还都写着「下一击 ×1.6」。先取出来乘进去，再清姿态。
  const chargeMul = actor.stance === 'charge' ? TUNING.CHARGE_DEALT_MUL : 1;
  if (actor.stance === 'charge') actor.stance = null;

  if (mpCost) actor.mp = Math.max(0, actor.mp - mpCost);

  const atk = actor.atk[kind];
  const rawDef = target.def[kind];
  const pen = actor.pen[kind];
  const defv = Math.max(0, rawDef - pen);
  const rawBase = atk * mult - defv;
  let dmg = Math.max(rawBase, atk * mult * TUNING.DMG_FLOOR_RATIO);

  const tm = takenMultipliers(state, actor, target, kind, dist);
  dmg *= tm.mul;
  const defendMul = target.stance === 'defend' ? TUNING.DEFEND_TAKEN_MUL : 1;
  dmg *= defendMul;
  const debuffMul = damageDebuffOf(actor);             // 被威吓：这一击威力打折
  dmg *= debuffMul;
  dmg *= chargeMul;

  const cp = critProfile(state, actor, target);
  const crit = state.rng() < cp.chance;
  if (crit) dmg *= cp.mul;
  dmg = Math.max(1, Math.round(dmg));

  const loss = applyHpLoss(state, target, dmg, spec.label, actor);
  const applied = loss.applied;
  actor.dealt += applied;
  // 来势超过对方剩余气血（溢出来势）时，写清是这一击把剩余气血彻底打空，
  // 而不是让玩家误以为对手只吃了「伤害 X」这点力道。
  const rawDmg = Math.round(dmg);
  const truncated = rawDmg > applied;

  // 这一击画面上算什么动作（近身一拳 / 抬手放出）：**界面不许自己猜**，由结算这一处定死，
  // 免得「界面按功法名猜成远程、结算其实贴身打」两套说法（见 battleBeats 的节拍翻译）。
  // 规矩：贴身 1 格且不是法术 → 近战；其余（法术、2 格开外的物攻）→ 远程。
  const style = spec.style === 'melee' || spec.style === 'ranged'
    ? spec.style
    : (dist <= 1 && kind !== 'mag' ? 'melee' : 'ranged');
  pushLog(state, {
    kind: 'hit', actorId: actor.id, targetId: target.id, skill: spec.label, style,
    dmg: applied, crit, truncated, angle, rolled, luck, mult: r3(mult),
    // 算式明细：**只给玩家看**，不进 AI 提示词（AI 一个数字都不算，见设计稿的「三权分立」）。
    audit: attackAudit({
      actor, target, kind, spec, atk, rawDef, pen, defv, mult, rolled, luck,
      tm, defendMul, debuffMul, chargeMul, crit, critMul: cp.mul,
      mpCost, mpMax: actor.mpMax, rawDmg, applied,
    }),
    text: `${actor.name} 施展「${spec.label}」→ 命中 ${target.name}，伤害 ${applied}`
      + (truncated ? `（这一击来势 ${rawDmg}，一击将其剩余气血彻底打空）` : '')
      + `${crit ? '，暴击' : ''}${angle === 'back' ? '，背击' : angle === 'side' ? '，侧击' : ''}`
      + `［${target.name} 气血 ${target.hp}/${target.hpMax}］`,
  });
  // 打完这一击才轮到"退出战斗"那行（顺序反了会让战报读起来倒因为果）
  if (loss.out) markOut(state, target, loss.outReason, spec.label, actor);
  checkEnd(state);
  return { hit: true, dmg: applied, crit, angle, rolled, luck, mult, mpCost };
}

/**
 * 战报的「算式明细」—— 一行一个动作，玩家能自己验算。
 * 起因（玩家原话）：「伤害 240（威力 1.73 × 运气 0.55（骰 1d10=3）→ 倍率 0.94，背击，耗蓝 85）这个是啥，
 * 你觉得别人看得懂吗」。病根不在数字错，在于**那行字里既没有攻击力、也没有对方防御**，
 * 却直接从「倍率」跳到几千的「来势」—— 中间还悄悄连乘了暴击/蓄力/地形/姿态。缺项太多，当然读不懂。
 * 所以这里把每一步写全：攻击力 × 倍率 → 减防御 → 逐项乘加成 → 来势 → 落到血条上多少。
 * 只给玩家看（不进 AI 提示词）：AI 只该照抄事实，不该学会算账。
 */
function attackAudit(o) {
  const {
    target, kind, spec, atk, rawDef, pen, defv, mult, rolled, luck,
    tm, defendMul, debuffMul, chargeMul, crit, critMul, mpCost, mpMax, rawDmg, applied,
  } = o;
  const atkWord = kind === 'mag' ? '法攻' : '物攻';
  const defWord = kind === 'mag' ? '法防' : '物防';
  const lines = [];

  // ① 攻击力 × 倍率
  lines.push(`出力：${atkWord} ${r3(atk)} × 这一击倍率 ${r3(mult)} = ${r3(atk * mult)}`);
  // ② 减防御
  const defPart = pen > 0
    ? (defv <= 0
      ? `${target.name}的${defWord} ${r3(rawDef)}（已被我方穿透 ${r3(pen)} 抵光，有效防御 0）`
      : `${target.name}的${defWord} ${r3(rawDef)} − 我方穿透 ${r3(pen)} = 有效防御 ${r3(defv)}`)
    : `${target.name}的${defWord} ${r3(defv)}`;
  lines.push(`破防：${r3(atk * mult)} − ${defPart} = ${r3(atk * mult - defv)}`
    + (Math.round(atk * mult - defv) < Math.round(atk * mult * TUNING.DMG_FLOOR_RATIO)
      ? `，比「出力 × ${Math.round(TUNING.DMG_FLOOR_RATIO * 100)}%」的保底还低，按保底 ${Math.round(atk * mult * TUNING.DMG_FLOOR_RATIO)} 算`
      : ''));
  // ③ 倍率从哪来
  if (spec.dice) {
    lines.push(`倍率 ${r3(mult)} 怎么来：功法威力 ${r3(num(spec.mult, 1))} × 骰运 ${r3(luck)}`
      + `（${diceText(spec.dice)} 掷出 ${rolled}，这类骰平均掷 ${diceExpected(spec.dice)}）`);
  } else {
    lines.push(`倍率 ${r3(mult)}：普通攻击是固定倍率，不掷骰`);
  }
  // ④ 后置加成逐项列出 —— 这一步是「倍率 0.94 却打出几千来势」的全部原因
  const extras = [];
  if (chargeMul !== 1) extras.push(`蓄力 ×${r3(chargeMul)}`);
  if (crit) extras.push(`暴击 ×${r3(critMul)}`);
  for (const p of tm.parts) extras.push(p);
  if (defendMul !== 1) extras.push(`${target.name}防御姿态 ×${r3(defendMul)}`);
  if (debuffMul !== 1) extras.push(`被威吓 ×${r3(debuffMul)}`);
  lines.push((extras.length ? `再乘：${extras.join(' ｜ ')} → ` : '没有额外加成 → ')
    + `来势 ${rawDmg}`);
  // ⑤ 耗蓝
  if (mpCost) {
    lines.push(`耗蓝 ${mpCost}（＝自己法力上限 ${r3(mpMax)} 的 ${r3(mpCost / Math.max(1, mpMax) * 100)}%）`);
  }
  // ⑥ 气血打空（来势溢出）
  if (rawDmg > applied) {
    lines.push(`气血打空：来势 ${rawDmg}，其中 ${applied} 已将其剩余气血全部清空，多出的 ${rawDmg - applied} 为溢出来势`);
  }
  return lines;
}

/** 扣血（hp 可一路扣到 0；归零即退出战斗）。返回是否有伤害、以及是否因此退出（退出由调用方在写完战报后再标记）。 */
function applyHpLoss(state, target, dmg, source = '', attacker = null) {
  // 不再有保底血线：气血 = max(0, 当前 − 来势)，扣到 0 为止，绝不抬血。
  const hurt = Math.max(0, Math.round(dmg));
  const next = Math.max(0, target.hp - hurt);
  const applied = target.hp - next;
  target.hp = next;
  target.taken += applied;
  // hp 归零即退出战斗。
  if (target.hp <= 0) {
    // 先不就地标记，只把结论带回去 —— 否则「退出战斗」那行会排在「命中」那行之前，
    // 战报读起来就成了「他倒下了，然后他被打了一掌」。
    // 死斗由程序直接写「死亡」；寻常交手只写「失去战力」，是死是伤交给战后 AI 叙事描写。
    const outReason = state.allowDeath ? '死亡' : '失去战力';
    return { applied, out: true, outReason };
  }
  return { applied, out: false, outReason: null };
}

function markOut(state, u, reason, source = '', attacker = null) {
  if (u.out) return;
  u.out = true;
  u.outReason = reason;
  pushLog(state, {
    kind: 'out', actorId: u.id, reason,
    text: `${u.name} ${reason}${source ? `（${source}）` : ''}，退出战斗`,
  });
}

/** 恢复类技能 / 丹药。 */
export function resolveHeal(state, actor, target, spec = {}) {
  const hp = Math.max(0, Math.round(num(spec.hp, 0)));
  const mp = Math.max(0, Math.round(num(spec.mp, 0)));
  const cost = Math.max(0, Math.round(num(spec.mpCost, 0)));
  if (cost) actor.mp = Math.max(0, actor.mp - cost);
  const hpGain = Math.min(hp, Math.max(0, target.hpMax - target.hp));
  const mpGain = Math.min(mp, Math.max(0, target.mpMax - target.mp));
  target.hp += hpGain;
  target.mp += mpGain;
  if (hpGain || mpGain) {
    pushLog(state, {
      kind: 'heal', actorId: actor.id, targetId: target.id, skill: spec.label,
      text: `${actor.name} 施展「${spec.label}」→ ${target.name} 回复 ${hpGain} 气血、${mpGain} 法力`
        + `${cost ? `（耗蓝 ${cost}）` : ''}［${target.hp}/${target.hpMax}］`,
    });
  } else {
    pushLog(state, { kind: 'heal', actorId: actor.id, skill: spec.label, text: `${actor.name} 施展「${spec.label}」，气血法力均已满，无效果` });
  }
  return { hpGain, mpGain, mpCost: cost };
}

// ============================================================
// 6. 执行一个动作（玩家与敌方共用）
// ============================================================

/**
 * 执行一次出手（普攻 / 功法 / 器物 / 防御 / 蓄力 / 威吓 / 逃遁 / 投降）。
 *
 * ⚠️ 2026-09-19 起**出手不再自动结束回合**：一个回合的额度分成两笔 ——
 * 走位额度（budget/spent）与出手额度（acted），两笔各自独立、互不锁死。
 * 所以玩家可以「走 → 打 → 再走」，打完还留着自己的回合；真正交出回合只有一条路：
 * 玩家点「结束回合」（见 endTurn），敌方的收尾由 battleAI.runEnemyTurn 显式调用。
 * @param {object} action { kind, targetId?, skill?, item? }
 * @returns {{ok:boolean, reason?:string, events?:object[]}}
 */
export function doAction(state, id, action) {
  if (state.finished) return { ok: false, reason: '战斗已结束' };
  const u = state.units[id];
  if (!u || state.actorId !== id) return { ok: false, reason: '现在不是该角色的回合' };
  if (state.turn.acted) return { ok: false, reason: '本回合已经出过手了' };
  const foes = activeIds(state).filter(x => state.units[x].side !== u.side);
  const kind = action?.kind;

  if (kind === 'attack') {
    const t = state.units[action.targetId] || nearestFoe(state, u, foes);
    if (!t) return { ok: false, reason: '没有可攻击的目标' };
    if (distance(u, t) > 1) return { ok: false, reason: '普通攻击只能打相邻 1 格' };
    resolveAttack(state, u, t, { label: '普通攻击', kind: 'phys', fixedMult: 1, distance: distance(u, t) });
  } else if (kind === 'skill') {
    const sk = action.skill || u.skills.find(s => s.name === action.skillName);
    if (!sk) return { ok: false, reason: '该功法不存在' };
    const cost = Math.round(num(sk.mpCost, 0));
    if (u.mp < cost) return { ok: false, reason: `法力不足（需 ${cost}）` };
    if (sk.type === '恢复') {
      const target = state.units[action.targetId] || u;
      resolveHeal(state, u, target, { label: sk.name, hp: sk.hpRecover, mp: sk.mpRecover, mpCost: cost });
    } else if (sk.type === '伤害') {
      const t = state.units[action.targetId] || nearestFoe(state, u, foes);
      if (!t) return { ok: false, reason: '没有可攻击的目标' };
      const d = distance(u, t);
      const range = clamp(Math.round(num(sk.range, 1)), 1, 8);
      if (d > range) return { ok: false, reason: `超出 ${range} 格攻击距离` };
      if (d >= TUNING.RANGED_AT && !hasLineOfSight(state.grid, u, t)) return { ok: false, reason: '视线被阻，打不到' };
      resolveAttack(state, u, t, {
        label: sk.name, kind: sk.dmgKind === '法' ? 'mag' : 'phys',
        dice: sk.dice, mult: sk.mult, distance: d, mpCost: cost,
      });
    } else {
      // 特攻：本版只结算「自带增益/减益」的效果字段，未实现的按无效处理并如实记账
      if (cost) u.mp = Math.max(0, u.mp - cost);
      pushLog(state, { kind: 'special', actorId: u.id, skill: sk.name, text: `${u.name} 施展「${sk.name}」（${sk.effect || '特攻类'}）· 耗蓝 ${cost}` });
    }
  } else if (kind === 'item') {
    const it = action.item || u.items.find(x => x.name === action.itemName);
    if (!it || num(it.quantity, 0) <= 0) return { ok: false, reason: '该物品已用尽' };
    it.quantity = num(it.quantity, 0) - 1;
    resolveHeal(state, u, u, { label: `服用 ${it.name}`, hp: it.heal?.hp, mp: it.heal?.mp });
  } else if (kind === 'defend') {
    u.stance = 'defend';
    // pose：画面上摆哪个姿势（防御与威吓都摆护架）。不写 pose 的动作（蓄力等）一律不做动作。
    pushLog(state, { kind: 'action', actorId: u.id, pose: 'block', text: `${u.name} 凝神防御（受到的伤害 ×${TUNING.DEFEND_TAKEN_MUL}）` });
  } else if (kind === 'charge') {
    u.stance = 'charge';
    pushLog(state, { kind: 'action', actorId: u.id, text: `${u.name} 蓄势待发（下一击 ×${TUNING.CHARGE_DEALT_MUL}，耗蓝减半）` });
  } else if (kind === 'intimidate') {
    const t = state.units[action.targetId] || nearestFoe(state, u, foes);
    if (!t) return { ok: false, reason: '没有可威吓的目标' };
    const gap = u.spirit - t.spirit;
    t.damageDebuff = intimidateDebuff(u.spirit, t.spirit);
    pushLog(state, { kind: 'action', actorId: u.id, targetId: t.id, pose: 'block', text: `${u.name} 以神识威压 ${t.name}（神识差 ${Math.round(gap)}），对方下一击威力 ×${Math.round((1 + t.damageDebuff) * 100) / 100}` });
  } else if (kind === 'flee') {
    // 结算层再拦一道：敌方不得脱身（候选清单已经不列出，这里是防止别的路径绕过）
    if (!canFlee(state, u)) return { ok: false, reason: '此战不许脱身' };
    const p = fleeChance(state, u);
    if (state.rng() < p) {
      u.out = true; u.outReason = '逃遁';
      // out:true = 「这条战报代表他离开了战斗」。演出层只看这一个记号决定"该不该演倒下"
      //（失败的那次逃遁不带它，所以不会凭空躺下）。投降那条同理带 out:true。
      pushLog(state, { kind: 'flee', actorId: u.id, out: true, text: `${u.name} 遁光一闪，脱离战圈（成功率 ${Math.round(p * 100)}%）` });
      const mine = u.side;
      finish(state, mine === 'left' ? '逃' : '逃', `${u.name} 逃遁成功，战斗结束`);
      return { ok: true };
    }
    pushLog(state, { kind: 'flee', actorId: u.id, text: `${u.name} 欲遁走，却被拦住（成功率 ${Math.round(p * 100)}%，掷点未过）` });
  } else if (kind === 'surrender') {
    u.out = true; u.outReason = '投降';
    pushLog(state, { kind: 'surrender', actorId: u.id, out: true, text: `${u.name} 收手认输` });
    finish(state, u.side === 'left' ? '降' : '胜', `${u.name} 投降，战斗结束`);
    return { ok: true };
  } else {
    return { ok: false, reason: '未知动作' };
  }

  // 这一手结算的过程中可能已经把战斗打完了（resolveAttack → checkEnd → finish 会清空 state.turn），
  // 所以必须先确认战斗还在进行，再去碰 state.turn。
  if (state.finished || !state.turn) return { ok: true };
  // 2026-09-19：出手**不再自动交出回合**。只记上「本回合已出过手」，回合仍留在他手里 ——
  // 他还能拿剩下的走位额度继续挪。所以这里不推进行动条、也不做地形回合结算，
  // 那些统统归 endTurn（玩家点「结束回合」时才发生）。
  state.turn.acted = true;
  state.turn.reach = currentReach(state);   // 顺手刷新可达格，状态永远与此刻的预算一致
  return { ok: true, events: state.log.slice(-4) };
}

function nearestFoe(state, u, foes) {
  let best = null;
  for (const fid of foes) {
    const f = state.units[fid];
    if (!best || distance(u, f) < distance(u, best)) best = f;
  }
  return best;
}

// ============================================================
// 7. 结束裁定
// ============================================================

export function checkEnd(state) {
  if (state.finished) return true;
  const left = activeIds(state).filter(id => state.units[id].side === 'left');
  const right = activeIds(state).filter(id => state.units[id].side !== 'left');
  if (!left.length && !right.length) { finish(state, 'draw', '双方俱已退出战斗'); return true; }
  if (!right.length) { finish(state, '胜', '对方全员失去战力'); return true; }
  if (!left.length) { finish(state, '败', '我方全员失去战力'); return true; }
  return false;
}

function finish(state, result, text) {
  state.finished = true;
  state.result = result;
  state.resultText = text;
  state.actorId = null;
  state.turn = null;
  pushLog(state, { kind: 'end', text: `战斗结束：${text}` });
}

function pushLog(state, entry) {
  state.log.push({ round: state.round, ...entry });
  if (state.log.length > 800) state.log.splice(0, 200);
}

// ============================================================
// 8. 日志（交给 AI 写正文的那份）
// ============================================================

/**
 * 把一局战斗整理成给 AI 的日志文本。
 * 规则：数字全部由程序给出，AI 只能照抄，不得自行换算。
 *
 * ⚠️ 这里**只放事实**（结果 / 参战双方 / 逐回合过程），不放任何「怎么给 AI 下指令」的话。
 * 两个原因（2026-09-19 修）：
 *   ① 这份文本同时会原样贴在玩家屏幕上的战报卡里（GameDashboard 的 <pre>），
 *      夹带提示词内务等于把「写正文的要求」给玩家看；
 *   ② 它以前自带三条「写正文的要求」，其中第 1 条写着「正文里出现的伤害、剩余气血、耗蓝
 *      必须与战报一致」—— 与战后协议里的「不要罗列数据」直接打架，AI 听了硬的那条，
 *      于是把战报里的「气血 600/3000」抄成「气血两千九百九十八点」写进散文。
 * 现在「写正文的要求」只有一处：协议里的【Mortal 战后叙事协议】（设置页可改）。
 */
export function battleLogText(state, opts = {}) {
  const maxLines = opts.maxLines || 120;
  const lines = [];
  const u = Object.values(state.units);
  lines.push(`【战斗结果】${state.resultText || '未分胜负'}｜判定：${state.result || '未结束'}｜共 ${state.round} 回合`);
  lines.push('【参战双方】');
  for (const x of u) {
    lines.push(`- ${x.name}（${x.realm || '—'}，${x.side === 'left' ? '我方' : '敌方'}）：`
      + `气血 ${x.hp}/${x.hpMax}｜法力 ${x.mp}/${x.mpMax}｜物攻 ${x.atk.phys} 物防 ${x.def.phys}｜法攻 ${x.atk.mag} 法防 ${x.def.mag}｜穿透 ${x.pen.phys}/${x.pen.mag}｜脚力 ${x.speed}｜神识 ${x.spirit}`
      + `｜累计造成 ${Math.round(x.dealt)}、承受 ${Math.round(x.taken)}` + (x.out ? `｜已退出（${x.outReason}）` : ''));
  }
  lines.push('【过程】（格式：回合｜谁｜做了什么｜结果）');
  const body = state.log.filter(e => e.kind !== 'system' && e.kind !== 'end');
  const tail = body.slice(-maxLines);
  for (const e of tail) lines.push(`${e.round}｜${e.text}`);
  return lines.join('\n');
}

/** 战斗结束时应写回快照的东西（只回「会被消耗的属性」，不回固有战力）。 */
export function battleOutcome(state) {
  const alive = {};
  for (const [id, u] of Object.entries(state.units)) {
    alive[id] = {
      hp: Math.max(0, Math.round(u.hp)),
      hpMax: u.hpMax,
      mp: Math.max(0, Math.round(u.mp)),
      mpMax: u.mpMax,
      out: u.out,
      outReason: u.outReason,
      status: u.out
        ? (u.outReason === '死亡' ? '已陨落' : u.outReason === '逃遁' ? '已遁走' : u.outReason)
        : '战斗结束',
    };
  }
  return {
    result: state.result,
    resultText: state.resultText,
    round: state.round,
    seed: state.seed,
    units: alive,
    logText: battleLogText(state),
  };
}

/** 供 UI 渲染的一帧快照（纯数据，不含 Map/函数）。 */
export function viewFrame(state) {
  return {
    size: state.size,
    grid: state.grid,
    finished: state.finished,
    result: state.result,
    resultText: state.resultText,
    round: state.round,
    actorId: state.actorId,
    turn: state.turn ? { ...state.turn, reach: undefined, cells: state.turn.reach?.cells || [] } : null,
    clock: { ...state.clock },
    units: Object.values(state.units).map(u => ({
      id: u.id, name: u.name, gender: u.gender, side: u.side, realm: u.realm, title: u.title,
      hp: u.hp, hpMax: u.hpMax, mp: u.mp, mpMax: u.mpMax,
      x: u.x, y: u.y, facing: u.facing, stance: u.stance,
      out: u.out, outReason: u.outReason,
      speed: u.speed, spirit: u.spirit, luck: u.luck, crit: u.crit,
      atk: u.atk, def: u.def, pen: u.pen,
      skills: u.skills, items: u.items.map(i => ({ name: i.name, quantity: i.quantity, heal: i.heal })),
      nextAt: state.clock[u.id],
      interval: u.interval,
      speedTier: u.speedTier,
    })),
    log: state.log.slice(-60),
  };
}
