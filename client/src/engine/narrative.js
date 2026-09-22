// ===== 本地旁白引擎（离线，基于规则的文字生成） =====
import { computeAttrs, rootDisplayName, personalityTraitText } from '../data/gameData.js';
import { matchWorldbook, PLOT_STYLES } from '../saveModel.js';
import { assemblePrompt } from './promptSystem.js';

const WEATHERS = ['晴空万里', '薄云蔽日', '阴云低垂', '细雨如丝', '狂风大作', '浓雾弥漫', '瑞雪纷飞'];
const EVENTS = [
  { w: 20, type: '平静', text: (ctx) => `这一日风平浪静。${ctx.charName}在${ctx.loc}中安顿下来，周遭灵气缓缓流动，一切都显得格外安宁。` },
  { w: 15, type: '偶遇', text: (ctx) => `一位面生的散修路过${ctx.loc}，与${ctx.charName}目光相接，微微颔首便径直离去。江湖路远，萍水相逢亦是缘分。` },
  { w: 12, type: '异动', text: (ctx) => `忽然，${ctx.loc}深处传来一阵轻微灵气波动，似有什么东西破土而出，又转瞬归于沉寂。${ctx.charName}心中微微一动。` },
  { w: 10, type: '兽踪', text: (ctx) => `远处山林间隐有兽吼传来，声若闷雷。${ctx.charName}屏息凝神片刻，那声音又渐渐远去，想来是过境的妖兽，并未朝此处而来。` },
  { w: 8, type: '拾遗', text: (ctx) => `${ctx.charName}在一处不起眼的角落里，发现了一枚残破的玉简，其中灵识早已溃散，唯余几行模糊的古篆，记载着一段不知真伪的传闻。` },
  { w: 8, type: '心魔', text: (ctx) => `夜深人静时，${ctx.charName}于打坐中忽然心浮气躁，识海中往事翻涌。修行之路逆水行舟，心境稍有不稳，便有走火入魔之虞。${ctx.charName}默运功法，良久方才平复。` },
  { w: 7, type: '商旅', text: (ctx) => `一支风尘仆仆的商队途经${ctx.loc}，领队的老者见${ctx.charName}气度不俗，主动攀谈了几句，言语间提及数百里外的坊市近日有一场小型拍卖。` },
  { w: 6, type: '天象', text: (ctx) => `是夜，天穹之上星河流转，隐有异芒坠向远山深处。${ctx.charName}远远望见，心知那是灵物出世或大能斗法之兆，福祸难料。` },
  { w: 6, type: '故人', text: (ctx) => `${ctx.charName}在${ctx.loc}外偶遇一位旧识，对方似有心事，寒暄两句便匆匆告辞，临走前欲言又止地看了一眼${ctx.charName}。` },
  { w: 5, type: '危机', text: (ctx) => `一股若有若无的杀机自暗处袭来！${ctx.charName}心头警兆大作，急退数步——却见草叶间蹿出一头瘴气缠身的毒虫，被护身罡气一荡，呜咽着钻回了阴影里。` },
  { w: 3, type: '奇遇', text: (ctx) => `机缘巧合之下，${ctx.charName}踏入了一处前人洞府的残址。阵法早已朽坏，只余石壁上一幅残缺的吐纳图。${ctx.charName}细细观摩良久，若有所悟。` },
];

const pickWeighted = (list) => {
  const total = list.reduce((a, e) => a + e.w, 0);
  let r = Math.random() * total;
  for (const e of list) { r -= e.w; if (r <= 0) return e; }
  return list[0];
};

function buildCtx(save, userAction) {
  const c = save.character;
  const persDimText = personalityTraitText(c.personality?.dims) || '深不可测';
  return {
    charName: c.name,
    race: c.race?.name || '凡人',
    origin: c.origin?.name || '凡人',
    realm: c.realm?.name || '凡人',
    root: rootDisplayName(c.root),
    gender: c.gender,
    loc: save.world.location?.name || '此地',
    season: save.world.season,
    weather: save.world.weather,
    time: save.world.timeLabel,
    factors: save.world.factors?.map(f => f.name) || [],
    persDimText,
    attrs: computeAttrs(c),
    traits: c.traits?.map(t => t.name) || [],
    skills: c.skills?.map(s => s.name) || [],
    userAction
  };
}

