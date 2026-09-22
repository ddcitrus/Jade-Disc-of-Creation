/*
 * 字体偏好：界面 / 标题 / 正文 三处**分别**可选，互不影响。
 *
 * 为什么单独一个文件、且存在 localStorage（而不是像字号行距那样存服务端 settings）：
 * 字体是**本机资源**。你在 A 机选了「华文楷体」，B 机没装这个字体，同步过去只会掉进
 * 回退链变成另一种字 —— 与其同步一份错的，不如各机器各选各的。
 * 另外这也是「启动即生效」的前提：settings 要等接口返回才知道，字体等不起（会闪一帧）。
 *
 * 生效方式：往 <html> 上写**内联** CSS 变量（--font-ui / --font-serif / --font-prose）。
 * 内联声明的优先级高于任何样式表规则，所以能盖住 guigu.css 里 :root 的那份定义；
 * 选「默认」时把变量**移除**，让它回落到样式表 —— 不在这里抄第二份默认值，
 * 将来改 guigu.css 的默认字体，这里自动跟随。
 */

export const FONT_KEY = 'mortal-fonts';

/* ---------------- 字体栈（按「族」给，不按具体字体） ----------------
 * 每个栈都是一条回退链：本机缺前者就用后者，最后一定落到通用族。
 * 中文字体名同时给英文名与中文名 —— Windows 认中文名，macOS 认英文名。
 */
const STACK = {
  // 黑体族
  hei: '"Microsoft YaHei UI", "Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", "Source Han Sans SC", "Noto Sans SC", system-ui, -apple-system, "Segoe UI", sans-serif',
  sys: 'system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  yuanti: '"Yuanti SC", "YouYuan", "幼圆", "Hiragino Maru Gothic ProN", "Microsoft YaHei", sans-serif',
  // 楷体族
  kai: '"STKaiti", "华文楷体", "Kaiti SC", "KaiTi", "楷体", serif',
  // 行楷（主菜单大标题那支招牌字）
  xingkai: '"STXingkai", "华文行楷", "STKaiti", "华文楷体", serif',
  // 宋体族
  song: '"STSong", "华文宋体", "STZhongs", "华文中宋", "Songti SC", "SimSun", "宋体", serif',
  // 仿宋
  fangsong: '"STFangsong", "华文仿宋", "FangSong", "仿宋", serif',
  // 隶书
  lishu: '"STLiti", "LiSu", "隶书", serif',
  // 等宽（数值、代码、JSON）
  mono: 'ui-monospace, "Cascadia Mono", "SF Mono", Consolas, Menlo, monospace',
};

/*
 * 三个可调槽位。cssVars 可以是多个 —— 例如「标题」同时管 --font-serif（各级标题）
 * 与 --font-title（主菜单大标题那支行楷）。选「默认」时两个都不动，
 * 于是主标题保持行楷、其余标题保持楷体；一旦选了具体某族，两者一起换成那一族。
 */
export const FONT_SLOTS = [
  {
    id: 'ui',
    cssVars: ['--font-ui'],
    label: '界面字体',
    hint: '菜单、按钮、列表、表单，以及界面上所有说明文字。',
    sample: '设置 · 存档 · 背包 · 传音符 · 是否覆盖当前存档？',
    big: false,
  },
  {
    id: 'title',
    cssVars: ['--font-serif', '--font-title'],
    label: '标题与强调',
    hint: '各级标题、卡片名、对话说话人，以及主菜单的大标题。',
    sample: '第一章 · 山边小村',
    big: true,
  },
  {
    id: 'prose',
    cssVars: ['--font-prose'],
    label: '正文字体',
    hint: '小说正文、旁白与战斗战报。',
    sample: '韩立盘膝而坐，缓缓吐出一口浊气。洞府之外，灵雾如潮汐般涌动。',
    big: false,
  },
];

// 每个槽的候选。id 为空串 = 不改（用样式表里的默认）。
export const FONT_CHOICES = {
  ui: [
    { id: '', name: '默认', note: '微软雅黑' },
    { id: 'hei', name: '黑体', stack: STACK.hei },
    { id: 'sys', name: '系统默认', stack: STACK.sys },
    { id: 'yuanti', name: '圆体', stack: STACK.yuanti },
    { id: 'song', name: '宋体', stack: STACK.song },
    { id: 'kai', name: '楷体', stack: STACK.kai },
    { id: 'fangsong', name: '仿宋', stack: STACK.fangsong },
    { id: 'mono', name: '等宽', stack: STACK.mono },
  ],
  title: [
    { id: '', name: '默认', note: '楷体' },
    { id: 'kai', name: '楷体', stack: STACK.kai },
    { id: 'xingkai', name: '行楷', stack: STACK.xingkai },
    { id: 'song', name: '宋体', stack: STACK.song },
    { id: 'hei', name: '黑体', stack: STACK.hei },
    { id: 'fangsong', name: '仿宋', stack: STACK.fangsong },
    { id: 'lishu', name: '隶书', stack: STACK.lishu },
  ],
  prose: [
    { id: '', name: '默认', note: '华文宋体' },
    { id: 'song', name: '宋体', stack: STACK.song },
    { id: 'kai', name: '楷体', stack: STACK.kai },
    { id: 'fangsong', name: '仿宋', stack: STACK.fangsong },
    { id: 'hei', name: '黑体', stack: STACK.hei },
    { id: 'xingkai', name: '行楷', stack: STACK.xingkai },
    { id: 'yuanti', name: '圆体', stack: STACK.yuanti },
  ],
};

