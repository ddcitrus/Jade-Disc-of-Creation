// ===== 占位符提取器 =====
// 从 save + snapshots + storyText + userInput 提取所有 ${xxx} 占位符的实际内容
// 对应「青竹正文Agent V1」预设中的 ${玩家状态快照} ${玩家物品} ${当前玩家输入} 等

import { snapshotToStateText, slotValueText } from '../data/snapshotSchema.js';
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

  // 开局设定：save.story.opening / save.world.opening 全项目零写入（无生产者）。
  // 2026-09-16 按要求去掉空值占位文本；将来建档时若写入开局，这里会自动生效。
  map['开局设定'] = save?.story?.opening || save?.world?.opening || '';

  map['玩家状态快照'] = playerSnap
    ? buildPlayerStateSnapshot(playerSnap)
    : '（主角快照未初始化）';

  map['玩家物品'] = playerSnap
    ? buildItemList(playerSnap.inventory, playerSnap.equipment)
    : '（无物品）';

  map['玩家技能'] = playerSnap
    ? buildSkillList(playerSnap.skills, playerSnap)
    : '（无技能）';

  map['玩家功法'] = playerSnap
    ? buildCultivationArts(playerSnap.cultivationArts, playerSnap.techniqueMasteries)
    : '（无功法）';

  // ⚠ 灵兽字段现状（2026-09-16 查证）：人物快照里根本没有灵兽栏 ——
  //   建档模板 NEW_CHAR_V2_TEMPLATE、演化白名单 EDIT_FIELDS、mortalCommands 的 beasts
  //   三条写入路径都不写灵兽（beasts 指令进来就 skipped），全项目无生产者。
  //   2026-09-16 按要求去掉空值占位文本（原先输出「（无灵兽）」/ 裸 []，都是提示词噪音）。
  //   若将来补全灵兽链路，注意两点：
  //   ① 读的键是英文 spiritBeasts（与快照的中文键风格不一致）；
  //   ② validateV2Snapshot 用 { ...raw } 不丢未知键，AI 自发写的「灵兽」会被保留但这里读不到。
  map['灵兽摘要'] = playerSnap?.spiritBeasts?.length
    ? playerSnap.spiritBeasts.map(b => `${b.name || '无名灵兽'}（${b.realm || '未知'}境界）`).join('、')
    : '';

  map['灵兽结构化摘要'] = playerSnap?.spiritBeasts?.length
    ? JSON.stringify(playerSnap.spiritBeasts, null, 2)
    : '';

  map['百艺合成结果'] = playerSnap?.cultivationArts
    ? buildHundredArts(playerSnap.cultivationArts)
    : '（百艺未入门）';

  map['人物关系'] = buildRelations(playerSnap, npcs);

  // ⚠ 任务系统无生产者：save.missions 在存档里根本不存在（建档/演化都不写）。
  //   2026-09-16 按要求去掉空值占位文本；将来接入任务系统时这里自动生效。
  map['当前任务'] = save?.missions?.active?.length
    ? save.missions.active.map(m => `· ${m.name || m.id}：${m.desc || ''}`).join('\n')
    : '';

  map['待领取任务'] = save?.missions?.available?.length
    ? save.missions.available.map(m => `· ${m.name || m.id}：${m.desc || ''}`).join('\n')
    : '';

  map['主角长期规划'] = playerSnap?.bio?.longTermGoal || '（未设定长期规划）';

  // ===== 独立前端协议组 =====
  // ⚠ 这一组读的字段全项目无生产者（2026-09-16 查证），按要求去掉空值占位文本：
  //   · 战斗协议：mortalCommands 把战斗状态写进「快照的」status.inBattle，
  //     这里读的却是 save.world.inBattle（对象 + 键名双重错位）→ 恒为假。
  //     要救只需改读取源，条件分支与 buildBattleProtocol 都还在。
  //   · 秘境协议：save.world.inSecretRealm 全仓零引用。
  //   · 外部天机裁决 / 双修协议 / 修为奖励正文落地：纯常量，源码里没有数据分支。
  map['外部天机裁决'] = '';
  map['战斗协议'] = save?.world?.inBattle ? buildBattleProtocol(save) : '';
  map['双修协议'] = '';
  map['秘境协议'] = save?.world?.inSecretRealm ? '当前处于秘境中' : '';
  map['修炼结算显示协议'] = '（本轮无修炼结算）';
  map['修为奖励正文落地'] = '';
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

  // 在场人物
  map['在场人物'] = buildOnSceneCharacters(playerSnap, npcs, save);

  // 离场人物：⚠ 无生产者（旧值恒为硬编码「（暂无）」，名字像却永远不说真话）。
  // 2026-09-16 按要求去掉输出。**真数据在隔壁 `${离场NPC}`**（读 save.npcs 里 group==='离场人物'），
  // 外部预设想拿离场人物请引用 `${离场NPC}`。
  map['离场人物'] = '';

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
  // ⚠ 无生产者：纯常量，源码里没有数据分支。2026-09-16 按要求去掉输出。
  map['隐藏剧情续写约束'] = '';
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
    // 不在当前地点的角色视为后台人物
    if (loc && w.location?.name && loc !== w.location.name) {
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

function buildPlayerStateSnapshot(snap) {
  return snapshotToStateText(snap);
}

function buildItemList(inventory, equipment) {
  const parts = [];
  if (equipment) {
    const w = slotValueText(equipment.weapon);
    const a = slotValueText(equipment.armor);
    const acc = slotValueText(equipment.accessory);
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

function buildCultivationArts(arts, masteries) {
  const parts = [];
  if (arts && typeof arts === 'object') {
    for (const [k, v] of Object.entries(arts)) {
      if (v && v.tier && v.tier !== '未入门') {
        parts.push(`· ${mapArtName(k)}：${v.tier}（进度 ${v.progress || 0}%）`);
      }
    }
  }
  if (masteries && typeof masteries === 'object') {
    for (const [k, v] of Object.entries(masteries)) {
      if (v && v.level) parts.push(`· ${k}：${v.level}`);
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
  if (playerSnap?.social?.bondedToPlayer) parts.push('· 与主角有羁绊');
  if (playerSnap?.bio?.rawRelations?.length) {
    for (const r of playerSnap.bio.rawRelations) {
      // 关系对象有两种历史形态，必须都认（否则新版数据会渲染成「· undefined：」混进提示词）：
      //   旧版 { target, relation, desc }
      //   新版 { targetId, label, favorability }
      const who = r?.target || r?.name || r?.targetId;
      const what = r?.relation || r?.label || '';
      if (!who && !what) continue; // 空条目直接跳过，宁可少一行也不写 undefined
      parts.push(`· ${who || '未知'}：${what}${r.desc ? '（' + r.desc + '）' : ''}`);
    }
  }
  for (const [id, snap] of npcs) {
    if (snap?.identity?.name) {
      const rel = snap.social?.bondedToPlayer ? '（与主角有羁绊）' : '';
      parts.push(`· ${snap.identity.name}：${snap.identity.realm || ''}${rel}`);
    }
  }
  return parts.join('\n') || '（暂无关系）';
}

function buildBattleProtocol(save) {
  return `当前处于战斗中。时间：${save.world?.timeLabel || ''}，地点：${save.world?.location?.name || ''}`;
}

function buildProgressionProtocol() {
  return `正文结束后生成 2-3 个推进选项，供玩家选择下一步行动。选项应简洁、具体、可操作。`;
}

function buildOnSceneCharacters(playerSnap, npcs, save) {
  const parts = [];
  if (playerSnap?.identity?.name) parts.push(`· ${playerSnap.identity.name}（主角）`);
  for (const [id, snap] of npcs) {
    if (snap?.identity?.name && snap.action?.location === save?.world?.location?.name) {
      parts.push(`· ${snap.identity.name}（${snap.identity.realm || ''}）`);
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
