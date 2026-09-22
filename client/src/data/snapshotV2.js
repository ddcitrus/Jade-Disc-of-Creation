// ===== 快照格式 v2（AI 面向 + 界面面向的唯一写法） =====
// 设计要点：扁平 + 中文键；数值不带壳；装备格只存物品名；物品 8 字段；品阶 1~36 品。
// 内部存档仍是老结构（identity/stats/... ，避免全项目重构），本模块负责三件事：
//   ① 视图转换：legacyToV2 把老快照翻成 v2 视图（给 AI 看、给界面看）
//               v2ToLegacy 把 AI 产出的 v2 快照合回老结构（初始化用）
//   ② 修改语句：parseEditBlock 逐行解析 + 校验（错误带行号）
//               applyEdits 把语句写进老结构快照
//   ③ 文本渲染：v2SnapshotText / v2BundleText（注入提示词用）
import { makeEmptySnapshot, attrRows } from './snapshotSchema.js';

/* ================= 一、装备槽位 ================= */

// 九个具名格（内衣格已按用户要求删除；老数据里的 underwear 归入「内衬」）
export const V2_EQUIP_NAMED = ['右手', '左手', '头部', '内衬', '甲身', '手部', '腿部', '足部', '披风'];
// 三个数组格
export const V2_EQUIP_ARRAYS = ['饰品', '法宝', '功法'];
export const V2_EQUIP_SLOTS = [...V2_EQUIP_NAMED, ...V2_EQUIP_ARRAYS];
export const V2_EQUIP_ARRAY_LEN = 6;

/* ================= 属性键（v2 扁平中文键 ↔ 内部 stats 键，唯一出处） ================= */
// 建档读入 / 修改语句 / 反向输出 / 注入兜底 / 缺省补零 全部引用这一份，
// 避免各写各的清单再漏掉某一项（穿透就是这么被漏掉的）。
// 顺序 = 属性栏与注入行的展示顺序；物防与法防共用 def 列、物理穿透与法术穿透共用 pen 列（校界口径）。
export const V2_ATTR_KEYS = [
  ['物攻', 'physAtk'], ['物防', 'physDef'], ['法攻', 'magAtk'], ['法防', 'magDef'],
  ['物理穿透', 'physPen'], ['法术穿透', 'magPen'],
  ['神识', 'spirit'], ['脚力', 'speed'], ['气运', 'luck'], ['魅力', 'charm'],
  ['会心', 'crit'],   // 2026-09-18 新增：暴击底子（百分点），装备与特质加成
];
export const V2_ATTR_NAMES = V2_ATTR_KEYS.map(([cn]) => cn);

// 「会心」缺省值（百分点）。老存档没有这一栏 —— 读出来显示、写回去落档都必须兜到这个值：
// 补 0 会把角色的暴击底子吃掉，而且 v2ToLegacy 会把那个 0 固化进快照。
// ⚠️ 与 battleEngine.js 的 TUNING.CRIT_DEFAULT 同值，engine.probe 有断言锁住这两处不漂。
export const CRIT_DEFAULT = 5;
const V2_ATTR_STAT = Object.fromEntries(V2_ATTR_KEYS.map(([cn, key]) => [cn, key]));

// 中文槽位 → 老结构路径
const SLOT_TO_LEGACY = {
  右手: ['weapon', 'right'],
  左手: ['weapon', 'left'],
  头部: ['armor', 'head'],
  内衬: ['armor', 'inner'],
  甲身: ['armor', 'armor'],
  手部: ['armor', 'hands'],
  腿部: ['armor', 'legs'],
  足部: ['armor', 'feet'],
  披风: ['armor', 'cloak'],
};
const ARRAY_SLOT_TO_LEGACY = { 饰品: 'accessory', 法宝: 'treasure', 功法: 'technique' };

// 宽容别名：英文槽位名 / 老字段名 / 常见别称，一并归一成中文规范名
const SLOT_ALIASES = {
  right: '右手', left: '左手', weapon: '右手', 兵器: '右手', 武器: '右手',
  head: '头部', inner: '内衬', underwear: '内衬', 内衣: '内衬', body: '甲身',
  armor: '甲身', 防具: '甲身', hands: '手部', legs: '腿部', feet: '足部', cloak: '披风',
  accessory: '饰品', treasure: '法宝', technique: '功法', 武功: '功法',
};
export function normalizeSlotName(raw) {
  const t = String(raw || '').trim();
  if (!t) return '';
  if (V2_EQUIP_SLOTS.includes(t)) return t;
  return SLOT_ALIASES[t] || '';
}

/* ================= 二、品阶与属性文本（实现见 gradeUtils.js，此处仅转出） ================= */

export {
  gradeToText, parseGrade, parseGradeStrict, normalizeGrade, LEGACY_GRADE_MAP,
  parseAttrText, attrTextFromMods, GRADE_CANDIDATES,
} from './gradeUtils.js';
import { normalizeGrade, parseAttrText, attrTextFromMods, parseGrade, parseGradeStrict } from './gradeUtils.js';
import { resolveTraitMods } from './traitLibrary.js';
import {
  buildSkill, buildSkillList, skillToV2, skillFromV2, skillCoefText, skillLineText,
  normalizeSkillType, normalizeDmgKind, parseSkillLine, poolCtxOf,
  SKILL_TYPES, DMG_KINDS, SKILL_WRITE_HINT,
} from './skillCodex.js';
// 交给 AI 照抄的新角色快照模板原文在 ../prompts/templates.js（本文件只做校验与转换）
import { NEW_CHAR_V2_TEMPLATE } from '../prompts/templates.js';
export { NEW_CHAR_V2_TEMPLATE };

/* ================= 四、储物袋物品 ================= */

export const V2_ITEM_FIELDS = ['名称', '类型', '子类', '数量', '品阶', '外观', '描述', '属性'];
export const V2_ITEM_TYPES = ['消耗品', '珍贵物品', '素材', '杂物', '装备', '法宝', '功法'];
export const V2_ITEM_SUBTYPES = ['武器', '防具', '饰品'];
export const ITEM_SEP = '｜';          // 全角竖线，AI 写物品多字段时的分隔符
export const V2_ITEM_SEP_SHORT = '|';  // 半角竖线：宽容接受，自动归一

// v2 物品 → 老结构物品
export function v2ItemToLegacy(it) {
  if (it == null) return null;
  if (typeof it === 'string') return { id: it, definitionId: it, name: it, quantity: 1, type: '杂物', subtype: '', appearance: '', desc: '', grade: normalizeGrade(it) || '', mods: null };
  const name = String(it.名称 ?? it.name ?? '').trim();
  if (!name) return null;
  const type = String(it.类型 ?? it.type ?? '杂物').trim() || '杂物';
  const qty = Math.max(1, Math.floor(Number(it.数量 ?? it.quantity ?? 1) || 1));
  const gradeText = normalizeGrade(it.品阶 ?? it.grade);
  const mods = it.mods && typeof it.mods === 'object' ? it.mods : parseAttrText(it.属性 ?? '');
  return {
    id: name,
    definitionId: name,
    name,
    quantity: qty,
    type,
    subtype: String(it.子类 ?? it.subtype ?? '').trim(),
    appearance: String(it.外观 ?? it.appearance ?? '').trim(),
    desc: String(it.描述 ?? it.desc ?? '').trim(),
    grade: gradeText,
    mods: mods && Object.keys(mods).length ? mods : null,
    lots: [{ id: `${name}:lot:${Date.now()}`, quantity: qty, source: '演化写入', acquiredAt: Date.now() }],
  };
}

// 老结构物品 → v2 物品（品阶一律换算成 1~36 品文本）
export function legacyItemToV2(it) {
  if (it == null) return null;
  if (typeof it === 'string') {
    return { 名称: it, 类型: '杂物', 子类: '', 数量: 1, 品阶: '', 外观: '', 描述: '', 属性: '' };
  }
  const name = String(it.name || it.id || it.definitionId || '').trim();
  if (!name) return null;
  return {
    名称: name,
    类型: String(it.type || '杂物'),
    子类: String(it.subtype || ''),
    数量: Math.max(1, Math.floor(Number(it.quantity ?? it.count ?? 1) || 1)),
    品阶: normalizeGrade(it.grade) || (it.grade ? String(it.grade) : ''),
    外观: String(it.appearance || ''),
    描述: String(it.desc || ''),
    属性: it.mods && typeof it.mods === 'object' ? attrTextFromMods(it.mods) : '',
  };
}

// 物品行文本：8 字段用全角竖线拼接（空字段保留占位）
export function v2ItemText(it) {
  const o = it || {};
  return V2_ITEM_FIELDS.map(f => String(o[f] ?? '')).join(ITEM_SEP);
}

/* ================= 五、基础值转换工具 ================= */

const numOr = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
export function normGender(g) {
  const t = String(g || '').trim();
  if (['男', '女', '无'].includes(t)) return t;
  if (t.startsWith('男')) return '男';
  if (t.startsWith('女')) return '女';
  if (t === '雄性') return '男';
  if (t === '雌性') return '女';
  return t || '男';
}
// "96/120" ↔ {current,max}
export function poolText(p) {
  if (p == null) return '';
  if (typeof p === 'number') return String(p);
  const cur = p.current ?? p.max ?? 0;
  const max = p.max ?? p.current ?? 0;
  return `${Math.round(numOr(cur))}/${Math.round(numOr(max))}`;
}
export function parsePool(text, fallback = { current: 0, max: 0 }) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const parts = t.split('/');
  if (parts.length === 1) {
    const n = Number(parts[0].trim());
    if (!Number.isFinite(n)) return null;
    return { current: n, max: fallback?.max ?? n };
  }
  if (parts.length !== 2) return null;
  const cur = Number(parts[0].trim());
  const max = Number(parts[1].trim());
  if (!Number.isFinite(cur) || !Number.isFinite(max)) return null;
  return { current: Math.max(0, cur), max: Math.max(0, max) };
}
export function statNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return numOr(v.current ?? v.max, 0);
  return numOr(v, 0);
}

/* ================= 六、legacy → v2 ================= */

