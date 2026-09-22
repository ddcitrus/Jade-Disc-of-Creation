// ===== 战斗地块（15×15 战场的地形表）=====
// 需求：战斗界面为 15×15 的地图，AI 根据实际场景生成各种地块；
//       **地块样式和效果由程序预先实现，AI 只负责选择**。
//
// 所以本模块是地块的唯一出处：AI 能写的只有「地块 id」，写成表外的名字一律退回「平地」。
// 每个地块的字段：
//   move      进入该格消耗的行动格（1 = 平地速度；耸峰不可通行）
//   passable  能否站上去
//   takenMul        站在上面**受到任何伤害**的倍率（草丛伏身、泥地陷足）
//   rangedTakenMul  站在上面受到**远程**（距离 ≥ 4）伤害的额外倍率，与 takenMul 叠乘（树林遮蔽）
//   magTakenMul     站在上面受到**法术**伤害的额外倍率，与 takenMul 叠乘（水洼湿身导电）
//   dealtMul        站在上面**造成任何伤害**的倍率（乱石借石势）
//   magicDealtMul   站在上面造成**法术**伤害的额外倍率，与 dealtMul 叠乘（阵纹增幅）
//   turn      { hpPct, mpPct } 回合结束时按上限占比结算（正数回复、负数流失）
//
// 2026-09-18：地形原带 dodge 加成，随「取消闪避」一并移除。
// 同日补齐：原来靠闪避吃饭的草地/泥地/草丛/乱石/水洼当时退化成纯通行消耗，
// 现各自补了与「通行代价」匹配的新效果 —— **十二种地形如今全部有效果**（平地是基准线）。
// 所有数值只作用于战斗过程，绝不写进角色快照。
//
// 注意：地块效果只作用于战斗过程，**绝不写进角色快照**（快照的 stats 语义是固有战力）。
//
// tone 字段（同日新增）：只给界面认「这格的表面该铺哪种贴图」，soil / grass / rock /
// water / rune 五档。它**不参与任何计算**，改它不会影响战斗，纯粹是为了让沙盘的土、草、
// 石头、水面看起来是不同材料；新增地块时忘了写会被界面兜底成 soil，不会报错。

export const MAP_SIZE = 27;   // 2026-09-20：边长由 15 扩大 1.8 倍至 27

const RAW = [
  { id: '平地', glyph: '·', color: '#e9e1cc', move: 1, passable: true, tone: 'soil', desc: '寻常地面，无加成（基准地形）' },
  { id: '草地', glyph: '🌿', color: '#dbe7c9', move: 1, passable: true, tone: 'grass', turn: { hpPct: 0.02 }, desc: '行走如常，草木生机：回合结束回复 2% 上限气血' },
  { id: '泥地', glyph: '≈', color: '#cbb894', move: 2, passable: true, tone: 'soil', takenMul: 1.05, desc: '移动消耗 2 格，脚下打滑受伤害 ×1.05' },
  { id: '沼泽', glyph: '≋', color: '#a8b489', move: 3, passable: true, tone: 'water', turn: { hpPct: -0.03 }, desc: '移动消耗 3 格，每回合流失 3% 上限气血' },
  { id: '毒沼', glyph: '☠', color: '#9aa86f', move: 3, passable: true, tone: 'water', turn: { hpPct: -0.05 }, desc: '移动消耗 3 格，每回合流失 5% 上限气血' },
  { id: '树林', glyph: '🌲', color: '#c3d6b0', move: 2, passable: true, tone: 'grass', rangedTakenMul: 0.85, desc: '移动消耗 2 格，受远程伤害 ×0.85' },
  { id: '草丛', glyph: '🌾', color: '#d8e0b8', move: 2, passable: true, tone: 'grass', takenMul: 0.90, desc: '移动消耗 2 格，伏身掩蔽受任何伤害 ×0.90' },
  { id: '乱石', glyph: '▲', color: '#d5cdbd', move: 2, passable: true, tone: 'rock', dealtMul: 1.05, desc: '移动消耗 2 格，借石势造成伤害 ×1.05' },
  { id: '水洼', glyph: '💧', color: '#c6dbe4', move: 2, passable: true, tone: 'water', magTakenMul: 1.10, turn: { mpPct: 0.02 }, desc: '移动消耗 2 格，湿身受法术伤害 ×1.10，回合结束回复 2% 上限法力' },
  { id: '灵脉', glyph: '✦', color: '#f2e6bd', move: 1, passable: true, tone: 'rune', turn: { hpPct: 0.04, mpPct: 0.04 }, desc: '回合结束回复 4% 上限气血与法力' },
  { id: '阵纹', glyph: '⛬', color: '#e3d6ea', move: 1, passable: true, tone: 'rune', magicDealtMul: 1.10, desc: '在此施法，法术伤害 ×1.10' },
  { id: '耸峰', glyph: '⛰', color: '#b9ab96', move: 0, passable: false, tone: 'rock', desc: '不可通行、阻挡远程射线' },
];

