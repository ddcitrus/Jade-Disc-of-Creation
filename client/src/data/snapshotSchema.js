// ===== 角色快照 Schema 与校验器 =====
// 该模块定义角色快照的字段结构、提供校验函数、空快照构造器与可读文本视图。

import { computeAttrs, rootDisplayName, rootRateFromText, ROOT_CULTIVATE_RATE, TRAIT_RARITIES, resolveTraitMods, personalityBrief } from './gameData.js';
import { GRADE_CANDIDATES, normalizeGrade, parseAttrText, attrTextFromMods } from './gradeUtils.js';
import { buildSkill } from './skillCodex.js';

// 造化阁开局技能只给「基础 / 入门 / 进阶」三档 → 映射到 1~36 品（各差两档），再由 skillCodex 算系数
// 开局技能的三档（基础/入门/进阶）→ 品阶。品阶决定该技能最高能到哪一档：1~9 品最高基础、
// 10~18 品最高精妙。故「进阶」技能映射到十二品，开局就能拿到 ×1.4 的精妙档，与「基础」拉开差别。
const TIER_TO_GRADE = { 基础: '一品', 入门: '三品', 进阶: '十二品' };
// 快照 v2 视图：注入给 AI 的「当前状态」统一用扁平中文键（与演化阶段让 AI 写的口径一致）
import { legacyToV2, v2SnapshotText, CRIT_DEFAULT } from './snapshotV2.js';
import { SPEED_MOD_KEYS } from './cultivationParams.js';

// ---------- 装备槽位工具 ----------
// 装备结构有两种形态：
//   形态一：equipment.weapon / armor / accessory 为字符串
//   形态二（concurrent 预设）：weapon={right,left}，armor={head,inner,armor,hands,legs,feet,cloak}，
//     accessory/treasure/technique 为槽位数组
// 该工具把任意槽位值安全转为可展示文本，避免把对象直接渲染进 React 导致崩溃。
// 槽位中文名。内衣格不存在（老数据里的 underwear/body 归入「内衬」「甲身」显示），
// 与快照 v2 的槽位清单一致：右手 左手 头部 内衬 甲身 手部 腿部 足部 披风。
export const EQUIP_SLOT_LABELS = {
  right: '右手', left: '左手',
  head: '头部', inner: '内衬', armor: '甲身', hands: '手部', legs: '腿部', feet: '足部', cloak: '披风',
  underwear: '内衬', body: '甲身',
};

// 坐标统一入口：AI 可能写成 [x,y]、"12,45"、{x,y}，界面按数字数组渲染（直接 .join 会崩）。
// 解析不出来返回 fallback（默认 null = 视为没有坐标）。
export function toCoords(v, fallback = null) {
  if (Array.isArray(v)) {
    const [a, b] = v;
    return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? [Number(a), Number(b)] : fallback;
  }
  if (v && typeof v === 'object') return toCoords([v.x ?? v.X, v.y ?? v.Y], fallback);
  const m = String(v ?? '').trim().match(/^(-?\d+)\s*[,\s]\s*(-?\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : fallback;
}

export function slotValueText(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    return v.map(x => slotValueText(x)).filter(Boolean).join('、');
  }
  if (typeof v === 'object') {
    // 已装备的物品对象（含 name 字段）直接显示名称
    if (typeof v.name === 'string' && v.name) return v.name;
    return Object.entries(v)
      .filter(([, val]) => val != null && val !== '')
      .map(([k, val]) => `${EQUIP_SLOT_LABELS[k] || k}:${slotValueText(val)}`)
      .join('、');
  }
  return String(v);
}

// ---------- 新版装备槽位结构（concurrent 预设兼容） ----------
// 装备槽位口径统一为 9 个具名格 + 3 个数组格：
//   weapon.right/left → 右手/左手
//   armor.head/inner/armor/hands/legs/feet/cloak → 头部/内衬/甲身/手部/腿部/足部/披风
//   accessory / treasure / technique → 饰品/法宝/功法（各 6 格）
export function newEquipmentSlots() {
  return {
    weapon: { right: null, left: null },
    armor: { head: null, inner: null, armor: null, hands: null, legs: null, feet: null, cloak: null },
    accessory: [null, null, null, null, null, null],
    treasure: [null, null, null, null, null, null],
    technique: [null, null, null, null, null, null],
  };
}

// 物品对象的「字段名」——它们**永远不可能是槽位名**。
// 脏数据里（AI 把整件物品写在了分组位置上，又被 normalizeItemShape 逐字段补成假物品）
// 这些键会各装着一件「由字段值拼出来的假物品」；不认出它们，界面就会凭空多出 6 件幽灵防具
// （实测：头部/内衬/手部/腿部/足部/披风全被填成名字叫「装备」「防具」「一品」的东西）。
const ITEM_FIELD_KEYS = new Set([
  'name', 'type', 'subtype', 'grade', 'appearance', 'desc', 'mods', 'quantity',
  'id', 'definitionId', 'lots', 'source', 'count', 'currentEffect', 'srcKey', 'definition',
]);

// 脏数据救援：从「每个字段各装着一件物品」的坏槽位里，捞出那件真正有名字的物品。
// 只在槽位值自己没有字符串 name 时才走这里（即数据已经坏了），正常数据永远不会命中。
function pickInnerItem(o) {
  for (const key of ['name', 'armor', 'body', ...Object.keys(o)]) {
    const x = o[key];
    if (x && typeof x === 'object' && !Array.isArray(x) && typeof x.name === 'string' && x.name) return x;
  }
  return null;
}

// 把任意形态的装备结构归一成上面这一套（界面显示与写入前都先过一遍）：
// - 整串字符串（"朴刀"）→ 兵器归右手、防具归甲身、饰品归第一格
// - 槽位值是字符串 → 包成 { name } 对象（界面只有对象/数组才是可点击的卡片）
// - 老键归并：underwear → 内衬、body → 甲身；其它未知键塞进空槽
//   —— 这条是「数据在、界面没了」的根治点：未知键不再被丢弃
//   ⚠ 但**物品字段名**那几个键例外（见 ITEM_FIELD_KEYS）：它们是坏数据，塞进槽位只会造幽灵装备
export function normalizeEquipment(eq) {
  const src = eq && typeof eq === 'object' && !Array.isArray(eq) ? eq : {};
  const toItem = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'string' || typeof v === 'number') return { name: String(v) };
    if (typeof v === 'object' && !Array.isArray(v)) {
      // ⚠ name 必须是**字符串**才算数：坏数据里 name 位置会被写成整件物品，
      //   直接 String() 会得到 "[object Object]" 当物品名（2026-09-26 崩因之一）。
      if (typeof v.name === 'string' && v.name) return { ...v, name: v.name };
      const inner = pickInnerItem(v);
      return inner ? { ...inner } : null;
    }
    if (Array.isArray(v)) {
      const nm = slotValueText(v);
      return nm ? { name: nm } : null;
    }
    return null;
  };
  const w = src.weapon;
  const weapon = {
    right: toItem(w && typeof w === 'object' && !Array.isArray(w) ? w.right : w),
    left: toItem(w && typeof w === 'object' && !Array.isArray(w) ? w.left : null),
  };
  const CANON = ['head', 'inner', 'armor', 'hands', 'legs', 'feet', 'cloak'];
  const armor = { head: null, inner: null, armor: null, hands: null, legs: null, feet: null, cloak: null };
  const a = src.armor;
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    for (const k of CANON) armor[k] = toItem(a[k]);
    const extra = { ...a };
    for (const k of CANON) delete extra[k];
    for (const [k, v] of Object.entries(extra)) {
      if (ITEM_FIELD_KEYS.has(k)) continue;   // 坏数据：字段名不是槽位名，别当装备显示
      const it = toItem(v);
      if (!it) continue;
      if (k === 'underwear') armor.inner = armor.inner || it;
      else if (k === 'body') armor.armor = armor.armor || it;
      else {
        const slot = CANON.find(s => !armor[s]);
        if (slot) armor[slot] = it;
      }
    }
  } else {
    armor.armor = toItem(a);
  }
  const out = { ...src, weapon, armor };
  for (const g of ['accessory', 'treasure', 'technique']) {
    const raw = src[g];
    const arr = Array.isArray(raw) ? raw : (raw == null || raw === '' ? [] : [raw]);
    out[g] = Array.from({ length: 6 }, (_, i) => toItem(arr[i]));
  }
  return out;
}

