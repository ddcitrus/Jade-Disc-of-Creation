// ===== 性格编码：AI 只写数字，程序翻成人话 =====
// 五段定长，段间用全角竖线（与储物袋、承诺同一套符号）：
//   九型 2 位 ｜ DISC 2 位 ｜ MBTI 4 位 ｜ HEXACO 6 位 ｜ VIA 6 位
//   例：54｜32｜2211｜010001｜021805
//
// 为什么要 AI 写数字：自由文本会飘（同义词、多写一句、格式抖动），数字串的失败形态只有一种 ——
// 位错（少写一位，整串往后挪），而且能被逐位正则抓住。**哪段不合格丢哪段，不整串作废**。
//
// 各段的取值（2026-09-29 与用户改后的契约对齐）：
//   · 九型 2 位：都是型号 1-9（第 2 位是次型，不限相邻，不能与第 1 位相同）
//   · DISC 2 位：都是型号 1-4，两者不能相同（没有「无次要型」这一档了）
//   · MBTI 4 位：每位 1 或 2
//   · HEXACO 6 位：每位 0 或 1 —— 1 = 这一维他身上明显，0 = 不记
//   · VIA 6 位：三项编号各两位，00 空位
//
// 本文件认两种形态：
//   · 数字编码 —— AI 建档那一次、以及剧情真把角色内核改掉的那一次写的就是它；
//   · 中文短版 —— 落盘存的是它（`snapshotV2` 的 `identity.personality`）。
// 为什么落盘存中文而不是数字：每轮演化 AI 都要在【当前各角色快照】里读到这个角色上轮写了什么，
// 存中文则所见即所写，它不用先解码再对照。老存档里 v1 留下的中文短句（如「外表刻板孤傲」）
// 没有标签、认不出，一律原样保留，不会被覆盖成编码。
//
// 字段形态、落点、界面位置见同目录《性格字段与落地方案.md》。

const SEP = '｜';   // 与 snapshotV2.ITEM_SEP 同一个字符；那边会 import 本文件，反向 import 会成环
const DOT = '·';

export const PERSONALITY_LABELS = ['九型', 'DISC', 'MBTI', 'HEXACO', 'VIA'];

// 界面与提示词共用的写法说明（界面那格下面的 hint 用它）
export const PERSONALITY_CODE_HINT = '九型 2 位（型＋次型，各 1-9）｜DISC 2 位（主型＋次要型，各 1-4）｜MBTI 4 位（每位 1 或 2）｜HEXACO 6 位（每位 0 或 1）｜VIA 6 位（三项编号各两位）　例：54｜32｜2211｜010001｜021805';

// ---------- 九型：型名（描述里写的）与短词（第 2 位用的） ----------
// 第 2 位也是 1-9 里的一个型号，渲染成「型名·第 2 位的词」，如 54 → 观察者·浪漫。
// 2026-09-29 起不再要求两位相邻（用户改的契约：第 2 位也是这 9 项），也不再允许填 0。
const ENNEA = [null,
  { name: '完美主义者', word: '完美主义' },
  { name: '给予者', word: '给予' },
  { name: '成就者', word: '成就' },
  { name: '浪漫者', word: '浪漫' },
  { name: '观察者', word: '观察' },
  { name: '忠诚者', word: '忠诚' },
  { name: '活跃者', word: '活跃' },
  { name: '领袖', word: '领袖' },
  { name: '和平者', word: '和平' },
];

// ---------- DISC：主型 + 次要型（两个都要写，1-4，不能相同；0 只作读档容错） ----------
const DISC = [null,
  { letter: 'D', name: '支配型', word: '支配', gloss: '遇事直接定方向，不在乎谁先开口' },
  { letter: 'I', name: '影响型', word: '影响', gloss: '靠说话带动气氛，愿意先亮出自己的态度' },
  { letter: 'S', name: '稳健型', word: '稳健', gloss: '稳健为主，先看退路再动手' },
  { letter: 'C', name: '谨慎型', word: '谨慎', gloss: '按规矩与数字办事，先把风险算清' },
];

