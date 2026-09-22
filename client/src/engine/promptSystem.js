// ===== 提示词与注入体系 · 组装逻辑 =====
// 所有提示词原文在 ../prompts/（先看那里的 README.md）；本文件只负责把它们按顺序拼成一条请求。
// 参照原站占位符预览与注入排布。
// 原站主聊天注入顺序：当前玩家输入 → 近期事态回顾 → 叙事记忆 → 世界地理/场景 →
// 世界因子 → 当前任务 → 剧情事件指导 → 状态写入规则 → 玩家状态快照 → NPC状态快照 →
// 在场/离场NPC → 物品/技能/功法 → 时间/地点/季节/天气 → 正文字数 → 人格核心
import { computeAttrs, rootDisplayName, personalityTraitText } from '../data/gameData.js';
import { matchWorldbookSplit, PLOT_STYLES } from '../saveModel.js';
import { resolveLayout } from './promptLayout.js';
import { processPromptsWithMacros } from './stMacroEngine.js';
import { extractPlaceholders, replacePlaceholders, extractPlaceholderNames } from './placeholderExtractor.js';
import { buildMortalProtocolText, MORTAL_PROTOCOL_SEGMENT_ID, MORTAL_PROTOCOL_META } from '../data/mortalProtocols.js';
import { getEffectiveTuning, serializeNumericTuning } from '../data/numericTuning.js';
import { colorPalettePromptText } from '../data/colorPalette.js';
import { NEW_CHAR_V2_TEMPLATE } from '../data/snapshotV2.js';
import { isV2Preset } from './evolutionPrompt.js';
import { PLACEHOLDERS, PRESET_ROLE_META } from '../prompts/tokens.js';
export { PLACEHOLDERS, PRESET_ROLE_META };
import { STYLE_PRESETS, DEFAULT_PROMPTS, DEFAULT_STATE_RULES } from '../prompts/storyPresets.js';
export { STYLE_PRESETS, DEFAULT_PROMPTS, DEFAULT_STATE_RULES };
import { DEFAULT_OUTPUT_CONTRACT, PLAYER_POV_CONTRACT, newCharIntakeLines } from '../prompts/contracts.js';
export { DEFAULT_OUTPUT_CONTRACT, PLAYER_POV_CONTRACT };
import { DEFAULT_BIO_TEMPLATE, DEFAULT_MEMORY_TEMPLATE, ASSISTANT_OP_TYPES, ASSISTANT_QUERY_SYSTEM, ASSISTANT_MODIFY_SYSTEM } from '../prompts/assistant.js';
export { DEFAULT_BIO_TEMPLATE, DEFAULT_MEMORY_TEMPLATE, ASSISTANT_OP_TYPES };
import { DEFAULT_EVOLUTION_RULES } from '../prompts/evolution.js';
export { DEFAULT_EVOLUTION_RULES };

// Mortal 协议占位符名 → 协议段 key（预设引用了占位符的协议不再于末尾重复注入）
const PROTOCOL_PLACEHOLDER_KEYS = {
  '正文状态栏协议': 'uiSys',
  '灵动正文语义渲染协议': 'proseDsl',
  '修炼结算显示协议': 'cultivation',
};
const ALL_PROTOCOL_KEYS = MORTAL_PROTOCOL_META.map(m => m.key); // 占位符未覆盖的协议（如 battle）也需在令牌出现时跳过


const PRESET_ROLE_SET = new Set(PRESET_ROLE_META.map(r => r.v));

/** 角色归一：model → assistant；无法识别的值按 system 处理 */
export function normalizePresetRole(role) {
  const r = String(role == null ? '' : role).trim().toLowerCase();
  if (r === 'model') return 'assistant';
  return PRESET_ROLE_SET.has(r) ? r : 'system';
}

/** 角色的中文说明（供界面展示） */
export function presetRoleZh(role) {
  const r = String(role == null ? 'system' : role).trim().toLowerCase();
  const hit = PRESET_ROLE_META.find(x => x.v === r);
  return hit ? hit.zh : '未知角色（按 system 处理）';
}

/**
 * 把预设里的第 from 段移到第 to 段的位置（拖动排序用）。
 * prompts 与 prompt_order[0].order 必须一起重排：注入时按 order 决定启用集合与顺序，
 * 只改 prompts 会让顺序「看着变了、实际没变」（或更糟——段被 order 里的旧位置拉回去）。
 * 各段的 enabled 状态跟着 identifier 走，不随位置变化；order 里多出的 identifier 保留在末尾。
 * @returns {object} 新的 raw 对象（不就地修改入参；越界/非法入参原样返回副本）
 */
export function reorderPresetPrompts(raw, from, to) {
  const out = raw && typeof raw === 'object' ? structuredClone(raw) : {};
  const arr = Array.isArray(out.prompts) ? out.prompts : [];
  const n = arr.length;
  const f = Number(from); const t = Number(to);
  if (!n || !Number.isInteger(f) || !Number.isInteger(t)) return out;
  if (f < 0 || f >= n || t < 0 || t >= n || f === t) return out;
  const [moved] = arr.splice(f, 1);
  arr.splice(t, 0, moved);
  out.prompts = arr;

  const fo = Array.isArray(out.prompt_order) ? out.prompt_order[0] : null;
  if (fo && Array.isArray(fo.order)) {
    const byId = new Map(fo.order.map(o => [o && o.identifier, o]));
    const used = new Set();
    const next = [];
    for (const p of arr) {
      const id = p && p.identifier;
      if (!id) continue;
      if (byId.has(id)) { next.push(byId.get(id)); used.add(id); }
      else next.push({ identifier: id, enabled: p.enabled !== false });
    }
    for (const o of fo.order) if (o && !used.has(o.identifier)) next.push(o);
    fo.order = next;
  }
  return out;
}

