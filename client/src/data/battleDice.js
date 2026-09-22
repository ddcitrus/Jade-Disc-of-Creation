// ===== 战斗骰子（aDb）=====
// 技能伤害写成 aDb 的形式，b 只能在 4/6/8/10/12/20/100 里选，a 不限。
//
// 2026-09-18 晚改口径 —— **骰子不再决定威力，只决定这一击的运气**：
//   · 威力（倍率）由品阶直接定死，卡面上写的就是它（见 skillCodex.gradeMult）
//   · 骰子给一个「运气系数」＝ 掷值 ÷ 这副骰子的平均掷值（平均恒为 1.00）
//        实际倍率 = 品阶倍率 × 运气
//   · 为什么不拿骰值直接当倍率：骰子只能整颗整颗加减，一颗十面骰值 0.55 倍，
//     步子比品阶每档的涨幅还粗 ⇒ 相邻品阶会被四舍五入抹成同一个数
//     （改之前 1/2/3 品全落成 2d10，三品功法与一品功法打出来一模一样）。
//   · 骰子颗数随品阶变多（见 skillCodex.diceForGrade），所以「低品忽高忽低、
//     高品稳准狠」这条味道保留。
//
// 本模块是**叶子模块**：不 import 任何业务代码，服务端也可直接引。
export const DICE_FACES = [4, 6, 8, 10, 12, 20, 100];
export const DICE_MIN_COUNT = 1;
export const DICE_MAX_COUNT = 999;

const isPlainObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * 解析骰子文本 → { count, faces }；非法返回 null。
 * 接受：'3d6' / '3D6' / ' 3 d 6 ' / '1d100' / { count, faces } / { a, b }
 * 拒绝：面数不在 DICE_FACES、骰数越界、缺项。
 */
export function parseDice(input) {
  if (isPlainObj(input)) {
    const count = Number(input.count ?? input.a);
    const faces = Number(input.faces ?? input.b);
    return legalize(count, faces);
  }
  const t = String(input ?? '').trim().toLowerCase();
  if (!t) return null;
  const m = t.match(/^(\d{1,4})\s*d\s*(\d{1,4})$/);
  if (!m) return null;
  return legalize(Number(m[1]), Number(m[2]));
}

function legalize(count, faces) {
  if (!Number.isFinite(count) || !Number.isFinite(faces)) return null;
  const c = Math.round(count);
  const f = Math.round(faces);
  if (c < DICE_MIN_COUNT || c > DICE_MAX_COUNT) return null;
  if (!DICE_FACES.includes(f)) return null;
  return { count: c, faces: f };
}

/** 骰子 → 文本 '3d6'；非法返回 ''。 */
export function diceText(input) {
  const d = parseDice(input);
  return d ? `${d.count}d${d.faces}` : '';
}

/** 平均掷值（a(b+1)/2）—— 运气系数的分母，也是「这副骰子稳不稳」的基准。非法返回 0。 */
export function diceExpected(input) {
  const d = parseDice(input);
  return d ? d.count * (d.faces + 1) / 2 : 0;
}

// ---------- 随机数 ----------
/**
 * 可播种随机源（mulberry32）。战斗中所有随机都走它，
 * 好处是同一 seed 可复现同一局（排查问题 / 单测断言用）。
 */
export function makeRng(seed = 1) {
  let a = (Math.round(Number(seed) || 1) >>> 0) || 1;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 掷一次骰子 → 运气系数（唯一口径）。
 * @returns {{ rolled:number, rolls:number[], dice:object|null, expected:number, luck:number }}
 *   luck = 掷值 ÷ 平均掷值；平均恰好 1.00。非法骰子返回 luck = 1（当作没有运气可言）。
 */
export function rollLuck(input, rng = Math.random) {
  const d = parseDice(input);
  if (!d) return { rolled: 0, rolls: [], dice: null, expected: 0, luck: 1 };
  const rolls = [];
  let sum = 0;
  for (let i = 0; i < d.count; i++) {
    const r = 1 + Math.floor(rng() * d.faces);
    rolls.push(r);
    sum += r;
  }
  const expected = diceExpected(d);
  return { rolled: sum, rolls, dice: d, expected, luck: expected > 0 ? sum / expected : 1 };
}
