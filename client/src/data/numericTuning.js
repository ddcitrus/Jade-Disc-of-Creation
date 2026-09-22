// ===== Mortal 数值体系（详细数值表） =====
// 数据源：mortal-numeric-tuning.json（现存 2 张：境界基准 / 装备品阶基准，与下方 TABLE_META 条目数一致）
// 2026-09-17 精简：原 37 张 → 2 张。技能系数五张表搬进 skillCodex.js（按品阶现算、写进角色快照的技能项，AI 不再查表）；
// 其余 30 张无程序消费方、预设与协议中亦无引用，全部退役。
// 退役表的原数据曾另存归档，该归档目录已在文档清理时删除（不可恢复）。
// 注入位置：正文提示词 {{numericRules}}（数值变化的唯一判定依据）
// 设置页「故事设定与数值规则 → 数值规则表」可导入自定义 JSON / 逐表启停。
import defaultTuning from './mortal-numeric-tuning.json';

export const DEFAULT_NUMERIC_TUNING = defaultTuning;

// ---------- 表元数据（中文名 + 用途说明，注入文本与设置页共用） ----------
export const TABLE_META = {
  realmProfiles: { name: '境界基准表', desc: '各境界 HP/MP/神识/攻防/穿透/速度 的基准值与上限，以及该境界的寿元' },
  equipmentBaseByGrade: { name: '装备品阶基准', desc: '1~36 品装备各主属性基准值' },
  // ↓ 其余 35 张表已于 2026-09-17 退役，不再注入：
  //   · 技能伤害倍率 / 技能耗蓝基准 / 技能资源伤害占比 / 技能回血倍率 / 技能回蓝倍率
  //     → 数值原样搬进 skillCodex.js 后，改为「品阶直连模型」：**品阶（1~36）就是强度的唯一出处**，
  //       伤害倍率 = 1.2^品阶（1 品 1.20 倍 → 36 品 708.8 倍，每高一品强两成），耗灵力与回复量按品阶
  //       在灵力/气血池上取比例。（旧五表原数据已随归档目录清空。）
  //   · 其余 30 张 → 无程序消费方、预设与协议中也无引用，整体退役
  //     其中「交易经济 tradeEconomy」原是全表仅一个字段的空壳（灵石购买力=1），代码里只有
  //     表声明与字段标签引用它。真正的物价口径写在演化预设 sharedRules 的「物价和金融系统」
  //     4601 字里 —— 数值表的「交易经济」从未接入，故一并退役，避免在数值表页误改。
  //   退役表的原数据已随归档目录清空、不可恢复；
  //   如需恢复某张表：在 client/src/data/mortal-numeric-tuning.json 的 tables 里补回条目，
  //   并在本处补回同 key 的 { name, desc }（数据需另行重制）。
};

// ---------- 字段中文映射（条目对象内的字段名） ----------
// 只列**现役两张表**实际用到的字段。
// 2026-09-17 裁掉的那 35 张表的标签（灵兽种类 / 施法媒介 / 通用…）已无用 —— 表都没了，
// 标签永远查不到，留着只会在读代码时误以为还有那些表。2026-09-18 清理时一并删除。
const FIELD_LABELS = {
  // 境界基准
  hpBase: 'HP下限', hpUpper: 'HP上限', mpBase: 'MP下限', mpUpper: 'MP上限',
  shenshiBase: '神识下限', shenshiUpper: '神识上限',
  atkBase: '物攻下限', atkUpper: '物攻上限', magBase: '法攻下限', magUpper: '法攻上限',
  defBase: '物防下限', defUpper: '物防上限', penBase: '穿透下限', penUpper: '穿透上限',
  speedBase: '速度下限', speedUpper: '速度上限',
  // 装备基准
  attackBase: '物攻', defenseBase: '物防', penetrationBase: '穿透',
  cultivationSpeedBase: '修炼加速',
};
export const fieldLabel = (f) => FIELD_LABELS[f] || f;

