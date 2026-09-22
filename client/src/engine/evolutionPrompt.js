// ===== 演化阶段提示词 · 组装逻辑 =====
// 契约与规则原文在 ../prompts/evolution.js；本文件负责拼装与解析。
// 输入：本轮正文 + 各角色当前快照 + 快照编辑规则预设
// 输出：严格 JSON 信封 { thinking, snapshots, deeds, worldTime }
import { snapshotsBundleText } from '../data/snapshotSchema.js';
import { v2BundleText, NEW_CHAR_V2_TEMPLATE } from '../data/snapshotV2.js';
import { getEffectiveTables } from '../data/numericTuning.js';
import { formatRealmBoundsTable } from '../data/realmBounds.js';
import { formatTraitModsTable } from '../data/traitLibrary.js';
import { EVOLUTION_HARD_CONTRACT, CONCURRENT_BRIDGE_CONTRACT, EVOLUTION_V2_CONTRACT, DEFAULT_EVOLUTION_RULES_FALLBACK, EVO_TRAIT_WRITE_NOTE, EVO_TRAIT_TABLE_NOTE, EVO_BASELINE_HEADING, EVO_V2_BASELINE_NOTE, EVO_V2_TEMPLATE_VALUE_NOTE, EVO_V2_TEMPLATE_CRIT_NOTE, EVO_V2_TEMPLATE_FIELDS_NOTE, EVO_V2_KIND_NOTE, EVO_V2_STATS_NOTE, EVO_V2_EQUIPMENT_NOTE, EVO_V2_ITEM_TYPE_NOTE, EVO_V2_ITEM_GRADE_NOTE, EVO_V2_ITEM_OPTIONAL_NOTE, EVO_V2_RELATION_NOTE, EVO_V2_BIO_NOTE, EVO_V2_EMPTY_KEY_NOTE, EVO_V2_NEW_CHAR_NOTE } from '../prompts/evolution.js';
export { EVOLUTION_HARD_CONTRACT, EVOLUTION_V2_CONTRACT };

// 境界数值基准紧凑表（供演化/初始快照提示词约束 AI 生成角色的属性区间）
// 表本身来自数值表；夹在表前后的说明文字在 ../prompts/evolution.js。
//
// 这里必须注入**用户生效的那张表**（settings.numericTuning），不是内置常量表：
// 故事阶段走 {{numericRules}} 注入的是生效表，若演化阶段注入内置表，AI 在同一个回合里
// 会看到两套区间（内置表一套、生效表一套，宽窄可能不同），于是新角色的属性按宽表写、
// 落库时被窄表强行压回，玩家看到的就是「AI 生成的属性超上限」。
// 同时必须给全列：旧版只输出 HP/MP 两列，攻防/神识/脚力没有区间可依，只能靠编。
function realmBaselineText(tuning) {
  // 用 getEffectiveTables（不是 getEffectiveTuning）：前者同时接受 settings 与 settings.numericTuning
  // 两种入参，且缺表时回落到内置默认，调用方不必关心传的是哪一层。
  const tables = getEffectiveTables(tuning) || {};
  const realm = formatRealmBoundsTable(tables.realmProfiles);
  const lines = [
    realm,
    '',
    traitModsText(),
    EVO_TRAIT_WRITE_NOTE,
  ];
  return lines.join('\n');
}

// 特质词条表：让 AI 知道库内特质的固定加成（这些数字由系统实时叠加，不用它写进属性）
function traitModsText() {
  return [
    '【特质词条表】（库内特质的固定加成，程序权威口径）',
    formatTraitModsTable(),
    EVO_TRAIT_TABLE_NOTE,
  ].join('\n');
}


