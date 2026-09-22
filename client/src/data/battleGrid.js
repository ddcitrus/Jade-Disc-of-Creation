// ===== 战斗网格（15×15 寻路与距离）=====
// 需求：「程序计算生成地块中战斗双方的可达性（要用最快的算法）」。
//
// 为什么选 Dijkstra 而不是 A*：
//   15×15 = 225 格，格子极小；A* 只求「到某一个点」的一条路，
//   而战棋每一回合要的是**预算内的整片可达区域**（玩家要看到所有能站的格）。
//   带权（平地 1 / 泥地 2 / 沼泽 3）的最短路，一次 Dijkstra + 二叉堆
//   就同时给出「所有可达格 + 到每一格的代价 + 回溯路径」，复杂度 O(V log V) ≈ 1 毫秒。
//
// 移动规则：8 方向；直行消耗 = 目标格地形消耗；斜行消耗 = ceil(地形消耗 × 1.4)。不可通行格跳过。
// 距离规则：**切比雪夫距离**（8 方向对称），攻击距离判定与站位评分共用同一把尺子。

import { MAP_SIZE, terrainOf } from './battleTerrain.js';

export const DIRS8 = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

export const inBounds = (x, y) => x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE;
export const cellKey = (x, y) => `${x},${y}`;
export const parseCellKey = (k) => {
  const [x, y] = String(k).split(',').map(Number);
  return { x, y };
};

/** 切比雪夫距离（8 方向棋盘距离）。 */
export function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** 从 (x,y) 出发到 (nx,ny) 的移动消耗；不可达返回 Infinity。 */
export function stepCost(grid, x, y, nx, ny) {
  if (!inBounds(nx, ny)) return Infinity;
  const t = terrainOf(grid[ny][nx]);
  if (!t.passable) return Infinity;
  const diag = nx !== x && ny !== y;
  return diag ? Math.ceil(t.move * 1.4) : t.move;
}

// ---------- 二叉最小堆（Dijkstra 用；不引第三方库） ----------
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node, pri) {
    const a = this.a;
    a.push({ node, pri });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].pri <= a[i].pri) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].pri < a[m].pri) m = l;
        if (r < a.length && a[r].pri < a[m].pri) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * 预算内的可达区域（Dijkstra）。
 * @param {string[][]} grid 15×15 地块 id
 * @param {{x:number,y:number}} from 起点
 * @param {number} budget 行动格预算
 * @param {Set<string>|Iterable<string>} [occupied] 被其它单位占住的格（不可停留、不可穿越）
 * @returns {{ dist: Map<string, number>, prev: Map<string, string|null>, cells: {x,y,cost}[] }}
 *          dist 含起点（cost 0）；cells 按代价升序，已剔除起点。
 */
export function reachable(grid, from, budget, occupied = []) {
  const block = new Set(occupied);
  const startKey = cellKey(from.x, from.y);
  block.delete(startKey); // 自己站的地方不算阻挡
  const dist = new Map([[startKey, 0]]);
  const prev = new Map([[startKey, null]]);
  const heap = new MinHeap();
  heap.push(startKey, 0);
  const cap = Math.max(0, Number(budget) || 0);

  while (heap.size) {
    const top = heap.pop();
    if (!top) break;
    const { x, y } = parseCellKey(top.node);
    // 惰性删除：堆里可能有旧的更大代价，跳过
    if (top.pri > (dist.get(top.node) ?? Infinity)) continue;
    for (const [dx, dy] of DIRS8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const nk = cellKey(nx, ny);
      if (block.has(nk)) continue;
      const c = stepCost(grid, x, y, nx, ny);
      if (!Number.isFinite(c)) continue;
      const nd = top.pri + c;
      if (nd > cap) continue;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, top.node);
        heap.push(nk, nd);
      }
    }
  }

  const cells = [...dist.entries()]
    .filter(([k]) => k !== startKey)
    .map(([k, cost]) => ({ ...parseCellKey(k), cost }))
    .sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x);
  return { dist, prev, cells };
}

/**
 * 「到最近源点的最少步数」场（多源 BFS，8 方向，被不可通行地块挡住）。
 *
 * 为什么需要它：切比雪夫距离是**直线**距离，看不见墙。
 *   实测踩过的坑：ai.probe 里给了一张「中间一道乱石墙」的地图，敌人走到墙边后
 *   所有可达格的直线距离完全一样，梯度消失 → 它就贴着墙反复防御，直到 50 回合僵持。
 *   换成真正的步数之后，绕行路径上每一格都比原地更近，敌人才会自己绕过去。
 *
 * 用途仅限**走位引导**（AI 评估"站哪更靠近对手"）。
 *   攻击距离判定仍然是切比雪夫距离（那是战斗规则，不是寻路）。
 * @param {string[][]} grid
 * @param {{x:number,y:number}[]} sources 源点（通常是全部敌人所在格）
 * @returns {Map<string, number>} 格 → 最少步数（源点为 0；不可达不出现）
 */