// 统一读取/写入装备槽（兼容旧字符串结构与新版槽位结构）
// group: 'weapon' | 'armor' | 'accessory' | 'treasure' | 'technique'
export function getEquipSlot(eq, group, key) {
  const g = eq?.[group];
  if (g == null) return null;
  if (Array.isArray(g)) return g[key] ?? null;
  if (typeof g === 'object') return g[key] ?? null;
  return g || null; // 旧字符串结构（只有 weapon/armor/accessory 顶格值）
}
export function setEquipSlot(eq, group, key, value) {
  const g = eq?.[group];
  if (Array.isArray(g)) { const a = [...g]; a[key] = value; return { ...eq, [group]: a }; }
  if (g && typeof g === 'object') return { ...eq, [group]: { ...g, [key]: value } };
  return { ...eq, [group]: value }; // 旧字符串结构退化处理
}

// ---------- 「已装备」判定（储物袋条目 ↔ 装备槽的对应关系） ----------
// 储物袋的数量口径 = 该角色**拥有**的件数，穿在身上的那件也算在里面；
// 装备槽只表示「这几件里，哪一件穿在身上」。所以同一件物品在储物袋与装备栏各露一次面
// 是**正常且被要求的**（AI 演化提示词也这么规定），不是重复条目。
// 储物袋列表据此标注「已装备」，玩家一眼就能看出两处是同一样东西。
// 返回 Map<物品名, Set<槽位中文名>>；兼容旧字符串结构与未知键。
export function equippedSlotMap(eq) {
  const out = new Map();
  const norm = normalizeEquipment(eq);
  const add = (v, label) => {
    if (v == null || v === '') return;
    const nm = typeof v === 'string' || typeof v === 'number' ? String(v) : (v.name || slotValueText(v));
    if (!nm) return;
    if (!out.has(nm)) out.set(nm, new Set());
    out.get(nm).add(label);
  };
  for (const [k, v] of Object.entries(norm.weapon || {})) add(v, EQUIP_SLOT_LABELS[k] || '兵器');
  for (const [k, v] of Object.entries(norm.armor || {})) add(v, EQUIP_SLOT_LABELS[k] || '甲身');
  const ARR_GROUPS = [['accessory', '饰品'], ['treasure', '法宝'], ['technique', '功法']];
  for (const [g, lb] of ARR_GROUPS) {
    const arr = norm[g];
    if (Array.isArray(arr)) arr.forEach((v, i) => add(v, `${lb}${i + 1}`));
  }
  return out;
}

// 取某物品被穿在哪些槽位（返回槽位中文名数组，空数组 = 没穿在身上）
export function equippedSlotsOf(slotMap, name) {
  const s = slotMap instanceof Map ? slotMap.get(String(name || '')) : null;
  return s ? [...s] : [];
}

/**
 * 储物袋是「拥有清单」：穿上 / 脱下装备都**不改数量**，只保证清单里有这条目。
 * - 已有同名条目 → 仅在它缺字段时用装备槽的信息补齐（已有值以储物袋为准，它是权威档案）
 * - 没有同名条目 → 补登一条（老存档 / AI 只写了装备槽而没登记储物袋的情况）
 * 返回新的 inventory 数组，不修改入参。
 */