// ---------- MBTI：四组二选一，1 = 前一个字母，2 = 后一个字母 ----------
const MBTI_PAIRS = [
  { first: 'E', second: 'I', words: ['外向', '内向'] },
  { first: 'S', second: 'N', words: ['实感', '直觉'] },
  { first: 'T', second: 'F', words: ['思考', '情感'] },
  { first: 'J', second: 'P', words: ['判断', '知觉'] },
];

// ---------- HEXACO：六维 ----------
// 内部值只有三种：+1 记偏高的那一侧、-1 记偏低的那一侧、0 不记。
// AI 写进来的数字形态是 0 或 1（1 = 这一维他身上明显，取偏高的词）；
// -1 只可能来自中文形态的偏低词、或旧规则留下的 2 —— 读档要认得出，写入口不再收。
const HEXACO = [
  { key: 'H', name: '诚实-谦逊', high: ['谦逊', '不把好处往自己身上揽'], low: ['自利', '先顾自己的得失'] },
  { key: 'O', name: '开放', high: ['求新', '爱想没见过的可能'], low: ['守成', '熟悉的做法不改'] },
  { key: 'E', name: '情绪', high: ['多感', '情绪写在脸上'], low: ['沉稳', '遇事先压住情绪'] },
  { key: 'X', name: '外向', high: ['外向', '人一多就来劲'], low: ['内敛', '独处比应酬省力'] },
  { key: 'A', name: '宜人', high: ['宽和', '别人的过失不追究'], low: ['强硬', '该顶回去的时候不退'] },
  { key: 'C', name: '尽责', high: ['严谨', '讲条理、有始有终'], low: ['随意', '东西放哪儿不太在意'] },
];

// ---------- VIA：24 项长处，编号 01-24（数组下标即编号，0 号空着） ----------
const VIA = ['',
  '创造力', '好奇心', '开放思维', '好学', '洞察力', '勇敢',
  '毅力', '正直', '热情', '爱', '善良', '社交智慧',
  '团队合作', '公平', '领导力', '宽恕', '谦逊', '审慎',
  '自我调节', '审美', '感恩', '希望', '幽默', '信仰',
];

// 词的查表（中文形态解析用）
const ENNEA_BY_NAME = new Map();
const ENNEA_BY_WORD = new Map();
for (let i = 1; i <= 9; i++) {
  ENNEA_BY_NAME.set(ENNEA[i].name, i);
  ENNEA_BY_WORD.set(ENNEA[i].word, i);
}
const HEXACO_BY_WORD = new Map();
HEXACO.forEach((d, i) => {
  HEXACO_BY_WORD.set(d.high[0], [i, 1]);
  HEXACO_BY_WORD.set(d.low[0], [i, -1]);
});
const VIA_BY_NAME = new Map();
for (let i = 1; i <= 24; i++) VIA_BY_NAME.set(VIA[i], i);

/* ================= 一、归一与判定 ================= */

// 半角竖线收全角、每段去首尾空白、去掉末尾空段。
// 不删中间的空段 —— 「54｜｜2211」是有意义的（DISC 那一段没写）。
export function normalizeCodeText(text) {
  const raw = String(text ?? '').replace(/\|/g, SEP).replace(/[\r\n]+/g, ' ').trim();
  if (!raw) return '';
  const segs = raw.split(SEP).map(s => s.trim());
  while (segs.length && !segs[segs.length - 1]) segs.pop();
  return segs.join(SEP);
}

// 「像不像编码」：整串只有数字与竖线，每段不超过 6 位，至少有一段有内容。
// 判据必须严 —— 老存档里躺着的是中文短句，那是要原样保留的；而纯数字串里认不出任何一段时，
// parsePersonalityText 会返回 ok=false，调用方照样原样保留。所以这里只做粗筛，细筛交给逐段校验。
export function looksLikePersonalityCode(text) {
  const t = normalizeCodeText(text);
  if (!t) return false;
  if (!/^[0-9｜]+$/.test(t)) return false;
  const segs = t.split(SEP).map(s => s.trim()).filter(Boolean);
  return segs.length >= 1 && segs.every(s => s.length <= 6);
}

/* ================= 二、解析（数字编码与中文短版都认） ================= */

