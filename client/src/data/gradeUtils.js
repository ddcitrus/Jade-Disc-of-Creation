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

// 品阶文本里可能被人为缀上境界注记（「二十品（大乘初期）」，见 gradeWithRealm）。
// AI 是照抄它看到的那一行的，所以读档与解析都要先剥掉这层注记再认品阶。
// 非字符串（坏数据里品阶位上躺着一整个对象）返回 ''，不让它变成 "[object Object]" 混进解析。
function stripGradeNote(text) {
  if (text == null || typeof text === 'object') return '';
  return String(text).replace(/[（(][^）)]*[）)]/g, '').trim();
}

export function parseGrade(text) {
  const t = stripGradeNote(text);
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
  // 同样先剥境界注记：AI 若把「二十品（大乘初期）」整段抄进登记行，不该因为这层注记被打回。
  const t = stripGradeNote(text);
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

// ---------- 品阶 → 修士境界（程序自动对照） ----------
// 与演化预设 sharedRules 的「品阶与寿元语义对应表」同源，**只取「修士境界」一列**：
// 不带寿元（正文境界基准表里已逐境界写着寿元，凡人 80，两份同屏会打架），
// 不带妖兽等级（那是妖兽口径，物品用不上）。
// 这里是品阶与境界对应关系的**唯一出处**：提示词那段对照表、物品品阶后缀、界面展示都从它长出来。
export const GRADE_REALM_MAP = {
  1: '炼气全期',
  2: '筑基初期', 3: '筑基中期', 4: '筑基后期',
  5: '结丹初期', 6: '结丹中期', 7: '结丹后期',
  8: '元婴初期', 9: '元婴中期', 10: '元婴后期',
  11: '化神初期', 12: '化神中期', 13: '化神后期',
  14: '炼虚初期', 15: '炼虚中期', 16: '炼虚后期',
  17: '合体初期', 18: '合体中期', 19: '合体后期',
  20: '大乘初期', 21: '大乘中期', 22: '大乘后期',
  23: '渡劫',
  24: '真仙下位', 25: '真仙中位', 26: '真仙上位',
  27: '金仙下位', 28: '金仙中位', 29: '金仙上位',
  30: '太乙下位', 31: '太乙中位', 32: '太乙上位',
  33: '大罗下位', 34: '大罗中位', 35: '大罗上位',
  36: '道祖',
};

// 品阶 → 该品阶对应的修士境界（认 1~36 数字，也认「二十品」这类文本）。
// 认不出（空 / 「残次品」这类自由描述 / 坏对象）返回 ''。
export function gradeRealmText(grade) {
  const n = parseGrade(grade);
  if (n == null || n < 1 || n > 36) return '';
  return GRADE_REALM_MAP[n] || '';
}

// 展示与注入用：品阶文本后挂上程序算出的境界 —— 「二十品（大乘初期）」。
// ⚠ 这只是给人与 AI 看的注记，**不写进存档**：物品的 grade 字段始终保持「二十品」。
//   把注记落盘会让逐档换色、篆字印、品阶解析跟着一起坏（它们读的是裸品阶）。
// 认不出品阶时原样返回（「残次品」这种自由描述不要被吃掉）。
export function gradeWithRealm(grade) {
  if (grade == null || typeof grade === 'object') return '';
  const raw = String(grade).trim();
  if (!raw) return '';
  const n = parseGrade(raw);
  if (n == null) return raw;
  return `${gradeToText(n)}（${GRADE_REALM_MAP[n]}）`;
}

// 1~36 品的候选清单（界面的 datalist 用）
export const GRADE_CANDIDATES = Array.from({ length: 36 }, (_, i) => gradeToText(i + 1));
