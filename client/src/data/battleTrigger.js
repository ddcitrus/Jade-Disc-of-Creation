// ===== 战斗触发（AI 指令 → 参战单位）=====
// 需求：「AI识别到战斗，调用工具。首先利用数值表等等规则校验是否各个人物属性是否正确。
//        向程序输入双方角色快照（保底血量机制已取消，气血打到 0 才退场）。调用战斗界面」
//
// 「调用工具」在本项目里的落地方式：AI 在正文回合末尾输出一段 <battle>…</battle>（JSON）。
// 本模块负责：解析 → 逐项校验（含数值表校界）→ 产出可直接交给 battleEngine 的参战单位。
// 战后补写正文用到的提示词原文在 ../prompts/contracts.js。
// 任何一步不合法都不会"静默篡改"，而是如实记进 warnings/errors，由界面提示玩家。

import { attrRows, characterAttrMods, characterClampBonus, CRIT_DEFAULT } from './snapshotSchema.js';
import { clampSnapshotStats, isCharClamped } from './attrClamp.js';
import { getEffectiveTables } from './numericTuning.js';
import { intervalForUnit } from './battleSpeed.js';
import { buildSkillFromSnapshot, itemHealOf } from './battleUnits.js';
import { normalizeTerrainId } from './battleTerrain.js';
import { generateBattlefield, describeBattlefield } from './battleMapGen.js';
import { buildAfterBattleProtocolText, battleWordQuota } from './mortalProtocols.js';
// 建档保底：宽容 JSON 与「按标准凡人现造一份可用档」都放在 snapshotV2（建档的唯一模块），
// 这里只调用 —— 两处各写一套修法必然会漂移。
import { looseJsonValue, fallbackV2Snapshot, v2ToLegacy, nameFromStoryText } from './snapshotV2.js';
import { PLAYER_POV_CONTRACT } from '../engine/promptSystem.js';
import { battleBeforeText, battleWordQuotaText } from '../prompts/contracts.js';

/** 找正文里**最后一段** <battle>…</battle>（同一回合可能写多段，取最后一段生效）。 */
export function parseBattleBlock(text) {
  const src = String(text || '');
  const re = /<battle\b[^>]*>([\s\S]*?)<\/battle>/gi;
  let m;
  let last = null;
  while ((m = re.exec(src)) !== null) last = m;
  if (!last) return null;
  const body = String(last[1] || '').trim();
  if (!body) return null;
  // 严格解析不行就走宽容解析（围栏/尾逗号/单引号/裸键/全角引号）——与建档块共用同一份实现
  let spec = null;
  try { spec = JSON.parse(body); } catch { spec = looseJsonValue(body); }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    // 写成了 'normal' 或纯文本：当成"按默认规则打一场"，不阻断
    return { spec: {}, raw: last[0], parseError: '指令不是合法 JSON，已按默认规则开局' };
  }
  return { spec, raw: last[0], parseError: '' };
}

// 宽松 JSON 的实现已上移到 snapshotV2.looseJsonValue —— 建档块与 <battle> 指令都是 AI 手写的
// JSON，修法必须同一套（2026-09-20）。本文件不再保留第二份实现。

/**
 * 把正文里的 <battle>…</battle> 整段去掉（它不该给玩家看）。
 * 流式未闭合时，从最后一个 <battle 起整段丢弃 —— 战斗布置不是正文的一部分。
 */
export function stripBattleBlocks(text) {
  let s = String(text || '');
  s = s.replace(/<battle\b[^>]*>[\s\S]*?<\/battle>/gi, '');
  const at = s.lastIndexOf('<battle');
  if (at >= 0 && !/<\/battle>/i.test(s.slice(at))) s = s.slice(0, at);
  return s;
}

// ============================================================
// 参战单位：从快照取「生效值」，与角色面板显示的数字逐字一致
// ============================================================

/**
 * 参战单位（combatant）构造。
 * 取值口径与正文协议一致：攻击/防御/穿透/脚力/神识一律取**生效值**（自身＋特质＋装备），
 * 气血/法力取「当前 / 上限（含加成）」。绝不另算一遍装备。
 */