export function ensureInvEntry(inventory, info = {}) {
  const list = Array.isArray(inventory) ? [...inventory] : [];
  const nm = String(info.name || '').trim();
  if (!nm) return list;
  const i = list.findIndex(x => invItemName(x) === nm);
  if (i < 0) {
    const now = Date.now();
    list.push({
      id: nm, definitionId: nm, name: nm, quantity: 1,
      type: info.type || '装备', subtype: info.subtype || '', grade: info.grade || '',
      appearance: info.appearance || '', desc: info.desc || '', mods: info.mods || null,
      lots: [{ id: `${nm}:lot:${now}`, quantity: 1, source: info.source || '装备补登', acquiredAt: now }],
    });
    return list;
  }
  const cur = list[i];
  const obj = cur && typeof cur === 'object' && !Array.isArray(cur)
    ? { ...cur }
    : { id: nm, definitionId: nm, name: nm, quantity: 1, type: '装备', subtype: '', grade: '', appearance: '', desc: '', mods: null };
  for (const k of ['type', 'subtype', 'grade', 'appearance', 'desc']) {
    if (!obj[k] && info[k]) obj[k] = info[k];
  }
  if (!obj.mods && info.mods) obj.mods = info.mods;
  if (!invItemQty(obj)) obj.quantity = 1;
  list[i] = obj;
  return list;
}

// 收集已装备物品的属性加成合计（装备对象可带 mods: {物攻: 5, ...}）
export function collectEquipMods(eq) {
  const mods = {};
  const add = (v) => {
    if (v && typeof v === 'object' && v.mods && typeof v.mods === 'object') {
      for (const [k, x] of Object.entries(v.mods)) {
        const n = Number(x); if (Number.isFinite(n)) mods[k] = (mods[k] || 0) + n;
      }
    }
  };
  const eqAny = eq || {};
  const weapon = eqAny.weapon;
  if (Array.isArray(weapon)) weapon.forEach(add);
  else if (weapon && typeof weapon === 'object') Object.values(weapon).forEach(add);
  else add(weapon);
  const armor = eqAny.armor;
  if (Array.isArray(armor)) armor.forEach(add);
  else if (armor && typeof armor === 'object') Object.values(armor).forEach(add);
  else add(armor);
  for (const g of ['accessory', 'treasure', 'technique']) {
    const arr = eqAny[g];
    if (Array.isArray(arr)) arr.forEach(add);
  }
  if (eqAny.techniques && typeof eqAny.techniques === 'object') Object.values(eqAny.techniques).forEach(add);
  return mods;
}

// ---------- 储物袋物品通用工具 ----------
// 储物袋物品在实际数据中有 4 种形态（读写均需兼容）：
//   A. 纯字符串（AI 精简输出）：'回气丹'
//   B. 模板对象（本项目模板直生成 / 换装回袋）：{ id, definitionId, name, quantity, type, desc, mods }
//   C. Mortal 协议实例对象（concurrent 演化 / 快照实例）：
//      { id:'I_xxx', definitionId:'D_xxx', quantity, lots:[{id,quantity,source,acquiredAt}], legacy?, currentEffect? }
//   D. AI 自由变体：{ name, count, ... } 字段名/完整度不固定
// 物品类型候选（大类）：装备的细分（武器/防具/饰品等）写在 subtype 子类字段
export const INV_ITEM_TYPES = ['消耗品', '珍贵物品', '素材', '杂物', '装备', '法宝', '功法'];
// 装备子类候选（槽位兼容匹配优先读子类）
export const INV_SUBTYPE_CANDIDATES = ['武器', '兵器', '剑', '刀', '枪', '棍', '防具', '衣物', '护甲', '内甲', '袍', '饰品', '配饰', '环', '佩', '链'];
// 品阶候选（datalist，可自由输入）
// 品阶候选：统一 1~36 品（老词「下品/上品」在读取时按 gradeUtils.LEGACY_GRADE_MAP 换算）
export const INV_GRADE_CANDIDATES = GRADE_CANDIDATES;

export function invItemName(it) {
  if (it == null) return '';
  if (typeof it === 'string') return it;
  return String(it.name || it.id || it.definitionId || slotValueText(it) || '');
}
export function invItemQty(it) {
  if (it == null || typeof it === 'string') return 1;
  return Math.max(1, Math.floor(Number(it.quantity ?? it.count ?? 1) || 1));
}
export function invItemSubtype(it) {
  return it && typeof it === 'object' ? String(it.subtype || '') : '';
}
export function invItemGrade(it) {
  return it && typeof it === 'object' ? String(it.grade || '') : '';
}
export function invItemModsText(mods) {
  if (!mods || typeof mods !== 'object') return '';
  return attrTextFromMods(mods);
}
// mods → 带正负号的词条文本（如「神识 -1，物防 +2」），特质/物品通用
export function modsToText(mods) {
  if (!mods || typeof mods !== 'object') return '';
  return Object.entries(mods)
    .map(([k, v]) => `${k} ${Number(v) > 0 ? '+' : ''}${v}`)
    .join('，');
}
// 槽位兼容匹配：类型/子类/名称任一命中关键词即视为可装备到该槽
export function invItemMatchesSlot(it, keys) {
  if (!Array.isArray(keys) || !keys.length) return false;
  const o = it && typeof it === 'object' ? it : {};
  const hay = `${o.type || ''}/${o.subtype || ''}/${invItemName(it)}`;
  return keys.some(k => hay.includes(k));
}
// '物攻+9000，法防+100' → { 物攻:9000, 法防:100 }
// 统一走 gradeUtils.parseAttrText：同时兼容 物攻+9000 / 物攻=9000 / 物攻:100 / 物攻-20
export function parseModsText(text) {
  return parseAttrText(text);
}
// 构造通用储物袋物品（B+C 混合形态：人可读字段 name/type/subtype/grade/appearance/desc/mods + Mortal 追溯 lot）
export function makeInvItem({ name, quantity = 1, type = '杂物', subtype = '', appearance = '', desc = '', grade = '', mods = null }) {
  const qty = Math.max(1, Math.floor(Number(quantity) || 1));
  const now = Date.now();
  return {
    id: name,
    definitionId: name,
    name,
    quantity: qty,
    type: type || '杂物',
    subtype: subtype || '',
    appearance: appearance || '',
    desc: desc || '',
    grade: grade || '',
    mods: mods && Object.keys(mods).length ? mods : null,
    lots: [{ id: `${name}:lot:${now}`, quantity: qty, source: '手动添加', acquiredAt: now }],
  };
}
// 任意形态物品 → 可编辑对象（字符串/残缺对象补全；spread 保留 C 型的 lots/currentEffect/legacy 等全部原字段）
export function normalizeInvItem(it) {
  if (it && typeof it === 'object' && !Array.isArray(it)) {
    return {
      ...it,
      id: it.id || it.name || '',
      definitionId: it.definitionId || it.id || it.name || '',
      name: it.name || it.id || it.definitionId || '',
      quantity: invItemQty(it),
      type: it.type || '杂物',
      subtype: it.subtype || '',
      appearance: it.appearance || '',
      desc: it.desc || '',
      grade: normalizeGrade(it.grade) || it.grade || '',
      mods: it.mods && typeof it.mods === 'object' ? it.mods : null,
    };
  }
  const name = typeof it === 'string' ? it : '';
  return { id: name, definitionId: name, name, quantity: 1, type: '杂物', subtype: '', appearance: '', desc: '', grade: '', mods: null };
}


