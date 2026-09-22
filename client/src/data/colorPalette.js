// ===== 正文着色词表（设置 → 正文规则与文风） =====
// 正文里的 <font color='#XXXXXX'> 由故事/世界书驱动，AI 可自由填色；本模块让用户限定可用颜色。
//
// 三处消费方：
//   1) StoryRenderer：strict 模式下丢弃词表外的颜色（该段回退默认字色），词表内的颜色归一化为规范值
//   2) promptSystem：把词表注入正文提示词，告诉 AI 只能用哪些颜色（否则 AI 照旧乱用）
//   3) SettingsPage：可视化编辑 + 实时预览
//
// 字段说明：
//   mode  'off' = 不限制（仅保留内置安全校验）；'strict' = 只允许 list 内的颜色
//   list  [{ name: 语义色名（AI 与用户都好认）, value: CSS 色值, desc: 用途提示（只进提示词） }]

export const DEFAULT_COLOR_PALETTE = {
  mode: 'off',
  list: [
    { name: '淡金', value: '#8F7426', desc: '灵石、法宝、机缘、道韵' },
    { name: '墨紫', value: '#6B4E9E', desc: '预兆、心境、神魂、秘术' },
    { name: '青碧', value: '#2E7D6B', desc: '灵气、木属、丹药、治愈' },
    { name: '丹朱', value: '#B4432B', desc: '血煞、危险、警示、杀机' },
    { name: '苍蓝', value: '#2F5D8C', desc: '水系、寒霜、符箓、冷静' },
    { name: '松绿', value: '#4A7A3A', desc: '草木、生机、灵植、驭兽' },
    { name: '赭褐', value: '#7A5A2E', desc: '土石、碑文、古朴、器物' },
    { name: '玄灰', value: '#5A5A66', desc: '未知、晦暗、旁白、回忆' },
  ],
};

// 归一化为标准形态（缺字段补默认、脏数据剔除）
export function normalizePalette(p) {
  if (!p || typeof p !== 'object') return structuredClone(DEFAULT_COLOR_PALETTE);
  const list = Array.isArray(p.list) ? p.list : [];
  return {
    mode: p.mode === 'strict' ? 'strict' : 'off',
    list: list
      .filter(e => e && typeof e === 'object' && String(e.value || '').trim())
      .map(e => ({
        name: String(e.name || '').trim(),
        value: String(e.value).trim(),
        desc: String(e.desc || '').trim(),
      })),
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
 * @returns {{ strict: boolean, size: number, resolve: (raw: string) => string, describe: () => string[] }}
 *   resolve 返回允许使用的颜色字符串；返回 '' 表示不着色
 */
export function makeColorResolver(palette) {
  const p = normalizePalette(palette);
  // 词表为空时限制不生效（否则 strict 会变成"禁止一切着色"，容易误伤）
  const strict = p.mode === 'strict' && p.list.length > 0;
  const byKey = new Map();
  const byName = new Map();
  for (const e of p.list) {
    const v = String(e.value || '').trim();
    if (!v) continue;
    const k = colorMatchKey(v);
    if (k && !byKey.has(k)) byKey.set(k, v);
    if (e.name && !byName.has(e.name)) byName.set(e.name, v);
  }
  return {
    strict,
    size: byKey.size,
    resolve(raw) {
      const s = String(raw || '').trim();
      if (!s) return '';
      // 1) 限制模式下先认「色名别名」（AI 写 <font color='淡金'> 也能命中；色名是用户自定义文本，不参与 CSS 注入判定）
      if (strict && byName.has(s)) return byName.get(s);
      // 2) 内置安全校验：挡住 CSS 注入（表达式、url()、var()、分号、括号等一律不通过）
      const basicOk = /^#[0-9a-f]{3,8}$/i.test(s)
        || /^(rgba?|hsla?)\(\s*[0-9.,%\s/deg]+\)$/i.test(s)
        || /^[a-z]{3,20}$/i.test(s);
      if (!basicOk) return '';
      // 3) 不限制模式：沿用原行为
      if (!strict) return s;
      // 4) 限制模式：词表匹配键 → 规范色值；未命中则丢弃
      const k = colorMatchKey(s);
      return k && byKey.has(k) ? byKey.get(k) : '';
    },
  };
}

/**
 * 生成注入正文提示词的着色词表区块。
 * 仅在 strict 且词表非空时返回文本，其它情况返回 ''（不污染提示词）。
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
