// ===== 数值钳制器（数值规则表 → 人物属性强制校界） =====
// 职责：拿「数值规则表」里的境界基准（realmProfiles）对照角色快照的属性，
//       凡与表不匹配者（超过上限 / 低于下限）一律强制写回边界值。
//
// 判定口径（与数值表语义一致）：
//   · max（属性上限容量）  → 钳制到 [基准下限, 上限]，既压高也抬低
//   · current（当前值）    → 压高；抬低分两种：
//                            固有战力（物攻/物防/法攻/法防/穿透/脚力/神识）**一律补满到容量**；
//                            气血 / 法力只在「满值态跟涨」时抬（原本满值、容量被抬上去），
//                            受伤 / 耗蓝（current < 旧 max）保持不动，绝不被治好。
//   · resources 镜像       → 随 stats 同步压界；发生跟涨时一并抬到新容量
//
// 为什么固有战力必须无条件补满：这些属性全程没有任何机制会消耗（本作无战斗结算模块，
// 战斗过程由 AI 叙述），current < max 不表示「虚弱」，只表示「数值被改坏了」。
// 典型成因是容量被校界抬到基准下限、当前值留在原处，于是出现 15/35 —— 而属性栏显示的是
// current，玩家看到的就是「属性低于标准值」。补满让已损坏的老存档在下一次落档时自愈。
//   · 加成剥离（meta.mods）→ 传入出身/种族/特质/加点/装备的加成后，校界只针对「剥离加成后的裸值」：
//                            有效区间随加成正比平移（[base+bonus, upper+bonus]），
//                            这样「嗜睡 脚力-1」不会被当成「低于基准」而被抬回去。
// 映射口径与正文提示词保持一致（见 evolutionPrompt 的 stats 契约）：
// 物攻→atk 列、法攻→mag 列、**物防与法防共用 def 列**、**物理穿透与法术穿透共用 pen 列**、
// 神识→shenshi 列。
// realmProfiles 只提供「物防/法防」「穿透」这类合并列，因此同轴属性一律共用同一列，
// 不对其中一项做例外豁免——凡 realmProfiles 有对应列可对照的属性都必须校界。
// 表内确实没有对应列的属性（气运/魅力/修炼速度）才列入「未覆盖」。

import { snapshotFromCharacter, modsToStatBonus, characterClampBonus } from './snapshotSchema.js';
import { getEffectiveTables } from './numericTuning.js';
// 境界文本归一 / 境界→表键 的唯一实现在 realmBounds（零依赖模块，服务端打回校验也用它）。
// 这里 re-export 一次，历史调用点（NumericPage 等）的导入路径不用改。
import { normalizeRealmText, resolveRealmKey, REALM_STAT_MAP, UNCOVERED_STATS } from './realmBounds.js';

export { normalizeRealmText, resolveRealmKey, REALM_STAT_MAP, UNCOVERED_STATS };

// ---------- 单值钳制 ----------
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const isNum = v => typeof v === 'number' && Number.isFinite(v);

// ---------- 与境界无关的固定上下限 ----------
// 境界基准表里没有列、因而拿不到区间的属性，若有硬性值域就在这里钉死。
// 气运（2026-09-18）：它只喂暴击率，满值 100 正好贡献 40%
//（见 battleEngine 的 CRIT_LUCK_COEF / CRIT_LUCK_MAX_LUCK，探针锁死两处同值）；
// 不钉死的话它会无意义地堆到无穷，暴击率早就封顶、多出来的部分也不是白给。
export const FIXED_BOUNDS = {
  luck: { lo: 0, hi: 100, label: '气运' },
  crit: { lo: 0, hi: null, label: '会心' },   // 会心无上限：只管不许为负
};

/**
 * 表外属性的固定上下限钳制（与境界无关，任何快照都做）。
 * 单独成一个函数，是为了让「境界认不出 → 不校界」这条短路不影响它。
 * @returns {{ snapshot: object, changes: object[] }}
 */
