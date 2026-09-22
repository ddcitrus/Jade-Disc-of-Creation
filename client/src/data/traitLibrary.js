// ===== 特质库（零依赖模块：客户端 / 服务端共用，禁止 import 任何东西） =====
// 为什么必须零依赖：服务端 `node index.js` 直跑 ESM，链路上只要出现 `import './x.json'`
// 就抛 ERR_IMPORT_ATTRIBUTE_MISSING。特质词条的解析口径前后端必须同一份，故放在这里。
//
// 口径（2026-09-17 起）：特质加成与装备加成同一待遇 —— 由系统实时叠加进角色的「生效」值，
// 不写进「自身」属性数字，数值校界也不为它上移境界区间
// （见 snapshotSchema.js 的 attrRows「自身＋特质＋装备＝生效」、attrClamp.js）。
//   · resolveTraitMods()：**唯一在用的口径**。库内按库权威值（AI 写的数字不许覆盖）；
//     库外采信它写的「加成」文本（无文本才用 mods 对象），**不设上限**。
//   · traitAllowanceMods() / TRAIT_MOD_CEILING：特质「额度」的旧口径，校界已不再使用，
//     保留以备特质相关的其它校验（如将来做「特质强度上限」）。
// ---------- 特质（先天气运，46 项） ----------
export const TRAIT_RARITIES = [
  { id: 'common', name: '平庸', cost: 5 },
  { id: 'normal', name: '普通', cost: 10 },
  { id: 'rare', name: '稀有', cost: 15 },
  { id: 'epic', name: '史诗', cost: 20 },
  { id: 'legend', name: '传说', cost: 25 },
  { id: 'myth', name: '神迹', cost: 50 },
];

