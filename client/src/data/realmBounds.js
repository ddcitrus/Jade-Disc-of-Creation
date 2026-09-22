// ===== 境界数值区间（零依赖：客户端 + 服务端共用同一口径） =====
// 为什么必须零依赖、且不 import 任何东西：
//   服务端是 `node index.js` 直跑 ESM，只要链路上出现 `import x from './x.json'`
//   就会抛 ERR_IMPORT_ATTRIBUTE_MISSING。而「AI 生成的属性必须落在数值表区间内」这条
//   规则前后端都要用（服务端打回 + 客户端校界），所以它的实现只能放在这种裸模块里。
//
// 本模块负责三件事：
//   1) 境界文本 → 数值表键（'练气7层' / '筑基期修士' → '炼气七层' / '筑基初期'）
//   2) 境界 → 各属性列的合法区间 [base, upper]（含「只识别出大境界」时的宽容并集）
//   3) 把区间渲染成注入提示词的紧凑表 / 校验一份 v2 快照是否越界
//
// 口径提醒：数值表约束的是 AI 写的「自身」值（不含特质、不含装备加成），与 attrClamp 的校界完全一致。

// ---------- 境界文本归一 ----------
const CN_DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

// 1~99 → 汉字（覆盖炼气十三层 / 三十六品等）
function toCnNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num < 0 || num > 99) return String(n);
  if (num < 10) return CN_DIGIT[num];
  if (num === 10) return '十';
  const tens = Math.floor(num / 10);
  const ones = num % 10;
  const t = tens === 1 ? '十' : CN_DIGIT[tens] + '十';
  return ones ? t + CN_DIGIT[ones] : t;
}

// 大境界异名（AI 常用别名 → 表内写法）
const REALM_ALIAS = [
  [/金丹|金丹期|金丹境/g, '结丹'],
  [/练气|練氣|练氣/g, '炼气'],
  [/築基/g, '筑基'],
  [/築/g, '筑'],
  [/煉氣|練氣|氣/g, '气'],
  [/練/g, '炼'],
  [/練虛|练虚/g, '炼虚'],
  [/渡劫期|渡劫境/g, '渡劫'],
  [/飞升|仙人/g, '真仙'],
  [/大罗金仙/g, '大罗'],
];

/**
 * 把任意境界写法归一为可与表键比对的文本。
 * 例：'筑基期修士（初入修仙）' → '筑基'；'练气7层' → '炼气七层'
 */
export function normalizeRealmText(raw) {
  if (raw == null) return '';
  let t = String(raw).trim();
  if (!t) return '';
  // 全角数字 → 半角
  t = t.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 去括号补充说明、空白与分隔符
  t = t.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s·・\-—_/、,，]/g, '');
  // 异体字 / 别名
  for (const [re, rep] of REALM_ALIAS) t = t.replace(re, rep);
  // 序数别名
  t = t.replace(/大圆满|圆满|巅峰|极致|末期/g, '后期')
    .replace(/前期|初阶|初层/g, '初期')
    .replace(/境界|修为|等级|实力/g, '');
  // 身份后缀（「筑基期修士」「炼气三层强者」）
  t = t.replace(/修士|修者|强者|高手|大能|前辈|弟子|存在|之躯|之身|之人/g, '');
  // 'N层' → '汉字层'；先吃掉序数词「第」（'炼气期第四层' → '炼气第四层' → '炼气四层'）
  t = t.replace(/第(?=[0-9一二三四五六七八九十]{1,3}层)/, '');
  t = t.replace(/^(.+?)(\d{1,2})层$/, (_, pre, d) => pre + toCnNumber(d) + '层');
  // '筑基期一层' → '筑基一层'；末尾孤立「期/境」删除（'真仙境' → '真仙'），
  // 但「初期/中期/后期」里的「期」必须保留
  t = t.replace(/[期境](?=[一二三四五六七八九十]{1,3}层)/, '');
  t = t.replace(/[期境]$/, (m, off, s) => (/[初中后末]/.test(s[off - 1] || '') ? m : ''));
  return t;
}