// 组装 messages：system 合并成一条 → assistant 段 → user 段。
// 末尾若是 assistant（预设只放了 AI 示范发言、没放 user 段），补一条 user 收尾：
// Anthropic 系接口要求末条为 user，多数兼容接口也不接受 assistant 结尾。
function buildRoleMessages({ sys = [], asst = [], user = [], fallback = '' }) {
  const messages = [];
  if (sys.length) messages.push({ role: 'system', content: sys.join('\n\n') });
  for (const a of asst) messages.push({ role: 'assistant', content: a });
  for (const u of user) messages.push({ role: 'user', content: u });
  if (!messages.length) messages.push({ role: 'user', content: fallback || '' });
  else if (messages[messages.length - 1].role === 'assistant') messages.push({ role: 'user', content: fallback || '（继续）' });
  return messages;
}


// ---------- 运行时占位符计算 ----------
function fmtAttrLine(c) {
  const a = computeAttrs(c);
  return `气血 ${a['气血上限']} · 法力 ${a['法力上限']} · 物攻 ${a['物攻']} · 物防 ${a['物防']} · 法攻 ${a['法攻']} · 法防 ${a['法防']} · 神识 ${a['神识']} · 气运 ${a['气运']}`;
}

// 玩家状态快照（参照原站快照结构：identity / action / bio 压缩呈现）
export function playerSnapshotText(save) {
  const c = save.character;
  const w = save.world;
  const lines = [
    `姓名：${c.name} | 性别：${c.gender} | 种族：${c.race?.name || '人族'} | 境界：${c.realm?.name || '凡人'}`,
    `灵根：${rootDisplayName(c.root)} | 身份：${c.origin?.name || '凡人'}`,
    `年龄：${c.age} 岁 · 寿元约 ${Math.max(0, (c.realm?.lifespan || 80) - c.age)} 年`,
    c.traits?.length ? `特质：${c.traits.map(t => `${t.name}（${t.rarity || '普通'}）`).join('、')}` : '特质：无',
    c.skills?.length ? `技能：${c.skills.map(s => s.name).join('、')}` : '技能：无',
    c.items?.length ? `物品：${c.items.map(i => `${i.name}×${i.count || 1}`).join('、')}` : '物品：无',
    `属性：${fmtAttrLine(c)}`,
    `当前行为：${save.lastState?.action || '（未记录）'}`,
    `着装：${save.lastState?.attire || '（未记录）'}`,
    `位置：${w.location?.name || '未知'}${save.lastState?.figure ? ` · ${save.lastState.figure}` : ''}`,
  ];
  if (c.personality?.deedsSummary) lines.push(`生平摘要：${c.personality.deedsSummary}`);
  return lines.join('\n');
}

export function npcSnapshotsText(save) {
  const npcs = save.npcs || [];
  if (!npcs.length) return '无';
  return npcs.map(n => [
    `· ${n.name}（${n.group} · ${n.subtitle || n.realm || '凡人'}）`,
    n.realm ? `  境界：${n.realm}` : '',
    n.relations?.length ? `  关系：${n.relations.map(r => `${r.target}(${r.relation})`).join('、')}` : '',
  ].filter(Boolean).join('\n')).join('\n');
}

function sceneInfoText(save) {
  const w = save.world;
  const onScreen = (save.npcs || []).filter(n => n.group === '在场人物').map(n => `${n.name}（${n.subtitle || n.realm || ''}）`);
  return [
    '### 【场景信息】',
    `时间：${w.timeLabel}（${w.season} · ${w.weather}）`,
    `地点：${w.location?.name || '未知'}${w.location?.aura ? ` · 灵气浓度 ${w.location.aura}` : ''}`,
    onScreen.length ? `在场人物：${onScreen.join('、')}` : '在场人物：无',
  ].join('\n');
}

function factorsText(save) {
  const f = save.world.factors || [];
  return f.length ? f.map(x => `· ${x.name}：${x.desc || ''}${x.effect ? `（效果：${x.effect}）` : ''}`).join('\n') : '无';
}

// 世界书：恒定条目（always）与关键词命中条目分开，便于分别放进恒定区 / 变化区。
// 条目来自跨存档共用的 settings.worldbook（不在存档里），所以这一组都收条目数组而非存档。
const wbEntryText = e => `【${e.name}】${e.content}`;

function worldbookAlwaysText(wb) {
  const { always } = matchWorldbookSplit(wb, '');
  return always.length ? always.map(wbEntryText).join('\n') : '';
}

function worldbookMatchedText(wb, recentText = '') {
  const { matched } = matchWorldbookSplit(wb, recentText);
  return matched.length ? matched.map(wbEntryText).join('\n') : '无命中条目';
}

// 完整世界书文本（恒定条目在前），保持旧行为
function worldbookText(wb, recentText = '') {
  const a = worldbookAlwaysText(wb);
  const m = worldbookMatchedText(wb, recentText);
  const parts = [];
  if (a) parts.push(a);
  if (m && m !== '无命中条目') parts.push(m);
  return parts.length ? parts.join('\n') : '无命中条目';
}