export const TRAITS = [
  // 平庸 5点
  { name: '体弱多病', rarity: 'common', desc: '从小你就时常生病，身体较为虚弱。', mods: { '物防': -2, '神识': 1 } },
  { name: '丢三落四', rarity: 'common', desc: '你总是记不住事情，功法口诀要背好几遍。', mods: { '神识': -3, '气运': 1 } },
  { name: '天生倒霉', rarity: 'common', desc: '走路踩狗屎，喝水塞牙缝，似乎是你的日常。', mods: { '气运': -5, '物防': 2 } },
  { name: '路痴', rarity: 'common', desc: '你天生方向感极差，但有时也能误入奇景。', mods: { '脚力': -2, '气运': 1 } },
  { name: '贪杯', rarity: 'common', desc: '你对美酒毫无抵抗力，但也因此结交了一些朋友。', mods: { '魅力': 2, '神识': -1 } },
  { name: '嗜睡', rarity: 'common', desc: '你总感觉睡不够，但每次醒来都精神饱满。', mods: { '法力上限': 10, '脚力': -1 } },
  { name: '话痨', rarity: 'common', desc: '你特别喜欢说话，有时会惹人烦，有时也能探听到意外的情报。', mods: { '魅力': -2, '神识': 2 } },
  { name: '守财奴', rarity: 'common', desc: '你对灵石有着异乎寻常的执着，一毛不拔。', mods: { '魅力': -3 } },
  { name: '洁癖', rarity: 'common', desc: '你无法忍受任何污秽，这让你在某些环境中束手束脚，但也使你心神澄净。', mods: { '神识': 2, '物防': -1 } },
  { name: '悲观主义', rarity: 'common', desc: '你总是先想到最坏的结果，这让你规避了风险，也错失了机遇。', mods: { '气运': -3, '法防': 2 } },
  { name: '好奇宝宝', rarity: 'common', desc: '你对任何未知事物都充满好奇，这可能带来麻烦，也可能带来发现。', mods: { '气运': 2, '物防': -1, '法防': -1 } },
  { name: '胆小如鼠', rarity: 'common', desc: '你天生胆小，但对危险的预感也因此异常灵敏。', mods: { '神识': 2, '物攻': -2 } },
  { name: '书呆子', rarity: 'common', desc: '相比于锻炼身体，你更喜欢在书海中遨游。', mods: { '神识': 3, '物攻': -2 } },
  { name: '直肠子', rarity: 'common', desc: '你说话从不拐弯抹角，容易得罪人，但也让人觉得你很真诚。', mods: { '魅力': -3, '气运': 1 } },
  { name: '脸盲', rarity: 'common', desc: '你很难记住别人的长相，但这让你对气息的感知更敏锐。', mods: { '魅力': -2, '神识': 2 } },
  // 普通 10点
  { name: '过目不忘', rarity: 'normal', desc: '你看过的功法典籍，从不会忘记一个字。', mods: { '神识': 5 } },
  { name: '天生神力', rarity: 'normal', desc: '你力大无穷，寻常成人三四人也未必是你的对手。', mods: { '物攻': 6, '法攻': -2 } },
  { name: '灵慧之心', rarity: 'normal', desc: '你对灵气的感应远超常人，修行事半功倍。', mods: { '法力上限': 25 } },
  { name: '铜皮铁骨', rarity: 'normal', desc: '你的筋骨强健异常，寻常刀剑难伤分毫。', mods: { '物防': 6 } },
  { name: '轻功卓绝', rarity: 'normal', desc: '你天生身轻如燕，纵跃如飞。', mods: { '脚力': 6 } },
  { name: '亲和之力', rarity: 'normal', desc: '无论走到哪里，你都很容易获得他人的好感。', mods: { '魅力': 5 } },
  { name: '吉人天相', rarity: 'normal', desc: '每逢绝境，总能逢凶化吉。', mods: { '气运': 6 } },
  { name: '斗战之魂', rarity: 'normal', desc: '越是强敌当前，你的战意越是沸腾。', mods: { '物攻': 4, '物理穿透': 2, '会心': 3 } },
  // 稀有 15点
  { name: '灵目如电', rarity: 'rare', desc: '你双目天生神光内蕴，可看破虚妄与隐匿。', mods: { '神识': 8, '法攻': 2, '会心': 5 } },
  { name: '不坏金身', rarity: 'rare', desc: '你的肉身坚韧远超同侪，气血充盈如炉。', mods: { '物防': 8, '气血上限': 40 } },
  { name: '法力如渊', rarity: 'rare', desc: '你的丹田气海宽阔如渊，法力绵长不绝。', mods: { '法力上限': 60 } },
  { name: '踏雪无痕', rarity: 'rare', desc: '你的身法已臻化境，来去无踪。', mods: { '脚力': 10, '物理穿透': 2 } },
  { name: '福缘深厚', rarity: 'rare', desc: '你命格中自带福星，奇遇常伴左右。', mods: { '气运': 10 } },
  { name: '天生魅体', rarity: 'rare', desc: '你生就一副勾人心魄的皮相，回头率十成十。', mods: { '魅力': 10, '气运': 2 } },
  { name: '剑心通明', rarity: 'rare', desc: '你的心中仿佛住着一把剑，遇敌则鸣。', mods: { '物攻': 6, '神识': 4, '会心': 6 } },
  { name: '雷劫淬体', rarity: 'rare', desc: '幼年曾遭雷击而不死，体内残留一丝雷霆之力。', mods: { '法攻': 6, '气血上限': 30 } },
  // 史诗 20点
  { name: '道体初成', rarity: 'epic', desc: '你的体质天生契合大道，修炼速度远超常人。', mods: { '法力上限': 50, '神识': 8, '气运': 5 } },
  { name: '杀伐果决', rarity: 'epic', desc: '你对敌时心如止水，出手绝不留情。', mods: { '物攻': 8, '法攻': 8, '魅力': -5, '会心': 8 } },
  { name: '不灭战魂', rarity: 'epic', desc: '气血越枯竭，你的战力反而越强横。', mods: { '物攻': 10, '气血上限': 50, '物防': -4 } },
  { name: '天罡战气', rarity: 'epic', desc: '你体内自生一股先天罡气，护体伤敌。', mods: { '物防': 10, '法防': 6 } },
  { name: '红鸾入命', rarity: 'epic', desc: '你命带桃花，无论男女都易为你倾心。', mods: { '魅力': 14, '气运': 3 } },
  { name: '通灵之体', rarity: 'epic', desc: '你天生可与万物之灵沟通，草木鸟兽皆可为友。', mods: { '神识': 12, '法攻': 4 } },
  // 传说 25点
  { name: '九转玄功', rarity: 'legend', desc: '传承自上古的无上炼体法门，肉身即是最强法宝。', mods: { '物攻': 12, '物防': 12, '气血上限': 80 } },
  { name: '天命之子', rarity: 'legend', desc: '冥冥之中自有天意眷顾，你便是这方天地的主角。', mods: { '气运': 20, '魅力': 5, '神识': 5 } },
  { name: '先天道胎', rarity: 'legend', desc: '未出生便吸纳先天灵气，大道亲如生母。', mods: { '法力上限': 80, '法攻': 10, '法防': 6 } },
  { name: '弑仙剑骨', rarity: 'legend', desc: '你的骨骼天生便是最好的剑，一念可斩仙。', mods: { '物攻': 16, '物理穿透': 6, '气血上限': -30, '会心': 6 } },
  { name: '万象魔瞳', rarity: 'legend', desc: '你的双瞳蕴含万象，可复制目见之法。', mods: { '神识': 15, '法术穿透': 5, '会心': 10 } },
  // 神迹 50点
  { name: '混沌之体', rarity: 'myth', desc: '传说中可容纳万法的至高体质，混沌未分，包容一切。', mods: { '法力上限': 120, '物防': 10, '法防': 10, '神识': 10 } },
  { name: '不死凤凰血', rarity: 'myth', desc: '你的血脉中流淌着不死神凰的精血，濒死可涅槃。', mods: { '气血上限': 150, '法攻': 12, '魅力': 8 } },
  { name: '天帝转世', rarity: 'myth', desc: '你是陨落天帝的一缕残魂转世，身负惊天之秘。', mods: { '物攻': 10, '法攻': 10, '神识': 10, '气运': 10, '魅力': 10 } },
  { name: '鸿蒙紫气', rarity: 'myth', desc: '开天辟地时遗留的一缕鸿蒙紫气入了你的眉心。', mods: { '法力上限': 100, '法术穿透': 8, '气运': 15 } },
];
// ---------- 查询 / 解析 ----------
const TRAIT_BY_NAME = new Map(TRAITS.map(t => [t.name, t]));