function equipValueName(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(equipValueName).filter(Boolean).join('、');
  if (typeof v === 'object') {
    if (v.name) return String(v.name);
    const parts = Object.entries(v).filter(([, x]) => x != null && x !== '').map(([, x]) => equipValueName(x)).filter(Boolean);
    return parts.join('、');
  }
  return String(v);
}
const asArr = (v) => (Array.isArray(v) ? v : []);

export function equipToV2(eq) {
  const e = eq && typeof eq === 'object' ? eq : {};
  const out = {};
  const w = e.weapon;
  const a = e.armor;
  const pick = (src, key) => (src && typeof src === 'object' && !Array.isArray(src) ? src[key] : null);
  // 老结构整串字符串：兵器归右手、防具归甲身、饰品归第一个饰品格
  out.右手 = equipValueName(typeof w === 'object' && !Array.isArray(w) ? w.right : w) || '';
  out.左手 = equipValueName(pick(w, 'left')) || '';
  out.头部 = equipValueName(pick(a, 'head')) || '';
  out.甲身 = equipValueName(pick(a, 'armor') ?? pick(a, 'body')) || '';
  out.手部 = equipValueName(pick(a, 'hands')) || '';
  out.腿部 = equipValueName(pick(a, 'legs')) || '';
  out.足部 = equipValueName(pick(a, 'feet')) || '';
  out.披风 = equipValueName(pick(a, 'cloak')) || '';
  // 内衬 = 老 inner + 老 underwear（内衣格已删，归并进内衬，避免数据丢失）
  const innerText = [equipValueName(pick(a, 'inner')), equipValueName(pick(a, 'underwear'))].filter(Boolean).join('、');
  out.内衬 = innerText;
  if (typeof a === 'string' && !out.甲身) out.甲身 = a;
  for (const [cn, legacyKey] of Object.entries(ARRAY_SLOT_TO_LEGACY)) {
    const raw = e[legacyKey];
    if (Array.isArray(raw)) out[cn] = raw.map(x => equipValueName(x) || null);
    else if (raw == null) out[cn] = Array(V2_EQUIP_ARRAY_LEN).fill(null);
    else {
      const one = equipValueName(raw);
      out[cn] = [one || null, ...Array(V2_EQUIP_ARRAY_LEN - 1).fill(null)];
    }
  }
  return out;
}

function relToV2(rows) {
  return asArr(rows).map(r => {
    if (typeof r === 'string') return { 对象: r, 身份: '', 好感: 0 };
    return {
      对象: String(r.targetId ?? r.name ?? r.对象 ?? ''),
      身份: String(r.label ?? r.身份 ?? ''),
      好感: numOr(r.favorability ?? r.favor ?? r.好感, 0),
    };
  }).filter(x => x.对象);
}

export function legacyToV2(snap) {
  if (!snap || typeof snap !== 'object') return null;
  const idt = snap.identity || {};
  const st = snap.stats || {};
  const act = snap.action || {};
  const bio = snap.bio || {};
  const eco = snap.economy || {};
  const coords = asArr(act.coordinates);
  // 技能耗灵力/回复量按角色自己的池现算，写进快照的是绝对数字（见下方「技能」一项）
  const poolCtx = poolCtxOf(snap);
  return {
    id: snap.id,
    kind: snap.kind,
    名称: String(idt.name || snap.id || ''),
    性别: normGender(idt.gender),
    种族: String(idt.race || ''),
    境界: String(idt.realm || ''),
    灵根: String(idt.linggen || ''),
    年龄: idt.age == null ? 0 : numOr(idt.age),
    寿元: idt.shouyuan == null ? 0 : numOr(idt.shouyuan),
    状态: String((snap.status || {}).current || ''),
    气血: poolText(st.hp),
    法力: poolText(st.mp),
    ...Object.fromEntries(V2_ATTR_KEYS.map(([cn, key]) => [
      cn,
      // 会心：老存档没这一栏时按缺省值给，不能补 0（0 会把暴击底子吃掉并被 v2ToLegacy 固化）
      statNum(st[key] ?? (key === 'crit' ? { current: CRIT_DEFAULT, max: CRIT_DEFAULT } : undefined)),
    ])),
    动作: String(act.action || ''),
    地点: String(act.location || ''),
    坐标: coords.length >= 2 ? [numOr(coords[0]), numOr(coords[1])] : null,
    灵石: numOr(eco.spiritStones, 0),
    储物袋: asArr(snap.inventory).map(legacyItemToV2).filter(Boolean),
    装备: equipToV2(snap.equipment),
    关系: relToV2(bio.rawRelations),
    背景: String(bio.background || ''),
    生平: String(bio.lifeStory || ''),
    内心: String(bio.innerThought || ''),
    短期目标: String(bio.shortTermGoal || ''),
    长期目标: String(bio.longTermGoal || ''),
    // 技能：五字段（名称/类型/品阶/伤害属性/效果）+ 程序按角色池算好的绝对值。
    // 耗灵力与回复量写**绝对数字**（灵力/气血上限 × 品阶比例），AI 只照抄、不做除法；
    // 角色晋阶、池变大后，下一次生成快照会自动给出新数字——技能本身不用改。
    // 强度完全由品阶决定（1 品 1.00 倍 → 36 品 43.07 倍），旧数据里的「档次」字段一律忽略。
    技能: buildSkillList(asArr(snap.skills)).map(s => skillToV2(s, poolCtx)).filter(Boolean),
    特质: asArr(snap.traits).map(t => {
      // 「加成」写的是**实际生效值**（库内特质取库里权威值、库外取 AI 写的数字），
      // 让 AI 在状态栏看到的数字与属性栏、校界是同一套。
      if (typeof t === 'string') return { 名称: t, 稀有度: '', 描述: '', 加成: '' };
      const base = { 名称: String(t.name || ''), 稀有度: String(t.rarity || ''), 描述: String(t.desc || t.description || t.effects || '') };
      return { ...base, 加成: modsText(resolveTraitMods(t) || t.mods || {}) };
    }).filter(x => x.名称),
  };
}

/* ================= 七、v2 → legacy（合回内部结构） ================= */

// 装备槽值：v2 只给名字，这里尽量把详细定义从「当前装备 / 储物袋」里找回来，
// 找不到也要写成 { name } 对象 —— 界面只有对象/数组形态才是可点击的卡片。
function resolveEquipValue(name, legacyEq, inventory) {
  const n = String(name ?? '').trim();
  if (!n || n === '空' || n === '无') return null;
  const pool = [];
  const collect = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (typeof v === 'object') { if (v.name) pool.push(v); else Object.values(v).forEach(collect); return; }
  };
  collect(legacyEq);
  const hitEq = pool.find(x => x.name === n);
  if (hitEq) return { ...hitEq };
  const inv = asArr(inventory);
  const hitInv = inv.find(it => it && typeof it === 'object' && (it.name === n || it.id === n));
  if (hitInv) {
    return {
      name: n,
      type: hitInv.type || '',
      subtype: hitInv.subtype || '',
      grade: normalizeGrade(hitInv.grade) || hitInv.grade || '',
      desc: hitInv.desc || '',
      mods: hitInv.mods && typeof hitInv.mods === 'object' ? hitInv.mods : null,
    };
  }
  return { name: n };
}

export function applyEquipToLegacy(eq, v2Equip, inventory) {
  const base = eq && typeof eq === 'object' ? eq : {};
  const out = { ...base };
  const v = v2Equip && typeof v2Equip === 'object' ? v2Equip : {};
  const setPath = (path, value) => {
    const [g, k] = path;
    const cur = out[g];
    if (g === 'weapon') {
      const obj = cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur } : { right: null, left: null };
      obj[k] = value;
      out.weapon = obj;
    } else {
      const obj = cur && typeof cur === 'object' && !Array.isArray(cur) ? { ...cur } : {};
      obj[k] = value;
      // 内衣格已删：老键一并清掉，避免界面外残留
      if (obj.underwear !== undefined) obj.underwear = null;
      if (obj.body !== undefined) obj.body = null;
      out.armor = obj;
    }
  };
  for (const [cn, path] of Object.entries(SLOT_TO_LEGACY)) {
    if (!Object.prototype.hasOwnProperty.call(v, cn)) continue;
    setPath(path, resolveEquipValue(v[cn], base, inventory));
  }
  for (const [cn, legacyKey] of Object.entries(ARRAY_SLOT_TO_LEGACY)) {
    if (!Object.prototype.hasOwnProperty.call(v, cn)) continue;
    const src = v[cn];
    const arr = Array.isArray(src) ? src : src == null ? [] : [src];
    const next = [];
    for (let i = 0; i < V2_EQUIP_ARRAY_LEN; i++) {
      next.push(resolveEquipValue(arr[i], base, inventory));
    }
    out[legacyKey] = next;
  }
  return out;
}

