// ===== 正文着色词表（设置 → 正文规则与文风） =====
// 正文里的 <font color='#XXXXXX'> 由故事/世界书驱动，AI 可自由填色；本模块让用户限定可用颜色。
//
// 四处消费方：
//   1) StoryRenderer：strict 模式下丢弃词表外的颜色（该段回退默认字色），词表内的颜色归一化为规范值
//   2) promptSystem：把词表注入正文提示词，告诉 AI 只能用哪些颜色（否则 AI 照旧乱用）
//   3) SettingsPage：可视化编辑 + 实时预览
//   4) GameDashboard：战后补写正文时也要渲染（同样走 StoryRenderer，只是调用点在别处）
//
// 字段说明：
//   mode  'off' = 不限制（仅保留内置安全校验）；'strict' = 只允许 list 内的颜色
//   list  [{ name: 语义色名（AI 与用户都好认）, value: CSS 色值, valueDark: 浓墨主题用的提亮值, desc: 用途提示（只进提示词） }]
//
// ⚠⚠ 为什么每个色要备两套值（2026-09-23 实测，别删）：
//   这 8 个色是**为浅纸配的深彩**——亮度 L 只有 0.10~0.18。压在「淡墨」的缥碧纸
//   (rgb(238,242,230), L=0.874) 上正好，压在「浓墨」的螺子黛深青
//   (rgb(16,46,51), L=0.023) 上全部读不清：实测最差 1.82:1（苍蓝），最好也就 3.21:1（淡金），
//   而正文门槛是 4.5:1。
//
//   ⚠ 曾想过「把浓墨底色压得更深来解决」——数学上走不通：底压到纯黑 #000000 时，
//     最差的苍蓝也只有 3.07:1，因为它自己的 L 才 0.1033。**不是底不够深，是色本身太暗。**
//
//   所以只能给浓墨另配提亮值：**色相一度不动**，只把亮度抬到刚过 4.5:1（见 valueDark）。
//   色名不变（AI 照旧写「苍蓝」），显示时按当前主题取对应值 ⇒ 两套主题都读得清，
//   且玩家看到的色和 AI 写的色名始终对得上。
//
//   ⚠ 主题在运行时怎么读：浓墨是**默认**主题，实现方式是**不写** data-theme 属性
//     （见 theme.js 的 applyTheme：dark 走 delete dataset.theme）。
//     所以判据是「data-theme === 'light' 才是淡墨」，不能用「=== 'dark'」。
export const DEFAULT_COLOR_PALETTE = {
  mode: 'off',
  /* ⚠ valueDark / valueLight 这批值是**由推导器算出来的**（保色相调亮度，带 3% 安全余量），
     不是手工挑的。
       浓墨：8 个全部 >= 4.6388:1，色相漂移 <= 0.31°。
       淡墨：只有 3 个需要调（淡金/青碧/松绿），其余 5 个本来就够读 ⇒ valueLight 留空，
             由 deriveLightVariant 现场推导（结果一致）。
     若你把某个 value 改了，别手算这两个字段——直接删掉它们，
     pickThemedValue 会现场用同一个算法推导。 */
  list: [
    { name: '淡金', value: '#8F7426', valueDark: '#B08F2F', valueLight: '#816922', desc: '灵石、法宝、机缘、道韵' },
    { name: '墨紫', value: '#6B4E9E', valueDark: '#9E88C4', desc: '预兆、心境、神魂、秘术' },
    { name: '青碧', value: '#2E7D6B', valueDark: '#3CA38B', valueLight: '#2C7866', desc: '灵气、木属、丹药、治愈' },
    { name: '丹朱', value: '#B4432B', valueDark: '#DA7762', desc: '血煞、危险、警示、杀机' },
    { name: '苍蓝', value: '#2F5D8C', valueDark: '#6497CB', desc: '水系、寒霜、符箓、冷静' },
    { name: '松绿', value: '#4A7A3A', valueDark: '#62A24D', valueLight: '#487739', desc: '草木、生机、灵植、驭兽' },
    { name: '赭褐', value: '#7A5A2E', valueDark: '#BA8A47', desc: '土石、碑文、古朴、器物' },
    { name: '玄灰', value: '#5A5A66', valueDark: '#92929E', desc: '未知、晦暗、旁白、回忆' },
  ],
};