// 表键 → 大境界前缀（'炼气一层'→'炼气'，'筑基初期'→'筑基'，'凡人'→'凡人'）
export function majorPrefixOf(normKey) {
  const m = normKey.match(/^(.*?)(下位|中位|上位|初期|中期|后期)$/);
  if (m && m[1]) return m[1];
  const m2 = normKey.match(/^(.*?)[一二三四五六七八九十]{1,3}层$/);
  if (m2 && m2[1]) return m2[1];
  return normKey;
}

/**
 * 境界文本 → realmProfiles 中的键。
 * 匹配顺序：完全相等 → 文本包含表键（最长优先）→ 表键以文本开头（表内靠前者优先）
 *          → 大境界前缀（「大罗金仙」这类带修饰写法）→ 文本以表键开头（表外层级，退化到大境界）
 * @returns {string|null}
 */
export function resolveRealmKey(realmText, realmKeys) {
  const keys = Array.isArray(realmKeys) ? realmKeys : Object.keys(realmKeys || {});
  if (!keys.length) return null;
  const norm = normalizeRealmText(realmText);
  if (!norm) return null;
  const pairs = keys.map(k => ({ k, n: normalizeRealmText(k) })).filter(p => p.n);
  // 1) 完全相等
  const exact = pairs.find(p => p.n === norm);
  if (exact) return exact.k;
  // 2) 表键是文本的一部分（AI 常写「筑基中期修士」）——最长者优先
  const contained = pairs.filter(p => norm.includes(p.n)).sort((a, b) => b.n.length - a.n.length);
  if (contained.length) return contained[0].k;
  // 3) 文本是表键的开头（只写「炼气」/「筑基」）——保持表内顺序，取最靠前的一档
  const prefixed = pairs.filter(p => p.n.startsWith(norm));
  if (prefixed.length) return prefixed[0].k;
  // 4) 大境界前缀命中（「大罗金仙」「太乙散数」）——最长前缀优先
  const majors = [...new Set(pairs.map(p => majorPrefixOf(p.n)))].sort((a, b) => b.length - a.length);
  const majorHit = majors.find(m => m && norm.startsWith(m));
  if (majorHit) {
    const f = pairs.find(p => majorPrefixOf(p.n) === majorHit);
    if (f) return f.k;
  }
  // 5) 文本比表键长且以表键开头（「炼气十四层」这类表外写法）→ 退化到该大境界首档
  const started = pairs.filter(p => norm.startsWith(p.n));
  if (started.length) return started.sort((a, b) => a.n.length - b.n.length)[0].k;
  return null;
}

// ---------- 属性列 ----------
// 快照 stats 键 → realmProfiles 字段前缀（多个 stats 键可指向同一列，如物防/法防共用 def）
// label = 单属性名（界面/报告用）；col = 列名（注入提示词的紧凑表用）
export const REALM_STAT_MAP = [
  { key: 'hp', field: 'hp', label: '血量', col: '气血', pool: true },
  { key: 'mp', field: 'mp', label: '法力', col: '法力', pool: true },
  { key: 'physAtk', field: 'atk', label: '物攻', col: '物攻' },
  { key: 'physDef', field: 'def', label: '物防', col: '物防·法防' },
  { key: 'magDef', field: 'def', label: '法防', col: '物防·法防' },
  { key: 'magAtk', field: 'mag', label: '法攻', col: '法攻' },
  { key: 'physPen', field: 'pen', label: '物理穿透', col: '穿透' },
  { key: 'magPen', field: 'pen', label: '法术穿透', col: '穿透' },
  { key: 'speed', field: 'speed', label: '脚力', col: '脚力' },
  { key: 'spirit', field: 'shenshi', label: '神识', col: '神识' },
];

// 注入提示词时的列顺序：与「故事阶段」注入的数值表保持完全一致，
// 免得同一个 AI 在两个阶段看到两种排法。
export const REALM_COLUMN_ORDER = ['hp', 'mp', 'shenshi', 'atk', 'mag', 'def', 'pen', 'speed'];