// 当前时空块：协议不再自带真实时空，由这一块统一给出权威数值
function sceneTimeText(save) {
  const w = save?.world || {};
  const lines = [
    '### 【当前时空】（本轮状态栏与 checkpoint 必须照抄这里的绝对时间与地点）',
    `时间：${w.timeLabel || '（未记录）'}`,
    `地点：${w.location?.name || '未知'}${w.location?.aura ? ` · 灵气浓度 ${w.location.aura}` : ''}`,
    `季节与天气：${w.season || '未知'} · ${w.weather || '未知'}`,
  ];
  if (w.location?.desc) lines.push(`环境：${w.location.desc}`);
  return lines.join('\n');
}


/**
 * 【主角心理留白】——玩家主权里最常被违反的一半。
 *
 * 成因：预设的「写作风格」段（尤其第三人称小说向的模板）常写着「大量内心独白、
 * 以自由间接引语直接给出、不要写成『他想』」。这套写法是为**第三人称小说**设计的；
 * 一旦叙事人称是第二人称（你），它必然变成替玩家断言心理：
 * 「你发现自己并不害怕杀人，甚至感到了一种从未有过的掌控感」——玩家没这么想，代入感当场碎掉。
 *
 * 而既有的三处玩家主权规则（预设「决策禁区」、末尾「玩家主权」、思维链「不得替玩家预设选择/行动/台词」）
 * 全都只覆盖**行动、发言、决定**，没有一条覆盖**心理、情绪、态度、评价** —— 所以拦不住。
 *
 * 这里补上，并且放在末尾契约区（服从度最高），保证**换任何预设都生效**。
 * 与文风无关：这条不是风格偏好，是玩家主权的硬边界。
 */


// 玩家自填的「其它约束」：接在所有提示词之后，是整条请求里最靠后的内容。
export function extraConstraintsText(settings) {
  const t = String(settings?.extraConstraints || '').trim();
  if (!t) return '';
  return `### 【其它约束（玩家指定，必须遵守）】\n${t}`;
}

function joinBlocks(list) {
  return list.filter(t => t && String(t).trim()).join('\n\n');
}

// 探针存档：把所有「逐回合可能变化」的字段一次性换掉。
// 用真实存档与探针存档各渲染一次，两次逐字节相同的预设段就是静态段。
function probeSave(save) {
  const K = '探针';
  const s = structuredClone(save || {});
  s.turnCount = (s.turnCount || 0) + 7;
  s.world = s.world || {};
  s.world.timeLabel = `${K}99年99月99日 99:99`;
  s.world.time = { y: 9999, mo: 99, d: 99, h: 99, mi: 99 };
  s.world.season = `${K}季`;
  s.world.weather = `${K}天`;
  s.world.inBattle = !s.world.inBattle;
  s.world.inSecretRealm = !s.world.inSecretRealm;
  if (s.world.location) s.world.location = { ...s.world.location, name: `${K}地点`, aura: K, desc: `${K}环境描述` };
  s.world.factors = [...(s.world.factors || []), { name: `${K}因子`, desc: K, effect: K }];
  s.character = { ...(s.character || {}), age: 999, items: [{ name: `${K}物品`, count: 9 }], skills: [{ name: `${K}技能` }] };
  s.character.personality = { ...(s.character.personality || {}), deedsSummary: `${K}生平` };
  s.lastState = { action: `${K}行为`, attire: `${K}着装`, figure: `${K}身影` };
  s.npcs = [...(s.npcs || []), { id: 'probe', name: `${K}NPC`, group: '在场人物', subtitle: K, realm: K, relations: [{ target: K, relation: K }] }];
  s.memories = [...(s.memories || []), { turn: 999, timeLabel: K, summary: `${K}记忆` }];
  s.memoryRecaps = [...(s.memoryRecaps || []), { fromTurn: 999, toTurn: 999, summary: `${K}阶段总结` }];
  s.plot = { ...(s.plot || {}), guidance: `${K}指导`, direction: `${K}方向` };
  s.missions = { active: [{ name: `${K}任务`, desc: K }], available: [] };
  const snapKeys = Object.keys(s.charSnapshots || {});
  if (snapKeys.length) {
    s.charSnapshots = structuredClone(s.charSnapshots);
    s.charSnapshots[snapKeys[0]] = { ...s.charSnapshots[snapKeys[0]], action: `${K}快照动作` };
  } else {
    s.charSnapshots = { B1: { identity: { name: K, race: '人族', linggen: K, age: 999, shouyuan: 999, personality: K }, stats: {}, resources: {}, equipment: {}, status: {}, action: K } };
  }
  return s;
}

// 探针 2：关系对齐探针。
// 只替换「值」的探针发现不了「关系比较」型依赖——例如 extractPlaceholders 里的
// 「后台人物故事」判断 `快照.action.location !== world.location.name`：
// 若真实情况本就是「玩家与所有 NPC 都不同地点」（独自行动时很常见），
// probeSave 把玩家地点换成第三个值后仍落在「不相等」这一侧，
// 段内容与真实完全相同，于是被判成静态并跳进恒定基座；
// 而玩家一旦移动，该段内容立刻变化，整个恒定前缀随之失效。
// 这里把玩家侧标量对齐到「存档中某个实体已存在的值」，制造「同处一地」的关系态来击穿它。
function probeSaveAligned(save) {
  const s = structuredClone(save || {});
  s.world = s.world || {};
  const locs = Object.values(s?.charSnapshots || {}).map(x => x?.action?.location).filter(Boolean);
  const here = s.world.location?.name;
  const other = locs.find(l => l !== here);
  if (other) s.world.location = { ...(s.world.location || {}), name: other };
  return s;
}

