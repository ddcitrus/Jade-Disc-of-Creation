// ===== 提示词注入顺序（分区排布） =====
// 目标：把「逐回合不变」的内容排在请求最前面，让前缀缓存能命中；
// 把「逐回合变化」的内容排在中间；末尾留一小段恒定契约，紧贴玩家输入以保住服从度。
//
// 三个分区：
//   stable  恒定基座 —— 逐回合逐字节相同，必须在最前，否则前缀缓存全部作废
//   dynamic 变化区   —— 逐回合变化，越靠后离本轮行动越近
//   tail    末尾契约 —— 恒定但必须留在最后（约 600 字），用少量重算换指令服从度
//
// 用户在「设置 → 注入顺序」里可自由调整每个区块所属分区与分区内先后。

export const LAYOUT_ZONES = [
  {
    id: 'stable',
    name: '恒定基座',
    desc: '逐回合逐字节相同。必须排在最前，前缀缓存才有命中空间。',
  },
  {
    id: 'dynamic',
    name: '变化区',
    desc: '逐回合变化。越靠后离本轮行动越近，模型的注意力越集中。',
  },
  {
    id: 'tail',
    name: '末尾契约',
    desc: '恒定但必须留在最后。少量重算换取末尾指令的服从度。',
  },
];

// 单个区块的元信息。locked = 位置固定不可移动（由消息角色决定，不参与排布）。
export const LAYOUT_BLOCKS = [
  {
    id: 'presetStatic', zone: 'stable',
    name: '预设 · 静态段',
    desc: '预设中渲染结果不随回合变化的段落（身份、世界观、写作风格、对白指导等）。运行时自动判定。',
  },
  {
    id: 'wbAlways', zone: 'stable',
    name: '世界书 · 恒定条目',
    desc: '世界书里勾选了「恒定」的条目。每回合都注入，内容不随剧情变化。',
  },
  {
    id: 'protocolStatic', zone: 'stable',
    name: '静态协议',
    desc: '状态栏、语义渲染、战斗推演、修炼结算四段协议。时空数值已改为由「当前时空」区块给出。',
  },
  {
    id: 'numeric', zone: 'stable',
    name: '数值表',
    desc: '境界与属性的数值基准。全请求最大的一块（约 2 万字），恒定。',
  },
  {
    id: 'palette', zone: 'stable',
    name: '正文着色词表',
    desc: '限定正文可用颜色。仅在「正文规则与文风」里开启颜色限制且词表非空时才有内容。',
  },
  {
    id: 'presetDynamic', zone: 'dynamic',
    name: '预设 · 动态段',
    desc: '预设中引用了占位符的段落（剧情指导、人物行为、玩家快照、场景信息等）。运行时自动判定。',
  },
  {
    id: 'textRules', zone: 'dynamic',
    name: '文风 · 字数 · 人称',
    desc: '「正文规则与文风」里设定的文风、字数区间、叙事人称。预设没引用对应占位符时在这里补注入。',
  },
  {
    id: 'memory', zone: 'dynamic',
    name: '叙事记忆',
    desc: '阶段总结 + 回合摘要。预设未引用 {{narrativeMemory}} 时才注入。',
  },
  {
    id: 'wbHits', zone: 'dynamic',
    name: '世界书 · 命中条目',
    desc: '按关键词命中的世界书条目，随最近剧情变化。预设未引用 {{worldbook}} 时才注入。',
  },
  {
    id: 'sceneTime', zone: 'dynamic',
    name: '当前时空',
    desc: '当前时间、地点、季节、天气。协议不再自带真实时空，改由这一块统一给出。',
  },
  {
    id: 'history', zone: 'dynamic',
    name: '最近剧情',
    desc: '最近 4 回合正文。请求里最大的单块变化内容。预设未引用 {{storyText}} 或 ${Chat History} 时才注入。',
  },
  {
    id: 'contract', zone: 'tail',
    name: '输出契约',
    desc: '「本轮只输出正文、禁止代码块」等末尾约束。内容固定，恒定但留在最后效果最好。',
  },
  {
    id: 'playerPov', zone: 'tail',
    name: '主角心理留白',
    desc: '禁止代写主角的内心、情绪、态度与评价（玩家主权）。预设里若有「大量内心独白」这类风格要求，只有它压得住。',
  },
  {
    id: 'extraConstraints', zone: 'tail',
    name: '其它约束',
    desc: '你在「其它约束」页里填的要求。接在所有提示词之后，留空则不注入。',
  },
  {
    id: 'presetUser', zone: 'tail',
    name: '预设 · user 段',
    desc: '预设里 role=user 的段落，含本轮玩家输入。固定为最后一条消息，不可移动。',
    locked: true,
  },
];

export function layoutBlockMeta(id) {
  return LAYOUT_BLOCKS.find(b => b.id === id) || null;
}

const ZONE_IDS = LAYOUT_ZONES.map(z => z.id);

/**
 * 把任意输入归一化成合法的排布数组 [{id, zone}, ...]。
 * - 数组顺序即分区内先后顺序
 * - 未知 id 丢弃、重复 id 只保留首次出现
 * - 缺失的区块按默认位置补齐（补在所属分区的末尾）
 */
export function normalizePromptLayout(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const id = typeof item === 'string' ? item : item?.id;
    if (!id || seen.has(id)) continue;
    const meta = layoutBlockMeta(id);
    if (!meta || meta.locked) continue;
    const zone = ZONE_IDS.includes(item?.zone) ? item.zone : meta.zone;
    out.push({ id, zone });
    seen.add(id);
  }
  // 补缺失项：非锁定区块放回它所属分区的末尾
  for (const b of LAYOUT_BLOCKS) {
    if (b.locked || seen.has(b.id)) continue;
    out.push({ id: b.id, zone: b.zone });
    seen.add(b.id);
  }
  // 锁定区块永远排在末尾
  for (const b of LAYOUT_BLOCKS) {
    if (!b.locked) continue;
    out.push({ id: b.id, zone: 'tail' });
  }
  return out;
}

/** 按分区取出有序 id 列表，供组装时使用 */
export function resolveLayout(raw) {
  const list = normalizePromptLayout(raw);
  const out = { stable: [], dynamic: [], tail: [] };
  for (const item of list) {
    if (out[item.zone]) out[item.zone].push(item.id);
  }
  return out;
}

/** 分区内移动：把 id 在所在分区内上移/下移一位 */
export function moveWithinZone(layout, id, dir) {
  const list = normalizePromptLayout(layout);
  const idx = list.findIndex(x => x.id === id);
  if (idx < 0) return list;
  const zone = list[idx].zone;
  const peers = list.map((x, i) => ({ ...x, i })).filter(x => x.zone === zone && !layoutBlockMeta(x.id)?.locked);
  const pos = peers.findIndex(x => x.id === id);
  const target = pos + dir;
  if (target < 0 || target >= peers.length) return list;
  const a = peers[pos].i, b = peers[target].i;
  const tmp = list[a];
  list[a] = list[b];
  list[b] = tmp;
  return list;
}

/** 跨区移动：把 id 改到另一个分区的末尾 */
export function moveToZone(layout, id, zone) {
  const list = normalizePromptLayout(layout).filter(x => x.id !== id);
  const meta = layoutBlockMeta(id);
  if (!meta || meta.locked || !ZONE_IDS.includes(zone)) return normalizePromptLayout(layout);
  const lastOfZone = list.map((x, i) => (x.zone === zone ? i : -1)).filter(i => i >= 0).pop();
  const item = { id, zone };
  if (lastOfZone === undefined) list.push(item);
  else list.splice(lastOfZone + 1, 0, item);
  return list;
}