// ---------- 组装 Stage 2 提示词 ----------
// args: { storyText, userInput, snapshots(对象), evolutionRules(对象或null), worldInfo }
export function assembleEvolutionPrompt({
  storyText, userInput, snapshots, evolutionRules, worldInfo = '', tuning = null,
}) {
  const rules = evolutionRules || DEFAULT_EVOLUTION_RULES_FALLBACK;
  // 拼装规则文本
  const rulesText = buildRulesText(rules);
  // 检测是否 concurrent 预设（决定是否附加格式桥接契约）
  const isConcurrent = !!(rules && typeof rules === 'object'
    && (rules.sharedRules || rules.itemSharedRules || (rules.prompts && typeof rules.prompts === 'object' && !Array.isArray(rules.prompts))));

  const sys = [
    '你是一位「修仙故事快照演化引擎」，职责是根据本轮正文与当前各角色快照，按规则输出本轮结束时的最新快照集合。',
    '',
    EVOLUTION_HARD_CONTRACT,
    ...(isConcurrent ? ['', CONCURRENT_BRIDGE_CONTRACT] : []),
    '',
    '## 【快照编辑规则】（你必须严格遵守各阶段规则）',
    rulesText,
    '',
    EVO_BASELINE_HEADING,
    realmBaselineText(tuning),
    '',
    '## 【世界信息】',
    worldInfo || '（无）',
    '',
    '## 【当前各角色快照】（本轮起点）',
    snapshotsBundleText(snapshots),
    '',
    '## 【本轮正文】',
    storyText || '（无正文）',
    '',
    '## 【玩家本轮行动】',
    userInput || '（无具体行动）',
  ].join('\n');

  return [
    { role: 'system', content: sys },
    { role: 'user', content: '请按契约输出本轮演化结果 JSON。' },
  ];
}

// 把规则对象拼成可注入文本（兼容三种形态）
function buildRulesText(rules) {
  // 形态 A：对象
  if (!Array.isArray(rules) && typeof rules === 'object' && rules !== null) {
    // 兼容 concurrent-evo-preset 新结构：sharedRules + itemSharedRules + prompts(对象) + outputFormat + bioCompressionTemplate
    if (rules.sharedRules || rules.itemSharedRules || rules.prompts || rules.outputFormat) {
      return buildFromConcurrentPreset(rules);
    }
    // 兼容导入的「完整版-物品管理.json」旧结构：contentTemplates / entrySharedRules / stages
    if (rules.contentTemplates || rules.entrySharedRules || rules.stages) {
      return buildFromPresetJson(rules);
    }
    // 默认 5 阶段
    const parts = [];
    for (const [id, r] of Object.entries(rules)) {
      if (!r) continue;
      if (r.enabled === false) continue;
      parts.push(`### 阶段 ${id}：${r.name || id}\n${r.content || ''}`);
    }
    return parts.join('\n\n') || '（无阶段规则，按常识演化）';
  }
  // 形态 B：数组
  if (Array.isArray(rules)) {
    return rules.map((r, i) => `### 阶段 ${i + 1}：${r.name || ''}\n${r.content || ''}`).join('\n\n');
  }
  return '（无阶段规则，按常识演化）';
}