export const TERRAINS = RAW.map(t => ({
  takenMul: 1,
  rangedTakenMul: 1,
  magTakenMul: 1,
  dealtMul: 1,
  magicDealtMul: 1,
  tone: 'soil',
  turn: null,
  ...t,
}));

export const TERRAIN_MAP = new Map(TERRAINS.map(t => [t.id, t]));

export const TERRAIN_IDS = TERRAINS.map(t => t.id);
export const DEFAULT_TERRAIN_ID = '平地';

/** 地块 → 名称清单文本（注入提示词 / AI 选地块时的唯一可选值）。 */
export function terrainCatalogText() {
  return TERRAINS.map(t => `${t.id}（${t.desc}）`).join('；');
}

/** 地块 id 归一：表外名字 / 空值 / 错字一律退回平地，绝不阻断。 */
export function normalizeTerrainId(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return DEFAULT_TERRAIN_ID;
  if (TERRAIN_MAP.has(t)) return t;
  // 容错：「乱石堆」→「乱石」；全名包含其一即命中（最长者优先）
  const hit = TERRAINS
    .filter(x => x.id.length > 1 && (t.includes(x.id) || x.id.includes(t)))
    .sort((a, b) => b.id.length - a.id.length)[0];
  return hit ? hit.id : DEFAULT_TERRAIN_ID;
}

/** 地块对象（永不返回 undefined）。 */
export function terrainOf(id) {
  return TERRAIN_MAP.get(normalizeTerrainId(id)) || TERRAIN_MAP.get(DEFAULT_TERRAIN_ID);
}

// ---------- 地图配方 → 15×15 格 ----------
const clampInt = (v, lo, hi) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * 把 AI 给的地图配方烤成 15×15 的地块 id 矩阵。
 * 配方形态（宽松，任何一项不合法就忽略这一项，不阻断开局）：
 *   { base: '平地', patches: [ { t:'乱石', rect:[x1,y1,x2,y2] } | { t:'水洼', at:[[x,y],…] } ] }
 * @returns {string[][]} grid[y][x]
 */
export function bakeMap(recipe) {
  const base = normalizeTerrainId(recipe?.base);
  const grid = Array.from({ length: MAP_SIZE }, () => Array(MAP_SIZE).fill(base));
  const patches = Array.isArray(recipe?.patches) ? recipe.patches : [];
  for (const p of patches) {
    const t = normalizeTerrainId(p?.t ?? p?.terrain ?? p?.id);
    const rect = Array.isArray(p?.rect) ? p.rect : null;
    if (rect && rect.length === 4) {
      const x1 = clampInt(rect[0], 0, MAP_SIZE - 1);
      const y1 = clampInt(rect[1], 0, MAP_SIZE - 1);
      const x2 = clampInt(rect[2], 0, MAP_SIZE - 1);
      const y2 = clampInt(rect[3], 0, MAP_SIZE - 1);
      if (x1 == null || y1 == null || x2 == null || y2 == null) continue;
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) grid[y][x] = t;
      }
      continue;
    }
    const at = Array.isArray(p?.at) ? p.at : (Array.isArray(p?.cells) ? p.cells : null);
    if (at) {
      for (const c of at) {
        if (!Array.isArray(c) || c.length < 2) continue;
        const x = clampInt(c[0], 0, MAP_SIZE - 1);
        const y = clampInt(c[1], 0, MAP_SIZE - 1);
        if (x == null || y == null) continue;
        grid[y][x] = t;
      }
    }
  }
  return grid;
}

