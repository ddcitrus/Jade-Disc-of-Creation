// ===== Mortal 协议指令解析器（state / upstore → 快照字段） =====
// 背景：concurrent-evo-preset 用 <state>/<upstore> 标签输出「逐行指令」（add/addSkill/addTrait/
// rel./cr./hp./mp./loc./role./pr./npc.ID={...}/character.* 路径赋值…）。本系统把这些标签桥接成
// 快照的 stateCommands / upstoreCommands 字符串字段，但此前只做原样保存与展示，
// 从未回写进快照本身 —— 于是角色名册里「技能 / 特质 / 储物袋 / 背景 / 内心 / 目标 / 关系 / 灵石」
// 永远是空的，装备槽还会漏出 Mortal 内部实例 id（I_C1_01）。
//
// 本模块把指令解析并投影到快照字段，作为「演化落盘」的一环，纯函数、无副作用、可单测。
//
// 支持：
//   add("C1", {"10":"背景","12":"内心","16":"动作|穿着|位置|身段|样貌","27":"动机",...})
//   npc.C1 = {n,r,p,lg,bg,act,apAge,yrr}          （简写键 → 同一套列投影）
//   addSkill / deSkill / addTrait / deTrait
//   rel.C1.B1 = 标签|好感|备注|认知
//   cr.C1 = 筑基初期/37  ·  cr.C1.p = 42  ·  cr.C1.p += 5
//   hp.C1 = 80  ·  mp.C1 -= 10
//   loc.C1 = 地点|3278,1925  ·  role.C1 = 散修  ·  ca.C1.alchemy = 精通/40
//   pr.C1 = 换装 | 保持脸型
//   character.C1.identity.appearanceAge = 10      （通用路径赋值，带字段白名单）
//   destroyItem / consumeItem({owner,itemId,quantity})
// 忽略（交给其它阶段/系统）：beasts.* / settleNpcCultivation / authorizeNpcCultivationEvent /
//   createItem / transferItem / equipItem / unequipItem / updateItem（物品实例系统不在本层落地）

// 储物袋口径与本层其它代码一致：储物袋 = 「拥有清单」，数量含穿在身上的那件。
// 所以穿 / 脱装备都不改数量（用 ensureInvEntry 保证清单里有这条），只有消耗 / 转出才真的减。
import { ensureInvEntry } from '../data/snapshotSchema.js';

// ---------- 通用小工具 ----------
const isPlainObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

function getPath(obj, path) {
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (!isPlainObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!isPlainObj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return true;
}

function deepMergeInto(base, patch) {
  const out = isPlainObj(base) ? { ...base } : {};
  if (!isPlainObj(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) continue;
    out[k] = isPlainObj(v) && isPlainObj(out[k]) ? deepMergeInto(out[k], v) : v;
  }
  return out;
}

const num = v => {
  const n = Number(String(v).replace(/[+＋]/g, '').trim());
  return Number.isFinite(n) ? n : null;
};

// ---------- 宽松 JSON（Mortal 指令里的 `{n:"x", apAge:8}` 不是合法 JSON） ----------
// 逐字符扫描：单引号字符串归一为双引号；处于「键位置」的裸标识符加引号。
export function looseToJson(text) {
  if (text == null) return null;
  let s = String(text).trim().replace(/;+\s*$/, '');
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* 继续宽松处理 */ }

  const out = [];
  let i = 0;
  let depth = 0;
  let lastSig = ''; // 最近一个有意义的字符（用于判断是否处于键位置）
  const isIdentStart = ch => /[A-Za-z_$\u4e00-\u9fa5]/.test(ch);
  const isIdentChar = ch => /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(ch);
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      // 字符串：统一用双引号输出，内部的 " 转义
      const quote = ch;
      let buf = '';
      i++;
      while (i < s.length) {
        const c = s[i];
        if (c === '\\') { buf += s[i + 1] === quote ? quote : c + (s[i + 1] ?? ''); i += 2; continue; }
        if (c === quote) { i++; break; }
        buf += c === '"' ? '\\"' : c;
        i++;
      }
      out.push('"' + buf + '"');
      lastSig = '"';
      continue;
    }
    if (ch === '{' || ch === '[') { depth++; out.push(ch); lastSig = ch; i++; continue; }
    if (ch === '}' || ch === ']') { depth = Math.max(0, depth - 1); out.push(ch); lastSig = ch; i++; continue; }
    if (ch === ':') { out.push(ch); lastSig = ':'; i++; continue; }
    if (ch === ',') { out.push(ch); lastSig = ','; i++; continue; }
    if (/\s/.test(ch)) { out.push(ch); i++; continue; }
    if (isIdentStart(ch) && (lastSig === '{' || lastSig === ',')) {
      let buf = '';
      while (i < s.length && isIdentChar(s[i])) { buf += s[i]; i++; }
      out.push('"' + buf + '"');
      lastSig = '"';
      continue;
    }
    out.push(ch);
    lastSig = ch;
    i++;
  }
  try { return JSON.parse(out.join('')); } catch { return null; }
}

// 值：对象/数组（宽松 JSON）→ 字面量；引号字符串 → 字符串；数字 → number；否则原文本
export function parseCommandValue(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const obj = looseToJson(raw);
    if (obj !== null) return obj;
  }
  if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) return raw.slice(1, -1);
  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

// ---------- 指令切分（一条指令可能跨行：JSON 对象换行输出） ----------
export function splitCommandLines(text) {
  const lines = Array.isArray(text) ? text.map(String) : String(text ?? '').split(/\r?\n/);
  const out = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (const rawLine of lines) {
    const line = String(rawLine ?? '').trim();
    if (!line) continue;
    if (!buf && (line.startsWith('//') || line.startsWith('#'))) continue; // 注释行
    buf = buf ? `${buf}\n${line}` : line;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && !quote) { out.push(buf); buf = ''; depth = 0; }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

// 顶层逗号切分（考虑引号与嵌套）
function splitTopLevel(text, sep = ',') {
  const parts = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === '\\') { buf += text[i + 1] ?? ''; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '{' || ch === '(' || ch === '[') { depth++; buf += ch; continue; }
    if (ch === '}' || ch === ')' || ch === ']') { depth--; buf += ch; continue; }
    if (ch === sep && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts.map(s => s.trim()).filter(s => s !== '');
}

const CALL_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/;
const ASSIGN_RE = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_$\u4e00-\u9fa5]+)*)\s*(\+=|-=|=)\s*([\s\S]+)$/;