// 兼容 concurrent-evo-preset-full 新结构
// 顶层：{ outputFormat, entrySharedRules, sharedRules, itemSharedRules, prompts(对象), bioCompressionTemplate }
function buildFromConcurrentPreset(preset) {
  const parts = [];
  // skipRuleNames：按规则名屏蔽指定的旧规则（v2 下用于挡掉「旧命令语法 / 旧输出格式 / 旧 ID 规则」）
  const skipNames = new Set((Array.isArray(preset.skipRuleNames) ? preset.skipRuleNames : []).map(String));
  const keep = (r) => r && r.enabled !== false && !skipNames.has(String(r.name || r.id || ''));
  if (preset.name) parts.push(`> 预设名：${preset.name}`);
  if (preset.description) parts.push(`> 描述：${preset.description.slice(0, 400)}`);

  // outputFormat：tagged 表示用 <thinking>/<state>/<upstore> 标签输出
  if (preset.outputFormat && !skipNames.has('__outputFormat')) {
    parts.push('## 【输出格式】');
    parts.push(`输出格式：${preset.outputFormat}（tagged = 使用 <thinking>、<state>、<upstore> 标签输出）`);
    parts.push('注意：本系统已改用【演化输出契约 v2】，上面这条历史输出格式要求作废，以 v2 契约的四段信封为准。');
  }

  // entrySharedRules：登场阶段共用规则
  if (Array.isArray(preset.entrySharedRules)) {
    parts.push('## 【登场阶段共用规则】');
    for (const r of preset.entrySharedRules) {
      if (!keep(r)) continue;
      parts.push(`### ${r.name || r.id || '规则'}\n${r.content || ''}`);
    }
  }

  // sharedRules：跨阶段共用规则
  if (Array.isArray(preset.sharedRules)) {
    parts.push('## 【跨阶段共用规则】');
    for (const r of preset.sharedRules) {
      if (!keep(r)) continue;
      parts.push(`### ${r.name || r.id || '规则'}\n${r.content || ''}`);
    }
  }

  // itemSharedRules：物品阶段共用规则
  if (Array.isArray(preset.itemSharedRules)) {
    parts.push('## 【物品阶段共用规则】');
    for (const r of preset.itemSharedRules) {
      if (!keep(r)) continue;
      parts.push(`### ${r.name || r.id || '规则'}\n${r.content || ''}`);
    }
  }

  // prompts：按角色分组的提示词（对象，非数组）
  // 每组结构：{ enabled: bool, rules: [{name, content, role, enabled}], assistantPrefill: string }
  // activePromptGroups：只注入列出的分组（v2 新增）。缺省时沿用老行为（全注入）。
  const activeGroups = Array.isArray(preset.activePromptGroups) && preset.activePromptGroups.length
    ? new Set(preset.activePromptGroups.map(String))
    : null;
  if (preset.prompts && typeof preset.prompts === 'object' && !Array.isArray(preset.prompts)) {
    parts.push('## 【按角色分组的演化提示词】');
    for (const [group, groupDef] of Object.entries(preset.prompts)) {
      if (!groupDef || groupDef.enabled === false) continue;
      if (activeGroups && !activeGroups.has(group)) continue;
      // 兼容两种形态：{ enabled, rules } 或 直接数组
      let rules;
      if (Array.isArray(groupDef)) {
        rules = groupDef;
      } else if (Array.isArray(groupDef.rules)) {
        rules = groupDef.rules;
      } else {
        continue;
      }
      parts.push(`### 角色组：${group}（${rules.length} 段规则）`);
      for (const r of rules) {
        if (!r || r.enabled === false) continue;
        const role = r.role ? `[${r.role}] ` : '';
        parts.push(`— ${role}${r.name || r.id || '段'}：\n${r.content || ''}`);
      }
      if (groupDef.assistantPrefill) {
        parts.push(`— [assistant prefill]：\n${groupDef.assistantPrefill}`);
      }
    }
  }

  // bioCompressionTemplate：生平压缩模板（注入供 AI 参考）
  if (preset.bioCompressionTemplate) {
    parts.push('## 【生平压缩模板参考】');
    parts.push(preset.bioCompressionTemplate);
  }

  return parts.join('\n\n') || '（预设为空，按常识演化）';
}

