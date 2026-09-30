// 修炼结算落盘（2026-09-27）
//
// 背景：AI 每轮现算的 <cultivation_card> 此前**只被 StoryRenderer 渲染，从不写进存档**
//   ⇒ identity.realmProgress 永远是 0；下一轮 AI 又读到 0，于是进度每轮从零起算、全部白涨。
//   协议（prompts/protocols.js 修炼结算段）本来就写着「new 是本卡结算完成后应写入存档的最终进度」，
//   只是没有任何代码执行这一步。这里补上。
//
// 归属按 characterName 匹配（主角与 NPC 同一口径）：谁的名字在卡上，就写谁的那一格。

const CARD_RE = /<cultivation_card>([\s\S]*?)<\/cultivation_card>/gi;

// 进度是百分数，卡上写超了（AI 偶尔给 120）也不让它越界。
const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n)));

/** 从正文里取出所有修炼结算卡；不是合法 JSON 的直接丢。 */
export function parseCultivationCards(text) {
  const out = [];
  const src = String(text || '');
  if (!src) return out;
  CARD_RE.lastIndex = 0;
  let m;
  while ((m = CARD_RE.exec(src))) {
    try {
      const j = JSON.parse(m[1].trim());
      if (j && typeof j === 'object' && !Array.isArray(j)) out.push(j);
    } catch { /* 卡片不是合法 JSON：忽略 */ }
  }
  return out;
}

/** 按角色名（或 ID）找快照条目。 */
function findEntry(snaps, who) {
  const key = String(who || '').trim();
  if (!key) return null;
  if (snaps[key] && typeof snaps[key] === 'object') return [key, snaps[key]];
  for (const [id, s] of Object.entries(snaps)) {
    if (s && typeof s === 'object' && String(s.identity?.name || '').trim() === key) return [id, s];
  }
  return null;
}

/**
 * 把卡片结算写进存档。**就地修改**传入的 save（调用方持有的是本轮的新对象）。
 * @returns {{save:object, applied:string[], missed:string[], touched:string[]}}
 */
export function applyCultivationCards(save, text) {
  const snaps = save?.charSnapshots;
  const applied = [];
  const missed = [];
  const touched = [];
  if (!snaps || typeof snaps !== 'object') return { save, applied, missed, touched };
  for (const card of parseCultivationCards(text)) {
    const hit = findEntry(snaps, card.characterName || card.name);
    if (!hit) { missed.push(String(card.characterName || card.name || '（卡片未署名）')); continue; }
    const [id, snap] = hit;
    if (!snap.identity || typeof snap.identity !== 'object') snap.identity = {};
    const label = snap.identity.name || id;
    if (card.type === 'breakthrough') {
      const to = String(card.to || '').trim();
      if (!to) { missed.push(`${label}（突破卡没写目标境界）`); continue; }
      snap.identity.realm = to;
      snap.identity.realmProgress = 0;
      applied.push(`${label} 破境 → ${to}`);
      touched.push(id);
      continue;
    }
    const n = Number(card.new);
    if (!Number.isFinite(n)) { missed.push(`${label}（卡没写最终进度）`); continue; }
    const before = Number(snap.identity.realmProgress) || 0;
    const after = clampPct(n);
    // 破境卡用 toRealm（协议：跨境界时 toRealm/new 是结算后的最终值与最终进度）
    const to = String(card.toRealm || '').trim();
    snap.identity.realmProgress = after;
    if (to && to !== snap.identity.realm) snap.identity.realm = to;
    applied.push(`${label} 修为 ${before}% → ${after}%${to ? ` · 境界 → ${to}` : ''}`);
    touched.push(id);
  }
  return { save, applied, missed, touched };
}