// 解析单条指令 → { type:'call'|'assign', ... }
export function parseCommand(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return null;
  const call = raw.match(CALL_RE);
  if (call) {
    const args = splitTopLevel(call[2]);
    return { type: 'call', name: call[1], args: args.map(parseCommandValue), rawArgs: args, raw };
  }
  const asg = raw.match(ASSIGN_RE);
  if (asg) {
    return { type: 'assign', target: asg[1], op: asg[2], value: parseCommandValue(asg[3]), raw };
  }
  return { type: 'unknown', raw };
}

// ---------- 指令文本 → 指令数组 ----------
export function parseMortalCommands(text) {
  return splitCommandLines(text).map(parseCommand).filter(Boolean);
}

// ---------- Mortal 列 → 快照字段 ----------
// 列定义出自 concurrent 预设「NPC基础信息列 / NPC心理与社交列 / NPC经济与目标列」
export const NPC_COLUMN_FIELDS = {
  '1': { composed: 'nameGender' },
  '2': { composed: 'realmRole' },
  '3': { path: 'identity.personality' },
  '4': { composed: 'status' },
  '5': { path: 'identity.linggen' },
  '6': { path: 'identity.specialConstitution' },
  '7': { path: 'identity.appellation' },
  '9': { composed: 'note' },
  '10': { path: 'bio.background' },
  '12': { path: 'bio.innerThought' },
  '16': { composed: 'action' },
  '19': { path: 'portraitPrompt' },
  '26': { path: 'economy.spiritStones', type: 'number' },
  '27': { path: 'bio.currentMotive' },
  '28': { path: 'bio.shortTermGoal' },
  '29': { path: 'bio.longTermGoal' },
  '30': { skip: true },   // 专属灵兽列表 → beast 域
  '31': { path: 'status.inBattle', type: 'boolean' },
  '34': { path: 'action.appearance' },
};

// 列中文名（名册「Mortal 原始列」卡片展示用）
export const NPC_COLUMN_LABELS = {
  '0': 'ID', '1': '名字|性别', '2': '境界|身份', '3': '性格', '4': '当前状态/Buffs',
  '5': '灵根', '6': '特殊体质', '7': '对玩家称呼', '9': '备注', '10': '背景/简介',
  '12': '内心想法/动机', '13': '人际关系（镜像·只读）', '15': '好感度（镜像·只读）',
  '16': '动作|穿着|位置|身段|样貌', '19': '画像提示', '21': '身体/隐秘状态', '22': '欲望值', '23': '愉悦值',
  '26': '当前灵石', '27': '当前动机', '28': '短期目标', '29': '长期目标',
  '30': '专属灵兽', '31': '战斗状态', '34': '容貌与身姿',
};

// `npc.C1 = {n,r,p,lg,bg,act,apAge,yrr,...}` 简写键 → 列
export const NPC_SHORT_KEYS = {
  n: '1', r: '2', p: '3', st: '4', lg: '5', sp: '6', ad: '7', note: '9',
  bg: '10', inner: '12', act: '16', img: '19', money: '26', m: '27', s: '28', l: '29', app: '34',
};

// 技能 category（英文枚举）→ 中文类别，用于快照页「品级/类别」显示
const SKILL_CATEGORY_ZH = {
  spell: '法术', martial: '武技', movement: '身法', body: '炼体',
  passive: '被动', support: '辅助', auxiliary: '辅助', technique: '功法', divine: '神通',
};

// ---------- 物品指令（createItem / equipItem / transferItem 等）支持 ----------
// item_management 阶段用 DEF/OWN/FAC 定义 + I_* 实例描述物品，本系统没有定义库，
// 所以把「本批次」的 createItem 收集成临时注册表（alias → 物品对象），
// 同批次的 equipItem / transferItem / consumeItem 就能解析出可读物品名。
const CN_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const RARITY_TIER_ZH = { ren: '人阶', di: '地阶', xuan: '玄阶', huang: '黄阶', tian: '天阶', xian: '仙阶' };
// Mortal category → 系统物品大类（INV_ITEM_TYPES）+ 保留原值作子类（槽位兼容匹配用「武器/防具」这类词）
const ITEM_CATEGORY_TO_TYPE = {
  武器: '装备', 防具: '装备', 装备: '装备', 法宝: '法宝', 功法: '功法', 秘籍: '功法',
  材料: '素材', 素材: '素材', 丹药: '消耗品', 消耗品: '消耗品', 消费: '消耗品',
  重要物品: '珍贵物品', 珍贵物品: '珍贵物品', 任务物品: '珍贵物品',
};

export function renderItemGrade(def) {
  const num = def?.numeric || {};
  const n = Number(num.grade);
  const tier = RARITY_TIER_ZH[num.rarityTier] || '';
  const g = Number.isFinite(n) && n > 0 ? `${CN_NUM[n] || n}品` : '';
  return `${g}${tier}`;
}

// createItem / definition → 系统物品条目
export function itemFromDefinition(def, { name, quantity = 1, acquisition = '', fallbackId = '' } = {}) {
  const category = def?.category || '';
  const desc = [def?.description, def?.effect].filter(Boolean).join('；');
  return {
    id: fallbackId || name,
    definitionId: fallbackId || name,
    name: name || def?.name || fallbackId || '未知物品',
    quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
    type: ITEM_CATEGORY_TO_TYPE[category] || '杂物',
    subtype: category || '',
    grade: renderItemGrade(def),
    appearance: def?.appearance || '',
    desc,
    mods: null,
    lots: acquisition ? [{ id: `${name}:lot`, quantity: Math.max(1, Math.floor(Number(quantity) || 1)), source: acquisition }] : [],
  };
}