// v2 扁平中文键 → 列 field（v2 新增角色能写的属性字段；穿透与物防/法防一样两键共用一个列）
export const V2_ATTR_TO_FIELD = [
  { v2: '物攻', field: 'atk' },
  { v2: '物防', field: 'def' },
  { v2: '法攻', field: 'mag' },
  { v2: '法防', field: 'def' },
  { v2: '物理穿透', field: 'pen' },
  { v2: '法术穿透', field: 'pen' },
  { v2: '神识', field: 'shenshi' },
  { v2: '脚力', field: 'speed' },
];

// 表中确实没有对应列、无法对照的属性（报告中说明用）
export const UNCOVERED_STATS = [
  { key: 'luck', label: '气运' },
  { key: 'charm', label: '魅力' },
  // 会心（2026-09-18 新增）：暴击底子，按百分点计。境界基准表没有这一列 ——
  // 它**不随境界涨**，只由装备与特质加成，所以也不需要校界钳制。
  { key: 'crit', label: '会心' },
];

// 单档某列的区间
function colRange(profile, field) {
  if (!profile || typeof profile !== 'object') return null;
  const upper = profile[`${field}Upper`];
  if (typeof upper !== 'number' || !Number.isFinite(upper)) return null;
  const base = profile[`${field}Base`];
  const lo = (typeof base === 'number' && Number.isFinite(base)) ? Math.min(base, upper) : 0;
  return { base: lo, upper };
}

/**
 * 境界文本 → 该境界下各属性列的合法区间。
 *
 * strict = true：境界精确命中某一档（含「炼气四层修士」这种包含式写法）→ 用该档区间，
 *                这是绝大多数情况（AI 写的就是表里的写法）。
 * strict = false：只识别出大境界（「炼气」「炼气十四层」「大罗金仙」这类表外/表内不全的写法）
 *                → 取该大境界**所有档的并集**，宁可放宽也不要误判 AI 写错。
 *
 * @returns {{ ok:boolean, reason?:string, key?:string, strict?:boolean, label?:string, cols?:object }}
 */
export function realmBoundsOf(realmText, realmProfiles) {
  const rp = realmProfiles && typeof realmProfiles === 'object' ? realmProfiles : null;
  const keys = rp ? Object.keys(rp) : [];
  if (!keys.length) return { ok: false, code: 'no-table', reason: '数值表缺少境界基准表（realmProfiles）' };
  const key = resolveRealmKey(realmText, keys);
  // code 用于区分两种失败：
  //   no-table      数值表没配好 —— 不是 AI 的责任，打回也没用，跳过校验
  //   unknown-realm AI 写了个表外境界（如「三阶妖兽」）—— 必须打回，见 checkV2RealmBounds
  if (!key) return { ok: false, code: 'unknown-realm', reason: `境界「${realmText || '未知'}」不在境界基准表中` };
  const norm = normalizeRealmText(realmText);
  const nk = normalizeRealmText(key);
  const strict = !!norm && (norm === nk || norm.includes(nk));
  const group = keys.filter(k => majorPrefixOf(normalizeRealmText(k)) === majorPrefixOf(nk));
  const useKeys = strict ? [key] : (group.length ? group : [key]);
  const cols = {};
  for (const field of REALM_COLUMN_ORDER) {
    let base = Infinity, upper = -Infinity, hit = false;
    for (const k of useKeys) {
      const r = colRange(rp[k], field);
      if (!r) continue;
      hit = true;
      base = Math.min(base, r.base);
      upper = Math.max(upper, r.upper);
    }
    if (hit) cols[field] = { base, upper };
  }
  return {
    ok: true, key, strict,
    keys: useKeys,
    label: strict ? key : `${majorPrefixOf(nk)}（${useKeys.length} 档合并）`,
    cols,
  };
}