/** 读当前是否淡墨。浓墨是默认态且「不写属性」⇒ 只有 === 'light' 才算淡墨。 */
export function isLightTheme() {
  try { return document.documentElement.dataset.theme === 'light'; } catch { return false; }
}

// ---------- 浓墨版色值的自动推导 ----------
/* 为什么需要：见文件头「为什么每个色要备两套值」。
   核心矛盾：玩家/内置填的色是「心里那个色」（多半是为浅纸选的深彩），
   压在浓墨的深青底上读不清。我们不能改他的色相（那就不是他要的色了），
   只能**保色相、抬亮度**，抬到刚好过正文可读门槛。

   算法：在 HSL 空间里保持 H 与 S 不动，只把 L 往上推，
        取第一个能让对比度 >= 4.5:1 的 L 值；仍然过不了就降饱和再试。
        ⚠ 若色本身已经够亮（浅纸版本来就浅），不动它 —— 抬亮会让它变白。 */

const READ_MIN = 4.5;          // 正文可读门槛
const SAFE_MARGIN = 1.03;      // 留 3% 余量：算出的值要 >= 4.5×1.03 ≈ 4.635
/* ⚠⚠ 为什么要 SAFE_MARGIN（踩过）：
   DARK_PAPER_L 是「浓墨正文纸面」相对亮度的**近似值**（实测 rgb(16,46,51)）。
   真实底色随主题变量/半透明纸罩浮动，且抬亮度的循环用浮点累加（l += 0.005），
   恰好卡在 4.5 时会算出 4.4966 —— 差一丝没过线。留 3% 余量后，
   推导值稳定落在 4.6~4.7，底色小范围浮动也不会跌破 4.5。 */
const READ_TARGET = READ_MIN * SAFE_MARGIN;
const DARK_PAPER_L = 0.023;    // 浓墨正文纸面的相对亮度（实测 rgb(16,46,51)）
const LIGHT_PAPER_L = 0.874;   // 淡墨正文纸面的相对亮度（实测 rgb(238,242,230)）

function _srgbF(v) {
  v /= 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function relLum(rgb) {
  return 0.2126 * _srgbF(rgb[0]) + 0.7152 * _srgbF(rgb[1]) + 0.0722 * _srgbF(rgb[2]);
}
function _ratioToDark(rgb) {
  const l = relLum(rgb);
  return (Math.max(l, DARK_PAPER_L) + 0.05) / (Math.min(l, DARK_PAPER_L) + 0.05);
}
function _hexToRgb(hex) {
  const h = String(hex || '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function _rgbToHex(rgb) {
  return '#' + rgb.map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function _rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
}
function _hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const c = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [c(h + 1 / 3) * 255, c(h) * 255, c(h - 1 / 3) * 255];
}

/* ---------- 按主题推导色值（浓墨提亮 / 淡墨压暗） ---------- */
/* 两套主题共用**同一个**推导器，只换「纸面亮度」和「找值方向」——
   ⚠ 刻意不写成两份复制品：上次的 bug 就是"算法只改了一处、验证器没跟上"。
   共用一份，方向由参数决定，就不可能两边跑偏。 */
const STEP = 1000;
const _quantize = (c) => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];

/**
 * 在指定纸面上找一个够读的色：色相不动，只调亮度；亮度调到底还不行再降饱和度。
 * @param {string} hex 任意 #RRGGBB
 * @param {number} paperL 纸面相对亮度（浓墨 0.023 / 淡墨 0.874）
 * @param {boolean} brighten true=往亮找（浓墨用）／false=往暗找（淡墨用）
 * @returns {string} 推导出的 #RRGGBB
 */