export function unitFromSnapshot(save, snap, opts = {}) {
  const id = String(opts.id || snap?.id || '');
  const traitMods = characterAttrMods(save, snap, id);
  const rows = attrRows(snap, traitMods);
  const rowOf = (k) => rows.find(r => r.key === k);
  // 生效值只从属性行里取（attrRows 算好的 effCurrent / effMax）——
  // 别在这里再 + bonus + traitBonus 一遍：气血 / 法力的「满值才跟涨」口径就在那边，
  // 两边各算一套的结果是「面板显示 0 / 100、进战斗 0 / 100」，新建角色带法力上限特质也永远是空蓝。
  const eff = (k, d = 0) => {
    const r = rowOf(k);
    if (!r) return d;
    return Math.round(Number(r.effCurrent) || 0);
  };
  const pool = (k) => {
    const r = rowOf(k);
    if (!r) return { cur: 0, max: 0 };
    const max = Math.round(Number(r.effMax) || 0);
    const cur = Math.min(Math.round(Number(r.effCurrent) || 0), max);
    return { cur, max };
  };

  const hp = pool('hp');
  const mp = pool('mp');
  const skills = (Array.isArray(snap?.skills) ? snap.skills : [])
    .map(s => buildSkillFromSnapshot(s, { hpMax: hp.max || hp.cur, mpMax: mp.max }))
    .filter(Boolean);
  const items = collectBattleItems(snap, opts.ownedItems);

  const speed = eff('speed', 20);
  // 行动条不直接吃脚力数值，而是按境界档位查表（battleSpeed.js）：
  // 旧公式在高境界会撞死在下限上，化神以上 26 个境界出手速度完全一样。
  // 脚力在这里只剩一个用途 —— 境界名认不出表时，拿它就近落档。
  const spd = intervalForUnit({ realm: snap?.identity?.realm || '', speed }, opts.realmProfiles);

  return {
    id,
    name: snap?.identity?.name || id,
    gender: snap?.identity?.gender || '',   // 仅用于 3D 角色按性别分配 VRM，不参与结算
    side: opts.side === 'right' ? 'right' : 'left',
    realm: snap?.identity?.realm || '',
    title: opts.title || '',
    hp: hp.cur || hp.max || 1,
    hpMax: hp.max || hp.cur || 1,
    mp: mp.cur,
    mpMax: mp.max,
    atk: { phys: eff('physAtk', 10), mag: eff('magAtk', 10) },
    def: { phys: eff('physDef', 10), mag: eff('magDef', 10) },
    pen: { phys: eff('physPen', 0), mag: eff('magPen', 0) },
    speed,
    interval: spd.interval,
    speedTier: spd.tier,
    spirit: eff('spirit', 10),
    luck: eff('luck', 5),
    // 会心（百分点）：暴击的底子，取生效值（自身＋特质＋装备）。缺省 = 原先固定的基础暴击率。
    crit: eff('crit', CRIT_DEFAULT),
    skills,
    items,
    floorHpPercent: opts.floorHpPercent,
  };
}

/**
 * 战斗回执 → 快照写回：把参战单位的战后气血 / 法力落回快照（唯一的写回实现，界面只调用不复刻）。
 *
 * 参战单位身上的是**生效值**（含特质与装备加成），快照里存的却是「自身值」—— 必须先减掉加成。
 * 不减的后果实测过：自身 100 ＋ 装备 50 的角色打一场，自身上限就被写成 150（加成就这么烙进自身一次），
 * 界面立刻显示成 40/200，要等下一回合数值表校界才拉回来。
 * 战损超过自身存量时自身会记成负数（＝加值给的那部分血先被打掉了）；显示端统一钳到 [0, 上限]
 * （见 snapshotSchema.poolCurrent），界面、注入文本、战斗取数都看不到负数。
 *
 * @param {object} snap 角色快照
 * @param {object} o    battleOutcome().units[id]（hp / hpMax / mp / mpMax / status）
 * @param {object} [traitMods] 该角色的特质加成（characterAttrMods 的产物）
 * @returns {object} 新的快照（不改原对象）
 */