// 区间 → 「下限~上限」；单点区间收敛成单个数字
export function rangeText(r) {
  if (!r) return '';
  return r.base === r.upper ? String(r.upper) : `${r.base}~${r.upper}`;
}

/**
 * 渲染「境界数值基准」紧凑表（注入提示词用）。
 * 只输出有 realmProfiles 列的那些属性，且行内不带任何解释文字——解释写在提示词的条款里。
 */
export function formatRealmBoundsTable(realmProfiles) {
  const rp = realmProfiles && typeof realmProfiles === 'object' ? realmProfiles : null;
  if (!rp || !Object.keys(rp).length) return '（未配置境界基准表）';
  const cols = REALM_COLUMN_ORDER
    .map(field => ({
      field,
      label: (REALM_STAT_MAP.find(s => s.field === field) || {}).col || field,
    }))
    .filter(c => Object.values(rp).some(p => colRange(p, c.field)));
  const lines = [];
  for (const [realm, profile] of Object.entries(rp)) {
    const seg = cols
      .map(c => {
        const r = colRange(profile, c.field);
        return r ? `${c.label} ${rangeText(r)}` : '';
      })
      .filter(Boolean);
    if (seg.length) lines.push(`${realm}：${seg.join('｜')}`);
  }
  return lines.join('\n');
}

// 从 v2 的「当前/上限」字符串里取两个数（与 snapshotV2.parsePool 的宽松度对齐）
function splitPool(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const parts = t.split('/');
  if (parts.length === 1) {
    const n = Number(parts[0].trim());
    return Number.isFinite(n) ? { current: n, max: n } : null;
  }
  if (parts.length !== 2) return null;
  const cur = Number(parts[0].trim());
  const max = Number(parts[1].trim());
  if (!Number.isFinite(cur) || !Number.isFinite(max)) return null;
  return { current: cur, max };
}

function boundsTableRef(key, field, which) {
  return `realmProfiles.${key}.${field}${which === 'upper' ? 'Upper' : 'Base'}`;
}

/**
 * 校验一份 **v2 完整快照**（新增角色）的战斗数值是否落在其境界的区间内。
 *
 * 只查「上限」这一类，不查气血/法力的当前值——受伤、耗蓝都是正常剧情状态，
 * 拿境界基准去卡当前值会把「重伤的修士」判成错误。
 * 气血/法力的「当前 ≤ 上限」由 snapshotV2 的格式校验负责。
 *
 * 特质与装备加成都不计入：stats 是「自身值」，语义＝境界基准 + 出身 + 种族 + 加点
 * （特质与装备由系统另行实时叠加，见 snapshotSchema 的 attrRows 三段口径），
 * 所以合法区间只为「仍留在自身里的加成」（出身/种族/加点，见 characterClampBonus）平移。
 * 加成来源见 attrClamp.js / saveModel.js：主角取 save.character 的出身/种族/加点，NPC 无此项。
 *
 * @param {object} v2 扁平中文键快照
 * @param {object} realmProfiles 生效数值表的 realmProfiles
 * @param {{ bonus?: object }} [opts] bonus：中文属性名 → 加成（如 { '物攻': 6, '气血上限': 50 }）
 * @returns {{ errors:string[], skipped:string, realmKey:string|null, strict:boolean, label:string }}
 */
