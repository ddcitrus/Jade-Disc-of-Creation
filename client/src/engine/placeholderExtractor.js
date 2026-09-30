// ===== 占位符提取器 =====
// 从 save + snapshots + storyText + userInput 提取所有 ${xxx} 占位符的实际内容
// 对应「青竹正文Agent V1」预设中的 ${玩家状态快照} ${玩家物品} ${当前玩家输入} 等
//
// 只登记「有真实数据来源」的名字。取不到值的名字不写进映射 —— 预设引用它们时，
// replacePlaceholders 会渲染成「（未提供：xxx）」，比登记一个恒为空的字符串更好排查。
// 2026-09-24 清掉的 12 个无生产者名字：开局设定、灵兽摘要、灵兽结构化摘要、当前任务、
// 待领取任务、外部天机裁决、战斗协议、双修协议、秘境协议、修为奖励正文落地、
// 离场人物、隐藏剧情续写约束。（想要离场人物请用 ${离场NPC}，它读 save.npcs。）

import { snapshotToStateText, slotValueText, normalizeEquipment } from '../data/snapshotSchema.js';
import { legacyToV2, v2SnapshotText } from '../data/snapshotV2.js';
import { getEffectiveTables } from '../data/numericTuning.js';
import { personalityTraitText } from '../data/gameData.js';
import { buildProtocolSegments } from '../data/mortalProtocols.js';
import { buildSkill, skillCoefText, poolCtxOf } from '../data/skillCodex.js';

/**
 * 主提取函数：从游戏状态提取所有 ${xxx} 占位符的值
 * @param {object} save - 存档
 * @param {object} snapshots - 各角色快照集合 { B1: {...}, C1: {...} }
 * @param {object} ctx - { userInput, storyText, settings }
 * @returns {object} { '玩家状态快照': '...', '玩家物品': '...', ... }
 */