export const FONT_DEFAULTS = { ui: '', title: '', prose: '' };

const CUSTOM_PREFIX = 'custom:';

// 自定义字体名会原样进 CSS 变量：分号/花括号会让整条声明失效，尖括号没意义。
// 清掉它们并截断长度 —— 这是防自己手抖，不是防攻击。
function sanitizeName(s) {
  return String(s == null ? '' : s).replace(/[;{}<>\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function isChoice(slotId, val) {
  if (val === '') return true;
  const list = FONT_CHOICES[slotId] || [];
  return list.some(c => c.id === val);
}

/* 存储里的一个槽是一段字符串：
 *   ''             → 默认（不动 CSS 变量）
 *   'kai'          → 内置候选
 *   'custom:xxx'   → 用户自己填的字体名 / 字体栈
 */

/* localStorage 用不了时（隐私模式 / 被禁用）的兜底：本次会话的改动先记在内存里，
   至少不会「刚选完就弹回默认」。刷新后自然丢失，符合"本来就存不了"的事实。 */
let memCache = null;

export function readFonts() {
  const out = { ...FONT_DEFAULTS };
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(FONT_KEY) || '{}'); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') raw = memCache;
  if (!raw || typeof raw !== 'object') return out;
  for (const slot of FONT_SLOTS) {
    const v = raw[slot.id];
    if (typeof v !== 'string') continue;
    if (v.startsWith(CUSTOM_PREFIX)) {
      const name = sanitizeName(v.slice(CUSTOM_PREFIX.length));
      if (name) out[slot.id] = CUSTOM_PREFIX + name;
    } else if (isChoice(slot.id, v)) {
      out[slot.id] = v;
    }
  }
  return out;
}

/* 把一个槽的取值翻成真正写进 CSS 的字体栈；空串 = 不写（用默认）。 */
export function stackOf(slotId, val) {
  if (!val) return '';
  if (val.startsWith(CUSTOM_PREFIX)) return sanitizeName(val.slice(CUSTOM_PREFIX.length));
  const c = (FONT_CHOICES[slotId] || []).find(x => x.id === val);
  return c && c.stack ? c.stack : '';
}

/* 用户当前填的自定义名（非自定义则空串），给输入框显示用。 */
export function customNameOf(val) {
  return typeof val === 'string' && val.startsWith(CUSTOM_PREFIX) ? val.slice(CUSTOM_PREFIX.length) : '';
}

/* 出厂字体栈：applyFonts 第一次被调用时（正是往 <html> 写内联变量**之前**）抓一份。
 * 只用来给设置页的「默认」按钮**显示字形** —— 不这么做的话，那个按钮会跟着当前选择
 * 一起变（界面改成宋体后，它自己也变成宋体的样子），看着像在骗人。
 *
 * 为什么不在代码里再抄一份默认值：那样改 guigu.css 就得记得同步改两处，迟早分叉。
 * 这里读的是样式表的实际取值，永远跟着走。
 */
let builtin = null;
function captureBuiltins() {
  const cs = getComputedStyle(document.documentElement);
  const inline = document.documentElement.style;
  const o = {};
  for (const slot of FONT_SLOTS) {
    const v = slot.cssVars[0];
    // 已经有内联覆盖 ⇒ 读到的不再是出厂值：宁可空着（按钮退回继承），也不给个假的
    o[slot.id] = inline.getPropertyValue(v) ? '' : cs.getPropertyValue(v).trim();
  }
  return o;
}
export function builtinStackOf(slotId) {
  if (!builtin) builtin = captureBuiltins();
  return builtin[slotId] || '';
}

/* 应用：写 <html> 内联变量 + 落 localStorage。返回规范化后的偏好对象。
 *
 * 入参是**补丁**（只给要改的槽），内部以 readFonts() 为底合并 —— 因为每次应用都会
 * 回写存储，readFonts() 拿到的永远是最新状态。这样连点几下候选也不会互相覆盖：
 * UI 里那几个事件闭包不保证看到最新的 React state，但存储是同步的。
 */
export function applyFonts(patch) {
  if (!builtin) builtin = captureBuiltins();   // 必须在写内联变量之前，否则抓到的是自己的覆盖值
  const src = readFonts();
  if (patch && typeof patch === 'object') {
    for (const slot of FONT_SLOTS) {
      if (typeof patch[slot.id] === 'string') src[slot.id] = patch[slot.id];
    }
  }
  const root = document.documentElement;
  const clean = {};
  for (const slot of FONT_SLOTS) {
    const val = typeof src[slot.id] === 'string' ? src[slot.id] : '';
    const stack = stackOf(slot.id, val);
    clean[slot.id] = stack ? val : '';   // 解析不出字体栈的取值一律当默认，不留脏数据
    for (const v of slot.cssVars) {
      if (stack) root.style.setProperty(v, stack);
      else root.style.removeProperty(v);
    }
  }
  memCache = clean;
  try { localStorage.setItem(FONT_KEY, JSON.stringify(clean)); } catch { /* 存不了就算了，本次会话仍然生效 */ }
  return clean;
}