// 五段的位次、名称、位数、示例 —— 报错文案与「五段写满」校验共用这一份，避免两处写岔
const SEG_SPEC = [
  ['ennea', '九型', 2, '54'],
  ['disc', 'DISC', 2, '32'],
  ['mbti', 'MBTI', 4, '2211'],
  ['hexaco', 'HEXACO', 6, '010001'],
  ['via', 'VIA', 6, '012004'],
];

// 这一段「有没有内容」。空段、以及虽写满数字但渲染不出东西的段都算没有：
// HEXACO 六位全 0、VIA 三项全 00，这两段的渲染结果都是空，等于没写。
function segHasContent(seg, key) {
  if (key === 'hexaco') return Array.isArray(seg.hexaco) && seg.hexaco.some(v => v !== 0);
  if (key === 'via') return Array.isArray(seg.via) && seg.via.length > 0;
  return seg[key] != null;
}

function missingSegments(seg) {
  return SEG_SPEC.filter(([k]) => !segHasContent(seg, k));
}

function emptySeg() {
  return { ennea: null, disc: null, mbti: null, hexaco: null, via: null };
}

/**
 * 解析性格文本。
 * @param {string} text
 * @param {{requireAll?: boolean}} [opts] requireAll：只给**写入口**（`applyEdits`）用，兼作**严格模式**开关。
 *   开了它：① 要求五段都有内容，缺哪段报哪段；② 各段按契约收紧（九型第 2 位不许为 0、
 *   DISC 第 2 位不许为 0 也不许与主型相同、HEXACO 每位只收 0 或 1）。
 *   读档口一律不开 —— 老档里本来就躺着缺口缺段的，那是要照原样读出来的，不能算错。
 * @returns {{ ok: boolean, code: boolean, seg: object, errors: string[], notes: string[] }}
 *   ok     至少认出一段（认不出 ⇒ 调用方按自由文本原样保留）
 *   code   来源是数字编码（中文形态为 false）
 *   errors 该段被丢弃的原因（会说清第几段、正确写法）
 *   notes  已接受、但值得记一笔的（如 HEXACO 写了 3、DISC 两位写了同一个型）
 */
export function parsePersonalityText(text, opts = {}) {
  const src = normalizeCodeText(text);
  const seg = emptySeg();
  const errors = [];
  const notes = [];
  if (!src) return { ok: false, code: false, seg, errors, notes };
  const strict = !!opts.requireAll;
  const code = looksLikePersonalityCode(src);
  const parts = src.split(SEP).map(s => s.trim());
  if (code) parseCodeSegments(parts, seg, errors, notes, strict);
  else parseLabeledSegments(parts, seg, errors);
  const ok = !!(seg.ennea || seg.disc || seg.mbti || seg.hexaco || seg.via);
  if (ok) notes.push(...crossCheckNotes(seg));
  if (opts.requireAll && ok) {
    const miss = missingSegments(seg);
    if (miss.length) {
      errors.push('五段没写全，缺 ' + miss.map(([, label, digits, eg]) => `${label}（${digits} 位，如 ${eg}）`).join('、') + '；五段一段都不能空');
    }
  }
  return { ok, code, seg, errors, notes };
}