// 兼容「完整版-物品管理.json」这类预设文件
function buildFromPresetJson(preset) {
  const parts = [];
  if (preset.name) parts.push(`> 预设名：${preset.name}`);
  if (preset.description) parts.push(`> 描述：${preset.description}`);
  // contentTemplates：可注入的命名模板
  if (preset.contentTemplates && typeof preset.contentTemplates === 'object') {
    parts.push('## 【内容模板】');
    for (const [k, v] of Object.entries(preset.contentTemplates)) {
      parts.push(`### ${k}\n${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  // entrySharedRules：登场阶段共用规则
  if (Array.isArray(preset.entrySharedRules)) {
    parts.push('## 【登场共用规则】');
    for (const r of preset.entrySharedRules) {
      if (!r || r.enabled === false) continue;
      parts.push(`### ${r.name || r.id || '规则'}\n${r.content || ''}`);
    }
  }
  // stages：演化阶段（重点）
  if (Array.isArray(preset.stages)) {
    parts.push('## 【演化阶段规则】');
    for (const st of preset.stages) {
      if (!st || st.enabled === false) continue;
      parts.push(`### 阶段 ${st.id || st.name || '?'}：${st.name || ''}`);
      if (st.description) parts.push(st.description);
      if (Array.isArray(st.rules)) {
        for (const r of st.rules) {
          if (!r || r.enabled === false) continue;
          parts.push(`— ${r.name || r.id || '规则'}：\n${r.content || ''}`);
        }
      } else if (st.content) {
        parts.push(st.content);
      }
    }
  }
  return parts.join('\n\n') || '（预设为空，按常识演化）';
}


// ---------- 解析演化结果 ----------
// 输入：AI 返回的原文。可能：纯 JSON / 带 ```json 围栏 / 前后有 thinking 文本
export function parseEvolutionResult(text) {
  if (!text || typeof text !== 'string') return { ok: false, raw: text, error: '空回复' };
  let candidate = text.trim();

  // 0. 优先尝试 tagged 格式：<state>...</state> 或 <upstore>...</upstore>
  //    concurrent-evo-preset 使用 tagged outputFormat
  const taggedState = candidate.match(/<state[^>]*>([\s\S]*?)<\/state>/i);
  const taggedUpstore = candidate.match(/<upstore[^>]*>([\s\S]*?)<\/upstore>/i);
  const taggedBlock = taggedUpstore || taggedState;
  if (taggedBlock) {
    // tagged 内容可能是 JSON 或 key=value 格式，尝试 JSON 解析
    let inner = taggedBlock[1].trim();
    // 移除 ```json 围栏
    inner = inner.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '').trim();
    const first = inner.indexOf('{');
    const last = inner.lastIndexOf('}');
    if (first >= 0 && last > first) {
      try {
        const obj = JSON.parse(inner.slice(first, last + 1));
        // tagged 格式的 snapshots 可能在顶层或需要包装
        if (obj.snapshots) {
          return { ok: true, parsed: obj, raw: text, format: 'tagged' };
        }
        // 如果 tagged 块本身就是单个快照对象
        if (obj.id && obj.identity) {
          return { ok: true, parsed: { snapshots: { [obj.id]: obj }, deeds: [], thinking: '' }, raw: text, format: 'tagged' };
        }
        // 多个快照对象
        return { ok: true, parsed: { snapshots: obj, deeds: [], thinking: '' }, raw: text, format: 'tagged' };
      } catch {
        // tagged 内容不是 JSON，继续尝试其他方式
      }
    }
  }

  // 1. 优先抽取 ```json ... ``` 围栏
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidate = fence[1].trim();

  // 2. 找到首个 { 与最后一个 }，截取
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first >= 0 && last > first) {
    candidate = candidate.slice(first, last + 1);
  }

  let obj;
  try {
    obj = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, raw: text, error: 'JSON 解析失败：' + e.message };
  }
  return { ok: true, parsed: obj, raw: text, format: 'json' };
}

// ---------- 构造「打回重写」的反馈提示 ----------
// errors: validateEvolutionResult().errors
export function buildRewriteFeedback(originalText, errors) {
  const flat = [];
  const walk = (es, indent = '') => {
    for (const e of (es || [])) {
      flat.push(`${indent}- ${e.msg || e.code || JSON.stringify(e)}`);
      if (e.sub) walk(e.sub, indent + '  ');
    }
  };
  walk(errors);
  return [
    '你上一轮的演化输出不符合契约，已被打回。请修正后重新输出合法 JSON。',
    '',
    '## 校验失败原因',
    flat.join('\n') || '（未给出具体原因）',
    '',
    '## 你上一轮的原始输出（仅供参考，不要原样复述）',
    '```',
    String(originalText || '').slice(0, 2000),
    '```',
    '',
    '请严格按契约重新输出本轮演化结果 JSON。不要解释、不要复述正文，直接给出 { ... }。',
  ].join('\n');
}


