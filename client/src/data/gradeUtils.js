// ===== 品阶与属性文本工具（被 snapshotSchema 与 snapshotV2 共用，自身不依赖任何模块）=====
// 品阶统一为 1~36 品（老数据里的「下品/上品」按 LEGACY_GRADE_MAP 换算）
// 属性文本统一为「物攻+9000，法防+100」

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function gradeToText(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v) || v < 1 || v > 36) return '';
  if (v < 10) return CN_DIGITS[v] + '品';
  if (v === 10) return '十品';
  if (v < 20) return '十' + CN_DIGITS[v % 10] + '品';
  return CN_DIGITS[Math.floor(v / 10)] + '十' + (v % 10 ? CN_DIGITS[v % 10] : '') + '品';
}

function cnToNum(s) {
  const t = String(s || '');
  if (!t) return NaN;
  const idx = t.indexOf('十');
  if (idx < 0) {
    const i = CN_DIGITS.indexOf(t);
    return i > 0 ? i : NaN;
  }
  const head = t.slice(0, idx);
  const tail = t.slice(idx + 1);
  const h = head ? CN_DIGITS.indexOf(head) : 1;
  const tl = tail ? CN_DIGITS.indexOf(tail) : 0;
  if (h < 0 || tl < 0) return NaN;
  return h * 10 + tl;
}

// 老品阶词 → 1~36 品的换算（六档均匀铺开，便于日后调整）
export const LEGACY_GRADE_MAP = {
  凡品: 1, 下品: 1, 中品: 7, 上品: 13, 极品: 19, 灵品: 25, 仙品: 31,
};

export function parseGrade(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const digits = t.match(/\d+/);
  if (digits) {
    const n = Number(digits[0]);
    return n >= 1 && n <= 36 ? n : null;
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_GRADE_MAP, t)) return LEGACY_GRADE_MAP[t];
  const m = t.match(/^([一二三四五六七八九十]+)品?$/);
  if (m) {
    const n = cnToNum(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 36) return n;
  }
  return null;
}

// 规范成 v2 文本（「三品」）；非法返回 ''
export function normalizeGrade(text) {
  const n = parseGrade(text);
  return n == null ? '' : gradeToText(n);
}

// 严格解析：只认 1~36 的阿拉伯数字或中文数字品阶，**不认「下品/上品/极品」这类老词**。
// 用于校验 AI 新写的语句与新增角色——逼它写 1~36 品，老词的换算只在读旧数据时发生。
export function parseGradeStrict(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  let m = t.match(/^(\d+)\s*品?$/);
  if (m) {
    const n = Number(m[1]);
    return n >= 1 && n <= 36 ? n : null;
  }
  m = t.match(/^([一二三四五六七八九十]+)品$/);
  if (m) {
    const n = cnToNum(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 36) return n;
  }
  return null;
}

// 『物攻+9000，法防+100』→ { 物攻:9000, 法防:100 }（兼容 物攻=9000 / 物攻:100 / 物攻-20）
export function parseAttrText(text) {
  const out = {};
  if (!text) return out;
  for (const seg of String(text).split(/[,，;；、\n]+/)) {
    const s = seg.trim();
    if (!s) continue;
    let m = s.match(/^(.+?)\s*([+\-＋－])\s*(\d+(?:\.\d+)?)\s*$/);
    if (!m) m = s.match(/^(.+?)\s*[=＝:：]\s*([+\-＋－]?)(\d+(?:\.\d+)?)\s*$/);
    if (!m) continue;
    const k = m[1].trim();
    const sign = (m[2] === '-' || m[2] === '－') ? -1 : 1;
    const n = Number(m[3]);
    if (!k || !Number.isFinite(n)) continue;
    out[k] = (out[k] || 0) + sign * n;
  }
  return out;
}

export function attrTextFromMods(mods) {
  if (!mods || typeof mods !== 'object') return '';
  return Object.entries(mods)
    .filter(([, v]) => Number.isFinite(Number(v)) && Number(v) !== 0)
    .map(([k, v]) => `${k}${Number(v) > 0 ? '+' : '-'}${Math.abs(Number(v))}`)
    .join('，');
}

// 1~36 品的候选清单（界面的 datalist 用）
export const GRADE_CANDIDATES = Array.from({ length: 36 }, (_, i) => gradeToText(i + 1));