// ---- 数字编码：按位次认段 ----
// strict ＝ 写入口（AI 交回来的那一份）：按契约收紧，不合规的那段丢掉并写出正确写法。
// 非 strict ＝ 读档口：老档里躺着的旧写法（九型的翼填 0、DISC 只写主型、HEXACO 写 0-5）都要读得出来。
function parseCodeSegments(parts, seg, errors, notes, strict) {
  const [s1, s2, s3, s4, s5] = parts;

  if (s1) {
    const type = Number(s1[0]);
    const wing = Number(s1[1]);
    if (!/^[1-9]\d$/.test(s1)) {
      errors.push('九型必须是 2 位、两位都取 1-9（第 1 位是主型，第 2 位是次型），例如 54；收到「' + s1 + '」，该段未记');
    } else if (wing === type) {
      if (strict) errors.push('九型的第 2 位与第 1 位同为 ' + type + '，要另写一个型号（如 54）；收到「' + s1 + '」，该段未记');
      else { notes.push('九型两位写了同一个型号 ' + type + '，已只记主型'); seg.ennea = { type, wing: 0 }; }
    } else if (!wing) {
      if (strict) errors.push('九型的第 2 位要写 1-9 中的一个，不能填 0（如 54）；收到「' + s1 + '」，该段未记');
      else seg.ennea = { type, wing: 0 };
    } else {
      seg.ennea = { type, wing };
    }
  }

  if (s2) {
    const main = Number(s2[0]);
    const sub = Number(s2[1]);
    const shape = strict ? /^[1-4][1-4]$/ : /^[1-4][0-4]$/;
    if (!shape.test(s2)) {
      errors.push(strict
        ? 'DISC 要写 2 位、两位都取 1-4（主型 ＋ 次要型，两者不能相同），例如 32；收到「' + s2 + '」，该段未记'
        : 'DISC 必须是 2 位（主型 1-4 ＋ 次要型 0-4），例如 32；收到「' + s2 + '」，该段未记');
    } else if (sub === main) {
      if (strict) errors.push('DISC 的次要型与主型同为 ' + main + '，要另写一个型号（如 32）；收到「' + s2 + '」，该段未记');
      else { notes.push('DISC 的次要型与主型同为 ' + main + '，已按无次要处理'); seg.disc = { main, sub: 0 }; }
    } else {
      seg.disc = { main, sub };
    }
  }

  if (s3) {
    if (!/^[12]{4}$/.test(s3)) {
      errors.push('MBTI 必须是 4 位、每位只写 1 或 2（1 = E/S/T/J，2 = I/N/F/P），例如 2211；收到「' + s3 + '」，该段未记');
    } else {
      seg.mbti = s3;
    }
  }

  if (s4) {
    const shape = strict ? /^[01]{6}$/ : /^[0-5]{6}$/;
    if (!shape.test(s4)) {
      errors.push(strict
        ? 'HEXACO 要写 6 位、每位只写 0 或 1（1 = 这一维他身上明显），例如 010001；收到「' + s4 + '」，该段未记'
        : 'HEXACO 必须是 6 位、每位 0-5，例如 010001；收到「' + s4 + '」，该段未记');
    } else {
      // 内部值只有三种：+1 记偏高的那一侧、-1 记偏低的那一侧、0 不记。
      // 新契约只写 0/1；2 是旧规则的「偏低」、3 是「居中」、4/5 是「偏高」，留着给读档用。
      if (s4.includes('3')) notes.push('HEXACO 写了 3（居中），已按不记处理');
      seg.hexaco = s4.split('').map(n => {
        const v = Number(n);
        if (v === 1 || v >= 4) return 1;
        if (v === 2) return -1;
        return 0;
      });
    }
  }

  if (s5) {
    if (!/^\d{6}$/.test(s5)) {
      errors.push('VIA 必须是 6 位（三项编号各两位，00 表示空），例如 021805；收到「' + s5 + '」，该段未记');
    } else {
      const picked = [];
      const bad = new Set();
      for (let i = 0; i < 6; i += 2) {
        const n = Number(s5.slice(i, i + 2));
        if (!n) continue;
        if (n < 1 || n > 24) { bad.add(s5.slice(i, i + 2)); continue; }
        if (!picked.includes(n)) picked.push(n);
      }
      if (bad.size) errors.push('VIA 的编号「' + [...bad].join('、') + '」超出 01-24，该项未记');
      if (picked.length) seg.via = picked;
    }
  }
}

