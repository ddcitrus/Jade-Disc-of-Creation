// ===== 存档数据模型 =====
import { computeAttrs, rootDisplayName, resolveTraitMods } from './data/gameData.js';
import { snapshotFromCharacter, characterClampBonus, syncTraitMods } from './data/snapshotSchema.js';
import { sanitizeSaveInPlace, looksLikeCharId } from './data/saveSanitize.js';
import { v2ToLegacy, applyEdits, parseNewCharBlocks, nameFromStoryText } from './data/snapshotV2.js';
import { getEffectiveTables } from './data/numericTuning.js';
import { clampSnapshotStats, isCharClamped } from './data/attrClamp.js';
import { applyCommandsToSnapshot, sanitizeEquipmentRefs, normalizeItemShape } from './engine/mortalCommands.js';
import { api } from './api.js';

export function newSaveId() {
  return 'save_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// 从角色创建向导结果构建新存档
export function buildSave(wizard, settings) {
  const now = Date.now();
  const [y, mo, d, h, mi] = wizard.startTime;
  // 主角角色对象与主角快照必须同源：
  //   向导里姓名键叫 charName，而快照生成器读的是 name —— 直接传 wizard 会让姓名落成角色 ID。
  //   这里统一成一个 playerChar，存档记录与快照都从它取，避免两边漂移。
  const playerChar = {
    name: String(wizard.charName || '').trim(),
    gender: wizard.gender,
    person: wizard.person,
    age: wizard.age,
    appearance: wizard.appearance || '',
    origin: wizard.origin,
    race: wizard.race,
    realm: wizard.realm,
    root: wizard.root,
    traits: wizard.traits,
    skills: wizard.skills,
    items: wizard.items,
    personality: wizard.personality,
  };
  return {
    id: newSaveId(),
    name: wizard.saveName,
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    difficulty: wizard.difficulty,
    settings: { mode: settings?.mode || 'local' },
    character: playerChar,
    world: {
      time: { y, mo, d, h, mi },
      timeLabel: `${y}年${String(mo).padStart(2, '0')}月${String(d).padStart(2, '0')}日 ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`,
      weather: '晴',
      season: '冬',
      location: wizard.location,
      factors: wizard.worldFactors,
    },
    story: [], // { turn, role: 'tiandao'|'narrator'|'user'|'ai', text, timeLabel, prePayload?, payload? }
    npcs: [],          // 非主角角色：{ id, name, group, subtitle, gender, race, realm, attrs, equipment, inventory, skills, traits, personality, relations }
    evolutions: [],    // 剧情演化线索：{ id, title, type, status, summary, progress, logs, updatedAt }
    // 世界书不在存档里：所有存档共用一份（server/data/worldbook.json），见 saveModel 头部说明
    // 初始快照：按创建时的选择固定格式模板直生成（不经 AI），界面选了什么快照就是什么
    charSnapshots: {
      B1: snapshotFromCharacter(playerChar, {
        id: 'B1', kind: 'player', isPlayer: true,
        locationName: wizard.location?.name,
        startYear: y,
      }),
    },
  };
}

// 角色 ID 形如 B1 / C12 / P_Fox —— 出现在「姓名」栏说明是落库时的兜底值，不是真名。
// 实现放在 data/saveSanitize.js（零依赖），服务端也要用同一份。
export { looksLikeCharId };


// ---------- 存档迁移（补齐缺失字段） ----------
export function migrateSave(save) {
  const s = { ...save };
  if (!s.npcs) s.npcs = [];
  delete s.worldbook; // 世界书已改为跨存档共用（server/data/worldbook.json），存档里不再保留该字段
  if (!s.world) s.world = {};
  if (!s.world.factors) s.world.factors = [];
  if (!s.plot) s.plot = { direction: '', styles: {}, guidance: '' };
  if (!s.plot.styles) s.plot.styles = {};
  if (!s.memories) s.memories = [];
  if (!s.lastState) s.lastState = null;
  if (!s.plotProgress) s.plotProgress = []; // 人物生平条目：{ turn, timeLabel, text }
  // 新增：各角色快照集合（B1/C1/...）
  if (!s.charSnapshots) s.charSnapshots = {};

  // 特质 mods 缓存按特质库重算归位
  // （历史 bug：库外特质的「加成」文本与缓存 mods 曾被重复相加，每落档一次翻一倍）
  if (s.charSnapshots && typeof s.charSnapshots === 'object') {
    for (const snap of Object.values(s.charSnapshots)) {
      if (snap && typeof snap === 'object') syncTraitMods(snap);
    }
  }

  // ---------- 自愈：修历史 bug 写进快照的坏数据 ----------
  // 【bug 1】主角姓名被写成角色 ID（B1）。
  // 【bug 2】bio.longTermGoal 里塞的是「性格底色：…」。
  // 规则统一放在 data/saveSanitize.js —— 服务端读写存档时也跑同一份，所以即使客户端是旧版本
  // 也污染不了磁盘数据。
  sanitizeSaveInPlace(s);
  // 名册分组规范化：历史自动建册用过「登场人物」等不在 CHARACTER_GROUPS 里的分组，
  // 名册按分组渲染时这些 NPC 会整体不可见 → 统一归入「在场人物」
  if (Array.isArray(s.npcs)) {
    s.npcs = s.npcs.map(n => (n && !CHARACTER_GROUPS.includes(n.group) ? { ...n, group: '在场人物' } : n));
  }
  return s;
}

// ---------- 角色快照集合工具 ----------
// 把存档里主角+所有 NPC 转成快照集合（给演化阶段作为输入起点）
export function buildCharSnapshotBundle(save, currentSnapshots = {}) {
  const bundle = { ...currentSnapshots };
  // 主角
  if (!bundle.B1) {
    bundle.B1 = snapshotFromCharacter(save.character, { id: 'B1', kind: 'player', isPlayer: true, locationName: save.world?.location?.name });
  } else {
    // 主角至少补 id/kind
    bundle.B1 = { ...bundle.B1, id: 'B1', kind: bundle.B1.kind || 'player' };
  }
  // NPC：以 npc.id 为 key
  for (const npc of (save.npcs || [])) {
    if (!bundle[npc.id]) {
      bundle[npc.id] = snapshotFromCharacter(npc, { id: npc.id, kind: 'npc', isPlayer: false });
    } else {
      bundle[npc.id] = { ...bundle[npc.id], id: npc.id, kind: bundle[npc.id].kind || 'npc' };
    }
  }
  return bundle;
}

// 把演化结果中的新快照集合写回存档：
// - 每个快照与既有快照深度合并（AI 只输出变化字段时不会丢失 bio/equipment/inventory 等既有字段）
// - 合并后投影 Mortal 指令（stateCommands/upstoreCommands → bio/skills/traits/inventory/关系…）
// - 丢弃装备槽里无法反查的内部实例 id（I_C1_01 → 槽位置空，避免名册显示裸 id）
// - 合并后按数值规则表强制校界（越界属性写回边界值，见 data/attrClamp.js）——可用 tuning.enforce=false 关闭
// - 主角 B1 写回 save.character 关键字段（name/realm/age 等可同步的）
// - NPC 按 snapshots 中的非 B1 id 同步回 save.npcs（更新 name/realm/subtitle）
// - 全部快照集合保存在 save.charSnapshots
// opts: { tuning: settings.numericTuning, onClamp: (changes) => void, onCommands: ({report,droppedRefs}) => void }
export function applyEvolvedSnapshots(save, snapshots = {}, deeds = [], opts = {}) {
  const s = migrateSave(structuredClone(save));
  const newBundle = { ...(s.charSnapshots || {}) };
  const tables = getEffectiveTables(opts.tuning);
  const enforceOn = !(opts.tuning && opts.tuning.enforce === false);
  const clamped = [];
  const commandReport = {};   // { id: { applied:[], skipped:[] } }
  const droppedRefs = [];     // 被丢弃的装备内部实例 id
  const itemFixes = [];       // 被自动补登进储物袋的装备物品（AI 只写了槽、没登记储物袋）
  // exactIds：这些角色的快照已是「本轮最终值」（v2 修改语句算出来的），整条采用，不做按名称合并
  const exactIds = new Set(opts.exactIds || []);
  // 汇总本轮所有角色的 state/upstore 指令：AI 偶尔会把某角色的指令写在别的人物快照上，
  // 全量重放（指令内部按角色 ID 自行判定归属）既不会写错人，也不会漏掉跨角色指令（物品转移等）。
  const allCommandTexts = [];
  for (const snap of Object.values(snapshots)) {
    if (!snap || typeof snap !== 'object') continue;
    for (const k of ['stateCommands', 'upstoreCommands']) {
      const t = snap[k];
      if (!t) continue;
      allCommandTexts.push(Array.isArray(t) ? t.filter(Boolean).map(String).join('\n') : String(t));
    }
  }
  for (const [id, snap] of Object.entries(snapshots)) {
    let merged = normalizeSnapshotResources(mergeSnapshot(newBundle[id], snap, { exact: exactIds.has(id) }));
    // Mortal 指令投影：concurrent 预设把数据写在 stateCommands/upstoreCommands（add/addSkill/
    // addTrait/createItem/equipItem/rel./cr./hp./loc./npc.ID={} 等），这里解析回快照字段（技能/特质/
    // 储物袋/装备/背景/内心/目标/关系/灵石/状态…），否则这些内容只会停留在「本轮演化指令」文本框里，名册永远读不到。
    if (allCommandTexts.length) {
      const r = applyCommandsToSnapshot(structuredClone(merged), ...allCommandTexts);
      merged = r.snapshot;
      const skipped = r.skipped.filter(s => !s.includes('（非当前角色'));
      if (r.applied.length || skipped.length) commandReport[id] = { applied: r.applied, skipped };
    }
    // 装备槽里的 Mortal 内部实例 id（I_C1_01 之类）不是可读名称：能按储物袋反查就用物品，
    // 查不到则清空该槽，避免名册出现「甲身 I_C1_01」这种裸 id。
    {
      const san = sanitizeEquipmentRefs(structuredClone(merged));
      merged = san.snapshot;
      if (san.dropped.length) droppedRefs.push({ id, refs: san.dropped });
    }
    // 物品结构归一：AI 常把装备槽写成 {"name":"剔骨刀"}（缺品阶/类型/外观/描述），
    // 储物袋也可能整条是字符串。这里统一补成标准物品结构，并尽量从储物袋反查取回完整字段；
    // 装备了但没登记进储物袋的，按槽位推断类型后补登一条（否则面板卸下时无处可放）。
    {
      const ni = normalizeItemShape(merged);
      merged = ni.snapshot;
      if (ni.registered.length) itemFixes.push({ id, registered: ni.registered });
    }
    // 特质词条归一：mods 一律按特质库重算（AI 写什么都不算数），属性栏与校界都以此为准
    merged = syncTraitMods(merged);
    // 数值校界：AI 给出的属性若逾越数值表区间（如炼气一层 HP 写到 5 万），强制改回边界。
    // 校界针对「自身」值：区间只为「仍留在自身里的加成」（出身/种族/加点，characterClampBonus）上移；
    // 特质与装备在自身之外由系统实时叠加，不参与区间（见 attrRows 的「自身＋特质＋装备＝生效」）。
    // 角色在「角色名册 · 基本信息」里选择豁免时不校界
    if (enforceOn && isCharClamped(s, id, merged)) {
      const r = clampSnapshotStats(merged, tables, { id, mods: characterClampBonus(s, merged, id) });
      if (r.changes.length) { merged = r.snapshot; clamped.push(...r.changes); }
    }
    newBundle[id] = merged;
    // 同步关键字段回存档角色记录（方便左侧信息栏等旧 UI 显示）
    if (id === 'B1' && snap.identity) {
      const c = { ...s.character };
      // 只有快照里是「像人名的真名」才回写。快照姓名若退化成角色 ID（历史 bug 的产物），
      // 绝不能让它把存档里已有的真名覆盖掉。
      const snapName = String(snap.identity.name || '').trim();
      const curCharName = String(c.name || '').trim();
      if (snapName && !looksLikeCharId(snapName)) c.name = snapName;      // 真名 → 采信
      else if (!curCharName && snapName) c.name = snapName;               // 存档本来没名字 → 先兜着
      // 其余情况（快照名是 ID / 存档已有真名）保持存档原值不动
      if (snap.identity.realm) {
        // 不强行覆盖 c.realm 对象，但更新名字（旧 UI 兼容）
        c.realm = { ...(c.realm || {}), name: snap.identity.realm };
      }
      if (snap.identity.age != null) c.age = snap.identity.age;
      if (snap.identity.linggen) {
        c.root = { ...(c.root || {}), name: snap.identity.linggen };
      }
      s.character = c;
      // 当前行为/着装/位置写入 lastState（供侧栏显示）
      if (snap.action) {
        s.lastState = {
          ...(s.lastState || {}),
          action: snap.action.action || s.lastState?.action || '',
          attire: snap.action.attire || s.lastState?.attire || '',
          figure: snap.action.figure || s.lastState?.figure || '',
        };
        if (snap.action.location) s.world = { ...s.world, location: { ...(s.world.location || {}), name: snap.action.location } };
      }
      // 物品同步（旧 UI 用）：带上品阶/类型，别让详情面板显示成空白
      if (Array.isArray(snap.inventory)) {
        c.items = snap.inventory.map(it => ({
          name: it.name || it.id || it.definitionId || '未知物品',
          count: it.quantity ?? 1,
          desc: it.desc || it.lots?.[0]?.source || '',
          type: it.type || '杂物',
          grade: it.grade || '',
        }));
      }
      // 技能同步（只取 name）；同样用合并后的列表，AI 没重述的技能不会丢
      if (Array.isArray(merged.skills)) {
        c.skills = merged.skills.map(sk => ({ name: sk.name || '', tier: sk.grade || '', desc: sk.description || '' }));
      }
      // 特质同步：名称/描述跟着快照走（AI 演化的新特质能进名册），但属性加成与稀有度仍由程序说了算。
      // 这里读的是合并后的快照（merged），它已经把「AI 本轮没提到的旧特质」保留下来了，
      // 所以不会再把玩家已有的特质弄丢；加成取值顺序：特质库 → 角色原档案（自定义特质）→ 快照自带。
      if (Array.isArray(merged.traits) && merged.traits.length) {
        const prev = Array.isArray(c.traits) ? c.traits : [];
        const byName = new Map(prev.filter(t => t && t.name).map(t => [t.name, t]));
        c.traits = merged.traits.map(t => {
          const name = typeof t === 'string' ? t : (t?.name || '');
          const old = byName.get(name) || {};
          const mods = resolveTraitMods(name) || resolveTraitMods(old) || resolveTraitMods(t) || null;
          const desc = (typeof t === 'object' && t && (t.desc || t.description || t.effect)) || old.desc || '';
          const effects = (typeof t === 'object' && t && t.effects) || old.effects || '';
          return { name, desc, effects, rarity: old.rarity || (typeof t === 'object' && t && t.rarity) || '普通', ...(mods ? { mods } : {}) };
        });
      }
    } else {
      // NPC：更新 npcs 列表（先按 id 匹配，再按姓名匹配——手工建册条目 id 是 npc_xxx，与快照 C 编号不同）
      let npcIdx = (s.npcs || []).findIndex(n => n.id === id);
      if (npcIdx < 0 && snap.identity?.name) npcIdx = s.npcs.findIndex(n => n.name === snap.identity.name);
      if (npcIdx >= 0) {
        const n = { ...s.npcs[npcIdx] };
        if (snap.identity?.name) n.name = snap.identity.name;
        if (snap.identity?.realm) n.realm = snap.identity.realm;
        if (snap.identity?.gender) n.gender = snap.identity.gender;
        if (snap.identity?.age != null) n.age = snap.identity.age;
        if (snap.action?.location) n.subtitle = `${snap.identity?.realm || ''} · ${snap.action.location}`;
        if (snap.identity?.personality) n.personality = { ...(n.personality || {}), summary: snap.identity.personality };
        s.npcs[npcIdx] = n;
      } else if (snap.identity) {
        // 新登场角色：AI 演化首次产出的快照 → 自动建册（id 用快照编号，名册快照页按 id 直连）
        s.npcs = [...(s.npcs || []), {
          ...newCharacter({
            name: snap.identity.name || id,
            group: '在场人物',
            subtitle: [snap.identity.realm, snap.action?.location].filter(Boolean).join(' · ') || '凡人',
            gender: snap.identity.gender || '男性',
            realm: snap.identity.realm || '凡人',
          }),
          id,
        }];
      }
    }
  }
  // 物品结构归一（全量 · 含本轮未被编辑的角色）：历史遗留的 {"name":"刀"} 装备槽、
  // 字符串形态的储物袋条目在这里一并修好；已完整的物品原样保留（幂等）。
  for (const id of Object.keys(newBundle)) {
    if (Object.prototype.hasOwnProperty.call(snapshots, id)) continue;  // 本轮已处理过
    const sn = newBundle[id];
    if (!sn || typeof sn !== 'object') continue;
    const ni = normalizeItemShape(sn);
    newBundle[id] = ni.snapshot;
    if (ni.registered.length) itemFixes.push({ id, registered: ni.registered });
  }
  s.charSnapshots = newBundle;
  // deeds 写入 plotProgress（人物生平）
  if (Array.isArray(deeds) && deeds.length) {
    for (const d of deeds) {
      const text = [d.time, d.location, d.description].filter(Boolean).join(' · ');
      if (text) s.plotProgress = [...(s.plotProgress || []), { turn: s.turnCount || 0, timeLabel: d.time || s.world?.timeLabel || '', text }];
    }
  }
  // 校界结果回传给调用方（toast 提示 / 审计）
  if (clamped.length && typeof opts.onClamp === 'function') opts.onClamp(clamped);
  // 指令投影报告（哪些字段由 Mortal 指令写入 / 哪些指令被跳过）
  if ((Object.keys(commandReport).length || droppedRefs.length || itemFixes.length) && typeof opts.onCommands === 'function') {
    opts.onCommands({ report: commandReport, droppedRefs, itemFixes });
  }
  return s;
}

/**
 * 首遇即建档（阶段 1 收尾调用）：把正文里 AI 写的 <new_char> 建档块**当场落档**。
 *
 * 为什么需要它：新角色快照原本只在阶段 2 由 <新增角色> 生成，导致首次登场那一回合的
 * 战斗卡无权威数值可抄（战斗协议却硬性要求「卡面照抄该角色状态栏」）。
 * 阶段 1 里 AI 先写建档块、再写登场正文与战斗卡，同一次生成内先定数后写卡，
 * 卡面与档案天然同源；阶段 2 再跑时该角色已是既有角色，只会写差异语句。
 *
 * 解析与校验都是**分级**的（2026-09-20 建档保底）：能修的字段一律补默认值照落，
 * 只有「不是对象 / 连名字都没有」才整块丢弃 —— 后者由战斗建局那一层的兜底档接住，
 * 所以「建档失败 ⇒ 打不了仗」这条死路已经不存在了。
 * @returns {{ save, ids: string[], rejected: string[], repaired: string[] }}
 */
export function ingestNewCharBlocks(save, rawText, opts = {}) {
  const bundle = buildCharSnapshotBundle(save, save.charSnapshots || {});
  const knownIds = opts.knownIds ? opts.knownIds.map(String) : Object.keys(bundle);
  // 建档保底 · 名称兜底：AI 偶尔把「名称」写成「姓名」「名字」，或整块漏了名称键。
  // 正文里的 ::dialogue 标记第三段就是「读者可见称呼」（协议规定），从那里把名字认回来，
  // 于是「只差一个名字」的建档块也能落档，不必退回阶段 2 等下一轮。
  const fallbackNames = {};
  for (const id of charIdsInText(rawText)) {
    const nm = nameFromStoryText(rawText, id);
    if (nm) fallbackNames[id] = nm;
  }
  const { init, rejected, repaired } = parseNewCharBlocks(rawText, { knownIds, fallbackNames });
  const ids = Object.keys(init);
  if (!ids.length) return { save, ids, rejected, repaired };
  const next = applyEvolutionV2(save, { init }, { tuning: opts.tuning });
  return { save: next, ids, rejected, repaired };
}

/** 正文里出现过的角色编号（对话标记与 <battle> 指令两处），用于给「名称兜底」圈定范围。 */
function charIdsInText(text) {
  const s = String(text ?? '');
  const out = new Set();
  for (const m of s.matchAll(/::dialogue\s+([ABC]\d+)/gi)) out.add(m[1].toUpperCase());
  for (const m of s.matchAll(/["']id["']\s*:\s*["']([ABC]\d+)["']/gi)) out.add(m[1].toUpperCase());
  return out;
}

/**
 * 应用快照 v2 的演化结果：{ init, edits }
 * - init：本轮新登场角色的 **完整快照**（v2 扁平中文格式）→ 转成内部结构
 * - edits：已存在角色的**修改语句**（已通过服务端逐行校验）
 * 落地方式是「先算出每个角色本轮的最终快照，再交给 applyEvolvedSnapshots 统一投影」，
 * 因此新增角色的建册、主角字段回写、数值校界、特质词条归一都沿用同一套逻辑，不重复实现。
 * opts: 同 applyEvolvedSnapshots，另加 onEdits({report})
 */
export function applyEvolutionV2(save, { init = {}, edits = [] } = {}, opts = {}) {
  const bundle = buildCharSnapshotBundle(save, save.charSnapshots || {});
  const finalSnaps = {};
  const addedIds = [];
  for (const [id, v2] of Object.entries(init || {})) {
    if (!v2 || typeof v2 !== 'object') continue;
    const kind = v2.kind || (id === 'B1' ? 'player' : 'npc');
    finalSnaps[id] = v2ToLegacy({ ...v2, id, kind }, bundle[id] || null);
    addedIds.push(id);
  }
  const byId = {};
  for (const e of (edits || [])) {
    if (!e || !e.id) continue;
    (byId[e.id] = byId[e.id] || []).push(e);
  }
  const report = {};
  for (const [id, list] of Object.entries(byId)) {
    const base = finalSnaps[id] || bundle[id];
    if (!base) { report[id] = { applied: [], skipped: [`找不到角色 ${id}，该角色的 ${list.length} 条语句已忽略`] }; continue; }
    const r = applyEdits(base, list);
    finalSnaps[id] = r.snapshot;
    report[id] = { applied: r.applied, skipped: r.skipped };
  }
  const next = applyEvolvedSnapshots(save, finalSnaps, [], { ...opts, exactIds: Object.keys(finalSnaps) });
  // v2 不再使用旧的 state/upstore 指令：清空这两个字段，避免旧指令每回合被重复重放（会让物品数量翻倍）
  for (const id of Object.keys(finalSnaps)) {
    const sn = next.charSnapshots?.[id];
    if (sn && (sn.stateCommands || sn.upstoreCommands)) {
      next.charSnapshots[id] = { ...sn, stateCommands: '', upstoreCommands: '' };
    }
  }
  if (typeof opts.onEdits === 'function') optionsSafeCall(opts.onEdits, { report, addedIds });
  return next;
}
function optionsSafeCall(fn, arg) {
  try { fn(arg); } catch { /* 回调失败不影响落库 */ }
}

// 快照深度合并：以既有快照为底，AI 演化结果只覆盖它明确给出的字段
// - null/undefined 不抹字段；对象递归合并；数组整体替换（视为新完整列表）
// - 例外：特质、技能是「角色长期带着的列表」，按名称合并（见 mergeNamedList）
// - stateCommands/upstoreCommands：数组归一化为换行分隔字符串（本轮指令替换上轮）
export function mergeSnapshot(base, overlay, opts = {}) {
  if (!base || typeof base !== 'object') return normalizeCommandFields(overlay);
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return base;
  const exact = opts.exact === true;
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v === null || v === undefined) continue;
    if (k === 'stateCommands' || k === 'upstoreCommands') {
      out[k] = Array.isArray(v) ? v.filter(Boolean).map(String).join('\n') : String(v);
      continue;
    }
    if (Array.isArray(v)) {
      // exact：调用方给的已是「本轮最终列表」（v2 修改语句算出来的），整条替换才支持删除项
      out[k] = (!exact && NAMED_LIST_KEYS.has(k) && Array.isArray(out[k])) ? mergeNamedList(out[k], v) : v;
      continue;
    }
    if (typeof v === 'object' && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeSnapshot(out[k], v, opts);
      continue;
    }
    out[k] = v;
  }
  return out;
}

// 需要「按名称合并」而不是整条替换的列表字段。
// 原因：AI 演化输出这些列表时常只写它这轮记得的条目。以前整体替换，玩家原有的特质
// 只要没被 AI 重述就会凭空消失（实测第 8 回合「嗜睡」被新写的「天灵根(火)」顶掉）。
const NAMED_LIST_KEYS = new Set(['traits', 'skills']);

// 按 name 合并两个列表：AI 写到的条目以 AI 为准（同名的沿用原条目再套上 AI 内容），
// AI 没写到的条目原样保留——AI 的残缺列表不再等于「删掉这些」。
function mergeNamedList(oldList, newList) {
  const nameOf = x => (typeof x === 'string' ? x : (x && typeof x === 'object' ? x.name : '')) || '';
  const out = [];
  const kept = new Set();
  for (const item of newList) {
    const nm = nameOf(item);
    const old = nm ? oldList.find(x => nameOf(x) === nm) : null;
    const itemIsObj = item && typeof item === 'object' && !Array.isArray(item);
    const oldIsObj = old && typeof old === 'object' && !Array.isArray(old);
    out.push(itemIsObj && oldIsObj ? { ...old, ...item } : item);
    if (nm) kept.add(nm);
  }
  for (const old of oldList) {
    const nm = nameOf(old);
    if (!nm || !kept.has(nm)) out.push(old);
  }
  return out;
}

// 归一化指令字段（数组 → 换行分隔字符串）
function normalizeCommandFields(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return snap;
  const out = { ...snap };
  for (const k of ['stateCommands', 'upstoreCommands']) {
    if (Array.isArray(out[k])) out[k] = out[k].filter(Boolean).map(String).join('\n');
  }
  return out;
}

// 资源镜像：AI 常只填 stats 不填 resources（名册显示「HP — · MP —」的根因）。
// resources 缺失时从 stats 同步；已有值不覆盖。
export function normalizeSnapshotResources(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return snap;
  const st = snap.stats;
  if (!st || typeof st !== 'object') return snap;
  const res = { ...(snap.resources || {}) };
  let changed = false;
  // current 与 max 独立镜像，均只补缺失值、不覆盖已有值
  for (const key of ['hp', 'mp']) {
    const stv = st[key];
    if (!stv || typeof stv !== 'object') continue;
    const r = { ...(res[key] || {}) };
    let touched = false;
    if (stv.current != null && r.current == null) { r.current = stv.current; touched = true; }
    if (stv.max != null && r.max == null) { r.max = stv.max; touched = true; }
    if (touched) { res[key] = r; changed = true; }
  }
  return changed ? { ...snap, resources: res } : snap;
}

// 把当前快照集合批量上传到服务端（角色名册每人一份独立存储）
export async function persistCharSnapshots(saveId, snapshots = {}) {
  try {
    const ids = Object.keys(snapshots);
    if (!ids.length) return;
    await api.batchSaveCharSnapshots(saveId, snapshots);
  } catch { /* 静默失败：本地存档已经写好，服务端可后续补 */ }
}

// 按集合对齐服务端各角色快照：以存档内 charSnapshots 为「全集」，服务端多出来的角色会被删除。
// 与 persistCharSnapshots 的区别：那个只增不减 —— 回滚（回退 / 重新生成 / 恢复人生快照）会把
// 存档里的角色集合缩回旧版本，被回滚掉的角色在 char_snaps 里会变成永久孤儿。
// 存档里一个角色快照都没有时（旧存档 / 异常状态）不执行，避免误删服务端唯一副本。
export async function alignCharSnapshots(saveId, snapshots = {}) {
  try {
    if (!Object.keys(snapshots || {}).length) return null;
    return await api.replaceCharSnapshots(saveId, snapshots);
  } catch { return null; } // 静默失败：存档已落盘，对齐可下次再补
}

// 工具：从存档角色生成初始快照（snapshotFromCharacter 包装，已顶部 import）

// ---------- AI 状态写入（正文尾部 ```state 块 → 存档状态，快照联通的核心） ----------
export function applyAIState(save, state) {
  if (!state || typeof state !== 'object') return save;
  const s = migrateSave(structuredClone(save));
  try {
    if (state.location && typeof state.location === 'string') {
      s.world.location = { ...(s.world.location || {}), name: state.location };
    }
    if (state.weather && typeof state.weather === 'string') s.world.weather = state.weather;
    if (Number(state.agePlus) > 0) s.character.age = (s.character.age || 0) + Number(state.agePlus);
    if (Array.isArray(state.newItems)) {
      const items = [...(s.character.items || [])];
      for (const it of state.newItems) {
        if (!it?.name) continue;
        const i = items.findIndex(x => x.name === it.name);
        if (i >= 0) items[i] = { ...items[i], count: (items[i].count || 1) + (Number(it.count) || 1) };
        else items.push({ name: it.name, count: Number(it.count) || 1, desc: it.desc || '', type: '杂物' });
      }
      s.character.items = items;
    }
    if (Array.isArray(state.npcUpdates)) {
      for (const nu of state.npcUpdates) {
        if (!nu?.name) continue;
        const ex = s.npcs.find(n => n.name === nu.name);
        if (ex) {
          if (nu.group) ex.group = nu.group;
          if (nu.subtitle) ex.subtitle = nu.subtitle;
          if (nu.realm) ex.realm = nu.realm;
        } else {
          s.npcs.push(newCharacter({ name: nu.name, group: nu.group, subtitle: nu.subtitle, realm: nu.realm }));
        }
      }
    }
    if (state.plotProgress && typeof state.plotProgress === 'string') {
      s.plotProgress = [...(s.plotProgress || []), { turn: s.turnCount || 0, timeLabel: s.world?.timeLabel || '', text: state.plotProgress }];
    }
  } catch { /* 状态块异常时保持原样 */ }
  return s;
}

// ---------- 剧情演化（原站结构：方向 + 风格指令 + 剧情指导） ----------
export const PLOT_STYLES = [
  { id: 'balance', name: '均衡推进', desc: '被选中时，剧情推进回到均衡轮换，而不是单一路线连霸多回合。',
    instructions: [
      '若选中，剧情推进应优先体现机遇、代价、明线、暗线、日常与冲突之间的轮换，不让任何单一路线连续霸占多回合。',
      '不要把均衡写成随机、平均分配或四平八稳；结合近期已经实际呈现的主导风格轮换，只有同一张力确实继续升级时才重复。'] },
  { id: 'romance', name: '恋爱拉扯', desc: '被选中时，剧情推进围绕暧昧、试探、误会与亲疏变化展开。',
    instructions: [
      '若选中，必须让有关系依据的具体人物通过选择、试探、竞争、边界变化或双向张力，实际改变亲疏、期待或后续行动。',
      '称谓、礼物、双修、身体接触或数值收益本身不算命中；不要每次直接发糖、告白或确定关系，要让心动、迟疑、错位和代价继续存在。'] },
  { id: 'combat', name: '战斗冲突', desc: '被选中时，剧情推进服务于对抗张力、布局与战后余波。',
    instructions: [
      '若选中，必须发生可见的对抗行动、攻防判断或足以改变交战条件的布局，并让胜负、威慑、伤势、资源、位置或关系至少一项留下后效。',
      '单纯宣战、备战口号、敌人登场或战力说明不算命中；不必每次立刻开战，但威慑、追击、牵制与战后处置必须真实改变下一步选择。'] },
  { id: 'intrigue', name: '权斗博弈', desc: '被选中时，剧情推进落到名分、规矩、借势与利益交换上。',
    instructions: [
      '若选中，必须让立场不同的各方围绕名分、规矩、把柄或资源，进行至少一次真实的出招、试探或交换，且改变某方的处境。',
      '口头立场、背景介绍或单方面盘算不算命中；让借势、反制、代价与联盟关系留下可追溯的变化。'] },
  { id: 'adventure', name: '冒险奇遇', desc: '被选中时，剧情推进朝线索、未知区域与高风险机缘收束。',
    instructions: [
      '若选中，必须出现可追索的线索、未探索的区域或带条件门槛的机缘，并让主角付出判断或代价后取得实质进展。',
      '单纯的宝物发放、境界提升或"恰好路过"不算命中；机缘要有风险、排他性与后续牵连。'] },
  { id: 'hardship', name: '受苦压迫', desc: '被选中时，剧情推进把压力、挫败与被迫选择写成持续处境。',
    instructions: [
      '若选中，必须让压力来自具体的强者、规则或资源困境，并实际压缩主角的选择空间，逼迫其取舍。',
      '单纯挨打、受辱情节或情绪描写不算命中；压迫要留下可反抗、可周旋、可积累的余地。'] },
  { id: 'daily', name: '日常温情', desc: '被选中时，剧情推进从生活节奏、人情往来和小起伏里展开。',
    instructions: [
      '若选中，必须通过具体的日常事务、人情往来或生活细节，让某段关系或处境发生细微但真实的变化。',
      '流水账式的吃饭赶路不算命中；日常里要埋下后续剧情可用的伏笔或情感积累。'] },
  { id: 'suspense', name: '悬疑危机', desc: '被选中时，剧情推进用疑点、错位与逼近感累积不安。',
    instructions: [
      '若选中，必须抛出新的疑点、信息错位或正在逼近的威胁，并让主角察觉到不对劲。',
      '单纯的环境渲染或"似乎有危险"不算命中；疑点要具体、可追查，威胁要有时间压力。'] },
  { id: 'ensemble', name: '群像互动', desc: '被选中时，剧情推进让多角色诉求、关系网和连锁反应同时转动。',
    instructions: [
      '若选中，必须让至少两名配角带着各自诉求行动，其行为互相影响并波及主角的选择。',
      '配角只作为背景板、传话筒或工具人不算命中；每个人的行动要有自己的因果。'] },
  { id: 'growth', name: '成长逆袭', desc: '被选中时，剧情推进围绕积累、补短板、反制准备与阶段性提升展开。',
    instructions: [
      '若选中，必须让主角通过积累、训练、谋划或领悟取得可验证的阶段性提升，且与之前的铺垫衔接。',
      '无因的顿悟、系统式直升或贵人白给不算命中；提升要付出时间、资源或风险代价。'] },
  { id: 'comedy', name: '喜剧调剂', desc: '被选中时，剧情推进允许轻巧失控、乌龙和反差来带动。',
    instructions: [
      '若选中，必须让误会、乌龙、反差或轻巧的失控真实推动至少一段互动，而非插科打诨。',
      '与剧情无关的段子、刻意卖萌不算命中；笑点要从人物性格与处境中自然生长。'] },
  { id: 'tragic', name: '悲壮抉择', desc: '被选中时，剧情推进围绕守护、代价、责任与不可两全的选择。',
    instructions: [
      '若选中，必须让主角或重要角色面对不可两全的选择，且无论怎么选都有真实的代价。',
      '为虐而虐、无意义的牺牲或强行煽情不算命中；抉择要贴合人物性格与积累的因果。'] },
  { id: 'sect', name: '宗门经营', desc: '被选中时，剧情推进落到宗门职责、资源盘子和长期布局的运转上。',
    instructions: [
      '若选中，必须涉及宗门的资源、人事、规矩或职责的具体运转，并让主角在其中的位置发生变化。',
      '泛泛的宗门背景介绍不算命中；经营要有数字感、人事感与可延续的长期布局。'] },
];

// ---------- 人生快照（前后端联通的核心数据结构） ----------
// 快照载荷 = 某一时刻的完整游戏状态（不含故事全文，避免体积膨胀）
export function buildSnapshotPayload(save) {
  const s = migrateSave(save);
  return {
    character: structuredClone(s.character),
    npcs: structuredClone(s.npcs || []),
    world: structuredClone(s.world || {}),
    plot: structuredClone(s.plot || {}),
    memories: structuredClone(s.memories || []),
    memoryRecaps: structuredClone(s.memoryRecaps || []),
    lastState: structuredClone(s.lastState || null),
    charSnapshots: structuredClone(s.charSnapshots || {}),
    plotProgress: structuredClone(s.plotProgress || []),
    turnCount: s.turnCount || 0,
    storyTail: (s.story || []).slice(-3).map(b => ({ turn: b.turn, role: b.role, timeLabel: b.timeLabel, text: (b.text || '').slice(0, 400) })),
  };
}

export function snapshotSummaryText(save) {
  const c = save.character;
  const w = save.world;
  return `${c?.name || '？'} · ${c?.realm?.name || '凡人'} · ${c?.age ?? '?'}岁 · ${w?.location?.name || '未知'} · 第 ${save.turnCount || 0} 回合`;
}

// 恢复快照：把载荷写回存档（保留 id/名称/创建时间与完整故事）
// 世界书已改为跨存档共用（server/data/worldbook.json）：既不在快照载荷里，也不写回存档。
// 老快照文件里可能残留 payload.worldbook，这里显式丢弃，免得它复活成存档字段。
export function applySnapshotPayload(save, payload, opts = {}) {
  const s = { ...save };
  s.character = structuredClone(payload.character);
  s.npcs = structuredClone(payload.npcs || []);
  s.world = structuredClone(payload.world || {});
  s.plot = structuredClone(payload.plot || {});
  s.memories = structuredClone(payload.memories || []);
  s.memoryRecaps = structuredClone(payload.memoryRecaps || []);
  delete s.worldbook;
  s.lastState = structuredClone(payload.lastState || null);
  // 角色快照集合一并回滚（回合回退/重新生成的关键）
  if (payload.charSnapshots && Object.keys(payload.charSnapshots).length) {
    s.charSnapshots = structuredClone(payload.charSnapshots);
  }
  if (Array.isArray(payload.plotProgress)) s.plotProgress = structuredClone(payload.plotProgress);
  s.turnCount = payload.turnCount || 0;
  return s;
}

// ---------- 玩家自持字段：回合落盘时必须取「最新副本」，不能跟着旧存档回滚 ----------
// 这几个字段由玩家在管理页自己维护（改剧情方向与风格），AI 与回合流程都不产生它们。
// 但一个回合是从**开跑那一刻的存档副本**算起的（正文 40~90 秒 + 演化，还要算上游重试，最长五分钟），
// 回合结束才整份写回磁盘；玩家在这段时间里改了方向或风格，那次写盘之后紧接着被回合的整份写回覆盖，
// 改动就"凭空消失"了。本项目已第四次踩同一类坑，这段机制正是为此设的。
// 世界书原本也在这张清单里 —— 改为跨存档共用文件后，它根本不在存档里，天然免疫，故已移出。
export const PLAYER_OWNED_PATHS = ['plot.direction', 'plot.styles'];

function readByPath(obj, path) {
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/**
 * 把 latest（当前最新的内存存档）里的「玩家自持字段」搬到 next 上，其余字段仍以 next 为准。
 * 只在落盘出口用：next 是回合算出来的结果，latest 是这一刻内存里最新的存档。
 * @param {object} next 准备写盘的存档（可能来自几十秒前的副本）
 * @param {object} latest 当前最新的内存存档
 */
export function carryPlayerOwnedFields(next, latest) {
  if (!latest || typeof latest !== 'object') return next;
  const out = { ...next };
  for (const p of PLAYER_OWNED_PATHS) {
    const v = readByPath(latest, p);
    if (v === undefined) continue;    // 最新副本里没有这一项 → 不动 next 的
    if (readByPath(out, p) === v) continue; // 本来就是同一份，免去克隆
    setByPath(out, p, structuredClone(v));
  }
  return out;
}

// ---------- 天道助手：变更提案的应用 ----------
// ops: { type:'set', path, value } | { type:'addTrait', name, desc } | { type:'addItem', name, count, desc }
//    | { type:'addNpc', name, group, subtitle } | { type:'removeNpc', name } | { type:'setNpcField', name, field, value }
export function setByPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) return false;
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return true;
}

export function applyAssistantOps(save, ops) {
  const s = migrateSave(structuredClone(save));
  const applied = [];
  const rejected = [];
  for (const op of ops || []) {
    try {
      if (op.type === 'set' && op.path) {
        if (setByPath(s, op.path, op.value)) applied.push(`设置 ${op.path} = ${JSON.stringify(op.value).slice(0, 40)}`);
      } else if (op.type === 'addTrait' && op.name) {
        const traits = [...(s.character.traits || [])];
        if (!traits.find(t => t.name === op.name)) {
          traits.push({ name: op.name, desc: op.desc || '天道助手添加', rarity: '稀有', mods: {} });
          s.character.traits = traits;
          applied.push(`新增特质「${op.name}」`);
        }
      } else if (op.type === 'addItem' && op.name) {
        const items = [...(s.character.items || [])];
        const i = items.findIndex(x => x.name === op.name);
        if (i >= 0) items[i] = { ...items[i], count: (items[i].count || 1) + (op.count || 1) };
        else items.push({ name: op.name, count: op.count || 1, desc: op.desc || '', type: '杂物' });
        s.character.items = items;
        applied.push(`物品「${op.name}」×${op.count || 1}`);
      } else if (op.type === 'addNpc' && op.name) {
        if (!s.npcs.find(n => n.name === op.name)) {
          s.npcs = [...s.npcs, newCharacter({ name: op.name, group: op.group, subtitle: op.subtitle })];
          applied.push(`新增角色「${op.name}」`);
        }
      } else if (op.type === 'removeNpc' && op.name) {
        s.npcs = s.npcs.filter(n => n.name !== op.name);
        // 名册与快照必须同步移除：只删名册条目的话，快照会变成没有名册指向的孤儿（名册里看不到它，
        // 但快照页按 id 仍能翻到），角色删除必须两边一起删。
        if (s.charSnapshots && typeof s.charSnapshots === 'object') {
          const hit = Object.keys(s.charSnapshots).find(k => k !== 'B1' && (s.charSnapshots[k]?.identity?.name === op.name || k === op.name));
          if (hit) {
            const { [hit]: _rm, ...rest } = s.charSnapshots;
            s.charSnapshots = rest;
            applied.push(`移除角色「${op.name}」及其快照 ${hit}`);
          } else {
            applied.push(`移除角色「${op.name}」`);
          }
        } else {
          applied.push(`移除角色「${op.name}」`);
        }
      } else if (op.type === 'setNpcField' && op.name && op.field) {
        s.npcs = s.npcs.map(n => n.name === op.name ? { ...n, [op.field]: op.value } : n);
        applied.push(`角色「${op.name}」.${op.field} = ${JSON.stringify(op.value).slice(0, 30)}`);
      } else if (op.type === 'patchSnapshot' && op.path && (op.charName || op.charId)) {
        // 快照修改：path 白名单校验，防止越权改动快照结构之外的存档数据
        if (!/^(identity|stats|status|action|bio|economy|resources|equipment|skills|traits)\./.test(String(op.path))) {
          rejected.push(`快照修改已拒绝：路径 ${op.path} 不在快照字段白名单内（identity./stats./status./action./bio./economy./resources. …）`);
        } else {
          const bundle = s.charSnapshots || {};
          const cid = (op.charId && bundle[op.charId]) ? op.charId
            : Object.keys(bundle).find(k => bundle[k]?.identity?.name === op.charName || k === op.charName);
          const target = cid && bundle[cid];
          if (!target) {
            rejected.push(`快照修改已拒绝：未找到角色「${op.charName || op.charId}」的快照`);
          } else {
            const ns = structuredClone(target);
            if (setByPath(ns, op.path, op.value)) {
              s.charSnapshots = { ...bundle, [cid]: ns };
              applied.push(`快照「${ns.identity?.name || cid}」.${op.path} = ${JSON.stringify(op.value).slice(0, 40)}`);
            } else {
              rejected.push(`快照修改已拒绝：路径 ${op.path} 无效`);
            }
          }
        }
      }
    } catch { /* 单条失败不影响其余 */ }
  }
  return { save: s, applied, rejected };
}

// ---------- 世界书 ----------
export function newWorldbookEntry(partial = {}) {
  return {
    id: 'wb_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: partial.name || '新条目',
    keywords: partial.keywords || [],
    content: partial.content || '',
    enabled: partial.enabled ?? true,
    always: partial.always ?? false,
    source: partial.source || '', // 归属批次：导入文件名 / 手动创建；空 = 早期条目（未分组）
  };
}

// 匹配世界书条目，并区分「恒定条目」与「关键词命中条目」
// 入参是**世界书条目数组**（来自跨存档共用的 settings.worldbook），不再是存档对象。
// 恒定条目（always=true）逐回合都要注入，内容不变 → 属于可被前缀缓存命中的部分；
// 命中条目的集合随最近剧情变化 → 属于变化部分。两者在提示词里分开注入。
export function matchWorldbookSplit(entries, recentText = '') {
  if (!Array.isArray(entries)) entries = [];
  const always = entries.filter(e => e.enabled && e.always);
  const matched = entries.filter(e => {
    if (!e.enabled || e.always) return false;
    return (e.keywords || []).some(k => k && recentText.includes(k));
  });
  return { always, matched };
}

// 匹配世界书条目（关键字命中最近剧情/用户行动）——保持旧签名，恒定条目在前
export function matchWorldbook(entries, recentText = '') {
  const { always, matched } = matchWorldbookSplit(entries, recentText);
  return [...always, ...matched];
}

// ---------- 角色 ----------
export const CHARACTER_GROUPS = ['主角', '在场人物', '离场人物', '妖兽'];

export function newCharacter(partial = {}) {
  return {
    id: 'npc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: partial.name || '新角色',
    group: partial.group || '在场人物',
    subtitle: partial.subtitle || '凡人 · 凡人',
    gender: partial.gender || '男性',
    race: partial.race || '人族',
    realm: partial.realm || '凡人',
    attrs: partial.attrs || null,
    equipment: partial.equipment || { 兵器: '', 防具: '', 饰品: '' },
    inventory: partial.inventory || [],
    skills: partial.skills || [],
    traits: partial.traits || [],
    personality: partial.personality || null,
    relations: partial.relations || [],
  };
}

export { computeAttrs, rootDisplayName };

// 注：原先的 advanceTime(save, hours)「每回合固定推进 N 小时」已移除——
// 世界时间现在完全由 AI 在正文里写下的绝对时间决定，读取与应用见 engine/worldTime.js。