export function applyBattleOutcome(snap, o, traitMods = null) {
  if (!snap || typeof snap !== 'object' || !o || typeof o !== 'object') return snap;
  const rows = attrRows(snap, traitMods);
  const bonusOf = (k) => Number(rows.find(r => r.key === k)?.total) || 0;
  const stats = { ...(snap.stats || {}) };
  const put = (k, v, max, minus) => {
    const cell = { ...(stats[k] || {}) };
    cell.current = Math.round(Number(v) || 0) - minus;
    const m = Number(max);
    if (Number.isFinite(m) && m > 0) cell.max = Math.max(0, Math.round(m) - minus);
    stats[k] = cell;
  };
  const hpMinus = bonusOf('hp'), mpMinus = bonusOf('mp');
  put('hp', o.hp, o.hpMax, hpMinus);
  put('mp', o.mp, o.mpMax, mpMinus);
  const next = {
    ...snap,
    stats,
    resources: {
      ...(snap.resources || {}),
      hp: { ...(snap.resources?.hp || {}), current: Math.round(Number(o.hp) || 0) - hpMinus },
      mp: { ...(snap.resources?.mp || {}), current: Math.round(Number(o.mp) || 0) - mpMinus },
    },
  };
  if (o.status) next.status = { ...(snap.status || {}), current: o.status };
  return next;
}

/** 角色身上「战斗中能用」的物品：消耗品 + 有回血/回蓝数值。 */
function collectBattleItems(snap, ownedItems) {
  const inv = Array.isArray(snap?.inventory) ? snap.inventory : [];
  const out = [];
  for (const it of inv) {
    if (!it || typeof it !== 'object') continue;
    const name = it.name || it.id || '';
    if (!name) continue;
    const heal = itemHealOf(it);
    if (!heal.hp && !heal.mp) continue;
    out.push({ name, quantity: Math.max(0, Math.round(Number(it.quantity) || 0)), heal });
  }
  // 不在快照里但在「储物袋清单」里的物品（板面口径）也认
  for (const nm of (Array.isArray(ownedItems) ? ownedItems : [])) {
    if (!nm || out.some(x => x.name === nm)) continue;
  }
  return out;
}

// ============================================================
// 校验 + 组装
// ============================================================

/**
 * 把 <battle> 指令与存档合起来，产出一场可跑的战斗配置。
 * 建档保底（2026-09-20）：指令点名的角色**没有档案**时不再判死，而是按标准凡人现造一份
 * 让他照常上场（见 recoverSnapshot），临时档随 `recovered` 返回、由调用方落盘并提示玩家核对。
 * 代价是一份待补的档案，换来的是剧情永远不会卡在「剑已出鞘」。
 *
 * @param {object} save 存档
 * @param {object} spec AI 的 <battle> JSON
 * @param {object} [opts] { tuning, seed, rawText, floorHpPercent }
 *        rawText：本回合正文，兜底建档时用它认角色称呼（::dialogue 标记）
 * @returns {{ ok:boolean, errors:string[], warnings:string[], units:object[], mapRecipe:object|null,
 *            kind:string, allowDeath:boolean, clamped:object, recovered:object, note?:string }}
 */