// 探针 3：集合翻转探针。
// 击穿「列表为空/非空」与「分类命中」型分支：把 npcs 的在/离场分类整体翻转，
// 并保证两类都非空；快照列表与记忆列表做「换名/清空」变形。
function probeSaveFlipped(save) {
  const s = structuredClone(save || {});
  const npcs = (s.npcs || []).map(n => ({
    ...n,
    group: n?.group === '离场人物' ? '在场人物' : '离场人物',
  }));
  if (!npcs.some(n => n.group === '离场人物')) npcs.push({ id: 'probeOff', name: '探针离场者', group: '离场人物', subtitle: '探针', realm: '探针' });
  if (!npcs.some(n => n.group === '在场人物')) npcs.push({ id: 'probeOn', name: '探针在场者', group: '在场人物', subtitle: '探针', realm: '探针' });
  s.npcs = npcs;
  const keys = Object.keys(s.charSnapshots || {});
  if (keys.length) {
    s.charSnapshots = structuredClone(s.charSnapshots);
    const last = keys[keys.length - 1];
    s.charSnapshots[last] = {
      ...s.charSnapshots[last],
      identity: { ...(s.charSnapshots[last]?.identity || {}), name: '探针角色' },
    };
  }
  s.memories = [];
  s.memoryRecaps = [];
  s.world = { ...(s.world || {}), factors: [] };
  return s;
}

function plotEvolutionText(save) {
  const plot = save.plot || {};
  const chosen = plot.styles || {};
  const active = PLOT_STYLES.filter(s => chosen[s.id]?.selected);
  const parts = [];
  if (plot.direction?.trim()) parts.push(`长期剧情方向（玩家意图，最高优先）：${plot.direction.trim()}`);
  if (active.length) {
    const turnIdx = save.turnCount || 0;
    const main = active[turnIdx % active.length];
    parts.push(`主导风格「${main.name}」：\n- ${main.instructions.join('\n- ')}`);
    for (const s of active) if (s.id !== main.id) parts.push(`叠加风格「${s.name}」：${s.desc}`);
  }
  if (plot.guidance?.trim()) parts.push(`当前剧情指导（导演层指令，优先级最高）：\n${plot.guidance.trim()}`);
  return parts.length ? parts.join('\n') : '（无特殊指导，按当前处境自然推进）';
}

function personalityCoreText(save) {
  const p = save.character.personality || {};
  const parts = [];
  // 带量纲与短句的偏向清单（文本自带表头），居中项不占篇幅
  const bias = personalityTraitText(p.dims);
  if (bias) parts.push(bias);
  if (p.scenarios?.length) parts.push(`情景反应：${p.scenarios.map(s => s.say).filter(Boolean).join('；')}`);
  return parts.length ? parts.join('\n') : '（性格深不可测，言行保持一致即可）';
}

function memoryText(save, settings) {
  const mem = save.memories || [];
  const recaps = save.memoryRecaps || [];
  const memCfg = settings?.memory || {};
  if (memCfg.enabled === false || (!mem.length && !recaps.length)) return '（暂无叙事记忆）';
  const parts = [];
  // 两级记忆：阶段总结（更早剧情脉络）在前，回合摘要（近期细节）在后——近细远粗，条数可配置
  if (recaps.length && memCfg.recapEnabled !== false) {
    parts.push('〔阶段总结 · 更早剧情脉络〕');
    parts.push(recaps.slice(-(memCfg.injectRecaps || 5)).map(r => `[第${r.fromTurn ?? '?'}-${r.toTurn ?? '?'}回合] ${r.summary}`).join('\n'));
  }
  if (mem.length) {
    parts.push('〔回合摘要 · 近期剧情〕');
    parts.push(mem.slice(-(memCfg.injectSummaries || 10)).map(m => `[${m.timeLabel || '第' + m.turn + '回合'}] ${m.summary}`).join('\n'));
  }
  return parts.join('\n');
}

function textRulesText(settings) {
  const tr = settings?.textRules || {};
  const style = STYLE_PRESETS.find(s => s.id === (tr.style || 'fanren'));
  const parts = [];
  if (style && style.id !== 'custom') parts.push(style.text);
  if (tr.customStyle?.trim()) parts.push(tr.customStyle.trim());
  return parts.length ? parts.join('\n') : '文风不限，保持修仙世界观即可。';
}

const PERSON_LABELS = { first: '第一人称（我）', second: '第二人称（你）', third: '第三人称（他/她）' };
function narrativePersonText(settings) {
  return PERSON_LABELS[settings?.story?.narrativePerson || 'second'] || PERSON_LABELS.second;
}

// 「正文规则与文风」的兜底注入：预设已引用的部分不重复写，未引用的部分补上。
// 外部预设（青竹等）只引用其中一两项，剩下的若不补，用户在设置页改了也不生效。
function buildTextRulesFill(settings, presetContent = '') {
  const has = (...keys) => keys.some(k => presetContent.includes(k));
  const parts = [];
  if (!has('${文风参考片段}', '{{textRules}}')) parts.push(`文风：${textRulesText(settings)}`);
  if (!has('${正文字数}', '{{wordCount}}')) {
    parts.push(`字数：${settings?.textRules?.minWords || 200}-${settings?.textRules?.maxWords || 400} 字`);
  }
  if (!has('${叙事人称协议}', '{{narrativePerson}}')) parts.push(`叙事人称：${narrativePersonText(settings)}`);
  return parts.length ? `### 【正文规则与文风】\n${parts.join('\n')}` : '';
}