// ---- 中文形态：认标签（「九型 观察者·浪漫」「DISC 稳健」「MBTI INTJ」…） ----
function parseLabeledSegments(parts, seg, errors) {
  for (const p of parts) {
    const m = p.match(/^(九型人格|九型|DISC|MBTI|HEXACO|VIA)\s*[:：]?\s*([\s\S]*)$/i);
    if (!m) continue;                       // 没标签的段不认（老档的自由短句就是这种，保持原样）
    const label = m[1].startsWith('九型') ? '九型' : m[1].toUpperCase();
    const body = m[2].trim();
    if (!body) continue;

    if (label === '九型') {
      const [tName, ...rest] = body.split(DOT).map(s => s.trim());
      const type = ENNEA_BY_NAME.get(tName) || ENNEA_BY_WORD.get(tName);
      if (!type) { errors.push('九型认不出「' + tName + '」，该项未记'); continue; }
      let wing = 0;
      if (rest.length) {
        const w = ENNEA_BY_WORD.get(rest[0]) || ENNEA_BY_NAME.get(rest[0]);
        if (w && w !== type) wing = w;
        else if (w) errors.push('九型的第 2 位「' + rest[0] + '」与主型相同，已只记主型');
        else errors.push('九型的第 2 位「' + rest[0] + '」认不出，已只记主型');
      }
      seg.ennea = { type, wing };
      continue;
    }

    if (label === 'DISC') {
      // 整词匹配（「稳健」「支配」…）—— 短版长版都认，长版里那句解释不含别的型名。
      // 按**出现顺序**记，不按编号顺序：数字形态的 32 渲染成「稳健、影响」，
      // 若按编号顺序读回来会变成 main=2(影响)、sub=3(稳健) —— 每轮渲染都在悄悄对调主次。
      const hits = [];
      for (let i = 1; i < DISC.length; i++) {
        const word = body.includes(DISC[i].word) ? DISC[i].word
          : (body.includes(DISC[i].name) ? DISC[i].name : null);
        if (!word) continue;
        hits.push({ idx: i, at: body.indexOf(word) });
      }
      hits.sort((a, b) => a.at - b.at);
      if (!hits.length) { errors.push('DISC 认不出「' + body + '」，该项未记'); continue; }
      const main = hits[0].idx;
      const sub = hits[1] && hits[1].idx !== main ? hits[1].idx : 0;
      seg.disc = { main, sub };
      continue;
    }

    if (label === 'MBTI') {
      const hit = body.toUpperCase().match(/[EI][SN][TF][JP]/);
      if (!hit) { errors.push('MBTI 里读不出四个字母，该项未记'); continue; }
      seg.mbti = hit[0].split('').map(c => {
        const pair = MBTI_PAIRS.findIndex(p => p.first === c || p.second === c);
        return c === MBTI_PAIRS[pair].first ? '1' : '2';
      }).join('');
      continue;
    }

    if (label === 'HEXACO') {
      const vals = [0, 0, 0, 0, 0, 0];
      let any = false;
      for (const [word, [dim, dir]] of HEXACO_BY_WORD) {
        if (!body.includes(word)) continue;
        vals[dim] = dir;                    // 中文形态只有方向：偏高的记 +1、偏低的记 -1
        any = true;
      }
      if (!any) { errors.push('HEXACO 里读不出词条，该项未记'); continue; }
      seg.hexaco = vals;
      continue;
    }

    if (label === 'VIA') {
      // 按**出现顺序**记，不按编号顺序 —— 否则「好奇心、审慎、洞察力」再读出来会变成
      // 「好奇心、洞察力、审慎」，每轮渲染都在悄悄换位置。
      const hits = [];
      for (const [name, idx] of VIA_BY_NAME) {
        const at = body.indexOf(name);
        if (at >= 0) hits.push({ idx, at });
      }
      hits.sort((a, b) => a.at - b.at);
      if (!hits.length) { errors.push('VIA 里读不出长处名，该项未记'); continue; }
      seg.via = hits.slice(0, 3).map(x => x.idx);
    }
  }
}