/** 按名查特质库条目（含 mods / rarity），查不到返回 null */
export const traitCatalogEntry = (name) => (name ? TRAIT_BY_NAME.get(String(name)) || null : null);

/** 稀有度归一为 id：'common' 与 '平庸' 都 → 'common'；查不到原样返回 */
export function rarityIdOf(rarity) {
  if (!rarity) return '';
  const hit = TRAIT_RARITIES.find(r => r.id === rarity || r.name === rarity);
  return hit ? hit.id : String(rarity);
}

export const traitCost = (t) => TRAIT_RARITIES.find(r => r.id === t?.rarity || r.name === t?.rarity)?.cost || 5;

// 只保留有限且非零的加成
function cleanMods(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const [k, v] of Object.entries(src)) {
    const n = Number(v);
    if (Number.isFinite(n) && n) out[k] = n;
  }
  return out;
}

/**
 * 「物攻+6，法防-2」→ { 物攻: 6, 法防: -2 }。
 * 零依赖实现（不能 import gradeUtils：服务端要直接用本模块）。
 * 兼容写法：物攻+6 / 物攻-2 / 物攻=6 / 物攻:6 / 物攻 6。
 */
const MOD_TEXT_RE = /([\u4e00-\u9fa5A-Za-z]+)\s*([+\-=:：]?)\s*(-?\d+(?:\.\d+)?)/g;
export function parseTraitModsText(text) {
  const out = {};
  if (text == null) return out;
  const s = String(text);
  if (!s.trim()) return out;
  MOD_TEXT_RE.lastIndex = 0;
  let m;
  while ((m = MOD_TEXT_RE.exec(s))) {
    const key = String(m[1] || '').trim();
    if (!key) continue;
    let n = Number(m[3]);
    if (!Number.isFinite(n)) continue;
    if (m[2] === '-') n = -n;      // 「物攻-20」的数字本身可能已带负号，符号以符号位为准
    if (n) out[key] = (out[key] || 0) + n;
  }
  return out;
}

// 特质对象 → 它自带的数字（「加成」文本优先；没写文本才用 mods 对象）
// 注意两者**不能相加**：syncTraitMods 会把解析结果写回 mods 当缓存，
// 若这里再把文本与 mods 相加，每次落档数字就翻一倍（历史 bug）。
function ownModsOf(trait) {
  if (!trait || typeof trait !== 'object') return {};
  const text = trait['加成'] ?? trait.加成 ?? trait.modsText ?? '';
  const fromText = parseTraitModsText(text);
  if (Object.keys(fromText).length) return fromText;   // 「加成」文本是权威原始来源
  return { ...cleanMods(trait.mods) };                 // 只写了 mods 对象（或都没写）
}

/**
 * 特质 → 属性词条（中文属性名 → 数值），**显示口径 = 校界口径**。
 * · 库内特质：一律取库里的权威值（AI 写的数字不许覆盖）。
 * · 库外特质：**原样采信它自带的数字**（mods 或「加成」文本），不设上限。
 *   没写数字则返回 null（由 traitAllowanceMods 给一份参考容差）。
 */
export function resolveTraitMods(trait) {
  if (trait == null) return null;
  const name = typeof trait === 'string' ? trait : trait.name;
  const lib = traitCatalogEntry(name);
  if (lib) {
    const out = cleanMods(lib.mods);
    return Object.keys(out).length ? out : null;
  }
  const obj = (typeof trait === 'string') ? { name: trait } : trait;
  const out = ownModsOf(obj);
  return Object.keys(out).length ? out : null;
}