function stateRulesText(settings) {
  const rules = settings?.evolutionRules || DEFAULT_EVOLUTION_RULES;
  const enabled = Object.values(rules).filter(r => r && r.enabled).map(r => r.content);
  return [DEFAULT_STATE_RULES, ...enabled].join('\n\n');
}

// 计算全部运行时占位符（供注入与「占位符预览」共用）
// opts.skipKeys：协议占位符已被预设 ${xxx} 引用的协议段 key（避免与 {{mortalProtocols}} 令牌双重注入）
export function buildTokens(save, settings, opts = {}) {
  const userInput = opts.userInput || '';
  const storyText = opts.storyText || (save.story || []).slice(-3).map(b => b.text).join('\n---\n');
  const skipKeys = Array.isArray(opts.skipKeys) ? opts.skipKeys : [];
  const w = save.world;
  const tokens = {
    '{{userInput}}': userInput.trim() || '（无具体行动，按当前处境自然推进剧情）',
    '{{storyText}}': storyText || '（故事刚刚开始）',
    '{{currentTime}}': w.timeLabel || '',
    '{{currentLocation}}': w.location?.name || '未知',
    '{{season}}': w.season || '',
    '{{weather}}': w.weather || '',
    '{{sceneInfoBlock}}': sceneInfoText(save),
    '{{onScreenNpcs}}': (save.npcs || []).filter(n => n.group === '在场人物').map(n => `· ${n.name}（${n.subtitle || n.realm || ''}）`).join('\n') || '无',
    '{{offScreenNpcs}}': (save.npcs || []).filter(n => n.group === '离场人物').map(n => `· ${n.name}（${n.subtitle || ''}）`).join('\n') || '无',
    '{{worldFactors}}': factorsText(save),
    '{{playerSnapshot}}': playerSnapshotText(save),
    '{{npcSnapshots}}': npcSnapshotsText(save),
    '{{narrativeMemory}}': memoryText(save, settings),
    '{{worldbook}}': worldbookText(settings?.worldbook, userInput + storyText),
    '{{plotEvolution}}': plotEvolutionText(save),
    '{{stateWriteRules}}': stateRulesText(settings),
    '{{textRules}}': textRulesText(settings),
    // {{mortalProtocols}} 令牌：被预设 ${xxx} 引用过的协议段跳过（防与占位符展开重复）
    '{{mortalProtocols}}': buildMortalProtocolText(save, settings?.textRules?.protocols, skipKeys, { battleMode: settings?.battle?.mode, settings }),
    '{{personalityCore}}': personalityCoreText(save),
    // 数值规则：只注入详细数值表（原「状态与数值变化的判定边界」导语已取消）
    '{{numericRules}}': serializeNumericTuning(getEffectiveTuning(settings)) || '（无数值约束）',
    // 正文着色词表：仅在用户把词表设为「限制」且非空时才有内容
    '{{colorPalette}}': colorPalettePromptText(settings) || '（未限制正文着色）',
    '{{wordCount}}': `${settings?.textRules?.minWords || 200}-${settings?.textRules?.maxWords || 400} 字`,
    '{{narrativePerson}}': narrativePersonText(settings),
    '{{currentSceneMap}}': w.location ? `${w.location.name}${w.location.desc ? `：${w.location.desc}` : ''}${w.location.aura ? `（灵气浓度 ${w.location.aura}）` : ''}` : '未知',
  };
  return tokens;
}

function renderTemplate(content, tokens) {
  return String(content || '').replace(/\{\{(\w+)\}\}/g, (m, name) => {
    const key = `{{${name}}}`;
    return key in tokens ? tokens[key] : m;
  });
}

// ---------- 组装主聊天消息（AI 模式） ----------
// 注：自双阶段改造后，正文阶段不再要求 AI 输出 ```state 块；
// 状态/快照演化交给 engine/evolutionPrompt.js 的 Stage 2。
export function assemblePrompt(settings, save, userInput, storyText) {
  const prompts = (settings?.prompts && settings.prompts.length ? settings.prompts : DEFAULT_PROMPTS)
    .filter(p => p.enabled !== false);
  const tokens = buildTokens(save, settings, { userInput, storyText });
  const sys = [];
  const user = [];
  const asst = [];
  for (const p of prompts) {
    const text = renderTemplate(p.content, tokens);
    if (!text.trim()) continue;
    const role = normalizePresetRole(p.role);
    if (role === 'user') user.push(text);
    else if (role === 'assistant') asst.push(text);
    else sys.push(text);
  }
  return buildRoleMessages({ sys, asst, user, fallback: tokens['{{userInput}}'] });
}

// Stage 1：仅生成正文（剔除状态写入段落，强化"只输出正文"约束）
export function assembleStoryPrompt(settings, save, userInput, storyText) {
  const msgs = assembleStoryMessages(settings, save, userInput, storyText);
  // 首遇即建档（阶段 1）：排在最后，离本轮输出最近，服从度最高
  const intake = newCharIntakeText(settings);
  return intake ? [...msgs, { role: 'system', content: intake }] : msgs;
}