export function extractPlaceholders(save, snapshots = {}, ctx = {}) {
  const { userInput = '', storyText = '', settings = {} } = ctx;
  const playerSnap = snapshots['B1'] || snapshots.player || null;
  const npcs = Object.entries(snapshots).filter(([id]) => id !== 'B1' && id !== 'player');

  const map = {};

  // ===== 玩家快照组 =====
  map['人格核心'] = playerSnap
    ? buildPersonalityCore(playerSnap, save)
    : '（主角快照未初始化）';

  map['玩家状态快照'] = playerSnap
    ? buildPlayerStateSnapshot(playerSnap, getEffectiveTables(settings))
    : '（主角快照未初始化）';

  map['玩家物品'] = playerSnap
    ? buildItemList(playerSnap.inventory, playerSnap.equipment)
    : '（无物品）';

  map['玩家技能'] = playerSnap
    ? buildSkillList(playerSnap.skills, playerSnap)
    : '（无技能）';

  map['玩家功法'] = playerSnap
    ? buildCultivationArts(playerSnap.cultivationArts)
    : '（无功法）';

  map['百艺合成结果'] = playerSnap?.cultivationArts
    ? buildHundredArts(playerSnap.cultivationArts)
    : '（百艺未入门）';

  map['人物关系'] = buildRelations(playerSnap, npcs);

  map['主角长期规划'] = playerSnap?.bio?.longTermGoal || '（未设定长期规划）';

  map['本轮运行时追加规则'] = settings?.textRules?.customStyle || '';

  // ===== 状态栏与正文渲染协议组 =====
  // 预设引用这些占位符时直接得到完整 Mortal 协议（可设置页「正文规则与文风」自定义）；
  // promptSystem 组装时检测预设已引用的协议，末尾只补注入未引用的，避免重复。
  const protocolSegs = buildProtocolSegments(save, settings?.textRules?.protocols);
  map['正文状态栏协议'] = protocolSegs.uiSys;
  map['灵动正文语义渲染协议'] = protocolSegs.proseDsl;
  map['修炼结算显示协议'] = protocolSegs.cultivation;
  map['推进选项生成协议'] = buildProgressionProtocol();

  // ===== 上下文组 =====
  map['当前玩家输入'] = userInput || '（无输入）';

  // ===== 字数与人称组（「自动下回合」右侧控件可改，实时注入） =====
  const minWords = settings?.textRules?.minWords || 200;
  const maxWords = settings?.textRules?.maxWords || 400;
  map['正文字数'] = `${minWords}-${maxWords} 字`;
  const person = settings?.story?.narrativePerson || 'second';
  map['叙事人称协议'] = person === 'first'
    ? '以第一人称「我」叙述，主角视角。'
    : person === 'third'
      ? '以第三人称叙述，用主角名字指代。'
      : '以第二人称「你」叙述，代入玩家视角。';

  // Chat History 由调用方注入（历史消息）
  map['Chat History'] = storyText || '';

  // 在场人物（档案块：身份 / 状态 / 装备 / 关系 / 技能 / 目标 / 承诺 / 背景 / 生平）
  map['在场人物'] = buildOnSceneCharacters(playerSnap, npcs, save, getEffectiveTables(settings));

  // 世界设定
  map['世界地理和时间'] = buildWorldGeo(save);
  map['修仙世界观宏观指导'] = '修仙世界遵循因果至上、境界严明、资源稀缺原则。';
  map['修仙世界观微观指导'] = '细节遵循修仙常识：灵石为通货、丹药辅助修炼、法器分品级。';

  // ===== ST 预设兼容组（青竹等外部预设引用的扩展占位符；缺失时曾以 ${xxx} 字面量泄漏进提示词）=====
  // ctx.sceneInfo / ctx.plotEvolution / ctx.textRulesText 由 promptSystem 传入（复用其构建器，避免循环依赖）
  const w = save?.world || {};
  map['文风参考片段'] = ctx.textRulesText || map['本轮运行时追加规则'] || '（文风不限，保持修仙世界观即可）';
  map['修仙世界观指导'] = `${map['修仙世界观宏观指导']}\n${map['修仙世界观微观指导']}`;
  map['状态写入规则'] = '（本阶段只生成剧情正文，不输出状态块；状态与快照演化由独立的演化阶段处理。）';
  map['当前输入事实校准'] = userInput ? `以本轮玩家输入为事实校准基准：${userInput}` : '（本轮无具体输入，按当前处境自然推进）';
  map['剧情事件指导'] = ctx.plotEvolution || '（无特殊指导，按当前处境自然推进）';
  map['地图实体'] = w.location
    ? `${w.location.name}${w.location.desc ? '：' + w.location.desc : ''}`
    : '（无地图实体）';
  map['世界地理信息'] = buildWorldGeo(save);
  map['场景信息'] = ctx.sceneInfo || `时间：${w.timeLabel || '未知'}（${w.season || ''} · ${w.weather || ''}）\n地点：${w.location?.name || '未知'}`;
  map['场景细节'] = [w.location?.desc, w.location?.aura ? `灵气浓度 ${w.location.aura}` : ''].filter(Boolean).join('；') || '（无额外场景细节）';
  map['当前场景地图'] = `${w.location?.name || '未知'}${w.location?.desc ? '：' + w.location.desc : ''}${w.location?.aura ? `（灵气浓度 ${w.location.aura}）` : ''}`;
  map['当前时间'] = w.timeLabel || '（未知）';
  map['当前地点'] = w.location?.name || '（未知）';
  map['时间地点行'] = `时间：${w.timeLabel || '未知'}｜地点：${w.location?.name || '未知'}`;
  map['季节'] = w.season || '（未知）';
  map['天气'] = w.weather || '（未知）';
  map['离场NPC'] = (save?.npcs || []).filter(n => n?.group === '离场人物')
    .map(n => `· ${n.name}（${n.subtitle || n.realm || ''}）`).join('\n') || '（暂无离场人物）';

  // 人物行为分析 / 后台人物故事：来自演化快照（字段形态不定，防御性取值）
  const behaviorLines = [];
  for (const [, snap] of npcs) {
    const nm = snap?.identity?.name;
    const act = snap?.action?.action;
    if (nm && act) behaviorLines.push(`· ${nm}：${act}`);
  }
  if (playerSnap?.identity?.name && playerSnap?.action?.action) {
    behaviorLines.push(`· ${playerSnap.identity.name}（主角）：${playerSnap.action.action}`);
  }
  map['人物行为分析'] = behaviorLines.join('\n') || '（暂无可分析的人物行为）';

  const backstage = [];
  for (const [, snap] of npcs) {
    const nm = snap?.identity?.name;
    if (!nm) continue;
    const loc = snap?.action?.location;
    // 不在当前地点的角色视为后台人物（判定口径与「在场人物」一致，否则同一个人会两处都出现）
    if (loc && w.location?.name && !samePlace(loc, w.location.name)) {
      backstage.push(`· ${nm}（${loc}）：${snap?.action?.action || '按自身目标缓慢推进'}`);
    }
  }
  map['后台人物故事'] = backstage.join('\n') || '（暂无后台人物动态）';

  return map;
}

// ===== 各占位符内容构建函数 =====

function buildPersonalityCore(snap, save) {
  const parts = [];
  if (snap.identity?.name) parts.push(`姓名：${snap.identity.name}`);
  if (snap.identity?.gender) parts.push(`性别：${snap.identity.gender}`);
  if (snap.identity?.realm) parts.push(`境界：${snap.identity.realm}`);
  // 性格以程序里的维度为权威（玩家在性格页拖动即时生效）；快照里的那句话仅作后备
  const dimsText = personalityTraitText(save?.character?.personality?.dims);
  if (dimsText) parts.push(dimsText);
  else if (snap.identity?.personality) parts.push(`性格：${snap.identity.personality}`);
  if (snap.identity?.linggen) parts.push(`灵根：${snap.identity.linggen}`);
  if (snap.bio?.background) parts.push(`背景：${snap.bio.background}`);
  return parts.join('\n') || '（未设定）';
}