// ---------- 库外特质的「参考幅度」（仅在它一个字都没写时兜底） ----------
// 取值 = 库里同稀有度、同一属性的最高幅度，由特质库现算，改库即生效。
// 注意：这**不是上限**。库外特质写了数字就原样采信（见 resolveTraitMods），本表只回答
// 「特质只有名称/稀有度/描述、没有任何数字时，校界该给它多大空间」。
export const TRAIT_MOD_CEILING = (() => {
  const table = {};
  for (const t of TRAITS) {
    const rarity = rarityIdOf(t.rarity) || 'common';
    const bag = (table[rarity] = table[rarity] || {});
    for (const [k, v] of Object.entries(cleanMods(t.mods))) {
      const n = Math.abs(v);
      if (n > (bag[k] || 0)) bag[k] = n;
    }
  }
  return table;
})();

// 全库该属性的最高幅度（同稀有度里没有这条属性时的兜底）
const ATTR_CEILING_FALLBACK = (() => {
  const table = {};
  for (const bag of Object.values(TRAIT_MOD_CEILING)) {
    for (const [k, v] of Object.entries(bag)) {
      if (v > (table[k] || 0)) table[k] = v;
    }
  }
  return table;
})();

/**
 * 单个属性的「参考幅度」：库外特质没写数字时，校界按它给空间。
 * @param {string} rarity 稀有度（id 或中文名，缺省按「平庸」）
 * @param {string} attr 中文属性名
 */
export function traitModCeiling(rarity, attr) {
  const key = rarityIdOf(rarity) || 'common';
  const own = TRAIT_MOD_CEILING[key]?.[attr];
  if (Number.isFinite(own) && own > 0) return own;
  const any = ATTR_CEILING_FALLBACK[attr];
  return Number.isFinite(any) && any > 0 ? any : 0;
}

/**
 * 特质 → 「校界额度」（中文属性名 → 数值）。
 * ⚠️ 2026-09-17 起数值校界**不再调用本函数**：特质已改为与装备同路的独立叠加段
 * （见 snapshotSchema.js 的 attrRows 三段口径），不写进「自身」，境界区间不为它上移。
 * 保留以备特质相关的其它校验。口径：库内取库权威值；库外写了数字原样采信（不设上限）；
 * 库外一字未写则按稀有度给一份参考幅度（见 TRAIT_MOD_CEILING）。
 */
export function traitAllowanceMods(trait) {
  if (trait == null) return null;
  const obj = (typeof trait === 'string') ? { name: trait } : trait;
  const exact = resolveTraitMods(obj);
  if (traitCatalogEntry(obj.name)) return exact;
  if (exact) return exact;              // 库外但写了数字 → 原样采信
  // 库外且没写数字（只有名称/稀有度/描述）：按该稀有度给参考幅度
  const rarity = obj.rarity || obj['稀有度'] || '';
  const out = {};
  const bag = TRAIT_MOD_CEILING[rarityIdOf(rarity) || 'common'] || {};
  for (const [attr, ceil] of Object.entries(bag)) {
    if (ceil) out[attr] = ceil;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 一组特质 → 额度合计（中文属性名 → 数值），同名只计一次。
 * 服务端（v2 快照的「特质」列）与客户端（快照 traits）共用。
 */
export function traitAllowanceTotal(traits) {
  const out = {};
  const seen = new Set();
  for (const t of (Array.isArray(traits) ? traits : [])) {
    const name = typeof t === 'string' ? t : (t?.name || t?.['名称']);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const raw = (typeof t === 'string')
      ? t
      : { name, rarity: t.rarity || t['稀有度'], mods: t.mods, 加成: t['加成'] ?? t.加成 };
    const bag = traitAllowanceMods(raw);
    if (!bag) continue;
    for (const [k, v] of Object.entries(bag)) out[k] = (out[k] || 0) + v;
  }
  return out;
}

/** 特质词条紧凑表（注入提示词用：让 AI 有据可依地把加成算进属性） */
export function formatTraitModsTable() {
  const lines = [];
  for (const rarity of TRAIT_RARITIES) {
    const seg = TRAITS.filter(t => t.rarity === rarity.id)
      .map(t => {
        const mods = cleanMods(t.mods);
        const body = Object.entries(mods).map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`).join('·') || '无加成';
        return `${t.name}（${body}）`;
      });
    if (seg.length) lines.push(`${rarity.name}：${seg.join('、')}`);
  }
  return lines.join('\n');
}