// 生成开场旁白
export function openingNarrative(save) {
  const c = save.character;
  const ctx = buildCtx(save);
  const lines = [];
  lines.push(`【天道初启 · 命盘落定，仙途自此展开。】`);
  lines.push('');
  lines.push(`${c.name} 以 ${c.origin?.name} 的身份出身。${c.origin?.desc || ''}`);
  lines.push('');
  lines.push(`${c.name} 的种族为 ${c.race?.name}。${c.race?.desc || ''}`);
  lines.push('');
  if (c.root?.typeId !== 'none') {
    lines.push(`灵根既定 —— ${rootDisplayName(c.root)}。天地灵气与 ${c.root?.elements?.join('、')} 之属性遥相呼应。`);
  } else {
    lines.push(`灵根既定 —— 无灵根。经脉之中一片死寂，修行之途注定千难万难。`);
  }
  lines.push('');
  if (save.background?.trim()) lines.push(save.background.trim());
  if (save.hook?.trim()) { lines.push(''); lines.push(`（钩子）${save.hook.trim()}`); }
  lines.push('');
  lines.push(`你的故事，将在 ${ctx.loc} 开始……`);
  if (ctx.factors.length) {
    lines.push('');
    lines.push(`【世界因子 · ${ctx.factors.join(' / ')}】这方天地的规则已然改写。`);
  }
  return lines.join('\n');
}

// 生成一回合旁白（根据用户行动）
export function turnNarrative(save, userAction, worldbook = []) {
  const ctx = buildCtx(save, userAction);
  const parts = [];

  // 玩家行动回显
  if (userAction?.trim()) {
    parts.push(`你决定：${userAction.trim()}`);
    parts.push('');
  }

  // 事件
  const ev = pickWeighted(EVENTS);
  let evText = ev.text(ctx);

  // 世界因子影响
  if (ctx.factors.includes('灵气断绝') && Math.random() < 0.3) {
    evText += `\n\n（末法时代，天地灵气稀薄如缕，纵有功法在手，吸纳一缕灵气也需平日三倍之功。）`;
  }
  if (ctx.factors.includes('血月当空') && Math.random() < 0.25) {
    evText += `\n\n（抬头望去，血月高悬，猩红月华洒落大地。魔气隐隐躁动，人心亦随之浮躁。）`;
  }
  if (ctx.factors.includes('极寒末世') && Math.random() < 0.25) {
    evText += `\n\n（寒风如刀，割面生疼。永冬之世，保暖与食物与修为同等重要。）`;
  }
  parts.push(evText);

  // 世界书条目（关键字命中时插入）——条目来自跨存档共用的 settings.worldbook，由调用方传入
  const recentText = (userAction || '') + evText;
  const wbHits = matchWorldbook(worldbook, recentText).filter(e => !e.always || Math.random() < 0.2);
  if (wbHits.length) {
    const e = wbHits[Math.floor(Math.random() * wbHits.length)];
    parts.push('');
    parts.push(`（${e.content}）`);
  }

  // 剧情演化：选中的风格影响本地旁白基调（每回合轮换一个已选风格）
  const chosen = (save.plot?.styles) || {};
  const activeStyles = PLOT_STYLES.filter(s => chosen[s.id]?.selected);
  if (activeStyles.length) {
    const turnIdx = save.turnCount || 0;
    const style = activeStyles[turnIdx % activeStyles.length];
    const flavor = {
      balance: '（际遇与代价轮转，明暗交替，日子在平静与波澜间缓缓推进。）',
      romance: '（心底某处泛起一丝涟漪，那份说不清道不明的牵绊，悄悄改变了些什么。）',
      combat: '（空气里的火药味愈发浓重，一场硬碰硬的较量正在逼近。）',
      intrigue: '（言谈机锋之间，各方的算计悄然铺开，一步踏错便是万劫不复。）',
      adventure: '（冥冥中似有某种机缘在远方呼唤，唯有胆大心细者方能抓住。）',
      hardship: '（重压如山，前路逼仄，唯有咬牙硬撑，暗中积蓄破局之力。）',
      daily: '（柴米油盐间的人情往来，透着几分难得的暖意与踏实。）',
      suspense: '（某些细节隐隐透着不对劲，像水面下的暗流，让人脊背发凉。）',
      ensemble: '（周遭众人各怀心思，一张无形的关系网正在悄然收拢。）',
      growth: '（一分耕耘一分收获，脚踏实地，终有拨云见日之时。）',
      comedy: '（阴差阳错间闹出几许乌龙，令人哭笑不得之余，气氛倒松快了不少。）',
      tragic: '（命运的天平微微倾斜，有些东西一旦失去，便再也回不来了。）',
      sect: '（宗门的差事与规矩如常运转，其间门道，须得细细经营。）',
    }[style.id];
    if (flavor) { parts.push(''); parts.push(flavor); }
  }

  // 时间流逝提示
  parts.push('');
  parts.push(`—— ${ctx.time} · ${ctx.season} · ${WEATHERS[Math.floor(Math.random() * WEATHERS.length)]} 于 ${ctx.loc}`);

  return parts.join('\n');
}