// 装备槽定位：weaponHand / armorPart / category+slotIndex
function writeEquipSlot(snap, item, opts) {
  if (!isPlainObj(snap.equipment)) snap.equipment = {};
  const eq = { ...snap.equipment };
  const obj = {
    name: item.name, type: item.type || '装备', subtype: item.subtype || '', grade: item.grade || '',
    appearance: item.appearance || '', desc: item.desc || '', mods: item.mods || null, quantity: 1,
  };
  const hand = opts.weaponHand || opts.hand;
  const part = opts.armorPart || opts.part;
  if (hand) {
    eq.weapon = { ...(isPlainObj(eq.weapon) ? eq.weapon : { right: null, left: null }), [hand === 'left' ? 'left' : 'right']: obj };
    snap.equipment = eq;
    return `weapon.${hand}`;
  }
  if (part) {
    const keys = ['head', 'inner', 'armor', 'hands', 'legs', 'feet', 'cloak', 'underwear'];
    const key = keys.includes(part) ? part : 'armor';
    eq.armor = { ...(isPlainObj(eq.armor) ? eq.armor : {}), [key]: obj };
    snap.equipment = eq;
    return `armor.${key}`;
  }
  // 饰品 / 法宝 / 功法 走编号槽数组
  const cat = String(opts.category || item.subtype || '');
  const group = cat.includes('饰品') ? 'accessory' : cat.includes('法宝') ? 'treasure' : cat.includes('功法') ? 'technique' : 'accessory';
  const idx = Math.max(0, Math.min(5, Number(opts.slotIndex) || 0));
  const arr = Array.isArray(eq[group]) ? [...eq[group]] : [null, null, null, null, null, null];
  arr[idx] = obj;
  eq[group] = arr;
  snap.equipment = eq;
  return `${group}[${idx}]`;
}

// 单列值 → 快照字段写入。返回 applied 描述数组（未命中返回空数组）
function applyColumn(snap, col, value, applied) {
  const def = NPC_COLUMN_FIELDS[String(col)];
  // 原始列值始终留档在 legacy.columns（可追溯，快照页「Mortal 原始列」可见）
  if (!isPlainObj(snap.legacy)) snap.legacy = { columns: {}, isOnscreen: true };
  if (!isPlainObj(snap.legacy.columns)) snap.legacy.columns = {};
  snap.legacy.columns[String(col)] = value;

  if (!def || def.skip) return applied;

  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '' || text == null) return applied;

  if (def.path) {
    const v = def.type === 'number' ? (num(text) ?? text) : (def.type === 'boolean' ? !!text : text);
    setPath(snap, def.path, v);
    applied.push(`${def.path} ⇒ ${String(v).slice(0, 30)}`);
    return applied;
  }

  const seg = String(text).split('|').map(s => s.trim());

  if (def.composed === 'nameGender') {
    if (seg[0]) { snap.identity.name = seg[0]; applied.push(`identity.name ⇒ ${seg[0]}`); }
    if (seg[1]) { snap.identity.gender = seg[1]; applied.push(`identity.gender ⇒ ${seg[1]}`); }
  } else if (def.composed === 'realmRole') {
    if (seg[0]) { snap.identity.realm = seg[0]; applied.push(`identity.realm ⇒ ${seg[0]}`); }
    // 第 2 列的身份段：身份履历由 role./identity 指令单独维护，这里只留档不擅自追加
    if (seg[1]) applied.push(`身份（留档）⇒ ${seg[1]}`);
  } else if (def.composed === 'status') {
    if (isPlainObj(value)) {
      snap.status = deepMergeInto(snap.status, value);
      applied.push('status ⇐ 对象');
    } else {
      snap.status = { ...(snap.status || {}), current: text };
      applied.push(`status.current ⇒ ${String(text).slice(0, 24)}`);
    }
  } else if (def.composed === 'note') {
    if (isPlainObj(value)) {
      snap.legacy.notes = deepMergeInto(snap.legacy.notes, value);
      // 备注列里的额外寿元是明确的独立字段
      const extra = num(value['额外寿元'] ?? value.extraShouyuan);
      if (extra != null) { snap.identity.extraShouyuan = extra; applied.push(`identity.extraShouyuan ⇒ ${extra}`); }
      const birth = num(value['出生年份'] ?? value.birthYear);
      if (birth != null && !snap.identity.birthYear) { snap.identity.birthYear = birth; applied.push(`identity.birthYear ⇒ ${birth}`); }
      applied.push('legacy.notes ⇐ 对象');
    }
  } else if (def.composed === 'action') {
    // 第16列：动作|穿着|位置(含坐标)|身段|样貌
    const act = { ...(snap.action || {}) };
    if (seg[0]) act.action = seg[0];
    if (seg[1]) act.attire = seg[1];
    if (seg[2]) {
      const m = seg[2].match(/^(.*?)[\s|]*(-?\d+)\s*,\s*(-?\d+)\s*$/);
      if (m && m[1].trim() && !/^[XYxy],[XYxy]$/.test(seg[2])) {
        act.location = m[1].trim();
        act.coordinates = [Number(m[2]), Number(m[3])];
      } else if (!/^[-?\dXYxy,\s]+$/.test(seg[2])) {
        act.location = seg[2];
      }
    }
    if (seg[3]) act.figure = seg[3];
    if (seg[4]) act.appearance = seg[4];
    snap.action = act;
    applied.push('action ⇐ 第16列');
  }
  return applied;
}

// 从装备槽卸下（按槽内物品名 / id 匹配），返回被卸下的物品对象（无匹配返回 null）
function takeOffSlot(snap, key) {
  const eq = snap.equipment;
  if (!isPlainObj(eq) || !key) return null;
  const match = (v) => isPlainObj(v) && [v.name, v.id, v.definitionId].some(x => x && String(x) === String(key));
  let taken = null;
  const next = { ...eq };
  for (const [group, val] of Object.entries(eq)) {
    if (Array.isArray(val)) {
      next[group] = val.map(v => { if (match(v)) { taken = taken || v; return null; } return v; });
    } else if (isPlainObj(val)) {
      const g = {};
      for (const [k, v] of Object.entries(val)) {
        if (match(v)) { taken = taken || v; g[k] = null; } else g[k] = v;
      }
      next[group] = g;
    } else if (typeof val === 'string' && val === key) {
      taken = taken || { name: val }; next[group] = null;
    }
  }
  snap.equipment = next;
  return taken;
}