export function stepField(grid, sources) {
  const dist = new Map();
  const queue = [];
  for (const s of (Array.isArray(sources) ? sources : [])) {
    if (!s || !inBounds(s.x, s.y) || !terrainOf(grid[s.y][s.x]).passable) continue;
    const k = cellKey(s.x, s.y);
    if (dist.has(k)) continue;
    dist.set(k, 0);
    queue.push(s);
  }
  for (let head = 0; head < queue.length; head++) {
    const { x, y } = queue[head];
    const d = dist.get(cellKey(x, y));
    for (const [dx, dy] of DIRS8) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const nk = cellKey(nx, ny);
      if (dist.has(nk)) continue;
      if (!terrainOf(grid[ny][nx]).passable) continue;
      dist.set(nk, d + 1);
      queue.push({ x: nx, y: ny });
    }
  }
  return dist;
}

/**
 * 从 reachable 的结果里回溯到某格的完整路径（含终点，不含起点）。
 * 不可达返回 null。
 */
export function pathTo(reach, target) {
  const tk = cellKey(target.x, target.y);
  if (!reach.dist.has(tk)) return null;
  const out = [];
  let cur = tk;
  while (cur) {
    const p = reach.prev.get(cur);
    if (p == null) break;
    out.push(parseCellKey(cur));
    cur = p;
  }
  return out.reverse();
}


// ---------- 视线（远程攻击是否被耸峰挡住） ----------
// 用 supercover 直线：把两点连线经过的每一格都取出来（含对角贴角）。
// 只被「不可通行」的地块（耸峰）阻挡 —— 树林只是遮蔽（减伤），不挡视线。
function supercover(a, b) {
  const pts = [];
  let x = a.x;
  let y = a.y;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const nx = Math.abs(dx);
  const ny = Math.abs(dy);
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  let ix = 0;
  let iy = 0;
  pts.push({ x, y });
  while (ix < nx || iy < ny) {
    const e = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (e === 0) { x += sx; y += sy; ix++; iy++; }
    else if (e < 0) { x += sx; ix++; }
    else { y += sy; iy++; }
    pts.push({ x, y });
  }
  return pts;
}

/** 两点之间是否通视（被耸峰挡住则 false）。端点自身不计。 */
export function hasLineOfSight(grid, a, b) {
  const line = supercover(a, b);
  for (let i = 1; i < line.length - 1; i++) {
    const p = line[i];
    if (!inBounds(p.x, p.y)) return false;
    if (!terrainOf(grid[p.y][p.x]).passable) return false;
  }
  return true;
}

// ---------- 走位：侧击 / 背击 ----------
/**
 * 方位扇区边界（度，以受击方「朝向」为 0° 基准）：
 *   夹角 ≤ 45°           → 正面
 *   45° < 夹角 < 135°    → 侧面（左右各 90°）
 *   夹角 ≥ 135°          → 背面（正后方 90° 的一个扇形，正好是整圈的 1/4）
 * 换成点积就是 cos ≥ +cos45° / ≤ −cos45°（≈ ±0.7071）。
 *
 * 界面把它画成脚下的圆：**背后那 1/4 涂红**。画面与判定共用这两个常量，
 * 以后谁要改扇区，改这里一处 —— 判定和红弧绝不会各说各话。
 */
export const FACING_SECTOR_DEG = 45;
// ⚠️ 必须带一点容差：45° 斜角的 cos 由整数格算出来是 1/√2 = 0.7071067811865475，
// 而 Math.cos(45°) 是 0.7071067811865476 —— 差一个 ulp。直接用后者当阈值，
// 「正斜前」会被判成侧面、「正斜后」会被判成侧面，扇区边界整条错位。
const ANGLE_EPS = 1e-9;
const COS45 = Math.cos(FACING_SECTOR_DEG * Math.PI / 180);
export const ANGLE_FRONT_COS = COS45 - ANGLE_EPS;
export const ANGLE_BACK_COS = -COS45 + ANGLE_EPS;

/**
 * 以受击方「朝向」为基准判断攻方站在哪个方位。
 *   朝向 = 该单位上一次移动的主方向（没移动过时由引擎兜底为「面朝敌方半场」）。
 *   做法：取「受击方 → 攻方」的向量 v，与朝向向量 f 求点积。
 *     cos ≥ +0.7071 → 攻方在正前方 90° 扇区内 → 'front'
 *     cos ≤ −0.7071 → 攻方在正后方 90° 扇区内 → 'back'
 *     其余          → 攻方在左右两侧           → 'side'
 * 注：格子坐标是整数、朝向也是八方向（分量只取 −1/0/1），所以 cos 只会取到
 * 0、±0.7071、±1 这五种值，扇区边界永远落在「斜前」与「斜后」这两个格子上，
 * 不会出现「看着在侧面却被判背击」的错位。
 * @returns {'front'|'side'|'back'}
 */
export function hitAngle(attacker, defender, facing) {
  const f = facing || { x: 1, y: 0 };
  const vx = attacker.x - defender.x;
  const vy = attacker.y - defender.y;
  if (!vx && !vy) return 'front';
  const dot = vx * f.x + vy * f.y;
  const len = Math.hypot(vx, vy) * Math.hypot(f.x, f.y) || 1;
  const cos = dot / len;
  if (cos >= ANGLE_FRONT_COS) return 'front';
  if (cos <= ANGLE_BACK_COS) return 'back';
  return 'side';
}

/** 移动前后 → 朝向（8 方向归一；没动返回 null）。 */
export function facingFromMove(from, to) {
  const dx = Math.sign(to.x - from.x);
  const dy = Math.sign(to.y - from.y);
  if (!dx && !dy) return null;
  return { x: dx, y: dy };
}