// 属性展示行（供属性栏数字 + 加成显示，替代横条）
export const ATTR_LABELS = {
  hp: '血量', mp: '法力', physAtk: '物攻', physDef: '物防', magAtk: '法攻', magDef: '法防',
  physPen: '物理穿透', magPen: '法术穿透', speed: '脚力', spirit: '神识', luck: '气运', charm: '魅力',
  // 2026-09-18 新增「会心」：暴击的底子，单位是百分点（5 = 5%）。
  // 不随境界涨、不进境界基准表，只由**装备**与**特质**加成（武器/饰品/法宝上的「会心+8」、词条上的「会心+5」）。
  crit: '会心',
};

// 「会心」缺省值（百分点）的唯一出处是 snapshotV2.js（属性扁平键那一层）；
// 这里转出，供建局（battleTrigger）与探针引用。必须与 battleEngine.js 的 TUNING.CRIT_DEFAULT 同值。
export { CRIT_DEFAULT };

// 中文属性键（出身 / 种族 / 特质 / 加点 的 mods 用中文书写） → 快照 stats 键
export const ATTR_ZH_TO_STAT = {
  '气血上限': 'hp', '法力上限': 'mp',
  '物攻': 'physAtk', '物防': 'physDef', '法攻': 'magAtk', '法防': 'magDef',
  '物理穿透': 'physPen', '法术穿透': 'magPen',
  '神识': 'spirit', '脚力': 'speed', '气运': 'luck', '魅力': 'charm',
  '会心': 'crit',
};

// 中文 mods 表 → stats 键加成表（'法力上限'+10、'脚力'-1 → { mp:10, speed:-1 }）
export function modsToStatBonus(mods) {
  const out = {};
  if (!mods || typeof mods !== 'object') return out;
  for (const [k, v] of Object.entries(mods)) {
    const n = Number(v);
    if (!Number.isFinite(n) || !n) continue;
    const key = ATTR_LABELS[k] ? k : ATTR_ZH_TO_STAT[k];
    if (!key) continue;
    out[key] = (out[key] || 0) + n;
  }
  return out;
}

/**
 * 该角色的**特质加成合计**（键为**中文属性名**），与装备加成同一待遇：
 *   由系统按特质栏实时计算、叠加进「生效」值 —— AI 不要写进自身，也不要重复叠加。
 * 权威来源：主角档案 traits + 快照 traits（同名只计一次）；
 *   特质库内有名字的以库为准，库里没有的采信 AI 自写的 mods /「加成」（resolveTraitMods 统一裁决）。
 * 用途：① 属性栏与注入文本的「特质」段；② 特质项的 mods 校核。
 * 注意：出身 / 种族 / 加点属于角色「自身」（由 computeAttrs 算进裸值），不在这里。
 */
export function characterAttrMods(save, snap, charId) {
  const mods = {};
  const push = (m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    for (const [k, v] of Object.entries(m)) {
      const n = Number(v);
      if (Number.isFinite(n) && n) mods[k] = (mods[k] || 0) + n;
    }
  };
  const isPlayer = charId === 'B1' || snap?.kind === 'player';
  const c = save?.character;
  const seen = new Set();
  if (isPlayer && c) {
    for (const t of (Array.isArray(c.traits) ? c.traits : [])) {
      const name = typeof t === 'string' ? t : t?.name;
      if (name) seen.add(name);
      push(resolveTraitMods(t));
    }
  }
  for (const t of (Array.isArray(snap?.traits) ? snap.traits : [])) {
    const name = typeof t === 'string' ? t : t?.name;
    if (name && seen.has(name)) continue;
    if (name) seen.add(name);
    push(resolveTraitMods(t));
  }
  return mods;
}

/**
 * 数值校界要「上移合法区间」的加成（中文属性名）—— 只含**仍留在自身里的那部分**：
 *   出身 + 种族 + 加点（主角有，NPC 没有）。
 * 特质与装备都在自身之外实时叠加，所以区间不为它们上移
 * （见 attrClamp.js 的 clampSnapshotStats：lo/hi = 表基准 + 本函数的加成）。
 * 与 characterAttrMods 同源于角色档案，避免「界面一个数、校界另一个数」的口径漂移。
 */
export function characterClampBonus(save, snap, charId) {
  const mods = {};
  const push = (m) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    for (const [k, v] of Object.entries(m)) {
      const n = Number(v);
      if (Number.isFinite(n) && n) mods[k] = (mods[k] || 0) + n;
    }
  };
  const isPlayer = charId === 'B1' || snap?.kind === 'player';
  const c = save?.character;
  if (isPlayer && c) {
    push(c.origin?.mods);
    push(c.race?.mods);
    push(c.alloc);
  }
  return mods;
}