// ---------- 单条指令应用 ----------
function applyCall(snap, cmd, applied, skipped, ctx) {
  const { name, args } = cmd;
  const id = args[0] == null ? '' : String(args[0]).trim();
  const mine = !id || id === snap.id || id === snap.identity?.name;

  switch (name) {
    case 'add': {
      if (!mine) { skipped.push(`${cmd.raw.slice(0, 40)}（非当前角色 ${id}）`); return; }
      const obj = args[1];
      if (!isPlainObj(obj)) { skipped.push('指令格式无法解析：' + cmd.raw.slice(0, 60)); return; }
      for (const [col, val] of Object.entries(obj)) applyColumn(snap, col, val, applied);
      return;
    }
    case 'addSkill':
    case 'addSkills': {
      if (!mine) { skipped.push(`${cmd.raw.slice(0, 40)}（非当前角色 ${id}）`); return; }
      const list = Array.isArray(args[1]) ? args[1] : [args[1]];
      const skills = Array.isArray(snap.skills) ? [...snap.skills] : [];
      for (const raw of list) {
        const s = isPlainObj(raw) ? raw : (typeof raw === 'string' ? { name: raw } : null);
        if (!s) continue;
        // 字段名与 skillCodex 对齐（type/grade/dmgKind/effect）；数值不在这里写，
        // 由 skillCodex 在读取该快照时按品阶现算，避免本模块引入依赖。
        // dmgKind = 伤害属性（物/法），由 AI 手填，本层只透传不做推断。
        const item = {
          id: s.id || s.name || '',
          name: s.name || s.id || '未知技能',
          type: s.type || '',
          dmgKind: s.dmgKind || s.伤害属性 || '',
          grade: s.grade || s.tier || SKILL_CATEGORY_ZH[s.category] || s.category || '',
          effect: s.effect || s.description || s.desc || '',
          level: s.level ?? s.tm ?? null,
          category: s.category || '',
          numeric: s.numeric || null,
        };
        const hit = skills.findIndex(x => (item.id && (x.id === item.id || x.name === item.name)) || (!item.id && x.name === item.name));
        if (hit >= 0) skills[hit] = { ...skills[hit], ...item };
        else skills.push(item);
        applied.push(`技能「${item.name}」`);
      }
      snap.skills = skills;
      return;
    }
    case 'deSkill':
    case 'removeSkill': {
      if (!mine) return;
      const key = String(args[1] ?? '').trim();
      if (!key) return;
      const before = Array.isArray(snap.skills) ? snap.skills.length : 0;
      snap.skills = (snap.skills || []).filter(s => String(s?.id ?? '') !== key && String(s?.name ?? '') !== key);
      if (snap.skills.length !== before) applied.push(`删除技能「${key}」`);
      return;
    }
    case 'addTrait':
    case 'addTraits': {
      if (!mine) { skipped.push(`${cmd.raw.slice(0, 40)}（非当前角色 ${id}）`); return; }
      const list = Array.isArray(args[1]) ? args[1] : [args[1]];
      const traits = Array.isArray(snap.traits) ? [...snap.traits] : [];
      for (const raw of list) {
        const t = isPlainObj(raw) ? raw : (typeof raw === 'string' ? { name: raw } : null);
        if (!t) continue;
        const item = {
          name: t.name || '未知特质',
          rarity: t.rarity || '普通',
          desc: t.desc || t.description || '',
          effects: t.effects || '',
          mods: isPlainObj(t.mods) ? t.mods : null,
          numeric: t.numeric || null,
        };
        const hit = traits.findIndex(x => x?.name === item.name);
        if (hit >= 0) traits[hit] = { ...traits[hit], ...item };
        else traits.push(item);
        applied.push(`特质「${item.name}」`);
      }
      snap.traits = traits;
      return;
    }
    case 'deTrait':
    case 'removeTrait': {
      if (!mine) return;
      const key = String(args[1] ?? '').trim();
      if (!key) return;
      const before = Array.isArray(snap.traits) ? snap.traits.length : 0;
      snap.traits = (snap.traits || []).filter(t => String(t?.name ?? '') !== key);
      if (snap.traits.length !== before) applied.push(`删除特质「${key}」`);
      return;
    }
    case 'destroyItem':
    case 'consumeItem': {
      const obj = args[0];
      if (!isPlainObj(obj)) { skipped.push('指令格式无法解析：' + cmd.raw.slice(0, 60)); return; }
      const owner = String(obj.owner ?? obj.characterId ?? snap.id);
      if (owner !== snap.id && owner !== snap.identity?.name) { skipped.push(`物品指令非当前角色 ${owner}`); return; }
      const key = String(obj.itemId ?? obj.id ?? obj.name ?? '');
      const qty = Math.max(1, Math.floor(Number(obj.quantity ?? 1) || 1));
      const inv = Array.isArray(snap.inventory) ? [...snap.inventory] : [];
      const idx = inv.findIndex(it => it && typeof it === 'object'
        && [it.id, it.definitionId, it.name].some(v => v && String(v) === key));
      if (idx < 0) { skipped.push(`储物袋里没有「${key}」，消耗未生效`); return; }
      const cur = Math.max(1, Math.floor(Number(inv[idx].quantity ?? 1) || 1)) - qty;
      if (cur > 0) inv[idx] = { ...inv[idx], quantity: cur };
      else {
        const gone = inv[idx];
        inv.splice(idx, 1);
        // 数量归零 → 身上若还穿着它，一并脱下，否则会出现「身上穿着一个已经不存在的东西」
        const nm = String(gone?.name || key);
        if (takeOffSlot(snap, nm)) applied.push(`「${nm}」已用尽，同时从装备栏脱下`);
      }
      snap.inventory = inv;
      applied.push(`${name === 'consumeItem' ? '消耗' : '销毁'}「${key}」×${qty}`);
      return;
    }
    case 'createItem': {
      const obj = args[0];
      if (!isPlainObj(obj)) { skipped.push('指令格式无法解析：' + cmd.raw.slice(0, 60)); return; }
      const owner = String(obj.owner ?? obj.characterId ?? '');
      const alias = String(obj.instanceAlias ?? obj.alias ?? '');
      const def = isPlainObj(obj.definition) ? obj.definition : null;
      const nm = (def && def.name) || obj.name || '';
      let item = null;
      if (nm) {
        item = itemFromDefinition(def || {}, {
          name: nm, quantity: obj.quantity, acquisition: obj.acquisition,
          fallbackId: alias || obj.definitionRef || nm,
        });
      } else if (alias) {
        item = { id: alias, definitionId: obj.definitionRef || alias, name: alias, quantity: 1, type: '杂物', subtype: '', desc: '' };
      }
      // 本批次注册表：供同批次的 equipItem / transferItem / destroyItem 解析出可读名称
      ctx.registry.set(alias || String(obj.definitionRef || nm), { ...(item || { name: nm || alias }), _owner: owner });
      if (!item) { skipped.push(`新增物品缺少名称，未能放进储物袋`); return; }
      if (owner && owner !== snap.id && owner !== snap.identity?.name) {
        skipped.push(`createItem 归属 ${owner}，写入其自身快照`);
        return;
      }
      const inv = Array.isArray(snap.inventory) ? [...snap.inventory] : [];
      // 幂等键：同批次重放/重复回填不叠加数量；不同批次同一物品则按定义复用累加
      const key = `${item.name}|${alias}|${obj.acquisition || ''}`;
      const exact = inv.findIndex(x => x && typeof x === 'object' && x.srcKey === key);
      if (exact >= 0) { skipped.push(`物品「${item.name}」本回合已登记过，未重复添加`); return; }
      const same = inv.findIndex(x => x && typeof x === 'object'
        && x.name === item.name && String(x.definitionId || '') === String(item.definitionId || ''));
      if (same >= 0) {
        inv[same] = { ...inv[same], quantity: Math.max(1, Math.floor(Number(inv[same].quantity) || 1)) + item.quantity };
      } else {
        inv.push({ ...item, srcKey: key });
      }
      snap.inventory = inv;
      applied.push(`物品「${item.name}」×${item.quantity}${item.grade ? `（${item.grade}）` : ''}`);
      return;
    }
    case 'equipItem': {
      const obj = args[0];
      if (!isPlainObj(obj)) { skipped.push('指令格式无法解析：' + cmd.raw.slice(0, 60)); return; }
      const owner = String(obj.owner ?? obj.characterId ?? '');
      if (owner && owner !== snap.id && owner !== snap.identity?.name) return;
      const key = String(obj.itemId ?? obj.id ?? obj.targetAlias ?? '');
      const hit = ctx.registry.get(key)
        || (snap.inventory || []).find(it => it && typeof it === 'object'
          && [it.id, it.definitionId, it.name].some(v => v && String(v) === key));
      if (!hit || !hit.name) {
        skipped.push(`要穿的「${key || '?'}」本回合没有出现，未穿上`);
        return;
      }
      const where = writeEquipSlot(snap, hit, obj);
      // 储物袋 = 拥有清单：穿上不改数量，只保证清单里有这条（AI 常只写装备槽、忘记登记储物袋）
      snap.inventory = ensureInvEntry(snap.inventory, { ...hit, source: (hit.lots && hit.lots[0] && hit.lots[0].source) || '装备补登' });
      applied.push(`装备「${hit.name}」→ ${where}`);
      return;
    }
    case 'unequipItem': {
      const obj = args[0];
      if (!isPlainObj(obj)) { skipped.push('指令格式无法解析：' + cmd.raw.slice(0, 60)); return; }
      const owner = String(obj.owner ?? obj.characterId ?? '');
      if (owner && owner !== snap.id && owner !== snap.identity?.name) return;
      const key = String(obj.itemId ?? obj.id ?? obj.name ?? '');
      const removed = takeOffSlot(snap, key);
      if (!removed) { skipped.push(`身上没穿「${key || '?'}」，无需卸下`); return; }
      const nm = String(removed.name || key);
      // 数量不动：储物袋里那条本来就是这件，脱下只是不再穿在身上
      snap.inventory = ensureInvEntry(snap.inventory, { ...removed, name: nm, source: '卸下补登' });
      applied.push(`卸下「${nm}」，物品仍在储物袋`);
      return;
    }
    case 'transferItem': {
      const obj = args[0];
      if (!isPlainObj(obj)) { skipped.push('指令格式无法解析：' + cmd.raw.slice(0, 60)); return; }
      const from = String(obj.from ?? '');
      const to = String(obj.to ?? '');
      const key = String(obj.itemId ?? obj.id ?? '');
      const qty = Math.max(1, Math.floor(Number(obj.quantity ?? 1) || 1));
      const meFrom = from && (from === snap.id || from === snap.identity?.name);
      const meTo = to && (to === snap.id || to === snap.identity?.name);
      if (meFrom) {
        const item = (snap.inventory || []).find(it => it && typeof it === 'object'
          && [it.id, it.definitionId, it.name].some(v => v && String(v) === key));
        if (!item) { skipped.push(`储物袋里没有「${key}」，未能转出`); return; }
        const left = Math.max(1, Math.floor(Number(item.quantity) || 1)) - qty;
        const inv = (snap.inventory || []).filter(x => x !== item);
        if (left > 0) inv.push({ ...item, quantity: left });
        // 全部转出 → 身上若还穿着它，一并脱下（转出去的东西不可能还穿在身上）
        else takeOffSlot(snap, item.name);
        snap.inventory = inv;
        applied.push(`转出「${item.name}」×${qty} → ${to}`);
        return;
      }
      if (meTo) {
        const src = ctx.registry.get(key) || (obj.targetAlias ? ctx.registry.get(String(obj.targetAlias)) : null);
        if (!src || !src.name) {
          skipped.push(`转入的「${key}」剧情里没写明是什么物品，未记录`);
          return;
        }
        const item = { ...src, quantity: qty };
        delete item._owner;
        const inv = [...(snap.inventory || []), { ...item, lots: obj.acquisition ? [{ id: `${item.name}:lot:${obj.acquisition}`, quantity: qty, source: obj.acquisition }] : [] }];
        snap.inventory = inv;
        applied.push(`获得「${item.name}」×${qty}（${obj.acquisition || '转入'}）`);
        return;
      }
      skipped.push(`这件物品的转移与本角色无关`);
      return;
    }
    case 'transferSpiritStones': {
      const obj = args[0];
      if (!isPlainObj(obj)) { skipped.push('指令格式无法解析：' + cmd.raw.slice(0, 60)); return; }
      const from = String(obj.from ?? '');
      const to = String(obj.to ?? '');
      const amount = Math.floor(Number(obj.amount ?? obj.quantity ?? 0) || 0);
      if (!amount) { skipped.push('灵石转移数量为 0'); return; }
      const eco = { ...(snap.economy || {}) };
      const cur = Number(eco.spiritStones) || 0;
      if (from && (from === snap.id || from === snap.identity?.name)) { eco.spiritStones = Math.max(0, cur - amount); }
      else if (to && (to === snap.id || to === snap.identity?.name)) { eco.spiritStones = cur + amount; }
      else { skipped.push(`灵石转移与本角色无关`); return; }
      snap.economy = eco;
      applied.push(`灵石 ⇒ ${eco.spiritStones}`);
      return;
    }
    case 'settleNpcCultivation':
    case 'authorizeNpcCultivationEvent':
    case 'de':
    case 'updateItem':
    case 'updateItemQuantity':
      skipped.push(`${name} 由对应模块单独更新，此处不重复处理`);
      return;
    default:
      skipped.push(`无法识别的指令 ${name}(...)（可能是 AI 写错了格式）`);
  }
}