// tables：生效数值表（由调用方从 settings 取）。带上它是为了让「修炼倍率」这类
// 现算出来的行跟参数段同口径 —— 玩家改过「装备品阶基准」时也不会两处不一致。
function buildPlayerStateSnapshot(snap, tables) {
  return snapshotToStateText(snap, tables);
}

function buildItemList(inventory, equipment) {
  const parts = [];
  if (equipment) {
    // ⚠ 必须先归一再看：AI 有时把整件物品写在了「分组」位置上，分组里于是留下一堆叫
    //   name/type/grade 的坏键；直接 slotValueText 会把这些字段名当槽位名喂给模型
    //   （"护甲：甲身:青色杂役袍服、name:青色杂役袍服、type:装备…"）。归一顺手把这些清掉。
    const eq = normalizeEquipment(equipment);
    const w = slotValueText(eq.weapon);
    const a = slotValueText(eq.armor);
    const acc = slotValueText(eq.accessory);
    if (w) parts.push(`武器：${w}`);
    if (a) parts.push(`护甲：${a}`);
    if (acc) parts.push(`饰品：${acc}`);
  }
  if (Array.isArray(inventory) && inventory.length) {
    parts.push('储物袋：');
    for (const item of inventory) {
      parts.push(`  · ${item.name || item.id}${item.count > 1 ? ` ×${item.count}` : ''}`);
    }
  }
  return parts.join('\n') || '（空空如也）';
}

function buildSkillList(skills, char) {
  if (!Array.isArray(skills) || !skills.length) return '（无技能）';
  // 字段口径统一走 skillCodex：读 name/type/grade/dmgKind/effect（旧数据自动补齐）；
  // 倍率与耗灵力按品阶算，回复量按角色自身池算成绝对数字（ctx 从角色快照的 stats 取）
  const ctx = poolCtxOf(char);
  const lines = skills.map(s => {
    const sk = buildSkill(s);
    if (!sk) return null;
    // 括号内第 2 段是伤害属性（物/法），战斗时据此取物攻/法攻 —— 未标注则省略
    const head = [sk.type, sk.dmgKind, sk.grade].filter(Boolean).join('·');
    const coef = skillCoefText(sk, ctx);
    return `· ${sk.name}${head ? `（${head}）` : ''}${coef ? `：${coef}` : ''}${sk.effect ? `　${sk.effect}` : ''}`;
  }).filter(Boolean);
  return lines.length ? lines.join('\n') : '（无技能）';
}

function buildCultivationArts(arts) {
  const parts = [];
  if (arts && typeof arts === 'object') {
    for (const [k, v] of Object.entries(arts)) {
      if (v && v.tier && v.tier !== '未入门') {
        parts.push(`· ${mapArtName(k)}：${v.tier}（进度 ${v.progress || 0}%）`);
      }
    }
  }
  return parts.join('\n') || '（百艺未入门）';
}

function buildHundredArts(arts) {
  if (!arts) return '（百艺未入门）';
  const names = { talisman: '符箓', formation: '阵法', alchemy: '炼丹', artifact: '炼器', puppet: '傀儡', beastTaming: '驭兽', cooking: '烹饪', planting: '灵植' };
  const parts = [];
  for (const [k, v] of Object.entries(arts)) {
    if (v && v.tier && v.tier !== '未入门') {
      parts.push(`${names[k] || k}=${v.tier}(${v.progress || 0}%)`);
    }
  }
  return parts.join('，') || '全部未入门';
}

function buildRelations(playerSnap, npcs) {
  const parts = [];
  if (playerSnap?.bio?.rawRelations?.length) {
    for (const r of playerSnap.bio.rawRelations) {
      // 关系对象有两种历史形态，必须都认（否则新版数据会渲染成「· undefined：」混进提示词）：
      //   形态一 { target, relation, desc }
      //   形态二 { targetId, label, favorability }
      const who = r?.target || r?.name || r?.targetId;
      const what = r?.relation || r?.label || '';
      if (!who && !what) continue; // 空条目直接跳过，宁可少一行也不写 undefined
      parts.push(`· ${who || '未知'}：${what}${r.desc ? '（' + r.desc + '）' : ''}`);
    }
  }
  for (const [id, snap] of npcs) {
    if (snap?.identity?.name) {
      parts.push(`· ${snap.identity.name}：${snap.identity.realm || ''}`);
    }
  }
  return parts.join('\n') || '（暂无关系）';
}