/**
 * 把快照 traits 里的**词条加成（mods）按特质库重算**并写回（程序权威）。
 * 合并完 AI 演化结果后调用一次即可：此后快照自带正确词条，
 * 属性栏 / 数值校界 / 提示词注入读到的都是程序算出来的值，AI 写什么都不影响。
 * @returns {object} 同一份快照（mods 已就地修正）
 */
export function syncTraitMods(snap) {
  if (!snap || typeof snap !== 'object' || !Array.isArray(snap.traits)) return snap;
  let changed = false;
  snap.traits = snap.traits.map(t => {
    if (t == null) return t;
    const name = typeof t === 'string' ? t : t.name;
    if (!name) return t;
    // 「加成」文本是权威原始来源（AI / 玩家写在词条上的那一份），已有的 mods 只是上一次同步的缓存。
    // 必须把缓存清掉再算，否则解析会把「文本 + 缓存」相加 → 每落档一次加成数字翻一倍（历史 bug）。
    const raw = typeof t === 'string' ? { name } : { ...t };
    const txt = raw['加成'] ?? raw.加成 ?? raw.modsText;
    if (txt != null && String(txt).trim() !== '') delete raw.mods;
    const mods = resolveTraitMods(raw);
    const next = typeof t === 'string' ? { name } : { ...t };
    if (JSON.stringify(next.mods ?? null) !== JSON.stringify(mods ?? null)) { next.mods = mods; changed = true; }
    return next;
  });
  snap.traitModsSynced = changed ? true : snap.traitModsSynced;
  return snap;
}


/**
 * 气血 / 法力这类「池」的**当前值**怎么算 —— 全项目唯一口径，别在别处另算一遍。
 *
 * 加值（特质 ＋ 装备）**同时抬当前值与上限**：装备写「气血 +50」＝ 多出 50 点实血，不是 50 个空槽。
 * 所以自身 60 / 100 带 +50 就是 **110 / 150**（而不是「60 / 150，回血无效」）。
 *   例：新建角色自身法力 0 / 0（凡人本来没有法力池）＋ 特质「法力上限 +100」⇒ 100 / 100。
 * 负加值（诅咒类）两头一起减。
 *
 * ⚠️ 自身存量（cur）**允许为负**，这不是脏数据：加值给的那部分血被打掉时，只能记在「自身」这一格
 *    （加值本身是实时算出来的、不落盘）。例：自身 0 / 0 ＋ 装备 +50 ⇒ 生效 50 / 50，挨 40 点伤后
 *    记成自身 −40、加成 50 ⇒ 显示 10 / 50。**显示端一律钳到 [0, 上限]**，界面、注入文本、战斗取数
 *    都看不到负数；加值一旦消失（脱下装备），负数自动被钳回 0。
 */
export function poolCurrent(cur, max, total) {
  const c = Number(cur) || 0;                   // 自身存量：可为负，见上文
  const m = Math.max(0, Number(max) || 0);
  const t = Number(total) || 0;
  // 上限先落地：负加值不许把池子压到 0 以下，当前值也不许浮在容量之上
  const top = Math.max(0, m + t);
  return Math.max(0, Math.min(c + t, top));
}

/**
 * 属性行。三段口径：自身 ＋ 特质 ＋ 装备 ＝ 生效。
 * 语义：stats 是「人物自身数值」（已含出身/种族/加点的效果，**不含特质、不含装备**），
 *   · bonus      = 装备加成（由系统按随身装备实时算，见 collectEquipMods）
 *   · traitBonus = 特质加成（由系统按特质栏实时算，与装备同一待遇）
 *   · total      = 两段加成合计
 *   · effCurrent / effMax = **生效值**（界面显示、注入文本、战斗取数一律用这两个，别再自己加）：
 *       非池属性 = current + total；气血 / 法力见 poolCurrent（加值同时抬当前值与上限）
 * @param {object} snap 角色快照
 * @param {object} [traitMods] 该角色的特质加成（中文属性名或 stats 键均可）
 */
export function attrRows(snap, traitMods = null) {
  const stats = snap?.stats || {};
  const equip = {};   // stats 键 → 装备加成
  const trait = {};   // stats 键 → 特质加成
  const extra = {};   // 不属于十二项基础属性的键（修炼速度、异常抵抗…）

  const bucket = (m, target) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return;
    for (const [k, v] of Object.entries(m)) {
      const n = Number(v);
      if (!Number.isFinite(n) || !n) continue;
      const key = ATTR_LABELS[k] ? k : ATTR_ZH_TO_STAT[k];
      if (!key) { extra[k] = (extra[k] || 0) + n; continue; }
      target[key] = (target[key] || 0) + n;
    }
  };
  bucket(collectEquipMods(snap?.equipment), equip);
  bucket(traitMods, trait);

  const rows = [];
  for (const [k, label] of Object.entries(ATTR_LABELS)) {
    // 会心：老存档里没有这一栏时也要显示默认底子，否则玩家在角色卡上看不到自己的暴击底子
    const s = stats[k] ?? (k === 'crit' ? { current: CRIT_DEFAULT, max: CRIT_DEFAULT } : undefined);
    const bonus = equip[k] || 0;
    const traitBonus = trait[k] || 0;
    if (!s && !bonus && !traitBonus) continue;
    const current = s?.current ?? s?.max ?? 0;
    const max = s?.max ?? s?.current ?? 0;
    const total = bonus + traitBonus;
    const isPool = k === 'hp' || k === 'mp';
    rows.push({
      key: k, label, current, max, bonus, traitBonus, total, isPool,
      effCurrent: isPool ? poolCurrent(current, max, total) : current + total,
      effMax: isPool ? Math.max(0, max + total) : max + total,
    });
  }
  for (const [label, v] of Object.entries(extra)) {
    if (!v) continue;
    // ⚠ effCurrent / effMax 必须一起给：界面两个渲染端都只读 effCurrent，
    //   少了它这一行会只剩标签、值位置一片空白（2026-09-27 用户报「修炼速度没有值」）。
    rows.push({ key: 'x_' + label, label, current: v, max: v, bonus: 0, traitBonus: 0, total: 0, effCurrent: v, effMax: v, isPool: false, extraOnly: true });
  }
  return rows;
}