export function clampFixedBounds(snap, meta = {}) {
  const out = { snapshot: snap, changes: [] };
  const stats = snap?.stats;
  if (!stats || typeof stats !== 'object') return out;
  const id = meta.id || snap.id || '';
  const name = meta.name || snap.identity?.name || id;
  let nextStats = null;
  for (const [key, b] of Object.entries(FIXED_BOUNDS)) {
    const cur = stats[key];
    if (!cur || typeof cur !== 'object') continue;
    const patched = { ...cur };
    let changed = false;
    for (const field of ['current', 'max']) {
      if (!isNum(cur[field])) continue;
      const lo = b.lo ?? -Infinity;
      const hi = b.hi ?? Infinity;
      const target = clamp(cur[field], lo, hi);
      if (target !== cur[field]) {
        patched[field] = target;
        changed = true;
        out.changes.push({
          id, name, stat: key, statLabel: b.label, field,
          from: cur[field], to: target, bonus: 0,
          bound: cur[field] > hi ? 'upper' : 'lower',
          limit: cur[field] > hi ? hi : lo,
          table: 'FIXED_BOUNDS',
        });
      }
    }
    if (changed) { nextStats = nextStats || { ...stats }; nextStats[key] = patched; }
  }
  if (nextStats) out.snapshot = { ...snap, stats: nextStats };
  return out;
}

/**
 * 对照数值表钳制单个角色快照。
 * @param {object} snap 角色快照
 * @param {object} tables 数值表集合（含 realmProfiles）
 * @param {object} [meta] { id, name } 报告中显示用
 * @returns {{ snapshot: object, changes: object[], realmKey: string|null, realmText: string, skipped: string }}
 */