// ---------- 默认战场（AI 没给地图、且生成器也没走到的最后兜底）----------
// 2026-09-20 第二次重做：玩家反馈「为什么总在中间摆一排岩石」。
// 不再有中列山岩墙，改为各处错落、大小不一（3~7 格）的紧凑岩块，块间留足空隙、不连成墙。
// 左下草丛 / 右上树林两片掩体，灵脉 / 阵纹放在开阔处作争夺点。
// 出生区（左右各 3 列）保持平地，保证双方一定站得下、走得出去。
export function defaultBattleMap() {
  const grid = Array.from({ length: MAP_SIZE }, () => Array(MAP_SIZE).fill(DEFAULT_TERRAIN_ID));
  const mid = Math.floor(MAP_SIZE / 2);

  // 确定性伪随机（固定种子，兜底地图每次一致）
  function mulberry(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry(0x5eed);
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const shuffle = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const safe = 3;
  const inSafe = (x) => x < safe || x >= MAP_SIZE - safe;
  // 一块紧凑不规则岩块（随机前沿生长）
  const blob = (sx, sy, maxCells) => {
    const cells = []; let placed = 0;
    const tryPut = (x, y) => {
      if (inSafe(x) || x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return false;
      if (grid[y][x] !== DEFAULT_TERRAIN_ID) return false;
      grid[y][x] = '耸峰'; cells.push([x, y]); placed++; return true;
    };
    if (!tryPut(sx, sy)) return 0;
    let guard = 0;
    while (placed < maxCells && guard++ < 80) {
      const b = cells[Math.floor(rng() * cells.length)];
      let grew = false;
      for (const [dx, dy] of shuffle(DIRS.slice())) { if (tryPut(b[0] + dx, b[1] + dy)) { grew = true; break; } }
      if (!grew) {
        let any = false;
        outer: for (const c of shuffle(cells.slice())) {
          for (const [dx, dy] of shuffle(DIRS.slice())) { if (tryPut(c[0] + dx, c[1] + dy)) { any = true; break outer; } }
        }
        if (!any) break;
      }
    }
    return placed;
  };
  // 各处错落布岩块（块间最小切比雪夫距离 3，不连成墙、不做中切），目标 47（保证 ≥ 配额 45）
  let count = 0, bguard = 0;
  const seeds = [];
  const tooClose = (x, y) => seeds.some(s => Math.max(Math.abs(s[0] - x), Math.abs(s[1] - y)) < 3);
  while (count < 47 && bguard++ < 400) {
    const cx = safe + 1 + Math.floor(rng() * (MAP_SIZE - 2 * safe - 2));
    const cy = 2 + Math.floor(rng() * (MAP_SIZE - 4));
    if (tooClose(cx, cy)) continue;
    const got = blob(cx, cy, 3 + Math.floor(rng() * 5));   // 3..7 格
    if (got > 0) { seeds.push([cx, cy]); count += got; }
  }
  // 左下草丛 / 右上树林两片掩体（大地图略放大）
  for (let y = Math.round(MAP_SIZE * 0.55); y <= Math.round(MAP_SIZE * 0.72); y++)
    for (let x = 1; x <= 3; x++) grid[y][x] = '草丛';
  for (let y = Math.round(MAP_SIZE * 0.18); y <= Math.round(MAP_SIZE * 0.36); y++)
    for (let x = MAP_SIZE - 5; x <= MAP_SIZE - 2; x++) grid[y][x] = '树林';
  // 开阔处各放一处灵脉、阵纹作为争夺点；另布两处水洼
  grid[Math.round(MAP_SIZE * 0.4)][mid - 2] = '灵脉';
  grid[Math.round(MAP_SIZE * 0.6)][mid + 2] = '阵纹';
  grid[Math.round(MAP_SIZE * 0.2)][Math.round(MAP_SIZE * 0.7)] = '水洼';
  grid[Math.round(MAP_SIZE * 0.75)][Math.round(MAP_SIZE * 0.25)] = '水洼';
  return grid;
}

/**
 * 出生点：把参战双方放到左右两侧的空地上（不可通行格自动跳过）。
 * 排布规则：左队从第 1 列往外排、右队从倒数第 2 列往外排；同一列内按「离中线近」优先，
 * 保证双方面对面。已有单位占用的格子不会重复分配。
 * @returns {{ [unitId]: {x,y} }}
 */
export function spawnPositions(grid, leftIds = [], rightIds = []) {
  const mid = Math.floor(MAP_SIZE / 2);
  const taken = new Set();
  const key = (x, y) => `${x},${y}`;

  // 一侧的候选格：按「列优先（离己方边远近）→ 行（离中线近）」排序
  const lanes = (fromCol, dir) => {
    const cols = [];
    for (let c = fromCol; c >= 0 && c < MAP_SIZE; c += dir) cols.push(c);
    const rows = [];
    for (let d = 0; d < MAP_SIZE; d++) {
      if (mid - d >= 0) rows.push(mid - d);
      if (d && mid + d < MAP_SIZE) rows.push(mid + d);
    }
    const out = [];
    for (const c of cols) for (const y of rows) out.push({ x: c, y });
    return out;
  };

  const place = (ids, fromCol, dir) => {
    const out = {};
    const cand = lanes(fromCol, dir);
    for (const id of ids) {
      const hit = cand.find(p => !taken.has(key(p.x, p.y)) && terrainOf(grid[p.y][p.x]).passable);
      if (hit) { taken.add(key(hit.x, hit.y)); out[id] = hit; }
    }
    return out;
  };

  const left = place(leftIds, 1, -1);
  const right = place(rightIds, MAP_SIZE - 2, 1);
  const result = { ...left, ...right };
  // 极端兜底：任何还没落位的单位，扔到任意空格
  for (const id of [...leftIds, ...rightIds]) {
    if (result[id]) continue;
    outer: for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        if (terrainOf(grid[y][x]).passable && !taken.has(key(x, y))) {
          taken.add(key(x, y));
          result[id] = { x, y };
          break outer;
        }
      }
    }
  }
  return result;
}