// 表级字段别名：同名字段在不同表中含义不同（境界基准的 hpBase 是"HP下限"，装备/消耗品的 hpBase 就是"HP"）
export const TABLE_FIELD_ALIAS = {
  equipmentBaseByGrade: { hpBase: 'HP', mpBase: 'MP', shenshiBase: '神识', speedBase: '速度' },
};

// ---------- 条目键中文映射 ----------
// 现役两张表的条目键本身就是「境界名」与「品阶数字」，无需翻译，原样输出。
// 原先那批键标签（法宝阶别 / 跨境差 / 灵兽种类 / 战斗行动 / 特质稀有度…）随各自退役表一并删除。
export const keyLabel = (k) => k;

// 表内字段标签（带表级别名）
export const tableFieldLabel = (tableKey, field) =>
  (TABLE_FIELD_ALIAS[tableKey] && TABLE_FIELD_ALIAS[tableKey][field]) || fieldLabel(field);

// 条目键标签（带条目专属别名）
export const tableKeyLabel = (k) => keyLabel(k);

// ---------- 数值格式化 ----------
const fmtNum = (v) => (typeof v === 'number' ? String(v) : String(v ?? ''));

// 单条目值 → 紧凑文本。返回 null 表示该值无法呈现（跳过）
function entryValueText(val, fieldAlias = {}) {
  if (val == null) return null;
  if (typeof val === 'number' || typeof val === 'string') return fmtNum(val);
  if (typeof val === 'object' && !Array.isArray(val)) {
    const parts = [];
    for (const [f, v] of Object.entries(val)) {
      if (v == null) continue;
      if (typeof v === 'object') return null; // 嵌套对象走不了紧凑格式，交给调用方跳过
      parts.push(`${(fieldAlias[f] || fieldLabel(f))}${fmtNum(v)}`);
    }
    return parts.join('·') || null;
  }
  return null;
}

// 境界基准表：专门排版「凡人：HP 100~300｜MP 0~30｜…｜寿元 80」
function serializeRealmProfiles(table) {
  const FIELDS = [
    ['hpBase', 'hpUpper', 'HP'], ['mpBase', 'mpUpper', 'MP'], ['shenshiBase', 'shenshiUpper', '神识'],
    ['atkBase', 'atkUpper', '物攻'], ['magBase', 'magUpper', '法攻'], ['defBase', 'defUpper', '物防/法防'],
    ['penBase', 'penUpper', '穿透（物/法）'], ['speedBase', 'speedUpper', '速度'],
  ];
  const lines = [];
  for (const [realm, p] of Object.entries(table || {})) {
    if (!p || typeof p !== 'object') continue;
    const segs = FIELDS.map(([lo, hi, label]) => `${label} ${fmtNum(p[lo])}~${fmtNum(p[hi])}`);
    // 寿元是单值不是区间，单独接在末尾
    if (p.lifespan != null) segs.push(`寿元 ${fmtNum(p.lifespan)}`);
    lines.push(`${realm}：${segs.join('｜')}`);
  }
  return lines;
}

// 装备品阶基准：『品阶1：物攻12·物防12·HP25…』
function serializeEquipment(table) {
  const alias = TABLE_FIELD_ALIAS.equipmentBaseByGrade;
  const lines = [];
  for (const [grade, p] of Object.entries(table || {})) {
    const text = entryValueText(p, alias);
    if (text) lines.push(`品阶${grade}：${text}`);
  }
  return lines;
}

// 通用表序列化：
// - 每条值只有一个字段（{value}/{stat}/{years} 等）→ 行内紧凑「k=v，k=v」（每 10 项换行，单字段名省略）
// - 值有多个字段 → 每条一行「键：a1·b2」
function serializeGeneric(table, alias) {
  const entries = Object.entries(table || {}).filter(([, v]) => v != null);
  if (!entries.length) return [];
  const scalarOf = (v) => (typeof v === 'object' && !Array.isArray(v)
    ? Object.values(v).find(x => x != null && typeof x !== 'object')
    : v);
  const allSingle = entries.every(([, v]) => typeof v === 'number' || typeof v === 'string' ||
    (typeof v === 'object' && !Array.isArray(v) && Object.values(v).filter(x => x != null && typeof x !== 'object').length <= 1));
  if (allSingle) {
    const parts = entries.map(([k, v]) => {
      const raw = scalarOf(v);
      return raw == null ? null : `${keyLabel(k)}=${fmtNum(raw)}`;
    }).filter(Boolean);
    const lines = [];
    for (let i = 0; i < parts.length; i += 10) lines.push(parts.slice(i, i + 10).join('，'));
    return lines;
  }
  const lines = [];
  for (const [k, v] of entries) {
    const t = entryValueText(v, alias);
    if (t != null) lines.push(`${keyLabel(k)}：${t}`);
  }
  return lines;
}