export function buildBattleFromSpec(save, spec, opts = {}) {
  const errors = [];
  const warnings = [];
  const kind = spec?.kind === 'deathmatch' || spec?.死斗 === true ? 'deathmatch' : 'normal';
  const allowDeath = spec?.allowDeath != null ? !!spec.allowDeath : kind === 'deathmatch';

  // 复制一份：兜底建档会往里塞临时档案，不能污染调用方的 save
  const snapshots = { ...(save?.charSnapshots || {}) };
  const list = normalizeUnitSpecs(save, spec);
  if (!list.length) {
    errors.push('战斗指令里没有列出任何参战角色（units 为空），无法开局');
    return { ok: false, errors, warnings, units: [], mapRecipe: null, kind, allowDeath, clamped: {}, recovered: {} };
  }

  const tables = getEffectiveTables(opts.tuning);
  const clamped = {};
  const recovered = {};   // 兜底造出来的档案（调用方据此落盘 + 提示玩家核对）
  const units = [];
  const seen = new Set();

  /** 把一条参战记录变成作战单位；认不出这个角色就返回 false（并记一条 error）。 */
  const takeUnit = (item) => {
    const id = String(item?.id || '').trim();
    if (!id) { warnings.push('有一条参战记录没有写角色 id，已跳过'); return false; }
    if (seen.has(id)) return false;
    seen.add(id);
    let snap = snapshots[id];
    if (!snap) {
      // 建档保底的最后一道（2026-09-20）：点名要他参战、却压根没有档案
      // （建档块没写、或写坏了没救回来）。这里**不判死**——按标准凡人现造一份让他上场，
      // 同时把「这份档是临时的」如实告诉玩家去核对。
      // 为什么不能判死：战斗模式一开，AI 就被明确告知「胜负由程序裁定」，程序再不开局，
      // 剧情会永久停在「剑已出鞘」那一刻，谁也推不动。
      //
      // 但**只对合法角色编号兜底**（B1 / C1 / A2…）。编号本身不合规的（AI 写嗨了、
      // 或沿用了旧存档的 npc_xxx）说明这条参战记录是坏的：给它造一份名叫「NOPE_999」的档案
      // 只会把垃圾带进名册。那种情况仍走下面的「退回默认对阵」，行为与从前一致。
      if (!/^[ABC]\d+$/.test(id)) {
        errors.push(`战斗指令引用了不存在的角色 ${id}——该角色没有快照，无法参战（正文里要先为他建档）`);
        return false;
      }
      snap = recoverSnapshot(id, item, save, opts);
      snapshots[id] = snap;
      recovered[id] = snap;
      warnings.push(`${snap.identity?.name || id} 没有角色档案（建档块缺失或不可用），已按标准凡人档临时建档参战——请到角色名册核对补全`);
    }
    // 数值表校界：AI 报进来的角色数值先过一遍表，越界的当场写回（这就是需求里那句"先校验属性是否正确"）
    // 区间只为「仍留在自身里的加成」（出身/种族/加点）上移，与角色面板的校界口径完全一致。
    //
    // ⚠️ 但「校界」的四道闸必须同一口径。面板保存（CharacterPanel.enforceGuard）、每回合落档
    // （saveModel）、数值表页（enforceSnapshotLimits）三处都会先问两句：
    //   · 全局「强制校界」开关（settings.numericTuning.enforce）是不是关了？
    //   · 这个角色在名册「基本信息」里是不是选了豁免？
    // 建局这一处原先漏了这两问，于是玩家把属性改到 1000、面板显示 1000、落档也留着 1000，
    // 一进战斗却被打回凡人上限 300 —— 他看到的「改了没用」就是这么来的。
    const enforceOn = !(opts.tuning && opts.tuning.enforce === false);
    const r = (enforceOn && isCharClamped(save, id, snap))
      ? clampSnapshotStats(snap, tables, { id, mods: characterClampBonus(save, snap, id) })
      : { snapshot: snap, changes: [] };
    // 校界改过的必须是**战斗里真正用的那一份**。曾经这里漏了一步：只把 r.snapshot 记进 clamped 落盘，
    // 建局却仍用旧 snap —— 于是主角的物攻按 15 算（应为 35）、脚力按 15 算（应为 20），
    // 需求里「先校验属性」这一步就白做了。故作战单位一律从校界后的快照取值。
    const effSnap = r.changes.length ? r.snapshot : snap;
    if (r.changes.length) {
      clamped[id] = r.snapshot;
      warnings.push(`${snap.identity?.name || id} 有 ${r.changes.length} 处属性越界，已按数值表写回边界`);
    }
    const side = item.side === 'right' || item.side === '右' ? 'right'
      : (item.side === 'left' || item.side === '左' ? 'left' : null);
    units.push(unitFromSnapshot(save, effSnap, {
      id,
      side: side || 'left',
      title: item.title || '',
      floorHpPercent: item.floorHpPercent,
      realmProfiles: tables.realmProfiles,
    }));
    return true;
  };

  for (const item of list) takeUnit(item);

  if (!units.length) {
    // 布置里点名的角色**一个都对不上**（多半是引用了从没建过档的人）。
    // 这里不能直接放弃：战斗模式一旦打开，AI 就被明确告知「胜负由程序裁定、你不许写结果」，
    // 若程序也不开局，剧情会永久停在"剑已出鞘"那一刻，谁也推不动。
    // 于是退回与「布置写空」完全相同的兜底：主角 vs 存档里的第一位 NPC。
    if (Object.keys(snapshots).length >= 2) {
      warnings.push('战斗布置里点名的角色都没有快照，已改为按默认规则开局（主角对阵存档中第一位 NPC）');
      errors.length = 0;
      for (const item of normalizeUnitSpecs(save, {})) takeUnit(item);
    }
  }

  if (!units.length) {
    errors.push('存档里可参战的角色不足两人，战斗无法开始');
    return { ok: false, errors, warnings, units: [], mapRecipe: null, kind, allowDeath, clamped, recovered };
  }

  // 没写 side 的：按出场顺序左右各半
  if (!list.some(x => x.side)) {
    const half = Math.ceil(units.length / 2);
    units.forEach((u, i) => { u.side = i < half ? 'left' : 'right'; });
    warnings.push('战斗指令没写阵营，已按出场顺序前后各半分成两方');
  } else if (units.length >= 2 && !units.some(u => u.side === 'right')) {
    // 两边都写了但都写成同一方：把后半数挪到对面
    const half = Math.ceil(units.length / 2);
    units.forEach((u, i) => { u.side = i < half ? 'left' : 'right'; });
    warnings.push('战斗指令只标了一方阵营，已把后半数角色划为另一方');
  }

  // 地块表外名字 → 平地（AI 只能选，不能自造）
  const mapRecipe = normalizeMapRecipe(spec?.map, warnings, { seed: opts.seed });

  // 保底血量机制已于 2026-09-20 取消：无论寻常交手还是死斗，floorHpPercent 一律 0，
  // 气血可一路扣到 0、归零才退出战斗（生死由战后 AI 叙事描写）。AI 即使写了该字段也忽略。
  for (const u of units) u.floorHpPercent = 0;

  if (!units.some(u => u.side === 'left') || !units.some(u => u.side === 'right')) {
    // 布置里只有一方有人（或分完还是一家）→ 同上，不能把剧情卡死在这里：
    // 补上存档里的其他角色凑成两方，而不是拒绝开局。
    const spare = Object.keys(snapshots).filter(k => !seen.has(k));
    for (const id of spare) {
      if (units.some(u => u.side === 'left') && units.some(u => u.side === 'right')) break;
      takeUnit({ id, side: units.some(u => u.side === 'left') ? 'right' : 'left' });
    }
    if (units.length > 1) {
      const half = Math.ceil(units.length / 2);
      units.forEach((u, i) => { u.side = i < half ? 'left' : 'right'; });
      warnings.push('战斗布置只列出了一方，已把存档里的其他角色补到对面');
    }
  }

  if (!units.some(u => u.side === 'left') || !units.some(u => u.side === 'right')) {
    errors.push('战斗双方必须各有至少一人（当前只有一方有角色）');
    return { ok: false, errors, warnings, units: [], mapRecipe, kind, allowDeath, clamped, recovered };
  }

  // 场景备注里附一句「战场长什么样」。AI 写正文时看不到地图，不给它说一声，
  // 它就会写出「旷野上两人厮杀」，而画面上其实横着一道山 —— 正文与战斗画面穿帮。
  const fieldText = describeBattlefield(mapRecipe);
  const note = [String(spec?.note || '').trim(), fieldText ? `战场：${fieldText}` : ''].filter(Boolean).join('；');

  return { ok: true, errors, warnings, units, mapRecipe, kind, allowDeath, clamped, recovered, note };
}