function buildProgressionProtocol() {
  return `正文结束后生成 2-3 个推进选项，供玩家选择下一步行动。选项应简洁、具体、可操作。`;
}

// ---- 在场人物档案（正文阶段） ----
// 这些字段是正文 AI 用得上的：装备决定他穿什么、拿什么；目标和承诺决定他下一步要干什么、答应过谁什么；
// 性格决定他遇事怎么反应、话怎么说；关系、技能、背景、生平补上这个人的来历与本事。数值（攻防气血）
// 不在其中 —— 正文不参与伤害结算，协议里也明令禁止正文 AI 自己算伤害，给了只会诱导它写数字。
// 渲染直接复用演化阶段的 v2SnapshotText（传 only 筛字段），两处口径因此完全一致。
// ⚠ 这里的顺序不决定输出顺序 —— v2SnapshotText 自己那一套行序说了算（性格排在长期目标之后）。
const DOSSIER_FIELDS = ['身份', '性格', '状态', '装备', '关系', '技能', '短期目标', '长期目标', '承诺1', '承诺2', '承诺3', '背景', '生平'];

// 同一地点：完全相等，或一方包含另一方。
// 存档里的地点写法不统一 —— 实测 2026-09-28：玩家在「天南/落云宗 · 迎仙镇 · 悦来客栈 · 二楼天字甲号房」，
// 柳三娘在「天南/落云宗 · 迎仙镇 · 悦来客栈」，同一间客栈的两个写法。严格相等会把她判成离场，
// 于是「此刻在场」下一个名字都没有，人明明就站在眼前。
export function samePlace(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// 单个角色的档案块：姓名（境界）作标题，其余字段逐行缩进两格
function npcDossierText(snap, tables) {
  const v2 = legacyToV2(snap);
  if (!v2) return '';
  const name = String(v2.名称 || v2.id || '').trim();
  if (!name) return '';
  const head = v2.境界 ? `${name}（${v2.境界}）` : name;
  const body = v2SnapshotText(v2, { snap, tables, only: DOSSIER_FIELDS });
  const indented = body.split('\n').filter(l => l.trim()).map(l => '  ' + l).join('\n');
  return indented ? `· ${head}\n${indented}` : `· ${head}`;
}

function buildOnSceneCharacters(playerSnap, npcs, save, tables) {
  const parts = [];
  if (playerSnap?.identity?.name) parts.push(`· ${playerSnap.identity.name}（主角）`);
  const here = save?.world?.location?.name;
  for (const [, snap] of npcs) {
    if (samePlace(snap?.action?.location, here)) {
      const dossier = npcDossierText(snap, tables);
      if (dossier) parts.push(dossier);
    }
  }
  return parts.join('\n') || '（独自一人）';
}

function buildWorldGeo(save) {
  const time = save?.world?.timeLabel || '未知时间';
  const loc = save?.world?.location?.name || '未知地点';
  const factors = (save?.world?.factors || []).map(f => f.name).join('、');
  return `时间：${time}\n地点：${loc}\n世界因子：${factors || '无'}`;
}

function mapArtName(k) {
  const names = { talisman: '符箓', formation: '阵法', alchemy: '炼丹', artifact: '炼器', puppet: '傀儡', beastTaming: '驭兽', cooking: '烹饪', planting: '灵植' };
  return names[k] || k;
}

/**
 * 替换文本中的 ${xxx} 占位符
 * @param {string} text - 含 ${xxx} 的文本
 * @param {object} placeholderMap - extractPlaceholders 返回的映射
 * @returns {string} 替换后的文本
 */
export function replacePlaceholders(text, placeholderMap) {
  if (!text) return '';
  return text.replace(/\$\{([^}]+)\}/g, (m, name) => {
    const val = placeholderMap[name];
    if (val != null) return String(val);
    // 未命中（预设引用了本项目不认识的占位符，例如外部作者的自定义写法）：
    // 2026-09-16 改。旧行为是原样返回 `${xxx}`（注释写「便于调试」），
    // 但那串东西长得像宏语法 —— AI 可能试着解读它，甚至当正文照抄出来。
    // 改成自然语言的缺失标记：模型只会当成一句「这里没东西」，
    // 而换预设时仍能一眼看出缺了哪个占位符（诊断价值不丢）。
    return `（未提供：${name}）`;
  });
}

/**
 * 从预设内容中提取所有用到的 ${xxx} 占位符名称
 */
export function extractPlaceholderNames(segments) {
  const names = new Set();
  for (const seg of segments) {
    const content = typeof seg === 'string' ? seg : (seg.content || '');
    const re = /\$\{([^}]+)\}/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      names.add(m[1]);
    }
  }
  return [...names];
}