function applyAssign(snap, cmd, applied, skipped) {
  const { target, op, value } = cmd;
  const parts = String(target).split('.');
  const head = parts[0];

  // 带角色 ID 的指令族：第二段就是 owner（cr.C1 / rel.C1.B1 / character.C1.xxx）
  const OWNER_HEADS = ['cr', 'hp', 'mp', 'loc', 'rel', 'role', 'pr', 'ca', 'npc', 'beasts', 'character', 'characters'];
  const ownerId = OWNER_HEADS.includes(head) ? (parts[1] || '') : '';
  // 灵兽字段属于 Beast 数据域，任何情况下都不写进人物快照
  if (head === 'beasts') { skipped.push('灵兽信息由灵兽模块更新，此处跳过'); return; }
  const mine = !ownerId || ownerId === snap.id || ownerId === snap.identity?.name;
  if (!mine) { skipped.push(`${cmd.raw.slice(0, 40)}（非当前角色 ${ownerId}）`); return; }

  switch (head) {
    case 'cr': {
      // cr.C1 = 境界/进度  |  cr.C1.p = 42  |  cr.C1.p += 5
      // 修为进度只住 identity.realmProgress 一格（主角与 NPC 同一口径；主角原有的
      // player.progress 抽屉已于 2026-09-22 废弃）。读取必须只看这一格 —— 原先「先看
      // identity 再看 player」的写法里，identity.realmProgress 的默认值是 0 而不是空值，
      // `??` 永远不会回落到 player，于是每次都从 0 起算再覆盖写回，`+=` 既不累加、
      // 还会把已有进度吃成增量本身（历史 bug）。
      if (parts[2] === 'p' || parts[2] === 'progress') {
        const cur = Number(snap.identity?.realmProgress) || 0;
        const v = value === '' ? cur : (num(value) ?? cur);
        const next = op === '+=' ? cur + v : op === '-=' ? cur - v : v;
        setPath(snap, 'identity.realmProgress', next);
        applied.push(`修为进度 ⇒ ${next}`);
        return;
      }
      const seg = String(value).split('/');
      if (seg[0]) { snap.identity.realm = seg[0].trim(); applied.push(`境界 ⇒ ${seg[0].trim()}`); }
      if (seg[1] != null && seg[1] !== '') {
        const p = num(seg[1]);
        if (p != null) {
          setPath(snap, 'identity.realmProgress', p);
          applied.push(`修为进度 ⇒ ${p}`);
        }
      }
      return;
    }
    case 'hp':
    case 'mp': {
      const key = head;
      const cur = Number(getPath(snap, `stats.${key}.current`) ?? 0) || 0;
      const max = num(getPath(snap, `stats.${key}.max`));
      const v = num(value);
      if (v == null) return;
      let next = op === '+=' ? cur + v : op === '-=' ? cur - v : v;
      if (max != null) next = Math.max(0, Math.min(max, next));
      else next = Math.max(0, next);
      setPath(snap, `stats.${key}.current`, next);
      setPath(snap, `resources.${key}.current`, next);
      if (max != null) setPath(snap, `resources.${key}.max`, max);
      applied.push(`${key.toUpperCase()} ⇒ ${next}`);
      return;
    }
    case 'loc': {
      const seg = String(value).split('|');
      const act = { ...(snap.action || {}) };
      if (seg[0] && !/^[XYxy]+$/.test(seg[0].trim())) act.location = seg[0].trim();
      if (seg[1]) {
        const m = String(seg[1]).match(/(-?\d+)\s*,\s*(-?\d+)/);
        if (m) act.coordinates = [Number(m[1]), Number(m[2])];
      }
      snap.action = act;
      applied.push(`位置 ⇒ ${act.location || ''}`);
      return;
    }
    case 'rel': {
      // rel.源.目标 = 标签|好感|备注|认知   （空段表示不改）
      const targetId = parts[2] || '';
      if (!targetId) return;
      const seg = String(value).split('|');
      if (seg.length === 1 && /^[^|]*$/.test(seg[0]) && !seg[0]) return;
      const bio = { ...(snap.bio || {}) };
      const list = Array.isArray(bio.rawRelations) ? [...bio.rawRelations] : [];
      const hit = list.findIndex(r => r && String(r.targetId) === targetId);
      const prev = hit >= 0 ? list[hit] : {};
      const nextRel = { ...prev, targetId };
      if (seg[0] !== undefined && seg[0].trim() !== '') nextRel.label = seg[0].trim();
      if (seg[1] !== undefined && seg[1].trim() !== '') {
        const f = num(seg[1]);
        if (f != null) nextRel.favorability = f;
      }
      if (seg[2] !== undefined && seg[2].trim() !== '') nextRel.desc = seg[2].trim();
      if (seg[3] !== undefined && seg[3].trim() !== '') nextRel.cognition = seg[3].trim();
      if (hit >= 0) list[hit] = nextRel; else list.push(nextRel);
      bio.rawRelations = list;
      snap.bio = bio;
      applied.push(`关系 ${targetId} ⇒ ${nextRel.label || ''}${nextRel.favorability != null ? `（好感 ${nextRel.favorability}）` : ''}`);
      return;
    }
    case 'role': {
      const v = String(value).trim();
      if (!v) return;
      const roles = Array.isArray(snap.identity?.identityRoles) ? [...snap.identity.identityRoles] : [];
      if (roles[roles.length - 1] !== v) roles.push(v);
      setPath(snap, 'identity.identityRoles', roles);
      applied.push(`当前身份 ⇒ ${v}`);
      return;
    }
    case 'pr': {
      const seg = String(value).split('|');
      snap.portraitNeedsRefresh = true;
      snap.portraitRefreshReason = (seg[0] || '').trim();
      snap.portraitRefreshGuidance = (seg[1] || '').trim();
      applied.push('肖像刷新标记');
      return;
    }
    case 'ca': {
      // ca.C1.alchemy = 精通/40
      const key = parts[2];
      if (!key) return;
      const seg = String(value).split('/');
      const arts = { ...(snap.cultivationArts || {}) };
      arts[key] = { tier: (seg[0] || '').trim(), progress: num(seg[1]) ?? arts[key]?.progress ?? 0 };
      snap.cultivationArts = arts;
      applied.push(`百艺 ${key} ⇒ ${arts[key].tier}`);
      return;
    }
    case 'npc': {
      // npc.C1 = {n:"名|性别", r:"境界|身份", p:"性格", lg:"灵根", bg:"背景", act:"动作|穿着|位置|身段|样貌", apAge:8, yrr:"…"}
      const obj = isPlainObj(value) ? value : looseToJson(String(cmd.raw).replace(/^[^=]+=/, ''));
      if (!isPlainObj(obj)) { skipped.push('指令格式无法解析：' + cmd.raw.slice(0, 60)); return; }
      for (const [k, v] of Object.entries(obj)) {
        if (v === '' || v == null) continue;
        if (k === 'apAge' || k === 'appearanceAge') { snap.identity.appearanceAge = num(v) ?? v; applied.push(`外貌年龄 ⇒ ${v}`); continue; }
        if (k === 'yrr' || k === 'youthRetentionReason') { snap.identity.youthRetentionReason = String(v); applied.push('驻颜理由'); continue; }
        if (k === 'birthYear') { snap.identity.birthYear = num(v) ?? v; continue; }
        if (k === 'isYaozu') { snap.identity.isYaozu = !!v; continue; }
        const col = NPC_SHORT_KEYS[k];
        if (col) applyColumn(snap, col, v, applied);
      }
      return;
    }
    case 'beasts': {
      skipped.push('灵兽信息由灵兽模块更新，此处跳过');
      return;
    }
    case 'character':
    case 'characters': {
      if (!mine) { skipped.push(`${cmd.raw.slice(0, 40)}（非当前角色 ${ownerId}）`); return; }
      const path = parts.slice(2).join('.');
      if (!path) return;
      // 字段白名单：只允许写快照已知分域，防止越权改动存档其它部分
      // ⚠️ `player` 域已于 2026-09-22 从白名单移除 —— 那个「主角专有」块整体废弃后，
      //    放开它只会让 AI 一句 `character.B1.player.x = 1` 就把废弃块重新造回来。
      if (!/^(identity|stats|status|action|bio|economy|equipment|skills|traits|inventory|social|cultivationArts|techniqueMasteries|portraitPrompt|adult|legacy)\./.test(path)) {
        skipped.push(`不允许直接改写 ${path}，已忽略`);
        return;
      }
      const cur = getPath(snap, path);
      let next = value;
      if (op === '+=' && num(value) != null && num(cur) != null) next = num(cur) + num(value);
      else if (op === '-=' && num(value) != null && num(cur) != null) next = num(cur) - num(value);
      setPath(snap, path, next);
      applied.push(`${path} ⇒ ${String(next).slice(0, 30)}`);
      return;
    }
    default:
      skipped.push(`无法识别的字段 ${head}，已忽略`);
  }
}