// 表 → 序列化行（跳过无法呈现的表返回空数组）
function serializeTable(key, table) {
  if (!table || typeof table !== 'object') return [];
  if (key === 'realmProfiles') return serializeRealmProfiles(table);
  if (key === 'equipmentBaseByGrade') return serializeEquipment(table);
  return serializeGeneric(table, TABLE_FIELD_ALIAS[key]);
}

/**
 * 把数值体系序列化为注入用紧凑文本。
 * tables 采用「用户表覆盖内置表」的合并语义：设置里只需保存被编辑过的那几张表，
 * 未覆盖的表继续走内置默认——这样游戏内「数值表」页改一张表不会把其余各表锁成副本。
 * @param {object} tuning - { enabled, disabledTables?: string[], tables?: object }；tables 缺省用内置默认
 * @returns {string}
 */
export function serializeNumericTuning(tuning) {
  if (tuning && tuning.enabled === false) return '';
  const tables = getEffectiveTables(tuning);
  const disabled = new Set(Array.isArray(tuning?.disabledTables) ? tuning.disabledTables : []);
  const chunks = [];
  for (const [key, meta] of Object.entries(TABLE_META)) {
    if (disabled.has(key)) continue;
    const lines = serializeTable(key, tables[key]);
    if (!lines.length) continue;
    chunks.push(`■ ${meta.name}（${key}）——${meta.desc}\n${lines.join('\n')}`);
  }
  if (!chunks.length) return '';
  return [
    '【Mortal 数值体系（详细数值表）】',
    '以下数值表是境界与装备两项数值的唯一判定基准；正文描写中的数值必须服从本表，禁止凭空编造或逾越区间。表中「A~B」为基准值~上限，「k=v」为条目取值，「·」分隔同一条目的多个字段。技能系数不在此列——它由程序按品阶算好、写在角色状态栏的「技能」行里，照抄即可，不要另行换算。',
    '',
    chunks.join('\n\n'),
  ].join('\n');
}

/**
 * 取实际生效的数值表集合（内置默认 ← 用户覆盖）。
 * 传 settings 或 settings.numericTuning 均可。
 * @returns {object} { [tableKey]: table }
 */
export function getEffectiveTables(tuning) {
  let t = tuning;
  // 容错：直接传了整份 settings
  if (t && typeof t === 'object' && !Array.isArray(t) && t.numericTuning && typeof t.numericTuning === 'object') {
    t = t.numericTuning;
  }
  const userTables = (t && typeof t === 'object' && t.tables && typeof t.tables === 'object') ? t.tables : null;
  return { ...(defaultTuning.tables || {}), ...(userTables || {}) };
}

// 该表是否被用户改过（用户覆盖层里存在即视为已改动）
export function isTableOverridden(tuning, tableKey) {
  const t = (tuning && typeof tuning === 'object' && tuning.numericTuning) ? tuning.numericTuning : tuning;
  return !!(t && t.tables && typeof t.tables === 'object' && Object.prototype.hasOwnProperty.call(t.tables, tableKey));
}

/**
 * 取生效的数值体系（设置覆盖 > 内置默认）。
 * 返回用户配置对象（enabled:false 表示停用注入）或内置默认表。
 */
export function getEffectiveTuning(settings) {
  const t = settings?.numericTuning;
  if (t && typeof t === 'object' && Object.keys(t).length) return t;
  return defaultTuning;
}