/**
 * 兜底造档：参战指令点名了一个没有档案的角色时，按「标准凡人」现造一份内部结构快照。
 * 名字尽量取真的（指令里写的 name → 正文 ::dialogue 标记里的称呼 → 退回角色 ID），
 * 其余数值一律走 fallbackV2Snapshot 的凡人基准，再由建局那一步的数值表校界抬到该境界下限。
 */
function recoverSnapshot(id, item, save, opts = {}) {
  const name = String(item?.name || item?.姓名 || item?.名字 || '').trim()
    || nameFromStoryText(opts.rawText, id)
    || id;
  const v2 = fallbackV2Snapshot(id, {
    name,
    kind: id === 'B1' ? 'player' : 'npc',
    realm: item?.realm || item?.境界,
    gender: item?.gender || item?.性别,
    location: save?.world?.location?.name,
  });
  return v2ToLegacy(v2, null);
}

function normalizeMapRecipe(raw, warnings, opts = {}) {
  const obj = raw && typeof raw === 'object' ? raw : null;
  const baseRaw = obj ? (obj.base ?? obj.底 ?? obj.地形) : null;
  const base = normalizeTerrainId(baseRaw);
  if (baseRaw && base !== String(baseRaw).trim()) warnings.push(`地块「${baseRaw}」不在预置地块表中，已替换为「${base}」`);
  const patches = [];
  for (const p of (Array.isArray(obj?.patches) ? obj.patches : [])) {
    if (!p || typeof p !== 'object') continue;
    const tRaw = p.t ?? p.terrain ?? p.地块 ?? p.id;
    const t = normalizeTerrainId(tRaw);
    if (tRaw && t !== String(tRaw).trim()) warnings.push(`地块「${tRaw}」不在预置地块表中，已替换为「${t}」`);
    if (Array.isArray(p.rect) && p.rect.length === 4) patches.push({ t, rect: p.rect });
    else if (Array.isArray(p.at)) patches.push({ t, at: p.at });
    else if (Array.isArray(p.cells)) patches.push({ t, at: p.cells });
  }
  // AI 交上来的地图**十有八九是一片空场**：提示词的示例当时只给了「乱石 + 水洼」这类
  // 走得上去的地块，AI 照抄，于是两边站在空地上对轰，走位与地形全成摆设。
  // 所以这里统一过一遍战场生成器：补隔断、补掩体、补争夺点，并保证左右一定走得通。
  // 它不会推翻 AI 已经明确布置的格子 —— 程序只兜底，不抢编导的位置（详见 battleMapGen 注释）。
  const field = generateBattlefield({ base, patches }, { seed: opts.seed });
  for (const n of field.notes) warnings.push(`战场太空旷，程序已自动布置：${n}`);
  return { base: field.base, patches: field.patches };
}