export function clampSnapshotStats(snap, tables, meta = {}) {
  const out = { snapshot: snap, changes: [], realmKey: null, realmText: '', skipped: '' };
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return out;

  // ① 与境界无关的固定上下限（气运 0~100、会心不为负）先做 —— 境界认不出也要钳，否则会漏网
  const fixed = clampFixedBounds(snap, meta);
  const base = fixed.snapshot;
  out.changes.push(...fixed.changes);
  out.snapshot = base;

  const rp = tables?.realmProfiles;
  if (!rp || typeof rp !== 'object') { out.skipped = '数值表缺少境界基准表（realmProfiles），未校界'; return out; }
  const identity = base.identity || {};
  const realmText = identity.realm || base.realm || '';
  out.realmText = realmText;
  const realmKey = resolveRealmKey(realmText, Object.keys(rp));
  out.realmKey = realmKey;
  if (!realmKey) { out.skipped = `境界「${realmText || '未知'}」不在境界基准表中（境界必须取表中档位：凡人 / 炼气一~十三层 / 筑基初期 …），未校界`; return out; }
  const profile = rp[realmKey] || {};
  const stats = base.stats;
  if (!stats || typeof stats !== 'object') { out.skipped = '快照缺少 stats，未校界'; return out; }

  const id = meta.id || snap.id || '';
  const name = meta.name || identity.name || id;
  // 人物自身 / 装备加成（中文属性名）→ stats 键加成表：校界只针对剥离加成后的「裸值」，
  // 否则「嗜睡：脚力 -1」这类负加成会把属性压到基准以下、再被抬回去（加成被抹掉）。
  const statBonus = modsToStatBonus(meta.mods || {});
  out.bonusApplied = statBonus;
  const nextStats = { ...stats };
  const nextRes = base.resources && typeof base.resources === 'object' ? { ...base.resources } : null;
  let touchedStats = false;
  let touchedRes = false;

  for (const spec of REALM_STAT_MAP) {
    const cur = stats[spec.key];
    if (!cur || typeof cur !== 'object') continue;
    const base = profile[`${spec.field}Base`];
    const upper = profile[`${spec.field}Upper`];
    if (!isNum(upper)) continue;
    const bonus = isNum(statBonus[spec.key]) ? statBonus[spec.key] : 0;
    // 有效区间随加成正比平移：裸值 ∈ [base, upper] ⟺ 值 ∈ [base+bonus, upper+bonus]
    const lo = (isNum(base) ? Math.min(base, upper) : 0) + bonus;
    const hi = upper + bonus;

    const patched = { ...cur };
    let changed = false;
    let fullRaised = false;   // 本项是否发生了「满值态跟涨」（供 resources 镜像同步）

    // 1) 上限容量：既压高也抬低（容量本身不合规就是数据错误）
    if (isNum(cur.max)) {
      const target = clamp(cur.max, lo, hi);
      if (target !== cur.max) {
        patched.max = target;
        changed = true;
        out.changes.push({
          id, name, realmText, realmKey, stat: spec.key, statLabel: spec.label, field: 'max',
          from: cur.max, to: target, bound: cur.max > hi ? 'upper' : 'lower',
          limit: cur.max > hi ? hi : lo, bonus,
          table: `realmProfiles.${realmKey}.${spec.field}${cur.max > hi ? 'Upper' : 'Base'}`,
        });
      }
    }
    // 2) 当前值
    //    · 压高：天花板 = min(表上限, 已钳制的 max)
    //    · 抬低（补满）：
    //        - 固有战力（非气血/法力）：无条件补满到容量。这类属性全程没有任何机制会消耗
    //          （全项目无战斗结算模块），current < max 不表示「虚弱」，只表示数值被改坏——
    //          典型成因是容量被抬到基准下限、当前值却留在原处，于是属性栏（显示的是 current）
    //          就显示成「属性低于标准值」。
    //        - 气血 / 法力：仅「满值态跟涨」（原本 current === 旧 max，容量被抬高时跟上去）；
    //          current < 旧 max 属正常剧情状态（受伤 / 耗蓝），保持不动，绝不被治好。
    if (isNum(cur.current)) {
      const ceiling = Math.min(hi, isNum(patched.max) ? patched.max : hi);
      // 下限：固有战力不允许为负（全程没有机制消耗它们）；气血 / 法力**允许为负** ——
      // 加值（特质 / 装备）给的那部分血被打掉时，只能记在「自身」这一格（加值本身实时算、不落盘）。
      // 例：自身 0/0 ＋ 装备 +50 ⇒ 生效 50/50，挨 40 伤后自身记 −40，显示 10/50。
      // 显示端统一钳到 [0, 上限]（attrRows.poolCurrent），界面、注入文本、战斗取数都看不到负数。
      const floor = spec.pool ? -Number.MAX_SAFE_INTEGER : 0;
      let target = clamp(cur.current, floor, ceiling);
      if (isNum(patched.max) && target < patched.max) {
        // 固有战力（物攻/物防/法攻/法防/穿透/脚力/神识）：全程没有任何机制会消耗它们，
        // current < max 不表示「虚弱」，只可能是数值被改坏（容量被抬上去、当前值留在原处）
        // —— 一律补满，数据自愈。
        // 气血 / 法力（spec.pool）：只有「满值态跟涨」——原本就是满的（current === 旧 max），
        // 容量被抬高时同步抬上去；受伤 / 耗蓝（current < 旧 max）保持不动，绝不把伤者治好。
        if (!spec.pool || cur.current === cur.max) {
          target = patched.max;
          fullRaised = true;
        }
      }
      if (target !== cur.current) {
        const raised = target > cur.current;
        patched.current = target;
        changed = true;
        out.changes.push({
          id, name, realmText, realmKey, stat: spec.key, statLabel: spec.label, field: 'current',
          from: cur.current, to: target,
          bound: raised ? 'lower' : 'upper',
          limit: raised ? lo : ceiling, bonus,
          table: `realmProfiles.${realmKey}.${spec.field}${raised ? 'Base' : 'Upper'}`,
        });
      }
    }
    if (changed) { nextStats[spec.key] = patched; touchedStats = true; }

    // 3) resources 镜像（hp/mp）：跟随 stats 压界，避免资源条仍显示超限值
    if (nextRes && spec.pool) {
      const r = nextRes[spec.key];
      if (r && typeof r === 'object') {
        const rp2 = { ...r };
        const stv = nextStats[spec.key] || cur;
        let ch = false;
        if (isNum(rp2.max) && isNum(stv.max) && rp2.max !== stv.max) { rp2.max = stv.max; ch = true; }
        // 满值态跟涨：stats 抬了、资源条必须一起抬，否则两边对不上（资源条仍显示旧的低值）
        if (fullRaised && isNum(rp2.current) && isNum(rp2.max) && rp2.current < rp2.max) { rp2.current = rp2.max; ch = true; }
        if (isNum(rp2.current)) {
          const cap = isNum(stv.current) ? Math.min(stv.current, isNum(rp2.max) ? rp2.max : stv.current) : (isNum(rp2.max) ? rp2.max : hi);
          if (cap != null && rp2.current > cap) { rp2.current = cap; ch = true; }
        }
        if (ch) { nextRes[spec.key] = rp2; touchedRes = true; }
      }
    }
  }

  if (!touchedStats && !touchedRes) return out;
  const next = { ...base, stats: nextStats };
  if (touchedRes) next.resources = nextRes;
  out.snapshot = next;
  return out;
}