/**
 * 【首遇即建档】阶段 1 的补充硬规则。
 *
 * 战斗协议要求「卡面数字必须逐字照抄该角色状态栏里的值」，但角色首次登场那一回合，
 * 快照要到阶段 2 才生成 —— 状态栏里没有他，卡面数字必然无据。
 * 因此让正文 AI 自己在角色露面**之前**先写一份建档块，程序当场落档（见 saveModel.ingestNewCharBlocks），
 * 同一次生成里先定数值、后写战斗卡，两边天然同源；阶段 2 只补它缺的叙事字段。
 *
 * 只在演化预设是 v2 时注入：只有 v2 才是「AI 写完整快照 + 程序逐项校验落库」的口径。
 */
export function newCharIntakeText(settings) {
  const list = Array.isArray(settings?.evolutionPresets) ? settings.evolutionPresets : [];
  const rules = list.find(p => p?.enabled) || list[0] || settings?.evolutionRules || null;
  if (!isV2Preset(rules)) return '';
  return newCharIntakeLines(NEW_CHAR_V2_TEMPLATE)
}

function assembleStoryMessages(settings, save, userInput, storyText) {
  // 优先：启用中的 SillyTavern 风格正文预设
  const activePreset = getActiveStoryPreset(settings);
  if (activePreset) {
    return assembleFromSillyTavernPreset(activePreset, save, settings, { userInput, storyText });
  }
  // 回退：DEFAULT_PROMPTS
  const prompts = (settings?.prompts && settings.prompts.length ? settings.prompts : DEFAULT_PROMPTS)
    .filter(p => p.enabled !== false);
  const tokens = buildTokens(save, settings, { userInput, storyText });
  const sys = [];
  const user = [];
  const asst = [];
  for (const p of prompts) {
    // 跳过状态写入段落：本阶段只生成正文
    if (p.id === 'state-write') continue;
    const text = renderTemplate(p.content, tokens);
    if (!text.trim()) continue;
    const role = normalizePresetRole(p.role);
    if (role === 'user') user.push(text);
    else if (role === 'assistant') asst.push(text);
    else sys.push(text);
  }
  // 旧自定义 prompts 未含 Mortal 协议段时，运行时补注入（状态栏/语义标记/结算/战斗）
  if (!prompts.some(p => p.id === MORTAL_PROTOCOL_SEGMENT_ID)) {
    sys.push(buildMortalProtocolText(save, settings?.textRules?.protocols, [], { battleMode: settings?.battle?.mode, settings }));
  }
  // {{worldbook}} 令牌现在只含命中条目，恒定条目与当前时空需单独补注入
  const wbAlways = worldbookAlwaysText(settings?.worldbook);
  if (wbAlways) sys.push(`### 【世界书·恒定设定（每轮必须遵守）】\n${wbAlways}`);
  sys.push(sceneTimeText(save));
  // 文风/字数/人称：默认段落只覆盖文风与字数，人称与自定义段落漏掉的项在这里补
  const rulesFill = buildTextRulesFill(settings, prompts.map(p => String(p.content || '')).join('\n'));
  if (rulesFill) sys.push(rulesFill);
  // 正文着色词表（默认预设路径没有 {{colorPalette}} 段落，按需补注入）
  const paletteText = colorPalettePromptText(settings);
  if (paletteText) sys.push(paletteText);
  // 末尾再追加一条强化约束
  sys.push(DEFAULT_OUTPUT_CONTRACT);
  // 主角心理留白：与预设无关的玩家主权硬边界，紧贴玩家输入之前
  sys.push(PLAYER_POV_CONTRACT);
  // 玩家自填的其它约束：排到最后，离本轮行动最近
  const extra = extraConstraintsText(settings);
  if (extra) sys.push(extra);
  return buildRoleMessages({ sys, asst, user, fallback: tokens['{{userInput}}'] });
}

// 取启用中的正文预设
export function getActiveStoryPreset(settings) {
  const list = Array.isArray(settings?.storyPresets) ? settings.storyPresets : [];
  const active = list.find(p => p && p.enabled);
  return active?.raw || null;
}

// 预设对「文风 / 字数 / 人称」三个占位符的引用情况（设置页据此提示会不会注入）。
// 与组装时同一套启用判定，避免提示与实际注入结果不一致。
export function presetPlaceholderUsage(settings) {
  const list = Array.isArray(settings?.storyPresets) ? settings.storyPresets : [];
  const active = list.find(p => p && p.enabled);
  if (!active?.raw) return null;
  const preset = active.raw;
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  const orderMap = new Map();
  const firstOrder = Array.isArray(preset.prompt_order) ? preset.prompt_order[0] : null;
  if (firstOrder && Array.isArray(firstOrder.order)) {
    for (const it of firstOrder.order) orderMap.set(it.identifier, !!it.enabled);
  }
  const text = prompts
    .filter(p => (orderMap.has(p.identifier) ? orderMap.get(p.identifier) : p.enabled !== false))
    .map(p => String(p.content || ''))
    .join('\n');
  return {
    name: active.name || '未命名预设',
    style: text.includes('${文风参考片段}') || text.includes('{{textRules}}'),
    words: text.includes('${正文字数}') || text.includes('{{wordCount}}'),
    person: text.includes('${叙事人称协议}') || text.includes('{{narrativePerson}}'),
  };
}