// ---------- 对外主入口 ----------
// 把 stateCommands / upstoreCommands 文本应用到单个快照
// opts: { extraText } 追加文本（如历史指令回放）
export function applyCommandsToSnapshot(input, ...texts) {
  const snap = input && typeof input === 'object' ? input : {};
  const applied = [];
  const skipped = [];
  // 本批次物品注册表（createItem 建立，供 equipItem/transferItem 解析别名）
  const ctx = { registry: new Map() };
  for (const t of texts) {
    if (!t) continue;
    for (const cmd of parseMortalCommands(t)) {
      try {
        if (cmd.type === 'call') applyCall(snap, cmd, applied, skipped, ctx);
        else if (cmd.type === 'assign') applyAssign(snap, cmd, applied, skipped);
      } catch (e) {
        skipped.push(`指令处理出错（${e.message}）：${cmd.raw.slice(0, 40)}`);
      }
    }
  }
  return { snapshot: snap, applied, skipped };
}

// ---------- 装备槽内部实例 id 处理 ----------
// Mortal 的物品实例 id（I_C1_01 / D_xxx / S_C1_01）不是可读名称，直接渲染会得到「甲身 I_C1_01」。
// 处理策略：能按储物袋反查到名称就用名称（物品对象）；查不到就丢弃该槽（显示「—」），避免裸 id 泄漏。
export function isItemRef(v) {
  return typeof v === 'string' && /^[A-Za-z]{1,4}_[A-Za-z0-9_]{2,}$/.test(v.trim());
}