// 快捷行动生成
export function quickActionNarrative(save, mode) {
  const map = {
    '静观其变': '收敛气息，静观四周变化，不主动涉险。',
    '顺势而为': '审时度势，循着眼前的机缘与线索自然行事。',
    '时光流转': '寻一处安稳之地打坐调息，任凭时光流转，专注修炼与恢复。'
  };
  return map[mode] || map['顺势而为'];
}

// 构建 AI 提示词（AI 模式用）—— 由提示词体系（promptSystem）按预设段落与占位符组装
export function buildAIPrompt(save, userAction, historyText, settings) {
  const storyText = historyText || (save.story || []).slice(-3).map(b => b.text).join('\n---\n');
  return assemblePrompt(settings, save, userAction, storyText);
}

// 构建剧情演化「导演层」提示词（生成当前剧情指导）
export function buildDirectorPrompt(save) {
  const ctx = buildCtx(save);
  const plot = save.plot || {};
  const chosen = plot.styles || {};
  const activeStyles = PLOT_STYLES.filter(s => chosen[s.id]?.selected);
  const recent = (save.story || []).slice(-4).map(b => b.text).join('\n').slice(-2000);
  const sys = [
    '《剧情指令生成器》',
    '',
    '【核心定位】',
    '你是「剧情指令生成器」——为当前回合提供剧情方向判断的中间层。',
    '你不是世界模拟器。你只报告与主角当前章节相关的部分。不相关的让它沉默。',
    '你的输出是给主叙事模型的指令，不是给玩家看的正文。',
    '',
    '【输出要求】',
    '1. 输出 100-250 字的剧情指导：本回合应推进什么、引入什么张力、哪些伏笔该回收、哪些该沉默。',
    '2. 只给方向与约束，不写具体正文，不替玩家做决定。',
    '3. 若提供了剧情风格指令，指导必须满足其"若选中，必须…"的命中标准。',
    '4. 直接输出指导内容，无标题无解释。',
    '',
    `【世界】${ctx.time} · ${ctx.loc}${ctx.factors.length ? ' · 世界因子：' + ctx.factors.join('、') : ''}`,
    `【主角】${ctx.charName}（${ctx.realm} · ${ctx.origin}）`,
    plot.direction?.trim() ? `【长期剧情方向（玩家意图，最高优先）】${plot.direction.trim()}` : '',
    activeStyles.length ? '【已选剧情风格指令】\n' + activeStyles.map(s => `「${s.name}」\n- ${s.instructions.join('\n- ')}`).join('\n') : '',
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: sys },
    { role: 'user', content: `【最近正文】\n${recent}\n\n请生成本回合的剧情指导。` },
  ];
}