function _deriveForPaper(hex, paperL, brighten) {
  const ratio = (c) => { const l = relLum(c); return (Math.max(l, paperL) + 0.05) / (Math.min(l, paperL) + 0.05); };
  const rgb = _hexToRgb(hex);
  if (!rgb) return '';
  if (ratio(rgb) >= READ_TARGET) return String(hex).toUpperCase(); // 本来就够读，别动它
  const [h, s, l0] = _rgbToHsl(rgb[0], rgb[1], rgb[2]);
  const from = Math.round(l0 * STEP);
  const end = brighten ? STEP : 0;
  const stepDir = brighten ? 1 : -1;
  /* ⚠ 用**整数步进**（千分位）而不是浮点累加：
     `for (let l = l0; l <= .98; l += .005)` 会累积浮点误差，实测把某个色卡在 4.4966
     刚好差一丝没过 4.5。改成整数计数再除，路径确定、可复现。

     ⚠⚠ 判定必须打在**取整后的 8bit 值**上，不能打在浮点值上（2026-09-23 实测抓到）：
       循环算出的是浮点三通道，写出去的是 `Math.round` 后的 #RRGGBB —— 两者不是同一个色。
       苍蓝在 i=592 档：浮点 [99.218,150.404,202.702] 对比度 4.6444（过了 4.635 的线），
       但取整成 #6396CB 后只有 4.6270（**没过**）。旧写法测浮点、发取整值，
       于是把两个色（苍蓝 4.627、玄灰 4.622）交在了安全余量之下。
       现在先把候选取整成 8bit、再拿它去判，保证"测的"就是"发的"。 */
  for (let i = from; brighten ? i <= end : i >= end; i += stepDir) {
    const c = _quantize(_hslToRgb(h, s, i / STEP));
    if (ratio(c) >= READ_TARGET) return _rgbToHex(c);
  }
  // 亮度调到底还不行（高饱和／极端的色常这样）⇒ 逐步降饱和再推
  for (let si = Math.round(s * 100); si >= 0; si--) {
    const s2 = si / 100;
    for (let i = from; brighten ? i <= end : i >= end; i += stepDir) {
      const c = _quantize(_hslToRgb(h, s2, i / STEP));
      if (ratio(c) >= READ_TARGET) return _rgbToHex(c);
    }
  }
  return brighten ? '#FFFFFF' : '#000000'; // 理论上到不了这儿（降饱和到底就是灰，必过其一）
}

/**
 * 给一个颜色算「浓墨主题版」：色相不动，抬亮度到过正文门槛（带安全余量）。
 * @param {string} hex 任意 #RRGGBB
 * @returns {string} 推导出的 #RRGGBB；输入不合法或本来已够亮则原样返回
 */
export function deriveDarkVariant(hex) {
  return _deriveForPaper(hex, DARK_PAPER_L, true);
}

/**
 * 给一个颜色算「淡墨主题版」：色相不动，压暗到过正文门槛（带安全余量）。
 * ⚠ 为什么要这个：原生色多半是**为浅底配的深彩**，但深得不够 ——
 *   实测内置 8 色里淡金 3.94／青碧 4.34／松绿 4.47 都低于 4.5，压在缥碧青纸上偏糊。
 * @param {string} hex 任意 #RRGGBB
 * @returns {string} 推导出的 #RRGGBB；输入不合法或本来已够读则原样返回
 */
export function deriveLightVariant(hex) {
  return _deriveForPaper(hex, LIGHT_PAPER_L, false);
}

/** 按当前主题取一个色。没配对应主题的版本时**现场推导**（玩家自定义色走这条路）。 */
export function pickThemedValue(entry, light) {
  const v = String(entry?.value || '').trim();
  if (light) {
    /* ⚠ 淡墨也要推导（2026-09-23 加）：原生色是为老主题配的，压在缥碧青纸上
       也可能偏弱 —— 实测内置 8 色里有 3 个低于 4.5（淡金 3.94／青碧 4.34／松绿 4.47）。
       玩家明确要求「跟浓墨版一样自动推导」，所以这里对称处理。 */
    const vl = String(entry?.valueLight || '').trim();
    if (vl) return vl;
    return deriveLightVariant(v) || v;
  }
  const vd = String(entry?.valueDark || '').trim();
  if (vd) return vd;                                      // 浓墨：配了就用
  return deriveDarkVariant(v) || v;                       // 没配：现场推导
}

/* ---------- 可读性自检（给设置页用，只读，不改玩家的色） ---------- */
/* ⚠ 为什么要有这个：玩家手上的色值多半是**为老主题配的**，压在新的缥碧青纸/螺子黛深青上
   未必够读。我们不替他改（那是他的设置），但必须让他**看得见**哪个色在本主题下偏弱。 */
const PAPER_L = { dark: DARK_PAPER_L, light: LIGHT_PAPER_L };   // 两套主题的正文纸面相对亮度（实测）