// 基于 SillyTavern 风格预设组装消息
// 预设结构：{ prompts:[{identifier,name,enabled,role,content,...}], prompt_order, ... }
// 关键：1) ST 宏引擎顺序求值（setvar/getvar 跨段共享）2) ${xxx} 占位符从快照/存档提取实际内容
//       3) 按「恒定前置 / 变化居中 / 契约收尾」三分区排布，让恒定内容落进前缀缓存
function assembleFromSillyTavernPreset(preset, save, settings, { userInput, storyText }) {
  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];

  // 决定启用顺序：优先用 prompt_order[0].order，否则用 prompts 自身 enabled
  const orderMap = new Map();
  const firstOrder = Array.isArray(preset.prompt_order) ? preset.prompt_order[0] : null;
  if (firstOrder && Array.isArray(firstOrder.order)) {
    for (const it of firstOrder.order) orderMap.set(it.identifier, !!it.enabled);
  }
  const enabledSegs = [];
  for (const p of prompts) {
    const enabled = orderMap.has(p.identifier) ? orderMap.get(p.identifier) : p.enabled !== false;
    if (enabled) enabledSegs.push(p);
  }

  // 预设通过 ${xxx} 引用过的协议段，末尾不再重复注入
  const presetContent = enabledSegs.map(x => String(x.content || '')).join('\n');
  const skipByPlaceholder = Object.entries(PROTOCOL_PLACEHOLDER_KEYS)
    .filter(([ph]) => presetContent.includes(`\${${ph}}`))
    .map(([, key]) => key);
  const tokenCoversAll = presetContent.includes('{{mortalProtocols}}');
  const skipKeys = tokenCoversAll ? ALL_PROTOCOL_KEYS : skipByPlaceholder;

  const charName = prompts.find(p => p.name?.includes('主提示'))?.content?.match(/「([^」]+)」/)?.[1] || 'Tomoyo';
  const macroCtx = { userName: save.character?.name || '主角', charName, model: settings?.ai?.model };

  // 渲染一组预设段：ST 宏 → ${占位符} → {{令牌}}
  const render = (sv, input, story) => {
    const macro = processPromptsWithMacros(
      enabledSegs.map(p => ({ role: p.role || 'system', content: p.content || '', name: p.name })),
      macroCtx
    );
    const pmap = extractPlaceholders(sv, sv.charSnapshots || {}, {
      userInput: input, storyText: story, settings,
      sceneInfo: sceneInfoText(sv), plotEvolution: plotEvolutionText(sv), textRulesText: textRulesText(settings),
    });
    const tk = buildTokens(sv, settings, { userInput: input, storyText: story, skipKeys });
    return macro.map((m, i) => {
      let text = replacePlaceholders(m.content, pmap);
      text = renderTemplate(text, tk);
      // model 是 ST 对 assistant 的写法，归一后按 assistant 独立成条
      const role = normalizePresetRole(m.role);
      return { name: enabledSegs[i]?.name || m.name, raw: String(enabledSegs[i]?.content || ''), role, text };
    });
  };

  // 真实渲染 + 多形态探针渲染：
  // 判定某段是否「静态」（逐回合逐字节不变）时，单一探针只能发现「直接引用存档值」的段，
  // 对「关系比较」「集合空/非空」「分类命中」型依赖会漏判——真实值与探针值落在同一分支时，
  // 段会被误判为静态并跳进恒定基座，等真实值换到另一侧时整段位移，恒定前缀全部失效。
  // 因此改用三个不同形态的探针分别击穿，判定取交集：任一探针结果与真实不同即为动态。
  // 探针抛错时按动态处理——宁可少放，不能放错。
  const realAll = render(save, userInput, storyText);
  const probeStory = [storyText, ...((settings?.worldbook || []).flatMap(e => e.keywords || []))].join('\n');
  const probeInput = `${userInput}\u0000探针输入`;
  const probeStoryArg = `${probeStory}\u0000探针剧情`;
  const probeAlls = [];
  for (const mk of [probeSave, probeSaveAligned, probeSaveFlipped]) {
    try {
      probeAlls.push(render(mk(save), probeInput, probeStoryArg));
    } catch (err) {
      probeAlls.push(null);
    }
  }

  const segs = [];
  for (let i = 0; i < realAll.length; i++) {
    const seg = realAll[i];
    if (!seg.text.trim()) continue;
    // 引用 {{worldbook}} 的段落一律按动态处理：命中集合无法用探针穷举
    const isStatic = !String(seg.raw).includes('{{worldbook}}')
      && probeAlls.every(pa => pa && pa[i] && pa[i].text === seg.text);
    segs.push({ ...seg, isStatic });
  }

  const tokens = buildTokens(save, settings, { userInput, storyText, skipKeys });
  const paletteText = colorPalettePromptText(settings);

  // 文风 / 字数 / 人称：预设引用了对应占位符就由预设自己给出，没引用的一律在这里补注入。
  // 否则用户在「正文规则与文风」里改了设置，换个预设就静默失效。
  const textRulesFill = buildTextRulesFill(settings, presetContent);

  const block = {
    presetStatic: joinBlocks(segs.filter(x => x.role === 'system' && x.isStatic).map(x => x.text)),
    presetDynamic: joinBlocks(segs.filter(x => x.role === 'system' && !x.isStatic).map(x => x.text)),
    wbAlways: (() => { const a = worldbookAlwaysText(settings?.worldbook); return a ? `### 【世界书·恒定设定（每轮必须遵守）】\n${a}` : ''; })(),
    protocolStatic: buildMortalProtocolText(save, settings?.textRules?.protocols, skipKeys, { battleMode: settings?.battle?.mode, settings }),
    textRules: textRulesFill,
    numeric: (!presetContent.includes('{{numericRules}}') && tokens['{{numericRules}}'] !== '（无数值约束）')
      ? `### 【数值规则】\n${tokens['{{numericRules}}']}` : '',
    palette: (!presetContent.includes('{{colorPalette}}') && paletteText) ? paletteText : '',
    memory: (!presetContent.includes('{{narrativeMemory}}') && tokens['{{narrativeMemory}}'] !== '（暂无叙事记忆）')
      ? `### 【叙事记忆】（此前剧情的浓缩摘要，保持连续性）\n${tokens['{{narrativeMemory}}']}` : '',
    wbHits: (() => {
      if (presetContent.includes('{{worldbook}}')) return '';
      const m = worldbookMatchedText(save, userInput + storyText);
      return m === '无命中条目' ? '' : `### 【世界书设定（必须遵守的背景设定）】\n${m}`;
    })(),
    sceneTime: sceneTimeText(save),
    history: (!presetContent.includes('{{storyText}}') && !presetContent.includes('${Chat History}')
      && tokens['{{storyText}}'] !== '（故事刚刚开始）')
      ? `### 【最近剧情回顾】（此前剧情原文，保持连贯，不要复述）\n${tokens['{{storyText}}']}` : '',
    contract: DEFAULT_OUTPUT_CONTRACT,
    // 主角心理留白：玩家主权硬边界，跟输出契约同处末尾契约区（服从度最高）
    playerPov: PLAYER_POV_CONTRACT,
    extraConstraints: extraConstraintsText(settings),
  };

  // 按用户设定的排布拼装：恒定基座 → 变化区 → 末尾契约（单条 system 消息）
  const layout = resolveLayout(settings?.promptLayout);
  const sys = joinBlocks([...layout.stable, ...layout.dynamic, ...layout.tail].map(id => block[id]));

  // 组装 messages（assistant / user 段按原顺序跟在 system 之后）
  const messages = [];
  if (sys.trim()) messages.push({ role: 'system', content: sys });
  for (const a of segs.filter(x => x.role === 'assistant')) messages.push({ role: 'assistant', content: a.text });
  for (const u of segs.filter(x => x.role === 'user')) messages.push({ role: 'user', content: u.text });
  if (!messages.length) messages.push({ role: 'user', content: userInput || '' });
  else if (messages[messages.length - 1].role === 'assistant') messages.push({ role: 'user', content: userInput || '（继续）' });
  return messages;
}