/**
 * 该角色是否受数值表约束。
 * 判定顺序：快照上的显式标记（AI/同步写入）→ 角色本体 numericClamp → 缺省视为受约束。
 * 角色本体存放位置：主角 save.character.numericClamp，NPC save.npcs[].numericClamp。
 * NPC 的册内 id 与快照 id 可能不同（手工建册是 npc_xxx、快照是 C1），故再按姓名兜底匹配。
 * @param {object} save 存档
 * @param {string} charId 角色 id（快照 id 或名册 id）
 * @param {object} [snap] 角色快照（可选，用于姓名兜底与快照级标记）
 * @returns {boolean} true = 受数值表约束
 */
export function isCharClamped(save, charId, snap) {
  if (snap && typeof snap === 'object' && snap.numericClamp === false) return false;
  const id = String(charId == null ? '' : charId);
  if (id === 'B1' || (snap && snap.kind === 'player')) return save?.character?.numericClamp !== false;
  const list = Array.isArray(save?.npcs) ? save.npcs : [];
  const hit = list.find(n => n && String(n.id) === id)
    || (snap?.identity?.name ? list.find(n => n && n.name === snap.identity.name) : null);
  return hit ? hit.numericClamp !== false : true;
}

/**
 * 校界整份存档里的角色快照（主角 + 名册 NPC，按 tuning.applyTo 与角色自身开关过滤）。
 * @param {object} save 存档
 * @param {object} tuning settings.numericTuning（可为 null = 内置表）
 * @param {object} [opts] { force: 忽略开关, silent }
 * @returns {{ save: object, changes: object[], scanned: number, enforced: boolean, skipped: object[] }}
 */
export function enforceSnapshotLimits(save, tuning, opts = {}) {
  const result = { save, changes: [], scanned: 0, enforced: false, skipped: [] };
  if (!save || typeof save !== 'object') return result;
  const enabled = opts.force === true || !(tuning && tuning.enforce === false);
  result.enforced = enabled;
  if (!enabled) return result;

  const tables = getEffectiveTables(tuning);
  const applyTo = (tuning && tuning.applyTo) || {};
  const wantPlayer = applyTo.playerB1 !== false;
  const wantNpcs = applyTo.npcs !== false;

  const bundle = { ...(save.charSnapshots || {}) };
  // 主角：快照缺失时从角色档案合成（保证 B1 始终受表约束）
  if (wantPlayer && !bundle.B1 && save.character) {
    try {
      bundle.B1 = snapshotFromCharacter(save.character, {
        id: 'B1', kind: 'player', isPlayer: true, locationName: save.world?.location?.name,
      });
    } catch { /* 角色档案不完整时跳过主角 */ }
  }

  let changedAny = false;
  for (const [id, snap] of Object.entries(bundle)) {
    if (!snap || typeof snap !== 'object') continue;
    const isPlayer = id === 'B1' || snap.kind === 'player';
    if (isPlayer ? !wantPlayer : !wantNpcs) continue;
    // 角色自身豁免（角色名册·基本信息里的开关）优先于全局作用域
    if (!isCharClamped(save, id, snap)) {
      result.skipped.push({ id, name: snap.identity?.name || id, msg: '该角色已在角色名册中豁免数值表约束，未校界' });
      continue;
    }
    result.scanned += 1;
    // 校界只针对「自身」值：区间只为「仍留在自身里的加成」（出身/种族/加点）上移，
    // 避免把它们误判为越界。特质与装备都在自身之外由系统实时叠加，不参与区间平移，
    // 故取 characterClampBonus（不含特质），而不是属性栏展示用的 characterAttrMods（特质段）。
    const r = clampSnapshotStats(snap, tables, { id, mods: characterClampBonus(save, snap, id) });
    if (r.skipped) result.skipped.push({ id, name: snap.identity?.name || id, msg: r.skipped });
    if (r.changes.length) {
      bundle[id] = r.snapshot;
      result.changes.push(...r.changes);
      changedAny = true;
    }
  }
  if (changedAny) result.save = { ...save, charSnapshots: bundle };
  return result;
}