/**
 * 算一个色在指定主题正文纸面上的对比度。
 * @param {string} hex
 * @param {boolean} light true=淡墨 / false=浓墨
 * @returns {number} WCAG 对比度；输入不合法返回 0
 */
export function contrastOnPaper(hex, light) {
  const rgb = _hexToRgb(hex);
  if (!rgb) return 0;
  const pl = light ? PAPER_L.light : PAPER_L.dark;
  const l = relLum(rgb);
  return +(((Math.max(l, pl) + 0.05) / (Math.min(l, pl) + 0.05)).toFixed(2));
}

/** 正文可读门槛。设置页用它给颜色标「够读 / 偏弱」。 */
export const READABLE_MIN = READ_MIN;

// 归一化为标准形态（缺字段补默认、脏数据剔除）
export function normalizePalette(p) {
  if (!p || typeof p !== 'object') return structuredClone(DEFAULT_COLOR_PALETTE);
  const list = Array.isArray(p.list) ? p.list : [];
  return {
    mode: p.mode === 'strict' ? 'strict' : 'off',
    list: list
      .filter(e => e && typeof e === 'object' && String(e.value || '').trim())
      .map(e => {
        const out = {
          name: String(e.name || '').trim(),
          value: String(e.value).trim(),
          desc: String(e.desc || '').trim(),
        };
        /* ⚠⚠ valueDark / valueLight 只在**玩家/存档本来就有值**时才带上这个键。
           无条件补 `valueDark: String(e.valueDark || '').trim()` 会让**没配过浓墨版的条目
           也被补上一个空字符串**，并且随存档一起落盘 —— settings.json 里会平白多出
           一堆 `"valueDark": ""`。
           设置页每次保存都走 normalizePalette，所以这是**会持续污染存档**的写法。
           没有就不产生这个键；pickThemedValue 本来就会对缺字段的现场推导，
           所以行为完全不变。 */
        const vd = String(e.valueDark || '').trim();
        if (vd) out.valueDark = vd;
        const vl = String(e.valueLight || '').trim();
        if (vl) out.valueLight = vl;
        return out;
      }),
  };
}

// 从 settings 取词表（settings.textRules.colorPalette）
export function getColorPalette(settings) {
  return normalizePalette(settings?.textRules?.colorPalette);
}

// ---------- 颜色归一化与匹配键 ----------
// 目的：让 #6b4e9e / #6B4E9E / rgb(107, 78, 158) 视为同一个颜色
function expandHex(hex) {
  const h = hex.slice(1).toLowerCase();
  return h.length === 3 ? '#' + h.split('').map(c => c + c).join('') : '#' + h;
}

function rgbToHex(s) {
  const m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
  if (!m) return '';
  const a = m[4];
  // 半透明颜色不参与词表匹配（无法与不透明色值等价）
  if (a != null && parseFloat(a) < 1 && parseFloat(a) !== 0) return '';
  const to = (n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, '0');
  return '#' + to(m[1]) + to(m[2]) + to(m[3]);
}

/** 把任意颜色写法压成匹配键；不认识的返回 '' */
export function colorMatchKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return expandHex(s);
  if (/^rgba?\(/i.test(s)) return rgbToHex(s) || s.toLowerCase().replace(/\s+/g, '');
  if (/^[a-z]{3,20}$/i.test(s)) return s.toLowerCase();
  return '';
}

// ---------- 解析器：渲染器与提示词共用同一份判定逻辑 ----------
/**
 * 生成颜色解析器。
 * @param {object} palette normalizePalette 的产物或原始设置值
 * @param {{ light?: boolean }} [opts] light=true 取淡墨那套色值，否则取浓墨那套。
 *   ⚠ 不给 opts 时**运行时自己读一次**当前主题（浓墨=不写 data-theme，见 isLightTheme）。
 *     之所以允许显式传：设置页要"按主题预览"，测试要双主题各跑一遍。
 * @returns {{ strict: boolean, size: number, resolve: (raw: string) => string }}
 *   resolve 返回允许使用的颜色字符串；返回 '' 表示不着色
 */