// ---------- 解析 AI 回复尾部的 ```state 块（快照联通：AI → 存档状态） ----------
export function parseStateBlock(text) {
  const m = text.match(/```state\s*([\s\S]*?)```/);
  if (!m) return { text: text.trim(), state: null };
  let state = null;
  try { state = JSON.parse(m[1]); } catch { state = null; }
  return { text: text.replace(m[0], '').trim(), state };
}

// ---------- 天道助手（查询/修改双模式，参照原站） ----------
// 存档上下文（给天道助手的紧凑数据）
export function assistantContextText(save) {
  const c = save.character;
  return JSON.stringify({
    主角: {
      姓名: c.name, 性别: c.gender, 年龄: c.age, 种族: c.race?.name, 境界: c.realm?.name,
      灵根: rootDisplayName(c.root), 出身: c.origin?.name,
      特质: (c.traits || []).map(t => t.name),
      技能: (c.skills || []).map(s => s.name),
      物品: (c.items || []).map(i => `${i.name}×${i.count || 1}`),
      性格: personalityCoreText(save),
    },
    人物名册: (save.npcs || []).map(n => ({ 姓名: n.name, 分组: n.group, 身份: n.subtitle, 境界: n.realm })),
    角色快照: Object.entries(save.charSnapshots || {}).map(([id, sn]) => ({ id, 姓名: sn?.identity?.name, 境界: sn?.identity?.realm, 当前状态: sn?.status?.current, 灵石: sn?.economy?.spiritStones })),
    世界: {
      时间: save.world?.timeLabel, 天气: save.world?.weather, 季节: save.world?.season,
      地点: save.world?.location?.name, 世界因子: (save.world?.factors || []).map(f => f.name),
    },
    剧情: {
      长期方向: save.plot?.direction || '',
      已选风格: PLOT_STYLES.filter(s => save.plot?.styles?.[s.id]?.selected).map(s => s.name),
      剧情指导: (save.plot?.guidance || '').slice(0, 300),
    },
    叙事记忆: (save.memories || []).slice(-8).map(m => m.summary),
    人物生平: (save.plotProgress || []).slice(-10).map(p => p.text),
    回合数: save.turnCount || 0,
  }, null, 1);
}

// 查询模式：基于存档数据回答玩家问题
export function buildAssistantQueryMessages(save, question) {
  return [
    {
      role: 'system',
      content: ASSISTANT_QUERY_SYSTEM,
    },
    { role: 'user', content: `【存档数据】\n${assistantContextText(save)}\n\n【玩家的问题】\n${question}` },
  ];
}


export function buildAssistantModifyMessages(save, instruction) {
  return [
    {
      role: 'system',
      content: ASSISTANT_MODIFY_SYSTEM,
    },
    { role: 'user', content: `【存档数据】\n${assistantContextText(save)}\n\n【玩家的修改需求】\n${instruction}` },
  ];
}

// 解析天道助手的 ```ops 块
export function parseOpsBlock(text) {
  const m = String(text || '').match(/```ops\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]);
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}
