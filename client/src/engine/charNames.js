// 角色内部 ID → 展示名 解析
//
// 背景：Mortal 协议的 state/upstore 指令用内部 ID 记人（B1 = 主角、C1/C2… = NPC，
// 关系写作 `rel.C1.B1 = 标签|好感|备注|认知`），解析后落进快照就是
// `bio.rawRelations = [{ targetId: 'B1', label: '救命恶徒', favorability: -25 }]`。
// 界面直接把 targetId 渲染出来，玩家看到的就是「B1」而不是「阿达」。
//
// 本模块只做「ID ↔ 姓名」的映射与关系行归一化，纯函数、无 React 依赖，便于单测。

// 建立 ID → 姓名的索引
// - B1 是主角：姓名的权威来源是 save.character.name（玩家在名册里改过名时，快照可能滞后）
// - 其余 ID 依次从 save.npcs（名册里显示的名字，玩家点开的就是它）、charSnapshots[id].identity.name 取
// - 先到先得（不覆盖已有映射），保证主角名不被同 ID 的 NPC 抢走
export function buildCharNameIndex(save) {
  const map = new Map();
  if (!save || typeof save !== 'object') return map;
  const put = (id, name) => {
    if (id == null || name == null) return;
    const k = String(id).trim();
    const v = String(name).trim();
    if (k && v && k !== v && !map.has(k)) map.set(k, v);
  };
  const snaps = save.charSnapshots && typeof save.charSnapshots === 'object' && !Array.isArray(save.charSnapshots)
    ? save.charSnapshots : {};
  put('B1', save.character?.name);
  put('B1', snaps.B1?.identity?.name);
  // 名册优先：左侧列表显示的就是 npcs[].name，关系里也应显示同一个名字
  for (const npc of (Array.isArray(save.npcs) ? save.npcs : [])) put(npc?.id, npc?.name);
  for (const [id, snap] of Object.entries(snaps)) put(id, snap?.identity?.name);
  return map;
}

// 单个 ID 查名：查不到就原样返回（AI 有时直接写人名，那就当成名字用）；空值走 fallback
export function charName(nameIndex, id, fallback = '') {
  if (id === null || id === undefined || id === '') return fallback;
  const key = String(id).trim();
  if (!key) return fallback;
  const hit = nameIndex instanceof Map ? nameIndex.get(key) : undefined;
  return hit || key;
}

// 关系数组归一化
// 兼容两种形态：
//   1) 快照演化产物 { targetId, label, favorability, desc, cognition }
//   2) 名册手工维护 { target, relation, desc }
// 返回可直接渲染的行：{ key, targetId, name, label, fav, favText, desc, cognition }
export function relationRows(relations, nameIndex) {
  const idx = nameIndex instanceof Map ? nameIndex : new Map();
  return (Array.isArray(relations) ? relations : []).flatMap((r, i) => {
    if (r == null) return [];
    // 防御：AI 偶尔把关系写成纯字符串（"与阿达：救命恶徒"）
    const raw = typeof r === 'object' && !Array.isArray(r) ? r : { label: String(r) };
    const targetId = raw.targetId ?? raw.target ?? raw.name ?? raw.id ?? '';
    const label = raw.label ?? raw.relation ?? raw.title ?? '';
    let fav = raw.favorability ?? raw.favor ?? raw.affinity ?? raw.favour ?? null;
    fav = (fav === null || fav === '' || !Number.isFinite(Number(fav))) ? null : Number(fav);
    return [{
      key: `${String(targetId)}#${i}`,
      targetId: String(targetId || ''),
      name: charName(idx, targetId, '?'),
      label: label ? String(label) : '',
      fav,
      favText: fav === null ? '' : `好感 ${fav > 0 ? '+' : ''}${fav}`,
      desc: raw.desc ?? raw.description ?? raw.note ?? '',
      cognition: raw.cognition ?? '',
    }];
  });
}