export function resolveItemRef(ref, inventory) {
  const key = String(ref ?? '').trim();
  if (!key || !Array.isArray(inventory)) return null;
  return inventory.find(it => it && typeof it === 'object'
    && [it.id, it.definitionId, it.name].some(v => v && String(v) === key)) || null;
}

function toEquipObject(item, ref) {
  return {
    name: item.name || item.id || ref,
    type: item.type || '装备',
    subtype: item.subtype || '',
    grade: item.grade || '',
    appearance: item.appearance || '',
    desc: item.desc || '',
    mods: item.mods || null,
    quantity: 1,
  };
}

// ---------- 物品条目结构归一 ----------
// 背景（2026-09-16 实盘）：AI 演化时只给 NPC 的装备槽写了 {"name":"剔骨刀"}，
// 品阶/类型/外观/描述全缺、储物袋还是空的 —— 面板上就表现为「物品不完整，品阶是空」。
// 契约里已经要求写全（见 evolutionPrompt.js），这里是兜底：把字符串 / 残缺对象统一补成标准物品结构。
// 注意：品阶只能由 AI 提供，程序补不出来；这里保证的是**结构完整**与**从储物袋反查取回已有字段**。
export function normalizeItemEntry(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const name = raw.trim();
    if (!name) return null;
    return { id: name, definitionId: name, name, quantity: 1, type: '杂物', subtype: '', grade: '', appearance: '', desc: '', mods: null };
  }
  if (!isPlainObj(raw)) return null;
  const name = String(raw.name ?? raw.名称 ?? raw.id ?? raw.definitionId ?? '').trim();
  if (!name) return null;
  const mods = isPlainObj(raw.mods) ? raw.mods : null;
  return {
    ...raw,   // 保留 lots / srcKey / acquisition 等既有附加字段
    id: String(raw.id || name),
    definitionId: String(raw.definitionId || raw.id || name),
    name,
    quantity: Math.max(1, Math.floor(Number(raw.quantity ?? raw.数量 ?? 1) || 1)),
    type: String(raw.type ?? raw.类型 ?? '').trim() || '杂物',
    subtype: String(raw.subtype ?? raw.子类 ?? '').trim(),
    grade: String(raw.grade ?? raw.品阶 ?? '').trim(),
    appearance: String(raw.appearance ?? raw.外观 ?? '').trim(),
    desc: String(raw.desc ?? raw.description ?? raw.描述 ?? '').trim(),
    mods,
  };
}