export function makeColorResolver(palette, opts) {
  const p = normalizePalette(palette);
  // 词表为空时限制不生效（否则 strict 会变成"禁止一切着色"，容易误伤）
  const strict = p.mode === 'strict' && p.list.length > 0;
  /* ⚠⚠ 主题必须是**每次 resolve 时现读**，不能在构造时定死。
     原因：StoryRenderer 里 resolver 被 useMemo 缓存（依赖只有 palette），
     而切主题只改 <html data-theme>、不触发 React 重渲染 ⇒ resolver 根本不会重建。
     若在这里 `const light = ...` 定死，玩家切主题后正文颜色会一直停在旧主题那套。
     opts.light 若显式给了（设置页预览 / 测试）就用它，否则每调一次读一次 DOM。 */
  const fixedLight = opts && typeof opts.light === 'boolean' ? opts.light : null;
  const nowLight = () => (fixedLight === null ? isLightTheme() : fixedLight);
  const byKey = new Map();      // 匹配键 → **条目本身**（出口再按主题取值，不能在这里定死色值）
  const byName = new Map();
  for (const e of p.list) {
    const v = String(e.value || '').trim();
    if (!v) continue;
    // ⚠ 三套色值都要登记成匹配键：AI 可能写淡墨版，也可能（学前面输出）写浓墨版，
    //   两者都归一化到同一条目；只登记一套的话，换主题后旧对话里的颜色会被 strict 当表外色丢掉。
    for (const cand of [v, String(e.valueDark || '').trim(), String(e.valueLight || '').trim()].filter(Boolean)) {
      const k = colorMatchKey(cand);
      if (k && !byKey.has(k)) byKey.set(k, e);
    }
    if (e.name && !byName.has(e.name)) byName.set(e.name, e);
  }
  return {
    strict,
    size: p.list.length,
    resolve(raw) {
      const s = String(raw || '').trim();
      if (!s) return '';
      const light = nowLight();
      // 1) 限制模式下先认「色名别名」（AI 写 <font color='淡金'> 也能命中；色名是用户自定义文本，不参与 CSS 注入判定）
      if (strict && byName.has(s)) return pickThemedValue(byName.get(s), light);
      // 2) 内置安全校验：挡住 CSS 注入（表达式、url()、分号、括号等一律不通过）
      const basicOk = /^#[0-9a-f]{3,8}$/i.test(s)
        || /^(rgba?|hsla?)\(\s*[0-9.,%\s/deg]+\)$/i.test(s)
        || /^[a-z]{3,20}$/i.test(s);
      if (!basicOk) return '';
      // 3) 不限制模式：沿用原行为（词表不管，原样放行）
      if (!strict) return s;
      // 4) 限制模式：词表匹配键 → 按主题取该条的色值；未命中则丢弃
      const k = colorMatchKey(s);
      return k && byKey.has(k) ? pickThemedValue(byKey.get(k), light) : '';
    },
  };
}

/**
 * 生成注入正文提示词的着色词表区块。
 * 仅在 strict 且词表非空时返回文本，其它情况返回 ''（不污染提示词）。
 *
 * ⚠ 这里刻意**只给一套色值**（e.value，浅纸版），不给 AI 两套。理由：
 *   色值在 AI 眼里只是个「色名 ↔ 色值」的锚点，让 AI 认出「苍蓝」对应哪个色；
 *   真正决定屏幕上显示什么颜色的，是渲染端按当前主题查表（见 pickThemedValue）。
 *   若给 AI 两套值，它会自己去猜该用哪套，反而可能写错主题那套 —— 反而坏事。
 *   渲染端两套值都登记成匹配键，所以 AI 写哪一套都能被认出来并归一到当前主题。
 */
export function colorPalettePromptText(settings) {
  const p = getColorPalette(settings);
  if (p.mode !== 'strict' || !p.list.length) return '';
  const lines = p.list.map(e => `- ${e.name ? e.name + ' ' : ''}${e.value}${e.desc ? '：' + e.desc : ''}`);
  return [
    '### 【正文着色词表（强制约束）】',
    '正文需要着色时，只能用 <font color=\'#RRGGBB\'>……</font> 包裹对应文字（这是本系统允许的唯一 HTML 例外）。',
    '颜色值必须严格取自下表；表外颜色会被客户端丢弃、该段回退默认字色，等于没写。',
    '不要自造颜色、不要使用渐变、半透明或 rgb()/hsl() 写法，也不要给整段正文大面积上色。',
    '',
    ...lines,
  ].join('\n');
}