/**
 * 属性行在**界面**上的显示文案（角色属性页与主界面右栏共用同一口径）。
 * 返回 null ⇒ 这一行在界面不出现。
 * 只有装备的「修炼速度／修炼加速」词条是这种情况：它按**加速点**记账（每 100 点 = 装备倍率 +1），
 * 换算出来只是修炼倍率里「装备那一段」，单独摆出来会跟旁边那行真正的修炼倍率
 * （灵根 × 装备，由 CultRateRow 出）打架 —— 同一栏里 ×13 与 ×19.5 两个数，玩家自然以为算错了。
 * 2026-09-27 用户要求「直接写修炼倍率 ×19.5」，故这行不再单独出现。
 * ⚠ 只改界面：注入给 AI 的文本仍带这行原始点数（snapshotV2 的「其他加成：修炼速度+1200」），
 *    AI 需要知道装备给了多少加速，所以 attrRows 里这行照旧产出，只是不往界面上画。
 */
export function attrRowView(row) {
  if (row?.extraOnly && SPEED_MOD_KEYS.includes(row?.label ?? '')) return null;
  return {
    label: row?.label ?? '',
    text: row?.isPool ? `${row.effCurrent} / ${row.effMax}` : String(row?.effCurrent ?? ''),
  };
}

/**
 * 属性行加值的悬停说明（界面文案唯一来源）。
 * 与注入给 AI 的「自身＋特质＋装备＝生效」三段口径一致：讲清生效值由哪三段相加而来。
 */
export function attrBonusHint(row) {
  if (!row) return '';
  const self = Number(row.current) || 0;
  const max = Number(row.max) || 0;
  const bonus = Number(row.bonus) || 0;
  const trait = Number(row.traitBonus) || 0;
  const selfText = row.isPool ? `${self} / ${max}` : `${self}`;
  const sgn = (n) => `${n > 0 ? '+' : ''}${n}`;
  if (!bonus && !trait) return `自身 ${selfText}，当前无特质与装备加成`;
  const cur = row.effCurrent ?? (row.isPool ? self : self + trait + bonus);
  const top = row.effMax ?? max + trait + bonus;
  const eff = row.isPool ? `${cur} / ${top}` : String(cur);
  // 加值同时抬当前值与上限（见 poolCurrent），所以不再需要解释「当前值为什么没涨」。
  // 唯一要补一句的是自身为负：那是「加值给的血被先打掉」的记账，否则看着像算错了。
  const why = row.isPool && self < 0 ? '（自身的负数表示加值那部分血已先被打掉）' : '';
  return `自身 ${selfText} ＋ 特质 ${sgn(trait)} ＋ 装备 ${sgn(bonus)} ＝ ${eff}${why}`;
}

// ---------- 必填字段表（缺失即视为格式不合规） ----------
// 每个 key 形如 'identity.name'：表示 identity.name 必须存在且类型合规。
export const SNAPSHOT_REQUIRED = {
  id: { type: 'string', desc: '角色 ID（B1/C1/C2…）' },
  kind: { type: 'enum', values: ['player', 'npc'], desc: '角色类型（只有主角与 NPC 两种；妖兽、敌人、傀儡等一律算 npc）' },
  identity: {
    _type: 'object',
    name: { type: 'string', desc: '姓名' },
    gender: { type: 'string', desc: '性别' },
    realm: { type: 'string', desc: '当前境界（如 筑基初期）' },
  },
  stats: {
    _type: 'object',
    hp: { _type: 'object', current: { type: 'number' }, max: { type: 'number' } },
    mp: { _type: 'object', current: { type: 'number' }, max: { type: 'number' } },
  },
  status: {
    _type: 'object',
    current: { type: 'string', desc: '当前状态（如 一切正常）' },
  },
  action: {
    _type: 'object',
    action: { type: 'string', desc: '当前动作描述' },
    location: { type: 'string', desc: '当前地点' },
  },
};

// ---------- 推荐字段表（缺失只警告，不阻断） ----------
export const SNAPSHOT_RECOMMENDED = [
  'identity.age', 'identity.shouyuan', 'identity.linggen',
  'stats.physAtk', 'stats.physDef', 'stats.magAtk', 'stats.magDef',
  'stats.speed', 'stats.spirit', 'stats.luck', 'stats.charm', 'stats.crit',
  'status.buffs', 'action.attire', 'action.appearance',
  'bio.background', 'bio.rawRelations',
  'economy.spiritStones', 'equipment', 'inventory', 'skills', 'traits',
  'cultivationArts',
];

// ---------- 类型校验工具 ----------
function typeOk(v, t) {
  if (t === 'string') return typeof v === 'string';
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v && typeof v === 'object' && !Array.isArray(v);
  if (t === 'enum') return true; // 由 values 校验
  return true;
}