/** 参战清单：AI 可写 units / 参战 / 双方，元素可以是 id 字符串或 {id,side,…}。 */
function normalizeUnitSpecs(save, spec) {
  const raw = spec?.units ?? spec?.参战 ?? spec?.双方 ?? spec?.characters;
  const out = [];
  const push = (v, side) => {
    if (v == null) return;
    if (typeof v === 'string' || typeof v === 'number') { out.push({ id: String(v), side }); return; }
    if (typeof v !== 'object') return;
    const id = v.id ?? v.角色 ?? v.charId;
    if (id == null) return;
    out.push({
      id: String(id),
      side: v.side ?? v.阵营 ?? side,
      title: v.title ?? v.称号 ?? '',
      // name/realm/gender：只在「这个人没建档、需要兜底造档」时用来给档案一个好称呼与境界，
      // 建过档的人一律以档案为准（AI 顺手写的名字不改官方档案）
      name: v.name ?? v.姓名 ?? v.名字 ?? v.称呼 ?? '',
      realm: v.realm ?? v.境界 ?? '',
      gender: v.gender ?? v.性别 ?? '',
      floorHpPercent: v.floorHpPercent ?? v.保底血量 ?? v.预留血量,
    });
  };
  if (Array.isArray(raw)) { raw.forEach(v => push(v, null)); return out; }
  if (raw && typeof raw === 'object') {
    // { left: [...], right: [...] } 或 { 左: [...], 右: [...] }
    for (const [k, arr] of Object.entries(raw)) {
      const side = /right|右|敌/.test(k) ? 'right' : (/left|左|我/.test(k) ? 'left' : null);
      if (Array.isArray(arr)) arr.forEach(v => push(v, side));
      else push(arr, side);
    }
    return out;
  }
  // 完全没写：默认「主角 + 存档里的第一位 NPC」打一场
  if (save?.charSnapshots?.B1) out.push({ id: 'B1', side: 'left' });
  const npcs = Object.keys(save?.charSnapshots || {}).filter(k => k !== 'B1');
  if (npcs.length) out.push({ id: npcs[0], side: 'right' });
  return out;
}

