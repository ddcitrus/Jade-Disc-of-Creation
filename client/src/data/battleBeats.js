// ===== 战报 → 画面上的「演出单」=====
//
// 为什么要这一层：引擎是**一瞬间算完**的。玩家点一下「劈山掌」，引擎在同一个 tick 里
// 就把「走过去 → 命中 → 掉血 → 也许倒下」全算完了，战报里一次多出好几行。
// 可画面上不能这么演 —— 必须按先后：先走过去、站定、抬手、手打到人身上，
// 这时候伤害数字才冒出来。玩家看到的时序错了，就会读成「一边走一边打，数字乱飘」。
//
// 一份演出单（beat）只描述「谁、做什么、对象是谁、数字多少」，**不描述时间**。
// 时间归 3D 场景管 —— 它手里才有真正的动作片段，知道一段 Cross Punch 有多长、
// 播到第几成算打中（见 battleSceneModels.ACTION_IMPACT）。这样这一层就是纯数据，
// 能在 node 里直接断言：战报里「移动 + 命中」两条 → 演出单里就是「先走、后打」两条。
//
// 谁能上演出单（其余一律不做动作，见需求「其他无动作」）：
//   移动 move   → 播 Running
//   命中 act    → 近战播 Cross Punch / 远程播 Magic Attack
//   护架 guard  → 播 Blocking（**一遍**）：威吓是抬手压过去，防御是抬起护架
//                 —— 防御演完由「防御姿态」冻在架住那一帧接着保持（见 HOLD_AT_IMPACT）
//   倒下        → 不在演出单里：由「退出战斗」这个状态驱动，人一退出就摆倒地姿势
//   蓄力 / 回血 / 器物 / 逃遁 / 投降 / 回合 / 退场 → 一条都不生成（需求原话「其他无动作」）
//
// 一条铁律：**同一个人连着好几件事时，先后不许乱**。调用方按顺序喂、按顺序演，
// 前一件没演完，后一件不许开播。

export const BEAT_MOVE = 'move';
export const BEAT_ACT = 'act';
export const BEAT_GUARD = 'guard';
export const BEAT_OUT = 'out';

let seq = 0;
const nextId = () => ++seq;

/** 把一条战报翻译成演出单条目；不认识的条目返回 null（＝这件事不做动作）。 */
function beatFromLog(e) {
  if (!e) return null;

  // actorId 必须有 —— 一条"不知道是谁在走"的演出单只会让队列空转（场景找不到人，只能当演完）。
  if (e.kind === 'move' && e.actorId && e.from && e.to) {
    return {
      id: nextId(), kind: BEAT_MOVE, actorId: e.actorId,
      from: { x: e.from.x, y: e.from.y },
      to: { x: e.to.x, y: e.to.y },
      cost: Number(e.cost) || 0,
    };
  }

  if (e.kind === 'hit' && e.actorId && e.targetId) {
    // 近战 / 远程由**结算那一处**定死（battleEngine.resolveAttack 写进 style），
    // 界面不许按功法名去猜 —— 猜错了就会「贴身打却放法术」。
    const style = e.style === 'ranged' ? 'ranged' : 'melee';
    return {
      id: nextId(), kind: BEAT_ACT, actorId: e.actorId, targetId: e.targetId,
      style, label: e.skill || '',
      dmg: Math.max(0, Math.round(Number(e.dmg) || 0)),
      crit: !!e.crit,
      // 「一击把剩余气血彻底打空」——数字后面挂个「终」字，别让玩家以为是这一击只有这么点力道
      truncated: e.truncated != null ? !!e.truncated : /彻底打空/.test(e.text || ''),
    };
  }

  // 退场（陨落 / 伤重不支 / 投降 / 逃遁成功）：**也要进演出单**，才有"先把这一手走完、再倒下"的先后。
  // ⚠ 2026-09-20 玩家报的原话：「顺序明明是王禅 移动 3 格… 王禅 收手认输，但是却是先投降后移动」。
  // 原因就是「退出战斗」这个状态原来照着 frame **立刻**生效，而移动还排在演出队列里没演，
  // 于是画面上人先躺下、再由一具尸体滑出去。现在退场也排队，顺序自然就对了。
  // 判据只看一件事：**这条战报是不是表示这个人离开了战斗**（引擎在成功的逃遁/投降上写 out:true）。
  if (e.actorId && (e.kind === 'out' || e.out === true)) {
    const reason = e.reason || (e.kind === 'surrender' ? '投降' : e.kind === 'flee' ? '逃遁' : '');
    return { id: nextId(), kind: BEAT_OUT, actorId: e.actorId, reason };
  }

  // 护架：防御与威吓都摆一次 Blocking（一次性的抬手）。
  //   威吓带 targetId（压向谁）、防御不带（只是举起来护住自己）—— 两者都**只演一遍**：
  //   演完防御由「防御姿态」接着冻在「架住」那一帧，威吓则回到待机。
  //   为什么防御也要演这一遍（2026-09-20 玩家原话「防御、威吓的动作演出一遍就行」）：
  //   只靠姿态切换的话，人是"啪"一下直接出现在举架姿势上，看不到抬手那一下。
  if (e.kind === 'action' && e.pose === 'block' && e.actorId) {
    return {
      id: nextId(), kind: BEAT_GUARD, actorId: e.actorId, targetId: e.targetId || null,
      label: e.label || '',
    };
  }

  return null;
}

/**
 * 把一批**新产生的**战报条目按原顺序翻译成演出单。
 * 只接「还没演过的那几条」——重复喂同一条会重复演，调用方（BattleView）靠对象身份去重。
 *
 * @param {object[]} entries 按时间顺序的新战报条目
 * @returns {object[]} 演出单，每项 { id, kind, ... }；没动作可做时返回空数组
 */
export function beatsFromLog(entries) {
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const b = beatFromLog(e);
    if (b) out.push(b);
  }
  return out;
}
