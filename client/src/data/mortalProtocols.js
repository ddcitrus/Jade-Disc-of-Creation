// ===== Mortal 运行时协议 · 组装逻辑 =====
// 协议原文（写给 AI 看的那些字）全部在 ../prompts/protocols.js，本文件只负责「怎么填、注在哪一段」。
// 由 Mortal 运行时注入主聊天提示词，高于正文预设中关于状态栏/环境信息/修炼结算/战斗的旧描述。
// 四个协议：状态栏（ui_sys/scene_checkpoint/地点层级）、灵动正文语义标记（DSL）、修炼结算显示、自动战斗推演。
// 占位符：${time_format_rule} ${time_format_example} ${current_time} ${current_location} ${season} ${weather}
//   时间/地点/季节/天气一律填「格式模板」而不是真实值——真实值由 promptSystem 的【当前时空】区块给出。
//   这样整段协议逐回合恒定，能留在请求的恒定前缀里被前缀缓存命中；
//   同时避免出现一个长得像真实时间的示例被模型直接照抄。

// 地块清单要动态注入战斗接管协议（唯一的可选值来源，AI 不能自造地块）
import { terrainCatalogText } from './battleTerrain.js';
// 修炼耗时：程序只给数据与公式，算由 AI 现算（公式段在 ../prompts/protocols.js 的修炼协议里）
import { cultivationFormulaLines, cultivationParamsText } from './cultivationParams.js';
import { MORTAL_UI_SYS_PROTOCOL, MORTAL_PROSE_DSL, MORTAL_PROSE_NUMBERS, MORTAL_CULTIVATION_PROTOCOL, MORTAL_BATTLE_PROTOCOL, BATTLE_TAKEOVER_BODY, MORTAL_BATTLE_NARRATIVE_PROTOCOL, MORTAL_TIME_TEMPLATE, MORTAL_PROTOCOL_META, MORTAL_PROTOCOL_SEGMENT_ID } from '../prompts/protocols.js';
export { MORTAL_BATTLE_PROTOCOL, MORTAL_TIME_TEMPLATE, MORTAL_PROTOCOL_META, MORTAL_PROTOCOL_SEGMENT_ID };


const pad2 = (n) => String(n ?? 0).padStart(2, '0');


/** 战后叙事的字数口径（与「自动下回合」右侧的字数控件同一条公式，见 GameDashboard.turnWords） */
export function battleWordQuota(settings) {
  const tr = settings?.textRules || {};
  const min = Math.max(1, Math.round(Number(tr.minWords) || 200));
  const max = Math.max(min, Math.round(Number(tr.maxWords) || 400));
  return {
    min, max,
    floor: Math.max(min, Math.round((min + max) / 2)),
    target: Math.max(min, Math.round(max * 0.9)),
  };
}


/**
 * 按「战斗模式」过滤协议段：两条战斗协议**互斥**，永不同时注入。
 *   mode = 'manual'（战斗模式开启）→ 注入 battleTakeover，跳过 battle
 *   mode = 其它（关闭 / 未设置）  → 注入 battle，跳过 battleTakeover
 */
export function filterProtocolMetaByMode(battleMode) {
  const manual = battleMode === 'manual';
  return MORTAL_PROTOCOL_META.filter(m => (m.mode === 'manual' ? manual : m.mode === 'auto' ? !manual : true));
}

/**
 * 组装单个协议文本：自定义覆盖优先（settings.textRules.protocols[key]），空值回退内置默认。
 * 自定义文本同样支持下列运行时占位符，按当前存档世界状态实时填充。
 */
export function buildProtocolSegment(key, save, overrides) {
  const meta = MORTAL_PROTOCOL_META.find(m => m.key === key);
  if (!meta) return '';
  const custom = overrides?.[key];
  return (typeof custom === 'string' && custom.trim()) ? custom : meta.default();
}

/**
 * 组装 Mortal 运行时协议分段（已按存档世界状态填充占位符）。
 * opts.battleMode = 'manual' 时用「战斗接管协议」顶替「自动战斗推演协议」。
 * @returns {{ uiSys:string, proseDsl:string, cultivation:string, battle:string, battleTakeover:string }}
 */