/** 判断一份预设是否是 v2 口径 */
export function isV2Preset(preset) {
  if (!preset || typeof preset !== 'object') return false;
  return preset.formatVersion === 'v2'
    || Array.isArray(preset.activePromptGroups)
    || !!(preset.prompts && preset.prompts.__v2);
}

// ---------- 组装 Stage 2 提示词（v2 路径） ----------
export function assembleEvolutionPromptV2({
  storyText, userInput, snapshots, evolutionRules, worldInfo = '', knownIds = [], tuning = null,
}) {
  const rules = evolutionRules || null;
  const rulesText = rules ? buildRulesText(rules) : '（无预设规则，按上面的契约演化）';
  const ids = knownIds.length ? knownIds : Object.keys(snapshots || {});
  const sys = [
    '你是一位「修仙故事快照演化引擎」。你只做一件事：对比本轮正文与当前快照，找出真正变化过的项，写成修改语句。',
    '',
    EVOLUTION_V2_CONTRACT,
    '',
    '## 【本领可用角色 ID】（行首只能写这些 ID）',
    ids.join('、') || '（无）',
    '',
    '## 【快照编辑规则】（预设分组规则，须与上面的契约一起遵守；冲突时以上面的契约为准）',
    rulesText,
    '',
    '## 【境界数值基准】（本表与正文阶段注入的数值表同源；下列属性一律不得越界）',
    EVO_V2_BASELINE_NOTE,
    '修改已有角色：气血上限、法力上限与战斗属性同样受本表约束。',
    '',
    realmBaselineText(tuning),
    '',
    '## 【新增角色完整快照模板】（结构照抄，数值按该角色境界改）',
    '<新增角色>',
    NEW_CHAR_V2_TEMPLATE,
    '</新增角色>',
    '说明（字段逐个列出，缺一个都会被校验打回）：',
    '- **结构照抄**：字段名、层级、空值写法（null / [] / ""）一个都不能少、不能改名、不能自己加键。',
    EVO_V2_TEMPLATE_VALUE_NOTE,
    EVO_V2_TEMPLATE_CRIT_NOTE,
    EVO_V2_TEMPLATE_FIELDS_NOTE,
    EVO_V2_KIND_NOTE,
    '  - 性别 只能写 男 / 女 / 无；境界 必须取【境界数值基准】表里有的档位名。',
    EVO_V2_STATS_NOTE,
    EVO_V2_EQUIPMENT_NOTE,
    '- **储物袋**：每项固定 8 字段 —— 名称｜类型｜子类｜数量｜品阶｜外观｜描述｜属性。',
    EVO_V2_ITEM_TYPE_NOTE,
    EVO_V2_ITEM_GRADE_NOTE,
    EVO_V2_ITEM_OPTIONAL_NOTE,
    EVO_V2_RELATION_NOTE,
    EVO_V2_BIO_NOTE,
    EVO_V2_EMPTY_KEY_NOTE,
    '',
    '## 【世界信息】',
    worldInfo || '（无）',
    '',
    '## 【当前各角色快照】（本轮起点；只写它们与本轮正文的差异）',
    v2BundleText(snapshots || {}),
    '',
    '## 【本轮正文】',
    storyText || '（无正文）',
    '',
    '## 【玩家本轮行动】',
    userInput || '（无具体行动）',
    '',
    '## 【输出提醒】',
    '先写 <thinking> 分段思考，再写 <新增角色>（无则 {}），再写 <修改> 语句块，最后写 <世界时间>。',
    '已存在的角色不要输出完整快照。没变化就不写那一行。',
    EVO_V2_NEW_CHAR_NOTE,
  ].join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: '请按输出契约 v2 给出本轮的 thinking / 新增角色 / 修改 / 世界时间。' },
  ];
}

// ---------- v2 输出解析（实现见 data/evolutionV2Envelope.js，前后端共用同一份） ----------
export { parseEvolutionV2Text, buildRewriteFeedbackV2 } from '../data/evolutionV2Envelope.js';