// 把 v2 快照合回内部结构。base 缺省时用 makeEmptySnapshot 打底（初始化角色用）。
export function v2ToLegacy(v2, base = null) {
  const id = String(v2?.id || base?.id || 'B1');
  const kind = v2?.kind || base?.kind || 'npc';
  const snap = base ? { ...base } : makeEmptySnapshot(id, kind);
  snap.id = id;
  snap.kind = kind;
  const identity = { ...(snap.identity || {}) };
  const stats = { ...(snap.stats || {}) };
  const action = { ...(snap.action || {}) };
  const bio = { ...(snap.bio || {}) };
  const status = { ...(snap.status || {}) };
  const economy = { ...(snap.economy || {}) };
  const setStat = (key, value) => {
    const cur = stats[key] && typeof stats[key] === 'object' ? stats[key] : {};
    stats[key] = { current: value, max: Math.max(cur.max ?? 0, value) === cur.max ? value : value };
    stats[key] = { current: value, max: value };
  };

  if (v2.名称 != null) identity.name = String(v2.名称);
  if (v2.性别 != null) identity.gender = normGender(v2.性别);
  if (v2.种族 != null) identity.race = String(v2.种族);
  if (v2.境界 != null) identity.realm = String(v2.境界);
  if (v2.灵根 != null) identity.linggen = String(v2.灵根);
  if (v2.年龄 != null) identity.age = Math.max(0, numOr(v2.年龄, identity.age || 0));
  if (v2.寿元 != null) identity.shouyuan = Math.max(0, numOr(v2.寿元, identity.shouyuan || 0));
  if (v2.状态 != null) status.current = String(v2.状态);
  const hp = parsePool(v2.气血);
  if (hp) stats.hp = hp;
  const mp = parsePool(v2.法力);
  if (mp) stats.mp = mp;
  for (const [cn, key] of V2_ATTR_KEYS) {
    if (v2[cn] != null) setStat(key, numOr(v2[cn], 0));
  }
  if (v2.动作 != null) action.action = String(v2.动作);
  if (v2.地点 != null) action.location = String(v2.地点);
  if (Array.isArray(v2.坐标) && v2.坐标.length >= 2) action.coordinates = [numOr(v2.坐标[0]), numOr(v2.坐标[1])];
  if (v2.灵石 != null) economy.spiritStones = Math.max(0, numOr(v2.灵石, 0));
  if (Array.isArray(v2.储物袋)) snap.inventory = v2.储物袋.map(v2ItemToLegacy).filter(Boolean);
  if (v2.装备 && typeof v2.装备 === 'object') snap.equipment = applyEquipToLegacy(snap.equipment, v2.装备, snap.inventory);
  if (Array.isArray(v2.关系)) {
    bio.rawRelations = v2.关系.map(r => ({
      targetId: String(r?.对象 ?? ''),
      label: String(r?.身份 ?? ''),
      favorability: numOr(r?.好感, 0),
    })).filter(r => r.targetId);
  }
  if (v2.背景 != null) bio.background = String(v2.背景);
  if (v2.生平 != null) bio.lifeStory = String(v2.生平);
  if (v2.内心 != null) bio.innerThought = String(v2.内心);
  if (v2.短期目标 != null) bio.shortTermGoal = String(v2.短期目标);
  if (v2.长期目标 != null) bio.longTermGoal = String(v2.长期目标);
  // 技能：AI 写的 v2 项一律交给 skillCodex 重算，不信 AI 自己填的系数数字
  if (Array.isArray(v2.技能)) snap.skills = buildSkillList(v2.技能);
  if (Array.isArray(v2.特质)) {
    snap.traits = v2.特质.map(t => {
      const row = { name: String(t?.名称 ?? ''), rarity: String(t?.稀有度 ?? ''), desc: String(t?.描述 ?? '') };
      const mods = parseAttrText(t?.加成 ?? t?.属性 ?? '');
      if (Object.keys(mods).length) row.mods = mods;
      return row;
    }).filter(t => t.name);
  }

  snap.identity = identity;
  snap.stats = stats;
  // resources 与 stats 同步（界面「HP/MP」行读的是 resources）
  snap.resources = {
    ...(snap.resources || {}),
    hp: { current: stats.hp?.current ?? 0, max: stats.hp?.max ?? 0 },
    mp: { current: stats.mp?.current ?? 0, max: stats.mp?.max ?? 0 },
  };
  snap.action = action;
  snap.bio = bio;
  snap.status = status;
  snap.economy = economy;
  return snap;
}

/* ================= 八、修改语句：字段规范 ================= */

// type: string | enum | int | pool | coord | itemList | equip | relList | skillList | traitList
export const EDIT_FIELDS = {
  性别: { type: 'enum', values: ['男', '女', '无'], ops: ['='] },
  种族: { type: 'string', ops: ['='] },
  境界: { type: 'string', ops: ['='] },
  灵根: { type: 'string', ops: ['='] },
  年龄: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  寿元: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  状态: { type: 'string', ops: ['='] },
  气血: { type: 'pool', ops: ['=', '+=', '-='] },
  法力: { type: 'pool', ops: ['=', '+=', '-='] },
  物攻: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  物防: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  法攻: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  法防: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  物理穿透: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  法术穿透: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  神识: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  脚力: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  气运: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  魅力: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  会心: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  动作: { type: 'string', ops: ['='] },
  地点: { type: 'string', ops: ['='] },
  坐标: { type: 'coord', ops: ['='] },
  灵石: { type: 'int', ops: ['=', '+=', '-='], min: 0 },
  储物袋: { type: 'itemList', ops: ['+=', '-='] },
  装备: { type: 'equip', ops: ['='] },
  关系: { type: 'relList', ops: ['+=', '-='] },
  背景: { type: 'string', ops: ['='] },
  生平: { type: 'string', ops: ['=', '+='] },
  内心: { type: 'string', ops: ['='] },
  短期目标: { type: 'string', ops: ['='] },
  长期目标: { type: 'string', ops: ['='] },
  技能: { type: 'skillList', ops: ['+=', '-='] },
  特质: { type: 'traitList', ops: ['+=', '-='] },
};
export const EDIT_FIELD_NAMES = Object.keys(EDIT_FIELDS);
const ARRAY_FIELD_NAMES = new Set(['储物袋', '关系', '技能', '特质']);

/* ================= 九、逐行解析 + 校验 ================= */

const LINE_RE = /^\s*\[([^\]]+)\]\s*(.+?)\s*(\+=|-=|=)\s*([\s\S]*)$/;

function splitItemPayload(text) {
  const raw = String(text ?? '').replace(/｜/g, ITEM_SEP).replace(/\|/g, ITEM_SEP);
  return raw.split(ITEM_SEP).map(x => x.trim());
}

/**
 * 解析并校验「修改语句」整块文本。
 * @param {string} text  <修改> 标签里的正文
 * @param {object} opts  { knownIds: string[] }  已知角色 ID（用于校验 [B1] 是否存在）
 *                       { ownedItems: { [id]: string[] } } 各角色当前储物袋物品名（装备必须先登记的校验用）
 * @returns {{ edits: Array, errors: Array<{line:number,text:string,msg:string}> }}
 */