export function checkV2RealmBounds(v2, realmProfiles, opts = {}) {
  const out = { errors: [], skipped: '', realmKey: null, strict: true, label: '' };
  if (!v2 || typeof v2 !== 'object') return out;
  const bonusOf = (attr) => {
    const n = Number(opts?.bonus?.[attr]);
    return Number.isFinite(n) ? n : 0;
  };
  const b = realmBoundsOf(v2.境界, realmProfiles);
  if (!b.ok) {
    // 数值表没配好 → 跳过（这不是 AI 能修的，打回只会让它无限重试）
    if (b.code === 'no-table') { out.skipped = b.reason; return out; }
    // 境界不在表内 → 打回。角色只有主角与 NPC 两种，境界必须取表中档位。
    // 以前这里也跳过，于是「三阶妖兽」这类自造境界可以带着任意数值直接落库。
    const who = `角色 ${String(v2.id || '')}${v2.名称 ? `「${v2.名称}」` : ''}`;
    out.errors.push(`${who}的境界「${v2.境界 || '（空）'}」不在境界基准表中，无法确定数值区间。境界必须取【境界数值基准】表左侧的档位（凡人 / 炼气一~十三层 / 筑基初期 / …）；妖兽、鬼物、傀儡等非人角色也按其实力对应到表中某一档来写，不得自造档位。`);
    return out;
  }
  out.realmKey = b.key;
  out.strict = b.strict;
  out.label = b.label;
  const id = String(v2.id || '');
  const name = String(v2.名称 || id || '角色');
  const who = `角色 ${id}${name && name !== id ? `「${name}」` : ''}`;

  // 气血 / 法力：只卡上限（当前值允许是受伤/耗蓝后的低值）
  for (const [zh, field, modKey] of [['气血', 'hp', '气血上限'], ['法力', 'mp', '法力上限']]) {
    const raw = v2[zh];
    if (raw == null || String(raw).trim() === '') continue;
    const p = splitPool(raw);
    if (!p) continue; // 写法不合法由 snapshotV2 报错，这里不重复
    const r = b.cols[field];
    if (!r) continue;
    const bonus = bonusOf(modKey);
    const lo = r.base + bonus;
    const hi = r.upper + bonus;
    if (p.max < lo || p.max > hi) {
      const tail = bonus ? `（表上限 ${r.upper} + 自身加成 ${bonus > 0 ? '+' : ''}${bonus} = ${hi}）` : '';
      out.errors.push(`${who}的「${zh}」上限写 ${p.max}，超出该境界（${b.label}）的合法区间 ${lo}~${hi}${tail}（${boundsTableRef(b.key, field, p.max > hi ? 'upper' : 'base')}）`);
    }
  }

  // 战斗属性：只有一个数，它同时是上限，必须落在区间内
  for (const { v2: zh, field } of V2_ATTR_TO_FIELD) {
    const raw = v2[zh];
    if (raw == null || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const r = b.cols[field];
    if (!r) continue;
    const bonus = bonusOf(zh);
    const lo = r.base + bonus;
    const hi = r.upper + bonus;
    if (n < lo || n > hi) {
      const over = n > hi;
      const tail = bonus ? `（表上限 ${r.upper} + 自身加成 ${bonus > 0 ? '+' : ''}${bonus} = ${hi}）` : '';
      out.errors.push(`${who}的「${zh}」写 ${n}，超出该境界（${b.label}）的合法区间 ${lo}~${hi}${tail}（${boundsTableRef(b.key, field, over ? 'upper' : 'base')}）`);
    }
  }
  return out;
}

/** 一句话说明一份快照的数值约束（打在回反馈开头，让 AI 一眼知道该按哪一档写） */
export function realmBoundsHintFor(v2, realmProfiles, opts = {}) {
  const b = realmBoundsOf(v2?.境界, realmProfiles);
  if (!b.ok) return '';
  const seg = REALM_COLUMN_ORDER
    .map(field => {
      const r = b.cols[field];
      if (!r) return '';
      const label = (REALM_STAT_MAP.find(s => s.field === field) || {}).col || field;
      return `${label} ${rangeText(r)}`;
    })
    .filter(Boolean);
  const bonusSeg = Object.entries(opts?.bonus || {})
    .filter(([, v]) => Number.isFinite(Number(v)) && Number(v))
    .map(([k, v]) => `${k}${Number(v) > 0 ? '+' : ''}${Number(v)}`);
  const tail = bonusSeg.length
    ? `；该角色自身已有加成（出身/种族/加点：${bonusSeg.join('、')}），上表区间已按它上浮，写「自身」值时按上浮后的区间取`
    : '';
  return `该角色境界「${b.label}」的属性区间：${seg.join('｜')}${tail}`;
}