function getVal(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ---------- 校验单条字段规则 ----------
function checkRule(obj, path, rule, errors, prefix = '') {
  const v = getVal(obj, path);
  const full = prefix || path;
  if (v === undefined || v === null) {
    errors.push({ path: full, code: 'missing', msg: `缺少必填字段 ${full}（${rule.desc || ''}）` });
    return;
  }
  if (rule.type && !typeOk(v, rule.type)) {
    errors.push({ path: full, code: 'type', msg: `${full} 类型不符，期望 ${rule.type}` });
    return;
  }
  if (rule.type === 'enum' && rule.values && !rule.values.includes(v)) {
    errors.push({ path: full, code: 'enum', msg: `${full} 取值非法：${v}，应为 ${rule.values.join('/')}` });
  }
}

// 递归遍历规则树
function walkRules(rules, obj, errors, prefix = '') {
  for (const [k, rule] of Object.entries(rules)) {
    if (k === '_type') continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (rule._type === 'object' || rule._type === 'enum') {
      // 嵌套对象
      if (rule._type === 'object') {
        const sub = getVal(obj, path);
        if (sub === undefined || sub === null) {
          errors.push({ path, code: 'missing', msg: `缺少必填字段 ${path}` });
        } else if (typeof sub !== 'object' || Array.isArray(sub)) {
          errors.push({ path, code: 'type', msg: `${path} 应为对象` });
        } else {
          walkRules(rule, obj, errors, path);
        }
      } else {
        checkRule(obj, path, rule, errors);
      }
    } else {
      checkRule(obj, path, rule, errors);
    }
  }
}

// ---------- 校验单个角色快照 ----------
export function validateSnapshot(snap) {
  const errors = [];
  const warnings = [];
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    return { ok: false, errors: [{ path: '$root', code: 'type', msg: '快照根必须是对象' }], warnings };
  }
  walkRules(SNAPSHOT_REQUIRED, snap, errors);
  // 推荐字段警告
  for (const path of SNAPSHOT_RECOMMENDED) {
    const v = getVal(snap, path);
    if (v === undefined || v === null) warnings.push({ path, code: 'recommended-missing', msg: `推荐字段缺失：${path}` });
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ---------- 构造空快照（字段与「快照实例.txt」一致） ----------
// 2026-09-24 清掉一批「零读零写 / 只读不写」的字段（全项目实证：没有生产者，或唯一读取者本身也死）：
//   lifespanRoll.zScore / rollCount、identity.aliasName / disguiseRealm /
//   appellation、linggenBreakthroughAptitude、action.appearanceDetails、social（整块）、
//   economy.spiritStoneBreakdown（整块）、techniqueMasteries（整块）、spiritBeasts（整块）、
//   adult（整块）、factionAffiliation（整块）、factionLoadout（整块）、customColumnValues。
// 要加回来之前请先确认存在真实写入路径，别只加一行声明。
export function makeEmptySnapshot(id, kind = 'npc', partial = {}) {
  const base = {
    id,
    kind,
    // 寿元掷点（参照快照实例）
    lifespanRoll: {
      majorRealm: '凡人',
      baseShouyuan: 80,
    },
    identity: {
      name: partial.name || id,
      gender: '男',
      realm: '凡人',
      realmProgress: 0,
      isYaozu: false,
      identityRoles: [],
      personality: '',
      linggen: '',
      linggenCultivationSpeedMultiplier: 1,
      // 自身修炼倍率 = 灵根倍率 × 装备倍率（不含当地灵气、世界因子、运气）。
      // 程序权威、每次落盘重算（syncCultivationRates），别手改 —— 会被覆盖。
      cultivationRate: 1,
      specialConstitution: '',
      birthYear: 0,
      age: 0,
      shouyuan: 80,
      extraShouyuan: 0,
      appearanceAge: 0,
      youthRetentionReason: '',
    },
    stats: {
      hp: { current: 100, max: 100 },
      mp: { current: 0, max: 0 },
      physAtk: { current: 10, max: 10 },
      physDef: { current: 10, max: 10 },
      magAtk: { current: 10, max: 10 },
      magDef: { current: 10, max: 10 },
      physPen: { current: 0, max: 0 },
      magPen: { current: 0, max: 0 },
      speed: { current: 10, max: 10 },
      spirit: { current: 10, max: 10 },
      luck: { current: 5, max: 5 },
      charm: { current: 5, max: 5 },
      crit: { current: CRIT_DEFAULT, max: CRIT_DEFAULT },   // 会心：暴击底子（百分点），装备与特质在其上叠加，不随境界涨
      extra: {},
    },
    resources: { hp: { current: 100 }, mp: { current: 0 } },
    status: { current: '一切正常', buffs: [] },
    action: {
      action: '',
      attire: '',
      location: '',
      coordinates: [0, 0],
      figure: '',
      appearance: '',
    },
    bio: {
      background: '',
      lifeStory: '',
      innerThought: '',
      rawRelations: [],
      currentMotive: '',
      shortTermGoal: '',
      longTermGoal: '',
      // 承诺三槽位（2026-09-28）：NPC 许下或接下的诺言，空槽留空。
      // 每格是一行文本，三段用全角竖线分隔：要做什么｜欠了谁｜什么时候到期
      // （读写口径见 snapshotV2 的 parsePromise / normalizePromiseText / promiseSummaryText）。
      // ⚠ 只给 NPC —— 主角的承诺由玩家自己掌握，AI 不许写（applyEdits 里有拦截）。
      promise1: '',
      promise2: '',
      promise3: '',
    },
    economy: {
      spiritStones: 0,
    },
    equipment: newEquipmentSlots(),
    inventory: [],
    skills: [],
    traits: [],
    cultivationArts: {
      talisman: { tier: '未入门', progress: 0 },
      formation: { tier: '未入门', progress: 0 },
      alchemy: { tier: '未入门', progress: 0 },
      artifact: { tier: '未入门', progress: 0 },
      puppet: { tier: '未入门', progress: 0 },
      beastTaming: { tier: '未入门', progress: 0 },
      cooking: { tier: '未入门', progress: 0 },
      planting: { tier: '未入门', progress: 0 },
    },
    // legacy 列（参照快照实例的 columns + isOnscreen）
    legacy: {
      columns: {},
      isOnscreen: true,
    },
  };
  // 主角专有块 `base.player` 已整体删除，不要加回来：其中 8 项全项目零读取，
  // 另外 5 项里只有「修为进度」有实际写入路径 —— 它与 NPC 同住 `identity.realmProgress`。
  // 旧档残留由 saveSanitize 的 stripPlayerBlockInPlace 幂等搬家并清块。
  return deepMerge(base, partial);
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------- 从存档角色生成初始快照（玩家/NPC） ----------
// ---------- 从存档角色生成初始快照 ----------
// 固定格式模板直生成：角色创建时的所有选择（灵根/出身/种族/特质/技能/物品/属性分配）
// 逐项映射进快照，不经 AI —— 保证「界面选了什么，快照里就是什么」
export function snapshotFromCharacter(char, opts = {}) {
  const id = opts.id || 'B1';
  const kind = opts.kind || (opts.isPlayer ? 'player' : 'npc');
  // 快照的「自身」值不含特质：特质与装备一样，由系统按特质栏实时叠加进「生效」值
  // （见 attrRows 的三段口径）。若这里带上特质，生效值会重复计一次。
  const attrs = computeAttrs(char, { excludeTraits: true });
  const age = char.age || 18;
  const lifespan = char.realm?.lifespan || 80;
  const rarityName = (rid) => TRAIT_RARITIES.find(r => r.id === rid || r.name === rid)?.name || '普通';
  const dims = char.personality?.dims || {};
  const persBrief = personalityBrief(dims);
  // 姓名兜底：NPC 无名时用 ID 尚可接受，主角用 ID 当姓名是事故（历史上发生过 B1 变姓名）。
  //   主角没有真名就留空，由界面显示「未命名」，绝不用 ID 顶替。
  const realName = String(char.name ?? '').trim();
  const identityName = realName || (kind === 'player' ? '' : id);
  // 灵根倍率按**灵根文字**反查（NPC 没有建档页那套 typeId，只能靠文字）；
  // 建档时装备槽是空的 ⇒ 自身修炼倍率就等于灵根倍率，之后每次落盘由 syncCultivationRates 重算。
  const linggenText = char.root ? rootDisplayName(char.root) : (opts.isPlayer ? '无灵根' : '');
  const linggenRate = rootRateFromText(linggenText) ?? ROOT_CULTIVATE_RATE[char.root?.typeId] ?? 1;

  return makeEmptySnapshot(id, kind, {
    id,
    kind,
    identity: {
      name: identityName,
      gender: char.gender || '男',
      realm: char.realm?.name || '凡人',
      realmProgress: 0,
      linggen: linggenText,
      linggenCultivationSpeedMultiplier: linggenRate,
      cultivationRate: linggenRate,   // 装备槽还是空的 ⇒ 装备倍率 1.0
      personality: persBrief,
      identityRoles: [char.origin?.name].filter(Boolean),
      birthYear: opts.birthYear ?? (opts.startYear ? opts.startYear - age : -age),
      age,
      shouyuan: lifespan,
      appearanceAge: age,
    },
    stats: {
      hp: { current: attrs['气血上限'], max: attrs['气血上限'] },
      mp: { current: 0, max: attrs['法力上限'] },
      physAtk: { current: attrs['物攻'], max: attrs['物攻'] },
      physDef: { current: attrs['物防'], max: attrs['物防'] },
      magAtk: { current: attrs['法攻'], max: attrs['法攻'] },
      magDef: { current: attrs['法防'], max: attrs['法防'] },
      physPen: { current: attrs['物理穿透'], max: attrs['物理穿透'] },
      magPen: { current: attrs['法术穿透'], max: attrs['法术穿透'] },
      speed: { current: attrs['脚力'], max: attrs['脚力'] },
      spirit: { current: attrs['神识'], max: attrs['神识'] },
      luck: { current: attrs['气运'], max: attrs['气运'] },
      charm: { current: attrs['魅力'], max: attrs['魅力'] },
      crit: { current: CRIT_DEFAULT, max: CRIT_DEFAULT },   // 会心：暴击底子（百分点），装备与特质在其上叠加，不随境界涨
    },
    resources: { hp: { current: attrs['气血上限'] }, mp: { current: 0 } },
    status: { current: '一切正常', buffs: [] },
    action: {
      action: '',
      attire: '',
      location: opts.locationName || '',
      coordinates: [0, 0],
      figure: '',
      appearance: char.appearance || '',
    },
    bio: {
      background: [char.origin?.desc, char.race?.desc].filter(Boolean).join(' ') || '',
      lifeStory: '',
      innerThought: '',
      rawRelations: [],
      currentMotive: '',
      shortTermGoal: '',
      // 长期目标留空由剧情演化填写。
      // longTermGoal 只放长期目标：塞性格摘要进去会让名册的「长期目标」栏显示一句性格描述。
      longTermGoal: '',
      // 承诺三槽位（见 makeEmptySnapshot 的同一处说明）：三段「要做什么｜欠了谁｜什么时候到期」，主角不记，只有 NPC 用。
      promise1: '',
      promise2: '',
      promise3: '',
    },
    lifespanRoll: {
      majorRealm: char.realm?.name || '凡人',
      baseShouyuan: lifespan,
    },
    equipment: newEquipmentSlots(),
    inventory: (char.items || []).map(it => ({
      id: it.name,
      definitionId: it.name,
      name: it.name,
      quantity: it.count || 1,
      type: it.type || '杂物',
      desc: it.desc || '',
      mods: it.mods || null,
    })),
    // 开局技能：三档（基础/入门/进阶）映射成品阶，类型按效果文本判，倍率与耗灵力由程序按品阶补齐
    skills: (char.skills || []).map(s => buildSkill({ name: s.name, grade: TIER_TO_GRADE[s.tier] || s.tier, effect: s.desc })).filter(Boolean),
    // 特质词条（mods）由程序按特质库解析填好——AI 不参与属性加成的计算
    traits: (char.traits || []).map(t => ({ name: t.name, desc: t.desc || '', rarity: rarityName(t.rarity), effects: '', mods: resolveTraitMods(t) })),
    // 2026-09-28：`portraitPrompt` 已随「去掉所有肖像功能」删除（原值来自建档页填的外貌，
    // 全项目零读取）。建档页的「外貌」本身仍在 `char.appearance` 上，只是不再抄进快照。
  });
}

// ---------- 把快照转为前端可读的「状态文本」（注入到正文提示词） ----------
// 统一走快照 v2 视图：扁平中文键，和演化阶段要求 AI 写的口径完全一致。
// 必须把内部结构快照一并传下去：属性行要展示「自身＋装备＝生效」，
// 而 v2 的装备格只存物品名，装备加成得从内部结构的装备对象里反查。
export function snapshotToStateText(snap, tables = null) {
  if (!snap) return '（无快照）';
  return v2SnapshotText(legacyToV2(snap), { snap, tables });
}