// 装备组 → 类型/子类的兜底推断（AI 只写物品名时，至少让类型栏不是空的）
const SLOT_TYPE_HINT = {
  weapon: { type: '装备', subtype: '武器' },
  armor: { type: '装备', subtype: '防具' },
  accessory: { type: '装备', subtype: '饰品' },
  treasure: { type: '法宝', subtype: '' },
  technique: { type: '功法', subtype: '' },
};

/**
 * 把「储物袋 + 装备槽」的物品对象补成标准结构。
 * - 储物袋里的字符串条目（AI 偶尔写 ["干粮袋"]）→ 完整对象；
 * - 装备槽只有 name 的对象 → **先从储物袋反查同名条目**取回品阶/外观/描述/词条（这是主角那条链的既有做法）；
 * - 储物袋里也没有的（AI 只写了槽、没登记）→ 按槽位推断类型与子类，并**补登一条进储物袋**，
 *   让「装备的物品必须在储物袋里有同名条目」这条既定约定重新成立（面板卸下时才能正常放回）。
 * 返回 { snapshot, fixed, registered } —— registered 是补登进储物袋的物品（供提示/审计）。
 */
export function normalizeItemShape(input) {
  const snap = input && typeof input === 'object' ? input : {};
  const fixed = [];
  const registered = [];
  const inv = (Array.isArray(snap.inventory) ? snap.inventory : [])
    .map(normalizeItemEntry).filter(Boolean);
  const eq = snap.equipment;
  if (!isPlainObj(eq)) return { snapshot: snap, fixed, registered };

  const byName = new Map();
  for (const it of inv) if (!byName.has(it.name)) byName.set(it.name, it);

  const fixSlot = (v, group) => {
    if (v == null || v === '') return v;
    const obj = normalizeItemEntry(v);
    if (!obj) return v;
    const objIsPlain = isPlainObj(v);
    const rawType = objIsPlain ? String(v.type ?? v.类型 ?? '').trim() : '';
    const rawSubtype = objIsPlain ? String(v.subtype ?? v.子类 ?? '').trim() : '';
    const hint = SLOT_TYPE_HINT[group] || { type: '装备', subtype: '' };
    let rec = byName.get(obj.name);
    if (!rec) {
      rec = {
        ...obj,
        type: rawType || hint.type,
        subtype: rawSubtype || obj.subtype || hint.subtype,
        source: obj.source || '装备补登',
      };
      inv.push(rec);
      byName.set(rec.name, rec);
      registered.push({ group, name: rec.name });
    }
    const out = {
      name: obj.name,
      type: rawType || rec.type || hint.type,
      subtype: rawSubtype || rec.subtype || hint.subtype,
      grade: rec.grade || obj.grade || '',
      appearance: rec.appearance || obj.appearance || '',
      desc: rec.desc || obj.desc || '',
      mods: rec.mods || obj.mods || null,
      quantity: 1,
    };
    if (String(v.grade ?? '') !== out.grade || (!objIsPlain && out.name)) {
      fixed.push({ group, name: out.name, grade: out.grade });
    }
    return out;
  };

  const next = { ...eq };
  for (const [group, val] of Object.entries(eq)) {
    if (Array.isArray(val)) next[group] = val.map(v => fixSlot(v, group));
    else if (isPlainObj(val)) {
      const g = {};
      for (const [k, v] of Object.entries(val)) g[k] = fixSlot(v, group);
      next[group] = g;
    } else next[group] = fixSlot(val, group);
  }
  snap.equipment = next;
  snap.inventory = inv;
  return { snapshot: snap, fixed, registered };
}

export function sanitizeEquipmentRefs(input) {
  const snap = input && typeof input === 'object' ? input : {};
  const dropped = [];
  const inv = Array.isArray(snap.inventory) ? snap.inventory : [];
  const eq = snap.equipment;
  if (!isPlainObj(eq)) return { snapshot: snap, dropped };

  const fixSlot = (v, where) => {
    if (v == null || v === '') return v;
    if (typeof v === 'string') {
      if (!isItemRef(v)) return v;
      const item = resolveItemRef(v, inv);
      if (item) return toEquipObject(item, v);
      dropped.push(`${where}：${v}`);
      return null;
    }
    if (isPlainObj(v)) {
      // {id:'I_x'} / {ref:'I_x'} 形态
      const ref = [v.id, v.ref, v.definitionId, v.itemId].find(x => isItemRef(x));
      if (ref && !v.name) {
        const item = resolveItemRef(ref, inv);
        if (item) return toEquipObject(item, ref);
        dropped.push(`${where}：${ref}`);
        return null;
      }
    }
    return v;
  };

  const next = { ...eq };
  for (const [group, val] of Object.entries(eq)) {
    if (Array.isArray(val)) {
      next[group] = val.map((v, i) => fixSlot(v, `${group}[${i}]`));
    } else if (isPlainObj(val)) {
      const g = {};
      for (const [k, v] of Object.entries(val)) g[k] = fixSlot(v, `${group}.${k}`);
      next[group] = g;
    } else {
      next[group] = fixSlot(val, group);
    }
  }
  snap.equipment = next;
  return { snapshot: snap, dropped };
}

// 渲染用便捷封装：返回已把内部实例 id 解析/清理过的 equipment（不修改原快照）
export function safeEquipment(snap) {
  if (!snap) return null;
  const r = sanitizeEquipmentRefs({ equipment: snap.equipment, inventory: snap.inventory });
  return r.snapshot.equipment || null;
}