/** 人话摘要（开局前的确认面板 / toast 用）。 */
export function describeBattleSetup(res) {
  const left = res.units.filter(u => u.side === 'left').map(u => u.name).join('、');
  const right = res.units.filter(u => u.side !== 'left').map(u => u.name).join('、');
  return `${left} 对阵 ${right}${res.kind === 'deathmatch' ? '（死斗）' : ''}`;
}

/**
 * 战后叙事请求：把程序打出来的战报交回 AI，让它写"过程与结果"的文字。
 * 这是需求里「程序把战斗日志返回 AI / AI 接受日志，编写文字描述过程与结果」那一步。
 *
 * 2026-09-19 重写（方案 B：和平时的正文请求同源）。改了三处：
 *   ① 提示词不再现写一份，改由【Mortal 战后叙事协议】承担（设置页可编辑，见 mortalProtocols）；
 *   ② 数值约束**不再复制**，由协议里的 ${proseNumbers} 引用设置页那一份 —— 改一处、两处生效；
 *   ③ 末尾补上与「自动下回合」完全相同口径的两条硬约束：篇幅、视点。
 * 为什么必须补数值约束：旧版整条请求里搜「正文数值约束」= 0 处，而战报里逐行写着
 * 「［古兰 气血 600/3000］」—— AI 照抄，就写成了「气血两千九百九十八点」。
 *
 * @param {object} save 存档（提供时空与人物语境）
 * @param {object} outcome battleEngine.battleOutcome
 * @param {{ note?:string, before?:string, after?:string }} [ctx]
 *        note   AI 自己写的开战缘由；before = 开战前的正文结尾；after = 之后已经被写出来的正文（正常为空）
 * @param {object} [settings] 完整设置（settings.textRules 决定协议文本与字数口径）
 * @returns {{ role:string, content:string }[]} 可直接交给 /api/ai/story 的消息
 */
export function battleNarrativeMessages(save, outcome, ctx = {}, settings = null) {
  const w = save?.world || {};
  const quota = battleWordQuota(settings);

  const head = [
    `【当前时空】${w.timeLabel || '（未知）'}｜${w.location?.name || '（未知）'}`,
    ctx.note ? `【开战缘由】${ctx.note}` : '',
    ctx.before ? battleBeforeText(ctx) : '',
  ].filter(Boolean);
  head.push(
    '',
    '【战斗回执（程序生成的事实清单：胜负、谁以什么方式退出、双方用过什么招，以此为准）】',
    String(outcome?.logText || ''),
    '',
    '【提醒】上面回执里的数字是给程序记的账。正文里请按开头那份数值约束把它们换成程度词'
    + '（「气血几乎被打空」「法力去了小半」），不要抄「气血 X/Y」「伤害 X 点」这类账目。',
  );
  const user = head.join('\n');

  return [
    { role: 'system', content: buildAfterBattleProtocolText(save, settings) },
    { role: 'user', content: user },
    // 末尾两条与「自动下回合」的顺序、口径完全一致（篇幅 → 视点），服从度最高。
    // 篇幅：给「区间」模型会贴下限写，故锚定区间上半段并给出明确目标字数。
    {
      role: 'system',
      content: battleWordQuotaText(quota),
    },
    { role: 'system', content: PLAYER_POV_CONTRACT },
  ];
}