export function buildProtocolSegments(save, overrides, opts = {}) {
  const real = opts.realTime === true; // 仅供排查问题：填真实时空（默认关闭，关闭才能保持协议恒定）
  const w = save?.world || {};
  const t = w.time || {};
  const realExample = t.y ? `${t.y}年${pad2(t.mo)}月${pad2(t.d)}日 ${pad2(t.h)}:${pad2(t.mi)}` : MORTAL_TIME_TEMPLATE;
  const timeText = real ? (w.timeLabel || realExample) : `（见【当前时空】段，格式 ${MORTAL_TIME_TEMPLATE}）`;
  const locText = real ? (w.location?.name || '未知') : '（见【当前时空】段）';
  const seasonText = real ? (w.season || '未知') : '（见【当前时空】段）';
  const weatherText = real ? (w.weather || '未知') : '（见【当前时空】段）';
  const fmtRule = `时间使用绝对游戏时间，格式为「${MORTAL_TIME_TEMPLATE}」；不要输出星期、周几或传统时辰`;
  const fill = (s) => String(s)
    .replace(/\$\{current_time\}/g, timeText)
    .replace(/\$\{current_location\}/g, locText)
    .replace(/\$\{season\}/g, seasonText)
    .replace(/\$\{weather\}/g, weatherText)
    .replace(/\$\{time_format_rule\}/g, fmtRule)
    .replace(/\$\{time_format_example\}/g, MORTAL_TIME_TEMPLATE);
  const segs = {};
  for (const meta of MORTAL_PROTOCOL_META) {
    segs[meta.key] = fill(buildProtocolSegment(meta.key, save, overrides));
  }
  return segs;
}

/**
 * 组装 Mortal 运行时协议全文（按战斗模式取相应那一条），并按当前存档世界状态填充占位符。
 * 注入位置：正文提示词（assembleStoryPrompt）的 system 段，末尾约束之前。
 * overrides：settings.textRules.protocols，允许用户在设置页自定义任意协议文本。
 * opts.battleMode：'manual' = 战斗模式开启（用接管协议），其余 = 关闭（用自动推演协议）。
 * 注意：只取 scope='story' 的协议。战后叙事协议（scope='afterBattle'）不进普通回合，
 *       由 buildAfterBattleProtocolText 单独取。
 */
export function buildMortalProtocolText(save, overrides, skipKeys = [], opts = {}) {
  const segs = buildProtocolSegments(save, overrides, opts);
  const text = filterProtocolMetaByMode(opts.battleMode)
    .filter(m => (m.scope || 'story') === 'story')
    .filter(m => !skipKeys.includes(m.key))
    .map(m => segs[m.key])
    .filter(s => s && s.trim())
    .join('\n\n');
  // 【本轮修炼参数】追加在协议全文**末尾**，而不是拼进修炼协议段里：
  //   前面的协议逐回合恒定，能留在请求的恒定前缀里被前缀缓存命中；只有这一段随
  //   地点/灵气/装备变化，坏了缓存也只坏末尾这一小段。
  //   它只给数据（境界、寿元、灵根、灵气、装备点数、世界因子），公式在上面的协议里，
  //   耗时由 AI 本轮现算 —— 见 mortalProtocols 的「耗时怎么算」段。
  const params = cultivationParamsText(save, { settings: opts.settings });
  return params ? `${text}\n\n${params}` : text;
}

/**
 * 组装「战斗结束、补写正文」那一次请求要用的协议全文（方案 B：和平时的正文同源）。
 * 两件事：
 *   ① ${proseNumbers} 实时展开成设置页里那份「正文数值约束」（用户改一处，两处生效）；
 *   ② 字数占位符按 settings.textRules 的字数区间填实际数字。
 * 用户自定义的战后协议若漏掉了 ${proseNumbers}，末尾**兜底补一份**数值约束——
 * 漏了它就等于回到「AI 把气血两千九百九十八点抄进散文」那个 bug。
 * @returns {string} 已填好占位符的协议全文
 */
export function buildAfterBattleProtocolText(save, settings) {
  const overrides = settings?.textRules?.protocols;
  const segs = buildProtocolSegments(save, overrides, {});
  const text = segs.battleNarrative || MORTAL_BATTLE_NARRATIVE_PROTOCOL;
  const numbers = (segs.proseNumbers || '').trim() || MORTAL_PROSE_NUMBERS;
  const q = battleWordQuota(settings);
  const quoted = text.includes('${proseNumbers}');
  const filled = text
    .replace(/\$\{proseNumbers\}/g, numbers)
    .replace(/\$\{battleWordsMax\}/g, String(q.max))
    .replace(/\$\{battleWordsFloor\}/g, String(q.floor))
    .replace(/\$\{battleWords\}/g, String(q.target));
  return quoted ? filled : `${filled}\n\n${numbers}`;
}