export function parseEditBlock(text, opts = {}) {
  const edits = [];
  const errors = [];
  const known = Array.isArray(opts.knownIds) ? opts.knownIds.map(String) : null;
  const lines = String(text ?? '').split('\n');
  // 储物袋现状（客户端随请求带上来的快照）：缺这个信息时跳过「装备先登记」校验，避免误伤
  const hasOwnedInfo = !!opts.ownedItems && typeof opts.ownedItems === 'object';
  const ownedOf = (id) => {
    const v = opts.ownedItems ? opts.ownedItems[id] : null;
    return Array.isArray(v) ? v.map(String) : [];
  };
  // 预扫本批次「储物袋 += 」新登记的物品名 —— AI 可能先写装备行、后写储物袋行，顺序不该成为打回理由
  const batchAdded = new Map();
  for (const raw of lines) {
    const bm = raw.trim().match(/^\[([^\]]+)\]\s*储物袋\s*\+=\s*([\s\S]*)$/);
    if (!bm) continue;
    const nm = splitItemPayload(bm[2])[0];
    if (!nm) continue;
    const bid = bm[1].trim();
    if (!batchAdded.has(bid)) batchAdded.set(bid, new Set());
    batchAdded.get(bid).add(nm);
  }
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;
    if (/^[#/]|^-{3,}$|^<|^>/.test(line)) return; // 注释/分隔/残留标签，跳过
    const ln = i + 1;
    const m = line.match(LINE_RE);
    if (!m) {
      errors.push({ line: ln, text: line, msg: `第 ${ln} 行：格式不对，应为「[角色ID] 字段 = 值」，例如 [B1] 境界 = 筑基中期` });
      return;
    }
    const [, id, rawPath, op, rawValue] = m;
    const charId = id.trim();
    if (known && !known.includes(charId)) {
      errors.push({ line: ln, text: line, msg: `第 ${ln} 行：找不到角色「${charId}」，本轮可用角色：${known.join('、') || '（无）'}` });
      return;
    }
    const pathParts = rawPath.trim().split('.').map(s => s.trim()).filter(Boolean);
    const head = pathParts[0];

    // ---- 装备：装备.槽位 = 物品名 ----
    if (head === '装备') {
      if (pathParts.length !== 2) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：装备只能写「装备.槽位 = 物品名」，例如 [B1] 装备.右手 = 青锋短剑` });
        return;
      }
      if (op !== '=') {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：装备槽只支持「=」，不支持 ${op}` });
        return;
      }
      const slotCn = normalizeSlotName(pathParts[1]);
      if (!slotCn) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：没有「${pathParts[1]}」这个槽位，可用：${V2_EQUIP_SLOTS.join(' ')}` });
        return;
      }
      const value = rawValue.trim();
      if (!value) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：装备槽的值不能为空；卸下请写「空」` });
        return;
      }
      // 装备的物品必须先在储物袋里登记过 —— 否则 resolveEquipValue 只能凑出 { name }，
      // 装备详情里的品阶/类型/描述全空（2026-09-16 用户报「NPC 物品不完整、品阶是空」的根因）。
      // 登记写法见提示词「五、物品规范」：名称｜类型｜子类｜数量｜品阶｜外观｜描述｜属性。
      if (hasOwnedInfo && value !== '空' && value !== '无') {
        const inBag = ownedOf(charId).includes(value) || !!batchAdded.get(charId)?.has(value);
        if (!inBag) {
          errors.push({
            line: ln,
            text: line,
            msg: `第 ${ln} 行：装备「${value}」不在 ${charId} 的储物袋里，无法登记它的品阶与属性。`
              + `请在同一批里先写一行登记：`
              + `[${charId}] 储物袋 += ${value}｜类型｜子类｜1｜品阶｜外观｜描述｜属性`
              + `（类型取 消耗品/珍贵物品/素材/杂物/装备/法宝/功法；类型写「装备」时子类必填 武器/防具/饰品；品阶写 1~36 品，如「二品」）`
              + `，再写本行。若这件物品本来就在储物袋里，请把名称写成与储物袋中完全一致。`,
          });
          return;
        }
      }
      edits.push({ line: ln, id: charId, field: '装备', slot: slotCn, op, value });
      return;
    }

    // ---- 数组字段的子路径：储物袋.X.字段 / 关系.X.好感 / 技能.X.说明 / 特质.X.描述 ----
    if (ARRAY_FIELD_NAMES.has(head) && pathParts.length >= 3) {
      const spec = EDIT_FIELDS[head];
      const subField = pathParts[pathParts.length - 1];
      const targetName = pathParts.slice(1, -1).join('.');
      const allowed = {
        储物袋: [...V2_ITEM_FIELDS.slice(1)],
        关系: ['身份', '好感'],
        技能: ['品阶', '类型', '伤害属性', '效果'],
        特质: ['稀有度', '描述', '加成'],
      }[head];
      if (!allowed.includes(subField)) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head} 里没有「${subField}」这一项，可用：${allowed.join(' ')}` });
        return;
      }
      if (!targetName) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：缺少要修改的对象名，例如 [B1] ${head}.某某.${subField} = …` });
        return;
      }
      // 「数量」「好感」是数字，允许加减；其余是文本，只能赋值
      const isNum = subField === '数量' || subField === '好感';
      const subOps = isNum ? ['=', '+=', '-='] : ['='];
      if (!subOps.includes(op)) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head}.${targetName}.${subField} 是文本，只能赋值，请用「${head}.${targetName}.${subField} = 值」` });
        return;
      }
      const subValue = rawValue.trim();
      if (!subValue) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head}.${targetName}.${subField} 的值不能为空` });
        return;
      }
      if (isNum && !/^[+＋-]?\d+$/.test(subValue)) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head}.${targetName}.${subField} 要写数字，例如 ${subField} -= 20` });
        return;
      }
      edits.push({ line: ln, id: charId, field: head, target: targetName, subField, op, value: subValue });
      return;
    }

    // ---- 顶层字段 ----
    const spec = EDIT_FIELDS[head];
    if (!spec) {
      errors.push({ line: ln, text: line, msg: `第 ${ln} 行：没有「${head}」这个字段。可改字段：${EDIT_FIELD_NAMES.join(' ')}` });
      return;
    }
    if (pathParts.length !== 1) {
      errors.push({ line: ln, text: line, msg: `第 ${ln} 行：「${head}」不能再带子路径` });
      return;
    }
    if (!spec.ops.includes(op)) {
      errors.push({ line: ln, text: line, msg: `第 ${ln} 行：「${head}」不支持 ${op}，只能用 ${spec.ops.join(' ')}` });
      return;
    }
    const value = rawValue.trim();
    if (!value) {
      errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head} 的值不能为空` });
      return;
    }

    // 值形状校验
    if (spec.type === 'enum' && !spec.values.includes(value)) {
      errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head} 只能是 ${spec.values.join(' / ')}，收到「${value}」` });
      return;
    }
    if (spec.type === 'int') {
      const n = Number(value.replace(/^[+＋]/, ''));
      if (!Number.isFinite(n)) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head} 要写整数，收到「${value}」` });
        return;
      }
      if (spec.min != null && op !== '-=' && n < spec.min) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head} 不能小于 ${spec.min}` });
        return;
      }
    }
    if (spec.type === 'pool' && op === '=' && !parsePool(value)) {
      errors.push({ line: ln, text: line, msg: `第 ${ln} 行：${head} 要写「当前/上限」，例如 [B1] 气血 = 40/120` });
      return;
    }
    if (spec.type === 'coord') {
      const parts = value.split(/[,，]/).map(s => Number(s.trim()));
      if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite)) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：坐标要写两个整数，例如 [B1] 坐标 = 340,120` });
        return;
      }
    }
    if (spec.type === 'itemList') {
      const seg = splitItemPayload(value);
      if (op === '+=' || op === '-=') {
        if (!seg[0]) {
          errors.push({ line: ln, text: line, msg: `第 ${ln} 行：物品缺「名称」` });
          return;
        }
        if (op === '+=') {
          const REQUIRED = [
            ['类型', 1],
            ['品阶', 4],
          ];
          for (const [label, idx] of REQUIRED) {
            if (!String(seg[idx] ?? '').trim()) {
              errors.push({ line: ln, text: line, msg: `第 ${ln} 行：物品缺「${label}」，${label}必填。整行应写成 名称｜类型｜子类｜数量｜品阶｜外观｜描述｜属性` });
              return;
            }
          }
          const grade = parseGradeStrict(seg[4]);
          if (grade == null) {
            errors.push({ line: ln, text: line, msg: `第 ${ln} 行：「${seg[4]}」不是合法品阶，请写 1~36 品，例如「三品」` });
            return;
          }
          const type = seg[1];
          if (!V2_ITEM_TYPES.includes(type)) {
            errors.push({ line: ln, text: line, msg: `第 ${ln} 行：物品类型「${type}」不合法，只能是 ${V2_ITEM_TYPES.join(' / ')}` });
            return;
          }
          if (type === '装备') {
            if (!String(seg[2] ?? '').trim()) {
              errors.push({ line: ln, text: line, msg: `第 ${ln} 行：类型是「装备」，子类必须填 ${V2_ITEM_SUBTYPES.join(' / ')}` });
              return;
            }
            if (!V2_ITEM_SUBTYPES.includes(seg[2].trim())) {
              errors.push({ line: ln, text: line, msg: `第 ${ln} 行：装备子类「${seg[2]}」不合法，只能是 ${V2_ITEM_SUBTYPES.join(' / ')}` });
              return;
            }
          }
          if (String(seg[7] ?? '').trim() && !Object.keys(parseAttrText(seg[7])).length) {
            errors.push({ line: ln, text: line, msg: `第 ${ln} 行：属性格式不对，应写「物攻+9000，法防+100」` });
            return;
          }
        }
      }
      edits.push({ line: ln, id: charId, field: head, op, segments: seg, value });
      return;
    }
    if (spec.type === 'relList' && op === '+=') {
      const seg = splitItemPayload(value);
      if (!seg[0]) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：关系缺「对象」，应写 对象｜身份｜好感` });
        return;
      }
      if (seg[2] != null && seg[2] !== '' && !Number.isFinite(Number(seg[2]))) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：好感要写数字，例如 [B1] 关系 += 墨凤羽｜同门师妹｜30` });
        return;
      }
    }
    if (spec.type === 'skillList' && op === '+=') {
      const seg = splitItemPayload(value);
      const parsed = parseSkillLine(seg);
      if (!parsed.name) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：技能缺「名称」。正确写法：${SKILL_WRITE_HINT}` });
        return;
      }
      if (parsed.type && !SKILL_TYPES.includes(parsed.type)) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：技能类型「${parsed.type}」不对，只能写 ${SKILL_TYPES.join(' / ')}。正确写法：${SKILL_WRITE_HINT}` });
        return;
      }
      if (parsed.grade && parseGradeStrict(parsed.grade) == null) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：技能品阶「${parsed.grade}」不是 1~36 品，例如「一品」` });
        return;
      }
      // 伤害属性在第 4 段。留空允许（协议会让 AI 战斗时按效果判定）；写了就必须是「物」或「法」。
      const slot4 = String(seg[3] ?? '').trim();
      if (seg.length >= 5 && !DMG_KINDS.includes(slot4)) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：伤害属性「${slot4}」不对，只能写 ${DMG_KINDS.join(' / ')}。正确写法：${SKILL_WRITE_HINT}` });
        return;
      }
    }
    if (spec.type === 'traitList' && op === '+=') {
      const seg = splitItemPayload(value);
      if (!seg[0]) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：特质缺「名称」，应写 名称｜稀有度｜描述｜加成` });
        return;
      }
      // 第 4 段 = 属性加成，与储物袋「属性」同格式：物攻+9000，法防+100（可省略）
      if (String(seg[3] ?? '').trim() && !Object.keys(parseAttrText(seg[3])).length) {
        errors.push({ line: ln, text: line, msg: `第 ${ln} 行：特质加成格式不对，应写「物攻+6，法防-2」` });
        return;
      }
    }
    edits.push({ line: ln, id: charId, field: head, op, value, segments: splitItemPayload(value) });
  });
  return { edits, errors };
}

/* ================= 十、把语句写进快照 ================= */

function ensureStat(stats, key) {
  const cur = stats[key];
  if (cur && typeof cur === 'object') return { current: statNum(cur.current), max: statNum(cur.max) };
  return { current: statNum(cur), max: statNum(cur) };
}
function setPool(snap, which, next) {
  const stats = { ...(snap.stats || {}) };
  const key = which === '气血' ? 'hp' : 'mp';
  stats[key] = { current: Math.max(0, Math.round(next.current)), max: Math.max(0, Math.round(next.max)) };
  snap.stats = stats;
  snap.resources = { ...(snap.resources || {}), [key]: { current: stats[key].current, max: stats[key].max } };
}

/**
 * 把解析好的修改语句应用到一份内部结构快照上（就地返回新对象，不改原对象）。
 * @returns {{ snapshot: object, applied: string[], skipped: string[] }}
 */
export function applyEdits(snapIn, edits) {
  const snap = structuredClone(snapIn || {});
  const applied = [];
  const skipped = [];
  snap.identity = { ...(snap.identity || {}) };
  snap.stats = { ...(snap.stats || {}) };
  snap.action = { ...(snap.action || {}) };
  snap.bio = { ...(snap.bio || {}) };
  snap.status = { ...(snap.status || {}) };
  snap.economy = { ...(snap.economy || {}) };
  const done = (e, what) => applied.push(`[${e.id}] ${what}`);

  for (const e of (edits || [])) {
    try {
      switch (e.field) {
        case '性别': snap.identity.gender = normGender(e.value); done(e, `性别=${snap.identity.gender}`); break;
        case '种族': snap.identity.race = e.value; done(e, `种族=${e.value}`); break;
        case '境界': snap.identity.realm = e.value; done(e, `境界=${e.value}`); break;
        case '灵根': snap.identity.linggen = e.value; done(e, `灵根=${e.value}`); break;
        case '年龄': {
          const cur = numOr(snap.identity.age, 0);
          const n = e.op === '=' ? Number(e.value) : e.op === '+=' ? cur + Number(e.value) : cur - Number(e.value);
          snap.identity.age = Math.max(0, Math.round(n)); done(e, `年龄=${snap.identity.age}`); break;
        }
        case '寿元': {
          const cur = numOr(snap.identity.shouyuan, 0);
          const n = e.op === '=' ? Number(e.value) : e.op === '+=' ? cur + Number(e.value) : cur - Number(e.value);
          snap.identity.shouyuan = Math.max(0, Math.round(n)); done(e, `寿元=${snap.identity.shouyuan}`); break;
        }
        case '状态': snap.status.current = e.value; done(e, `状态=${e.value}`); break;
        case '气血':
        case '法力': {
          const key = e.field === '气血' ? 'hp' : 'mp';
          const cur = ensureStat(snap.stats, key);
          let next;
          if (e.op === '=') next = parsePool(e.value) || cur;
          else {
            const n = Number(e.value);
            next = { current: Math.max(0, cur.current + (e.op === '+=' ? n : -n)), max: cur.max };
          }
          // 上限只能通过「= 当前/上限」调整，避免 AI 用加减把上限算错
          if (e.op === '=' && next.max < next.current) next.max = next.current;
          setPool(snap, e.field, next); done(e, `${e.field}=${next.current}/${next.max}`); break;
        }
        case '物攻': case '物防': case '法攻': case '法防':
        case '物理穿透': case '法术穿透':
        case '神识': case '脚力': case '气运': case '魅力': case '会心': {
          const key = V2_ATTR_STAT[e.field];
          const cur = ensureStat(snap.stats, key);
          const n = e.op === '=' ? Number(e.value) : e.op === '+=' ? cur.current + Number(e.value) : cur.current - Number(e.value);
          const v = Math.max(0, Math.round(n));
          // 数值不带壳：current 与 max 同步（突破/受伤都由「=」整条改写）
          if (e.op === '=') snap.stats[key] = { current: v, max: v };
          else snap.stats[key] = { current: v, max: Math.max(0, Math.round(e.op === '+=' ? cur.max + Number(e.value) : cur.max - Number(e.value))) };
          done(e, `${e.field}=${snap.stats[key].current}/${snap.stats[key].max}`); break;
        }
        case '动作': snap.action.action = e.value; done(e, `动作=${e.value}`); break;
        case '地点': snap.action.location = e.value; done(e, `地点=${e.value}`); break;
        case '坐标': {
          const p = e.value.split(/[,，]/).map(s => Number(s.trim()));
          snap.action.coordinates = [Math.round(p[0]), Math.round(p[1])]; done(e, `坐标=${snap.action.coordinates.join(',')}`); break;
        }
        case '灵石': {
          const cur = numOr(snap.economy.spiritStones, 0);
          const n = e.op === '=' ? Number(e.value) : e.op === '+=' ? cur + Number(e.value) : cur - Number(e.value);
          snap.economy.spiritStones = Math.max(0, Math.round(n)); done(e, `灵石=${snap.economy.spiritStones}`); break;
        }
        case '装备': {
          snap.equipment = applyEquipToLegacy(snap.equipment, { [e.slot]: e.value === '空' || e.value === '无' ? null : e.value }, snap.inventory);
          done(e, `装备.${e.slot}=${e.value}`); break;
        }
        case '储物袋': {
          const inv = Array.isArray(snap.inventory) ? [...snap.inventory] : [];
          if (e.subField) {
            const idx0 = inv.findIndex(it => (typeof it === 'string' ? it : it?.name) === e.target);
            if (idx0 < 0) { skipped.push(`[${e.id}] 储物袋里没有「${e.target}」`); break; }
            const old0 = typeof inv[idx0] === 'string' ? { name: e.target, quantity: 1 } : inv[idx0];
            const cur0 = numOr(old0.quantity, 1) || 1;
            if (e.subField === '数量') {
              const n = e.op === '=' ? Number(e.value) : e.op === '+=' ? cur0 + Number(e.value) : cur0 - Number(e.value);
              const left = Math.max(0, Math.round(n));
              if (left <= 0) inv.splice(idx0, 1);
              else inv[idx0] = { ...old0, quantity: left };
              done(e, `储物袋.${e.target}.数量=${left}`);
            } else {
              const key = { 名称: 'name', 类型: 'type', 子类: 'subtype', 品阶: 'grade', 外观: 'appearance', 描述: 'description', 属性: 'mods' }[e.subField];
              const patch = {};
              if (e.subField === '品阶') patch.grade = normalizeGrade(e.value) || e.value;
              else patch[key] = e.value;
              inv[idx0] = { ...old0, ...patch };
              done(e, `储物袋.${e.target}.${e.subField}=${e.value}`);
            }
            snap.inventory = inv; break;
          }
          const name = String(e.segments?.[0] ?? '').trim();
          const idx = inv.findIndex(it => (typeof it === 'string' ? it : it?.name) === name);
          if (e.op === '+=') {
            const item = v2ItemToLegacy({
              名称: name,
              类型: e.segments[1],
              子类: e.segments[2] || '',
              数量: e.segments[3] || 1,
              品阶: e.segments[4],
              外观: e.segments[5] || '',
              描述: e.segments[6] || '',
              属性: e.segments[7] || '',
            });
            if (!item) { skipped.push(`[${e.id}] 储物袋 += 物品名不合法`); break; }
            if (idx >= 0) {
              const old = typeof inv[idx] === 'string' ? { name } : inv[idx];
              inv[idx] = { ...old, ...item, quantity: (numOr(old.quantity, 1) || 1) + item.quantity };
            } else inv.push(item);
            done(e, `储物袋 +${name}×${item.quantity}`);
          } else {
            if (idx < 0) { skipped.push(`[${e.id}] 储物袋里没有「${name}」，未减少`); break; }
            const qty = Math.max(1, Math.floor(Number(e.segments?.[1]) || 1));
            const old = typeof inv[idx] === 'string' ? { name, quantity: 1 } : inv[idx];
            const left = (numOr(old.quantity, 1) || 1) - qty;
            if (left > 0) inv[idx] = { ...old, quantity: left };
            else inv.splice(idx, 1);
            done(e, `储物袋 -${name}×${qty}`);
          }
          snap.inventory = inv; break;
        }
        case '关系': {
          const list = Array.isArray(snap.bio.rawRelations) ? [...snap.bio.rawRelations] : [];
          if (e.subField) {
            const i = list.findIndex(r => String(r?.targetId ?? r?.name ?? '') === e.target);
            if (i < 0) { skipped.push(`[${e.id}] 关系里没有「${e.target}」`); break; }
            if (e.subField === '好感') {
              const old = numOr(list[i].favorability, 0) || 0;
              const n = e.op === '=' ? Number(e.value) : e.op === '+=' ? old + Number(e.value) : old - Number(e.value);
              list[i] = { ...list[i], favorability: Math.round(n) };
            } else list[i] = { ...list[i], label: e.value };
            done(e, `关系.${e.target}.${e.subField}=${list[i].favorability ?? e.value}`);
          } else {
            const name = String(e.segments?.[0] ?? '').trim();
            const i = list.findIndex(r => String(r?.targetId ?? r?.name ?? '') === name);
            if (e.op === '+=') {
              const row = { targetId: name, label: String(e.segments?.[1] ?? ''), favorability: Math.round(Number(e.segments?.[2]) || 0) };
              if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row);
              done(e, `关系 +${name}`);
            } else {
              if (i < 0) { skipped.push(`[${e.id}] 关系里没有「${name}」`); break; }
              list.splice(i, 1);
              done(e, `关系 -${name}`);
            }
          }
          snap.bio.rawRelations = list; break;
        }
        case '背景': snap.bio.background = e.value; done(e, '背景已更新'); break;
        case '生平': {
          const cur = String(snap.bio.lifeStory || '');
          snap.bio.lifeStory = e.op === '+=' ? [cur, e.value].filter(Boolean).join('\n') : e.value;
          done(e, '生平已更新'); break;
        }
        case '内心': snap.bio.innerThought = e.value; done(e, '内心已更新'); break;
        case '短期目标': snap.bio.shortTermGoal = e.value; done(e, `短期目标=${e.value}`); break;
        case '长期目标': snap.bio.longTermGoal = e.value; done(e, `长期目标=${e.value}`); break;
        case '技能': {
          const list = Array.isArray(snap.skills) ? [...snap.skills] : [];
          if (e.subField) {
            const i = list.findIndex(s => String(s?.name ?? '') === e.target);
            if (i < 0) { skipped.push(`[${e.id}] 技能里没有「${e.target}」`); break; }
            // 四个子字段都走 buildSkill 重建：改品阶必须连带重算倍率与耗灵力
            if (e.subField === '类型') list[i] = buildSkill({ ...list[i], type: normalizeSkillType(e.value) });
            else if (e.subField === '效果') list[i] = buildSkill({ ...list[i], effect: e.value });
            else if (e.subField === '伤害属性') list[i] = buildSkill({ ...list[i], dmgKind: normalizeDmgKind(e.value) });
            else list[i] = buildSkill({ ...list[i], grade: e.value });
            done(e, `技能.${e.target}.${e.subField}=${e.value}`);
          } else {
            const name = String(e.segments?.[0] ?? '').trim();
            const i = list.findIndex(s => String(s?.name ?? '') === name);
            if (e.op === '+=') {
              // 写法：名称｜类型｜品阶｜伤害属性｜效果；倍率与耗灵力由 skillCodex 按品阶算好，AI 不写数字
              const p = parseSkillLine(e.segments);
              const row = buildSkill({
                name,
                type: p.type,
                grade: p.grade,
                dmgKind: p.dmgKind,
                effect: p.effect,
              });
              if (row) {
                if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row);
                done(e, `技能 +${name}`);
              }
            } else {
              if (i < 0) { skipped.push(`[${e.id}] 技能里没有「${name}」`); break; }
              list.splice(i, 1);
              done(e, `技能 -${name}`);
            }
          }
          snap.skills = list; break;
        }
        case '特质': {
          const list = Array.isArray(snap.traits) ? [...snap.traits] : [];
          if (e.subField) {
            const i = list.findIndex(t => String(t?.name ?? '') === e.target);
            if (i < 0) { skipped.push(`[${e.id}] 特质里没有「${e.target}」`); break; }
            if (e.subField === '稀有度') list[i] = { ...list[i], rarity: e.value };
            else if (e.subField === '加成') {
              // 「加成」是复合字段，赋值即整体替换（空值 = 清掉加成）
              const add = parseAttrText(e.value);
              if (Object.keys(add).length) list[i] = { ...list[i], mods: add };
              else { const t = { ...list[i] }; delete t.mods; list[i] = t; }
            } else list[i] = { ...list[i], desc: e.value };
            done(e, `特质.${e.target}.${e.subField}=${e.value}`);
          } else {
            const name = String(e.segments?.[0] ?? '').trim();
            const i = list.findIndex(t => String(t?.name ?? '') === name);
            if (e.op === '+=') {
              const row = { name, rarity: String(e.segments?.[1] || '普通'), desc: String(e.segments?.[2] || '') };
              const add = parseAttrText(String(e.segments?.[3] ?? ''));   // 第 4 段：属性加成（可省略）
              if (Object.keys(add).length) row.mods = add;
              if (i >= 0) list[i] = { ...list[i], ...row, mods: { ...(list[i].mods || {}), ...(row.mods || {}) } };
              else list.push(row);
              done(e, `特质 +${name}`);
            } else {
              if (i < 0) { skipped.push(`[${e.id}] 特质里没有「${name}」`); break; }
              list.splice(i, 1);
              done(e, `特质 -${name}`);
            }
          }
          snap.traits = list; break;
        }
        default:
          skipped.push(`[${e.id}] 不支持的字段「${e.field}」`);
      }
    } catch (err) {
      skipped.push(`[${e.id}] ${e.field} 应用失败：${err?.message || err}`);
    }
  }
  // 资源镜像：应用完统一同步一次（界面 HP/MP 行读 resources）
  const st = snap.stats || {};
  snap.resources = { ...(snap.resources || {}) };
  if (st.hp) snap.resources.hp = { current: statNum(st.hp.current), max: statNum(st.hp.max) };
  if (st.mp) snap.resources.mp = { current: statNum(st.mp.current), max: statNum(st.mp.max) };
  return { snapshot: snap, applied, skipped };
}

/* ================= 十一、v2 文本渲染（注入提示词） ================= */

const EMPTY_ARR = (v) => !Array.isArray(v) || !v.length;

/**
 * 属性四段口径 —— 注入给 AI 的属性行写作「自身＋特质＋装备＝生效」。
 *   · 自身   = 快照 stats（境界基准 + 出身 + 种族 + 加点）；**唯一可以被剧情改写的属性**
 *   · 特质   = 当前特质词条加成的合计（程序按快照特质栏实时求和，AI 只读）
 *   · 装备   = 随身装备「属性」词条的合计（程序按已装备物品实时求和，AI 只读）
 *   · 生效   = 自身 + 特质 + 装备；战斗、比斗、伤害计算、强弱判断一律取它
 * 为什么要写成多段：AI 原先只看到「物攻 15」（自身值），既不知道武器给了多少，
 * 也拿不到可以代入伤害公式的数，于是自己编一个「武器 12」出来。
 * 只读「特质」「装备」两列、只写「自身」这一列，是防止加成被写回属性数字（越演越虚高）的关键。
 */
export const ATTR_TRIAD_HEADER = '属性（自身＋特质＋装备＝生效）：战斗与伤害计算一律用「生效」；剧情改动只写「自身」；「特质」「装备」由系统按当前特质与随身装备实时计算，不要写进属性、也不要重复叠加。';

// 属性行每行放几项（太长会让模型看漏）
const ATTR_TRIAD_PER_LINE = 4;

// 属性词条 → 「物攻+80，法防-5」
export function modsText(mods) {
  if (!mods || typeof mods !== 'object' || Array.isArray(mods)) return '';
  return Object.entries(mods).map(([k, v]) => {
    const n = Number(v);
    if (!Number.isFinite(n) || !n) return '';
    return `${k}${n > 0 ? '+' : ''}${n}`;
  }).filter(Boolean).join('，');
}

// 装备格的值 → 「青钢剑（物攻+80）」：v2 只存名字，词条从当前装备 / 储物袋反查
function equipValueWithMods(name, legacyEq, inventory) {
  const n = String(name ?? '').trim();
  if (!n) return '';
  const item = resolveEquipValue(n, legacyEq, inventory);
  const txt = modsText(item?.mods);
  return txt ? `${n}（${txt}）` : n;
}

// 属性三段文本：attrRows 的行 → 「物攻 15＋160＝175」
// 快照自带特质 → 特质加成表（与装备加成同一口径：由系统实时叠加进「生效」值）
function traitModsOf(snap) {
  const out = {};
  for (const t of (Array.isArray(snap?.traits) ? snap.traits : [])) {
    const m = resolveTraitMods(t);
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
    for (const [k, v] of Object.entries(m)) {
      const n = Number(v);
      if (Number.isFinite(n) && n) out[k] = (out[k] || 0) + n;
    }
  }
  return out;
}

function attrTriadItems(rows) {
  const items = [];
  if (!Array.isArray(rows)) return items;
  for (const r of rows) {
    if (!r || r.extraOnly) continue;               // 非十二项基础属性（修炼速度等）另起一行
    const label = r.label === '血量' ? '气血' : r.label;
    const bonus = Number(r.bonus) || 0;
    const trait = Number(r.traitBonus) || 0;       // 特质加成：与装备同一待遇，由系统实时叠加
    if (r.isPool) {
      const selfCur = Number(r.current) || 0;
      const selfMax = Number(r.max) || 0;
      // 「＝」后面是生效值：加值同时抬当前值与上限（见 attrRows / poolCurrent）。
      // 别自己再拿 自身 ＋ 加成算一遍，否则注入给 AI 的数字会跟面板对不上。
      const cur = Number(r.effCurrent) || 0;
      const max = Number(r.effMax) || 0;
      items.push(`${label} ${selfCur}/${selfMax}＋${trait}＋${bonus}＝${cur}/${max}`);
    } else {
      const cur = Number(r.current) || 0;
      // 全零的穿透行没有任何信息量，不占篇幅
      if (!cur && !bonus && !trait) continue;
      items.push(`${label} ${cur}＋${trait}＋${bonus}＝${Number(r.effCurrent) || 0}`);
    }
  }
  return items;
}

/**
 * 角色快照 → 注入文本。
 * @param {object} v2 legacyToV2(snap) 的结果
 * @param {object} [opts] { snap }：对应的内部结构快照。带上它才能算出装备加成列
 *   （v2 的装备格只存物品名，词条与加成要靠内部结构反查）
 */
export function v2SnapshotText(v2, opts = {}) {
  if (!v2) return '（无快照）';
  const snap = opts?.snap || null;
  // 技能行的耗灵力/回复量按这个角色自己的池现算，保证与属性栏同口径（晋阶后自动更新）
  const skillCtx = poolCtxOf(snap || v2);
  const legacyEq = snap?.equipment;
  const inventory = snap?.inventory;
  const L = [];
  const row = (k, v) => {
    if (v === '' || v == null) return;
    L.push(`${k}：${v}`);
  };
  L.push(`【角色 ${v2.id} · ${v2.kind}】`);
  row('名称', v2.名称);
  row('性别', v2.性别);
  row('种族', v2.种族);
  row('境界', v2.境界);
  row('灵根', v2.灵根);
  row('年龄', v2.年龄 ? `${v2.年龄} 岁` : '');
  row('寿元', v2.寿元 || '');
  row('状态', v2.状态);

  // ---- 属性：三段口径（自身＋特质＋装备＝生效）----
  // 特质加成与装备加成一样由系统实时算：这里从快照的特质栏现算，AI 写进「自身」的会被视为它的裸值
  const rows = snap ? attrRows(snap, opts.traitMods ?? traitModsOf(snap)) : null;
  const triad = attrTriadItems(rows);
  if (triad.length) {
    L.push(ATTR_TRIAD_HEADER);
    for (let i = 0; i < triad.length; i += ATTR_TRIAD_PER_LINE) {
      L.push('  ' + triad.slice(i, i + ATTR_TRIAD_PER_LINE).join(' ｜ '));
    }
    const extra = (rows || []).filter(r => r && r.extraOnly && Number(r.current));
    if (extra.length) L.push('  其他加成：' + extra.map(r => `${r.label}${Number(r.current) > 0 ? '+' : ''}${r.current}`).join('，'));
  } else {
    // 兜底（没有内部结构快照时）：只给自身值，不伪造装备列
    row('气血', v2.气血);
    row('法力', v2.法力);
    const attrs = V2_ATTR_NAMES
      .filter(k => v2[k] != null && v2[k] !== '').map(k => `${k} ${v2[k]}`).join(' · ');
    row('属性', attrs);
  }

  row('动作', v2.动作);
  row('地点', v2.地点);
  if (Array.isArray(v2.坐标) && v2.坐标.length >= 2) row('坐标', `${v2.坐标[0]},${v2.坐标[1]}`);
  row('灵石', v2.灵石);
  if (v2.装备 && typeof v2.装备 === 'object') {
    const parts = [];
    for (const s of V2_EQUIP_NAMED) {
      if (v2.装备[s]) parts.push(`${s}=${equipValueWithMods(v2.装备[s], legacyEq, inventory)}`);
    }
    for (const s of V2_EQUIP_ARRAYS) {
      const arr = asArr(v2.装备[s]).map(x => x || '').filter(Boolean)
        .map(x => equipValueWithMods(x, legacyEq, inventory));
      if (arr.length) parts.push(`${s}=${arr.join('、')}`);
    }
    row('装备', parts.length ? parts.join(' · ') : '（空）');
  }
  if (!EMPTY_ARR(v2.储物袋)) {
    L.push('储物袋：');
    for (const it of v2.储物袋) L.push(`  · ${v2ItemText(it)}`);
  }
  if (!EMPTY_ARR(v2.关系)) {
    L.push('关系：');
    for (const r of v2.关系) L.push(`  · ${r.对象}｜${r.身份 || ''}｜${r.好感 ?? 0}`);
  }
  row('背景', v2.背景);
  if (v2.生平) L.push(`生平：${v2.生平}`);
  row('内心', v2.内心);
  row('短期目标', v2.短期目标);
  row('长期目标', v2.长期目标);
  // 技能：把程序算好的倍率/回复量/耗灵力一并写出来，战斗推演直接照抄这里的数字，不要再自己查表或另算
  // 伤害属性也写在这一行（括号内第 2 段），战斗时据此取「生效物攻/物防」或「生效法攻/法防」
  if (!EMPTY_ARR(v2.技能)) {
    const seg = v2.技能.map(s => {
      const line = skillLineText(s, skillCtx);
      if (line) return line;
      // 名称都没了的脏数据才走到这里，保底给个可读形态
      const head = `${s.名称}（${s.类型 || '伤害'}·${s.品阶 || '未标品阶'}）`;
      const coef = skillCoefText(s, skillCtx);
      return coef ? `${head}：${coef}` : head;
    }).join('、');
    L.push(`技能：${seg}`);
  }
  if (!EMPTY_ARR(v2.特质)) L.push(`特质：${v2.特质.map(t => (t.加成 ? `${t.名称}（${t.加成}）` : t.名称)).join('、')}`);
  return L.join('\n');
}

export function v2BundleText(bundle) {
  const ids = Object.keys(bundle || {});
  if (!ids.length) return '（暂无角色快照）';
  return ids.map(id => v2SnapshotText(legacyToV2(bundle[id]), { snap: bundle[id] })).join('\n\n');
}

/* ================= 十二、初始化快照校验（AI 新增角色时用） ================= */

// 必填项（缺一个就打回）
const V2_INIT_REQUIRED_STRING = ['名称', '性别', '种族', '境界', '灵根', '状态', '气血', '法力', '动作', '地点'];
const V2_INIT_REQUIRED_NUMBER = ['年龄', '寿元', '灵石'];
const V2_INIT_FILL_NUMBER = [...V2_ATTR_NAMES];

/**
 * 校验一份「新增角色」的 v2 完整快照。**分级**：只有致命问题才算 errors（整块丢弃），
 * 其余一律补默认值放行并把原因记进 warns。
 *
 * 为什么分两级（2026-09-20 用户需求「建档要有保底机制」）：
 *   建档块是 AI 写在正文里的，格式抖动是常态。原先「只要有一处不合格就整块丢弃」，
 *   代价是那个角色**从此没有档案** —— 紧接着同一轮的 <battle> 指令点名要他参战，
 *   建局时找不到快照就把整场战斗判死，玩家卡在「剑已出鞘」谁也推不动。
 *   一个「寿元写成了八十年」的笔误，不该换来一场打不了的仗。
 *
 * errors（致命，丢弃）：不是对象 / 连名字都没有（建出来的档在名册与战报里印不出称呼）。
 * 其余全部可修：缺文本字段补默认值、数字不是数字补 0、储物袋里读不出名称的条目丢掉、
 * 品阶/子类/属性格式不对留原文（数值表校界与界面会兜）。
 *
 * @param {string} id 角色 ID
 * @param {object} raw AI 写的 v2 快照
 * @param {{ fallbackName?: string }} [opts] fallbackName：名称缺失时的兜底称呼（调用方从正文里认到的名字）
 * @returns {{ errors: string[], warns: string[], fixed: object|null }}
 */
export function validateV2Snapshot(id, raw, opts = {}) {
  const errors = [];
  const warns = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [`角色 ${id} 的快照必须是一个对象`], warns, fixed: null };
  }
  const v2 = { ...raw, id: String(raw.id || id), kind: raw.kind || 'npc' };
  if (!['player', 'npc'].includes(v2.kind)) {
    warns.push(`kind「${v2.kind}」不合法，已按 npc 处理`);
    v2.kind = 'npc';
  }
  // 名称：先认常见别名键（AI 偶尔写成「姓名」「名字」），再落到调用方给的兜底名，最后才是致命
  const nameRaw = v2.名称 ?? v2.姓名 ?? v2.名字 ?? v2.name ?? v2.名;
  const name = String(nameRaw ?? '').trim() || String(opts.fallbackName ?? '').trim();
  if (!name) errors.push(`角色 ${id} 缺少「名称」`);
  else {
    if (nameRaw == null || String(nameRaw).trim() === '') warns.push(`名称缺失，已按「${name}」兜底`);
    v2.名称 = name;
  }
  // 其余必填文本：缺了就补默认值（不再打回）
  const TEXT_DEFAULTS = { 性别: '男', 种族: '人族', 境界: '凡人', 灵根: '无灵根', 状态: '一切正常', 动作: '', 地点: '' };
  for (const k of V2_INIT_REQUIRED_STRING) {
    if (k === '名称' || k === '气血' || k === '法力') continue;
    if (v2[k] == null || String(v2[k]).trim() === '') {
      const d = TEXT_DEFAULTS[k] ?? '';
      if (k !== '动作' && k !== '地点') warns.push(`缺少「${k}」，已按「${d}」兜底`);
      v2[k] = d;
    }
  }
  if (!['男', '女', '无'].includes(String(v2.性别).trim())) {
    warns.push(`性别「${v2.性别}」不合法，已归一为「${normGender(v2.性别)}」`);
    v2.性别 = normGender(v2.性别);
  }
  for (const k of V2_INIT_REQUIRED_NUMBER) {
    if (v2[k] == null || !Number.isFinite(Number(v2[k]))) { warns.push(`「${k}」不是数字，已补 0`); v2[k] = 0; }
  }
  // 气血 / 法力：写不出「当前/上限」时补 0/0 —— 落档与建局都要过数值表校界，
  // 而校界对「当前 === 上限」的池子会整条抬到该境界基准，于是 0/0 自动变成健康的满值，
  // 不会留下一个一碰就倒的空血角色。见 attrClamp.clampSnapshotStats 的「满值态跟涨」。
  for (const k of ['气血', '法力']) {
    if (v2[k] != null && !parsePool(v2[k])) { warns.push(`「${k}」不是「当前/上限」，已补 0/0（进战斗前会按境界基准校界）`); v2[k] = '0/0'; }
    else if (v2[k] == null) v2[k] = '0/0';
  }

  // 装备：必须是对象，九个具名格给名字或 null，三个数组格是数组。
  // ⚠️ 「补空格」这几段**必须对「原本没有装备对象」的情况也跑**：
  // 从前这里写的是 else 分支，缺对象就 push 一个 error 直接丢档，谁也走不到补格那一步；
  // 现在缺对象只是警告（保底放行），若不补格，界面读到的就是 undefined。
  if (!v2.装备 || typeof v2.装备 !== 'object' || Array.isArray(v2.装备)) {
    warns.push('缺少「装备」对象，已补空装备栏');
    v2.装备 = {};
  }
  for (const s of V2_EQUIP_NAMED) if (!(s in v2.装备)) v2.装备[s] = null;
  for (const s of V2_EQUIP_ARRAYS) {
    const arr = v2.装备[s];
    if (arr == null) { v2.装备[s] = Array(V2_EQUIP_ARRAY_LEN).fill(null); continue; }
    if (!Array.isArray(arr)) { warns.push(`装备格「${s}」不是数组，已清空`); v2.装备[s] = Array(V2_EQUIP_ARRAY_LEN).fill(null); continue; }
    const next = arr.slice(0, V2_EQUIP_ARRAY_LEN);
    while (next.length < V2_EQUIP_ARRAY_LEN) next.push(null);
    v2.装备[s] = next.map(x => (x == null || x === '' ? null : String(x)));
  }
  // 槽位值只能是物品名
  for (const s of V2_EQUIP_NAMED) {
    const val = v2.装备[s];
    if (val != null && typeof val !== 'string') {
      const nm = val && typeof val === 'object' ? (val.名称 || val.name || '') : '';
      if (!nm) warns.push(`装备格「${s}」不是物品名，已置空`);
      v2.装备[s] = nm || null;
    }
  }

  // 数值兜底
  for (const k of V2_INIT_FILL_NUMBER) if (v2[k] == null || !Number.isFinite(Number(v2[k]))) v2[k] = 0;
  if (v2.灵石 == null) v2.灵石 = 0;
  if (!Array.isArray(v2.坐标)) v2.坐标 = [0, 0];
  if (!Array.isArray(v2.储物袋)) v2.储物袋 = [];
  if (!Array.isArray(v2.关系)) v2.关系 = [];
  if (!Array.isArray(v2.技能)) v2.技能 = [];
  if (!Array.isArray(v2.特质)) v2.特质 = [];

  // 特质每项：名称 / 稀有度 / 描述 / 加成（第 4 项可省略；库外特质可自填加成数字，无上限）
  v2.特质 = v2.特质.map((t, i) => {
    const o = t && typeof t === 'object' ? { ...t } : { 名称: String(t ?? '') };
    const name = String(o.名称 ?? '').trim();
    if (!name) { warns.push(`特质第 ${i + 1} 项缺名称，已忽略该项`); return null; }
    const addText = String(o.加成 ?? '').trim();
    if (addText && !Object.keys(parseAttrText(addText)).length) {
      warns.push(`特质「${name}」的加成「${addText}」读不出属性，已保留原文待核对`);
    }
    return { 名称: name, 稀有度: String(o.稀有度 ?? '').trim(), 描述: String(o.描述 ?? '').trim(), 加成: addText };
  }).filter(Boolean);
  for (const k of ['背景', '生平', '内心', '短期目标', '长期目标']) if (v2[k] == null) v2[k] = '';

  // 储物袋每项 8 字段
  v2.储物袋 = v2.储物袋.map((it, i) => {
    const o = it && typeof it === 'object' ? { ...it } : { 名称: String(it ?? '') };
    const name = String(o.名称 ?? '').trim();
    if (!name) { warns.push(`储物袋第 ${i + 1} 项缺名称，已忽略该项`); return null; }
    const typeRaw = String(o.类型 ?? '').trim();
    const type = (!typeRaw || !V2_ITEM_TYPES.includes(typeRaw)) ? '杂物' : typeRaw;
    if (!typeRaw) warns.push(`物品「${name}」缺类型，已按「杂物」记`);
    else if (type !== typeRaw) warns.push(`物品「${name}」的类型「${typeRaw}」不合法，已按「杂物」记`);
    const subtype = String(o.子类 ?? '').trim();
    if (type === '装备' && !V2_ITEM_SUBTYPES.includes(subtype)) {
      warns.push(`装备「${name}」的子类「${subtype}」不合法（应为 ${V2_ITEM_SUBTYPES.join(' / ')}），已保留原文待核对`);
    }
    const grade = parseGradeStrict(o.品阶) != null ? normalizeGrade(o.品阶) : '';
    if (!grade && String(o.品阶 ?? '').trim()) warns.push(`物品「${name}」的品阶「${o.品阶}」不合法，已保留原文待核对`);
    const attrText = String(o.属性 ?? '').trim();
    if (attrText && !Object.keys(parseAttrText(attrText)).length) {
      warns.push(`物品「${name}」的属性「${attrText}」格式不对，已保留原文待核对`);
    }
    return {
      名称: name,
      类型: type,
      子类: subtype,
      数量: Math.max(1, Math.floor(Number(o.数量 ?? 1) || 1)),
      品阶: grade || String(o.品阶 ?? ''),
      外观: String(o.外观 ?? ''),
      描述: String(o.描述 ?? ''),
      属性: attrText,
    };
  }).filter(Boolean);

  // 关系
  v2.关系 = v2.关系.map(r => ({
    对象: String(r?.对象 ?? '').trim(),
    身份: String(r?.身份 ?? '').trim(),
    好感: Math.round(Number(r?.好感 ?? 0) || 0),
  })).filter(r => r.对象);

  return { errors, warns, fixed: v2 };
}

/* ================= 十三、新增角色完整快照：硬编码模板 ================= */


/* ================= 十四、首遇即建档（阶段 1 的 <new_char> 块） ================= */
//
// 时序问题：新角色的快照原本只由**阶段 2（演化）**的 <新增角色> 生成，于是「首次登场那一回合」
// 的战斗卡（阶段 1 产物）结构上没有任何权威数值可抄，AI 只能现编 —— 而战斗协议又硬性要求
// 「卡面数字必须逐字照抄该角色状态栏里的值」，此时状态栏里根本没有这个人。
// 解法：让阶段 1 的正文 AI 在角色首次露面**之前**先输出一份建档块，程序当场落档；
// 同一次生成里先定数字、后写卡，卡面与档案天然同源；阶段 2 再把它当既有角色只写差异。
export const NEW_CHAR_OPEN = '<new_char>';
export const NEW_CHAR_CLOSE = '</new_char>';

/**
 * 从可见正文里摘掉建档块（它不给玩家看）。
 * 流式过程中块未闭合时，从 `<new_char>` 起整段先不显示，等闭合后继续。
 */
export function stripNewCharBlocks(text) {
  const s = String(text ?? '');
  let out = '';
  let i = 0;
  for (;;) {
    const a = s.indexOf(NEW_CHAR_OPEN, i);
    if (a < 0) {
      // 尾部可能只是**收到一半的开标签**（流式）——先不显示，等下一个分片补全；
      // 因为每次都是拿完整缓冲重算，这部分下一分片会原样补回来。
      let tail = s.slice(i);
      for (let k = NEW_CHAR_OPEN.length - 1; k >= 1; k--) {
        if (tail.endsWith(NEW_CHAR_OPEN.slice(0, k))) { tail = tail.slice(0, tail.length - k); break; }
      }
      out += tail;
      break;
    }
    out += s.slice(i, a);
    const b = s.indexOf(NEW_CHAR_CLOSE, a);
    if (b < 0) break; // 块还没闭合：从这里起整段不显示
    i = b + NEW_CHAR_CLOSE.length;
  }
  return out;
}

/**
 * 宽容 JSON：AI 写的建档块经常「不是严格合法 JSON」—— 被 ```json 围栏包住、尾逗号、
 * 单引号、裸键、全角引号冒号。这些都不该让整份档案作废，所以先修再解。
 * 与 battleTrigger 的 <battle> 指令共用这一份实现（那边从本模块导入，避免两套修法漂移）。
 * @returns {any|undefined} 解析成功返回值，失败返回 undefined
 */
export function looseJsonValue(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return undefined;
  const attempt = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
  let v = attempt(raw);
  if (v !== undefined) return v;
  let s = raw;
  s = s.replace(/^\s*```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');   // ```json … ```
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');                            // /* 块注释 */
  s = s.replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1');                    // // 行注释（不碰 :// 之类）
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");                  // 全角引号
  s = s.replace(/：/g, ':');                                          // 全角冒号
  s = s.replace(/,\s*([}\]])/g, '$1');                                // 尾逗号
  v = attempt(s);
  if (v !== undefined) return v;
  s = s.replace(/'([^'\\]*)'/g, '"$1"');                             // 单引号 → 双引号
  s = s.replace(/([{,]\s*)([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*:/g, '$1"$2":'); // 裸键
  return attempt(s);
}

/**
 * 解析正文里的建档块 → { init, rejected, repaired }。
 * init：通过校验、可直接落档的 v2 快照（键＝角色 ID）
 * rejected：真正没救的（连名字都没有 / 编号不合规），给提示用
 * repaired：**兜底放行**的（补过默认值才合格的），一并说明补了什么 —— 界面据此提示玩家去核对
 *
 * knownIds 里的角色已经建过档 —— 模型若整块重发，直接丢弃（此时它该写的是修改语句）。
 * fallbackNames：{ [id]: 名字 }，名称键全丢时用它兜底（调用方从正文的 ::dialogue 标记里认名字）。
 */
export function parseNewCharBlocks(text, { knownIds = [], fallbackNames = {} } = {}) {
  const known = new Set((knownIds || []).map(String));
  const init = {};
  const rejected = [];
  const repaired = [];
  const re = /<new_char>([\s\S]*?)<\/new_char>/gi;
  let m;
  while ((m = re.exec(String(text ?? '')))) {
    let obj = looseJsonValue(m[1]);
    if (obj === undefined || obj === null) { rejected.push('建档块不是合法 JSON（已尝试宽松修复）'); continue; }
    if (typeof obj !== 'object' || Array.isArray(obj)) { rejected.push('建档块内容不是对象'); continue; }
    for (const [rawId, v2] of Object.entries(obj)) {
      const id = String(rawId || '').trim();
      if (!/^[ABC]\d+$/.test(id)) { rejected.push(`角色编号「${id}」不合规（应形如 C1）`); continue; }
      if (known.has(id)) { rejected.push(`${id} 已建过档，重复的建档块已忽略`); continue; }
      const r = validateV2Snapshot(id, v2, { fallbackName: fallbackNames?.[id] });
      if (r.errors.length || !r.fixed) { rejected.push(`${id}：${r.errors[0] || '快照无效'}`); continue; }
      init[id] = r.fixed;
      if (r.warns.length) repaired.push(`${id}：${r.warns.slice(0, 3).join('；')}`);
    }
  }
  return { init, rejected, repaired };
}

/**
 * 从正文里认「某个角色 ID 的称呼」—— 建档保底（第三层）用。
 *
 * 战斗建局时若发现 <battle> 点名的 id 压根没有档案，至少得给他一个说得过去的称呼，
 * 否则名册与战报里只能印「C1」。可用的来源：
 *   ① 正文语义标记：::dialogue C1|wary|老药农  → 第三段就是「读者可见称呼」（协议规定）
 *   ② <battle> 指令里 AI 顺手写的 name / 姓名
 * 认不到就返回空，由调用方退回用 id 当称呼。
 */
export function nameFromStoryText(text, id) {
  const cid = String(id || '').trim();
  if (!cid) return '';
  const s = String(text ?? '');
  const esc = cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dlg = s.match(new RegExp(`::dialogue\\s+${esc}\\s*\\|\\s*[^|\\n]*\\|\\s*([^\\n]+)`, 'i'));
  if (dlg && String(dlg[1]).trim()) return String(dlg[1]).trim().replace(/[「」『』"'【】]/g, '').slice(0, 16);
  const alt = s.match(new RegExp(`["']id["']\\s*:\\s*["']${esc}["'][^}]*?["'](?:name|姓名)["']\\s*:\\s*["']([^"']+)["']`, 'i'));
  if (alt && String(alt[1]).trim()) return String(alt[1]).trim().slice(0, 16);
  return '';
}

/**
 * 兜底档案（建档保底的最后一道）：一个角色没能建档、却已经要参战时，由程序按
 * 「标准凡人」现造一份最小可用档 —— 宁可数值平庸，也不让剧情卡死在「剑已出鞘」。
 *
 * 数值取凡人基准（与 snapshotSchema.makeEmptySnapshot 的默认档同值）；罗列出来是为了
 * 即使角色被设为「豁免数值表」，这份档本身也是合理的，不会出现 0 血 0 攻的空壳。
 * 进战斗前的数值表校界会把它抬到该角色境界的下限（没豁免时）。
 * 带 recovered 标记 —— 界面据此提示玩家「这份档案是程序兜底的，请到角色名册核对补全」。
 */
export function fallbackV2Snapshot(id, opts = {}) {
  const v2 = emptyV2(id, opts.kind === 'player' ? 'player' : 'npc');
  v2.名称 = String(opts.name || id);
  v2.性别 = normGender(opts.gender || '男');
  v2.境界 = String(opts.realm || '凡人');
  v2.状态 = '一切正常';
  v2.气血 = '150/150';
  v2.法力 = '0/0';
  v2.物攻 = 15; v2.物防 = 12; v2.法攻 = 15; v2.法防 = 12;
  v2.神识 = 12; v2.脚力 = 12; v2.气运 = 5; v2.魅力 = 5;
  v2.动作 = '持械戒备';
  v2.地点 = String(opts.location || '');
  v2.坐标 = [0, 0];
  v2.recovered = true;
  return v2;
}

/** 全新角色的 v2 空骨架（键名与 NEW_CHAR_V2_TEMPLATE 完全一致；改 schema 忘改模板时校验会失败） */export function emptyV2(id = 'C1', kind = 'npc') {
  const 装备 = {};
  for (const s of V2_EQUIP_NAMED) 装备[s] = null;
  for (const s of V2_EQUIP_ARRAYS) 装备[s] = Array(V2_EQUIP_ARRAY_LEN).fill(null);
  return {
    id, kind,
    名称: '', 性别: '男', 种族: '人族', 境界: '凡人', 灵根: '无灵根',
    年龄: 0, 寿元: 80, 状态: '一切正常',
    气血: '0/0', 法力: '0/0',
    物攻: 0, 物防: 0, 法攻: 0, 法防: 0, 物理穿透: 0, 法术穿透: 0, 神识: 0, 脚力: 0, 气运: 0, 魅力: 0,
    会心: 5,   // 不给 0 —— 会心的默认底子是 5（百分点），缺省补 0 会把角色的暴击底子吃掉
    动作: '', 地点: '', 坐标: [0, 0], 灵石: 0,
    储物袋: [], 装备, 关系: [],
    背景: '', 生平: '', 内心: '', 短期目标: '', 长期目标: '',
    技能: [], 特质: [],
  };
}