/* ================= 三、交叉校对（五套里有两组量的是同一类东西） ================= */
// 这张对照表是经验性的，没有学术标准可依 —— 只当校对用，不当判据，方向对不上只记一条提示。
function crossCheckNotes(seg) {
  const notes = [];
  const h = seg.hexaco;
  const m = seg.mbti;
  // HEXACO 那一维的方向：内部值本身就是 +1 偏高 / -1 偏低 / 0 不记
  const hexSign = (dim) => {
    const v = h?.[dim] ?? 0;
    return v > 0 ? 1 : v < 0 ? -1 : 0;
  };
  // MBTI 那一位的方向，换算到「高」这一边：
  //   E 外向 / J 判断 本身就是高；S 实感、T 思考 相对 N 直觉、F 情感是低 —— 两组方向相反
  const mbtiSign = (i) => {
    const first = m[i] === '1';
    const firstIsHigh = i === 0 || i === 3;
    return first === firstIsHigh ? 1 : -1;
  };
  if (m && h) {
    const pairs = [
      [0, 3, 'MBTI 的内外向', 'HEXACO 的外向'],
      [1, 1, 'MBTI 的实感/直觉', 'HEXACO 的开放'],
      [2, 4, 'MBTI 的思考/情感', 'HEXACO 的宜人'],
      [3, 5, 'MBTI 的判断/知觉', 'HEXACO 的尽责'],
    ];
    for (const [mbIdx, hexIdx, aLabel, bLabel] of pairs) {
      const hs = hexSign(hexIdx);
      if (!hs || mbtiSign(mbIdx) === hs) continue;
      const letter = m[mbIdx] === '1' ? MBTI_PAIRS[mbIdx].first : MBTI_PAIRS[mbIdx].second;
      notes.push(aLabel + '（' + letter + '）与 ' + bLabel + '方向不一致');
    }
  }
  // DISC 的支配对 MBTI 的外向、谨慎对内向
  const d = seg.disc?.main;
  if (d && m) {
    if (d === 1 && mbtiSign(0) !== 1) notes.push('DISC 的支配与 MBTI 的内向方向不一致');
    if (d === 4 && mbtiSign(0) !== -1) notes.push('DISC 的谨慎与 MBTI 的外向方向不一致');
  }
  return notes;
}

/* ================= 四、渲染 ================= */

function enneaText(e) {
  const t = ENNEA[e.type];
  if (!t) return '';
  return e.wing ? t.name + DOT + ENNEA[e.wing].word : t.name;
}

function discText(d, long) {
  const one = (i) => {
    const x = DISC[i];
    if (!x) return '';
    return long ? x.name + '（' + x.gloss + '）' : x.word;
  };
  return [one(d.main), d.sub ? one(d.sub) : ''].filter(Boolean).join('、');
}

function mbtiText(code, long) {
  const letters = code.split('').map((c, i) => (c === '1' ? MBTI_PAIRS[i].first : MBTI_PAIRS[i].second)).join('');
  if (!long) return letters;
  const gloss = code.split('').map((c, i) => MBTI_PAIRS[i].words[c === '1' ? 0 : 1]).join(DOT);
  return letters + '（' + gloss + '）';
}

function hexacoText(vals, long) {
  const out = [];
  vals.forEach((v, i) => {
    if (!v) return;
    const pair = v > 0 ? HEXACO[i].high : HEXACO[i].low;
    out.push(long ? pair[0] + '（' + pair[1] + '）' : pair[0]);
  });
  return out.join('、');
}

function viaText(list) {
  return list.map(i => VIA[i]).filter(Boolean).join('、');
}

export function renderPersonality(seg, long = false) {
  const parts = [];
  if (seg.ennea) parts.push('九型 ' + enneaText(seg.ennea));
  if (seg.disc) parts.push('DISC ' + discText(seg.disc, long));
  if (seg.mbti) parts.push('MBTI ' + mbtiText(seg.mbti, long));
  if (seg.hexaco) {
    const t = hexacoText(seg.hexaco, long);
    if (t) parts.push('HEXACO ' + t);
  }
  if (seg.via?.length) {
    const t = viaText(seg.via);
    if (t) parts.push('VIA ' + t);
  }
  return parts.join(SEP);
}

/** 落盘/读写口归一：像编码就转成中文短版，否则（老档的中文短句、玩家手写）原样留着。 */
export function normalizePersonalityText(text) {
  const t = normalizeCodeText(text);
  if (!t) return '';
  const p = parsePersonalityText(t);
  if (!p.ok) return t;
  return renderPersonality(p.seg, false) || t;
}

/** 短版：给 AI 看（正文档案、每轮演化快照）。 */
export function personalityShortText(text) {
  const t = normalizeCodeText(text);
  if (!t) return '';
  const p = parsePersonalityText(t);
  return p.ok ? (renderPersonality(p.seg, false) || t) : t;
}

/** 长版：只给界面看（角色详情页），每项带一句解释。不进提示词。 */
export function personalityLongText(text) {
  const t = normalizeCodeText(text);
  if (!t) return '';
  const p = parsePersonalityText(t);
  return p.ok ? (renderPersonality(p.seg, true) || t) : t;
}

// 供探针与界面取表
export const PERSONALITY_TABLES = { ENNEA, DISC, MBTI_PAIRS, HEXACO, VIA };
