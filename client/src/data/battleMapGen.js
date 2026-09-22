// ===== 战场生成器：把 AI 给的地图配方补成一块「能打的战场」 =====
//
// 为什么要有这个模块（2026-09-18 玩家原话）：
//   「AI 生成地图的时候应该多考虑生成障碍物，不然平地互殴没意思」。
// 两个病根：
//   ① 提示词里的示例只写了「平地 + 乱石 + 水洼」——**其中没有一个不可通行的地块**。
//      AI 照抄示例，于是十有八九交出一片空场，两边站着对轰，走位、地形、绕后全成了摆设。
//   ② 整张地图完全指望 AI 自觉。AI 忘了写 map 就退回 defaultBattleMap，而那道隔断用的是
//      「乱石」——乱石是**可以走上去**的，只是慢一点；全项目真正不能过的只有「耸峰」。
//
// 本模块干两件事：
//   ① 把 AI 的配方**补齐**：有隔断（耸峰）、有掩体（草丛/树林等）、有争夺点（灵脉/阵纹）、
//      而且从左一定走得到右；
//   ② 给这局战场一句**人话说明**，写进请求的场景备注 —— 否则 AI 写正文时不知道地图上
//      横着一道山，写出「旷野上两人对轰」就与画面穿帮了。
//
// 三条规矩：
//   · **不推翻 AI**：AI 明确布置过的格子（与底色不同的格）一律不动 —— 它说这里是水洼就保持水洼。
//     程序只在「还是底色」的空位上添东西。AI 因此永远有用，程序只负责兜底。
//   · **不封死**：补完真跑一遍连通性（8 方向、按可通行判定），走不通就拆最靠中线的那块石头开门。
//     这是项目铁律③「开局永不卡死」在地图这一层的版本 —— 封死的地图＝双方永远碰不上＝
//     战斗耗到回合上限判平局，玩家看到的是「两边互相顶了 50 回合」。
//   · **可复现**：随机全走内部播种的伪随机（同 seed 同一张图），排查问题与写断言都靠得住。
//
// 注意：本模块**只在 AI 指令那条路上调用**（battleTrigger.normalizeMapRecipe）。
// createBattle 保持「给什么用什么」的纯粹语义 —— 引擎单测传空地图就是要测空地图。

import { MAP_SIZE, bakeMap, terrainOf, normalizeTerrainId, DEFAULT_TERRAIN_ID } from './battleTerrain.js';
import { DIRS8 } from './battleGrid.js';

/**
 * 战场的硬性配额。
 * 这些数是「下限/上限」，不是目标值 —— AI 布置得比下限好，程序一格都不动。
 *   minBlocked 14：225 格里至少 14 格是过不去的（约 6%），够立一道隔断带 + 两处石堆；
 *                  再少就构不成「绕还是直冲」的选择，所以看到的是空场。
 *   maxBlocked 52：最多 23%。再多地图就变成迷宫，双方光找路就得磨一整局。
 *   minFeature 20：带效果的地形（草丛/树林/乱石/水洼/沼泽/灵脉…）至少 20 格，约 9%，
 *                  保证场上有「站哪儿好」的取舍；这些格是**走得上去**的，不影响通行。
 *   safeCols    3：左右各 3 列是出生区，**不许立石头**，否则开局就有人被卡在家里。
 */
// 配额按「相对 15×15 的面积倍数」缩放，地图变大变小都保持同样的疏密比例。
const AREA_K = (MAP_SIZE * MAP_SIZE) / 225;
export const FIELD_QUOTA = {
  minBlocked: Math.round(14 * AREA_K),
  maxBlocked: Math.round(52 * AREA_K),
  minFeature: Math.round(20 * AREA_K),
  safeCols: 3,
};

// ---------- 确定性伪随机（mulberry32）----------
function mulberry32(a) {
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位种子（没给 seed 时用配方本身派生，保证同一份配方每次补出同一张图）。 */
function hashSeed(str) {
  let h = 2166136261;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const key = (x, y) => `${x},${y}`;
const inBounds = (x, y) => x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE;

/** 这块地形有没有「站上去不一样」的效果（纯展示字段不算）。 */
function isFeature(t) {
  return !!(t?.turn
    || Number(t?.takenMul) !== 1
    || Number(t?.rangedTakenMul) !== 1
    || Number(t?.magTakenMul) !== 1
    || Number(t?.dealtMul) !== 1
    || Number(t?.magicDealtMul) !== 1);
}

/**
 * 战场体检：数一数空场到底有多空。
 * @param {string[][]} grid
 * @param {string} [base] 底色地块。**与底色相同的格一律不算「布置」**——
 *   若底色本身带效果（比如整片草地都回血），那只是舞台背景，不该记成「AI 布置了 225 格地形」。
 */
export function battlefieldStats(grid, base = null) {
  let blocked = 0, feature = 0, open = 0;
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const id = grid[y][x];
      if (base && id === base) { open++; continue; }
      const t = terrainOf(id);
      if (!t.passable) { blocked++; continue; }
      open++;
      if (isFeature(t)) feature++;
    }
  }
  return { blocked, feature, open, total: MAP_SIZE * MAP_SIZE };
}

/** 8 方向连通域（只问走不走得到，不管代价）。 */
function floodFrom(grid, start) {
  const seen = new Set([key(start.x, start.y)]);
  const q = [start];
  while (q.length) {
    const c = q.shift();
    for (const [dx, dy] of DIRS8) {
      const nx = c.x + dx, ny = c.y + dy;
      if (!inBounds(nx, ny)) continue;
      const k = key(nx, ny);
      if (seen.has(k)) continue;
      if (!terrainOf(grid[ny][nx]).passable) continue;
      seen.add(k);
      q.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/** 在某段列区间里找第一个可通行格（出生点探针用）。行从中间往上下散开，与出生点的排布口径一致。 */
function firstWalkable(grid, fromX, toX) {
  const mid = Math.floor(MAP_SIZE / 2);
  const rows = [];
  for (let d = 0; d < MAP_SIZE; d++) {
    if (mid + d < MAP_SIZE) rows.push(mid + d);
    if (d && mid - d >= 0) rows.push(mid - d);
  }
  for (const y of rows) {
    for (let x = fromX; x <= toX; x++) if (terrainOf(grid[y][x]).passable) return { x, y };
  }
  return null;
}

/**
 * 生成／补齐一块战场。
 * @param {{base?:string, patches?:object[]}} recipe AI 的地图配方（可缺省）
 * @param {{seed?:number}} [opts]
 * @returns {{base:string, patches:object[], notes:string[], added:number, opened:number}}
 *          patches = AI 原有的补丁 + 程序补的补丁（永远追加在后面，不改写 AI 的）
 */
export function generateBattlefield(recipe, opts = {}) {
  const safeCols = FIELD_QUOTA.safeCols;
  const inSafe = (x) => x < safeCols || x >= MAP_SIZE - safeCols;

  // 底色自己不可通行（AI 把整张战场底料写成耸峰）→ 退回平地，否则没人站得住
  const baseRaw = normalizeTerrainId(recipe?.base);
  const base = terrainOf(baseRaw).passable ? baseRaw : DEFAULT_TERRAIN_ID;

  const aiPatches = Array.isArray(recipe?.patches) ? recipe.patches : [];
  const grid = bakeMap({ base, patches: aiPatches });
  // 留一份「AI 原样」的底稿。最后收工时，一切改动（包括拆掉 AI 立的山、清平出生区）
  // 都靠这张底稿与最终图的差异汇总成补丁回传 —— 否则本次修改只活在内存的 grid 里，
  // 调用方拿 bakeMap(patches) 一烤就全变回去了（这个坑在探针 §4/§5 里被逮住过）。
  const aiGrid = grid.map(row => row.slice());

  const rng = mulberry32(Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : hashSeed(JSON.stringify({ base, aiPatches })));
  const added = [];          // [x, y, 地块id]
  const notes = [];
  const isBlank = (x, y) => grid[y][x] === base;   // 仍是底色 = 程序可以动

  /** 往「还是底色」的空位上放一块地。占了 AI 的格 / 出生区放石头 → 直接拒绝。 */
  const put = (x, y, t) => {
    if (!inBounds(x, y) || !isBlank(x, y)) return false;
    if (t === '耸峰' && inSafe(x)) return false;
    grid[y][x] = t;
    added.push([x, y, t]);
    return true;
  };

  // ---------- ① 出生区清障 + 底色兜底 ----------
  // 就算 AI 在 x=0..2 立了山，也拆掉 —— 出生区不可通行会让 spawnPositions 把人甩到别处，
  // 甚至两人挤在同一侧，读起来就是「莫名其妙站一块了」。
  let cleared = 0;
  for (let y = 0; y < MAP_SIZE; y++) {
    for (const x of [...Array(safeCols).keys(), ...Array(safeCols).keys()].map((_, i) => i < safeCols ? i : MAP_SIZE - safeCols + (i - safeCols))) {
      if (!terrainOf(grid[y][x]).passable) { grid[y][x] = base; cleared++; }
    }
  }

  // ---------- ② 补障碍：各处错落的不规则岩块（不再有中列墙） ----------
  let s = battlefieldStats(grid, base);
  const barrier = { main: null, gaps: [], count: 0 };
  if (s.blocked < FIELD_QUOTA.minBlocked) {
    Object.assign(barrier, addBarrier(grid, base, rng, put));
    if (barrier.count) notes.push(`各处错落布置了 ${barrier.count} 格天然岩块（不再有中列山岩墙）`);
  }

  // ---------- ③ 补战术地形：中路争夺点 + 两翼掩体 ----------
  s = battlefieldStats(grid, base);
  if (s.feature < FIELD_QUOTA.minFeature) {
    const f = addFeatures(grid, base, rng, put, barrier.main, FIELD_QUOTA.minFeature - s.feature);
    for (const n of f.notes) notes.push(n);
  }

  // ---------- ④ 障碍超量则削（AI 铺成迷宫的情形）----------
  s = battlefieldStats(grid, base);
  if (s.blocked > FIELD_QUOTA.maxBlocked) {
    const rocks = [];
    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        if (grid[y][x] !== base && !terrainOf(grid[y][x]).passable) rocks.push({ x, y });
      }
    }
    // 从靠外的先拆：中线那圈留着（那是「绕还是冲」的关键），先清边角
    rocks.sort((a, b) => {
      const cm = (MAP_SIZE - 1) / 2;
      return (Math.abs(b.x - cm) + Math.abs(b.y - cm)) - (Math.abs(a.x - cm) + Math.abs(a.y - cm));
    });
    let drop = s.blocked - FIELD_QUOTA.maxBlocked;
    for (const r of rocks) {
      if (drop <= 0) break;
      grid[r.y][r.x] = base;
      const i = added.findIndex(a => a[0] === r.x && a[1] === r.y);
      if (i >= 0) added.splice(i, 1);
      drop--;
    }
    if (drop < s.blocked - FIELD_QUOTA.maxBlocked) notes.push('原有的山岩太密，已削去一部分，免得双方光找路就磨一整局');
  }

  // ---------- ⑤ 必须走得通：不通就拆最靠中线的石头开门 ----------
  const opened = ensureCrossable(grid, base, added);

  // ---------- ⑥ 汇总成新的配方（AI 的补丁原样保留在前，程序只在后面追加差异补丁）----------
  // 补丁是**按顺序覆盖**的（bakeMap 后铺的赢），所以「把 AI 的石头拆掉」这种改动
  // 只要在末尾补一条「这格改回底色」就成立了，不必去改 AI 那几条补丁。
  const byTerrain = new Map();
  const push = (t, x, y) => {
    if (!byTerrain.has(t)) byTerrain.set(t, []);
    byTerrain.get(t).push([x, y]);
  };
  let changed = 0;
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      if (grid[y][x] === aiGrid[y][x]) continue;
      changed++;
      push(grid[y][x], x, y);
    }
  }
  const patches = [
    ...aiPatches,
    ...[...byTerrain.entries()].map(([t, at]) => ({ t, at })),
  ];

  if (cleared) notes.unshift('出生区挡住了去路，已清平');
  if (opened) notes.push(`原有山岩封死了去路，已打通 ${opened} 格`);
  return { base, patches, notes, added: changed, opened };
}

/**
 * 自然散布若干「不规则岩块」（blob）。
 * 2026-09-20：旧版在中列造一整道山岩墙（带缺口）—— 玩家反馈「为什么总在中间摆一排岩石」。
 * 现改为随机位置、随机大小（3~7 格）的紧凑岩块，块与块保持最小间距、不连成墙；
 * 是否封死由最后一步 ensureCrossable 兜底开门。
 */
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 从 (sx,sy) 起做随机前沿生长，长成一块最多 maxCells 格的不规则岩块，返回实际放下的格数。 */
function growBlob(put, rng, sx, sy, maxCells) {
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const cells = [];
  let placed = 0;
  if (put(sx, sy, '耸峰')) { cells.push([sx, sy]); placed++; }
  if (!placed) return 0;      // 种子格放不下（被占/边界），直接放弃这块
  let guard = 0;
  while (placed < maxCells && guard++ < 80) {
    const base = cells[Math.floor(rng() * cells.length)];
    let grew = false;
    for (const [dx, dy] of shuffled(DIRS, rng)) {
      if (put(base[0] + dx, base[1] + dy, '耸峰')) {
        cells.push([base[0] + dx, base[1] + dy]); placed++; grew = true; break;
      }
    }
    if (!grew) {
      // 这个格长不动，换别的格；全卡住就停
      let any = false;
      outer: for (const b of shuffled(cells, rng)) {
        for (const [dx, dy] of shuffled(DIRS, rng)) {
          if (put(b[0] + dx, b[1] + dy, '耸峰')) {
            cells.push([b[0] + dx, b[1] + dy]); placed++; any = true; break outer;
          }
        }
      }
      if (!any) break;
    }
  }
  return placed;
}

function addBarrier(grid, base, rng, put) {
  const mid = Math.floor(MAP_SIZE / 2);
  const safe = FIELD_QUOTA.safeCols;
  const seeds = [];
  const tooClose = (x, y) => seeds.some(s => Math.max(Math.abs(s[0] - x), Math.abs(s[1] - y)) < 4);
  let count = 0;
  let guard = 0;
  while (count < FIELD_QUOTA.minBlocked && guard++ < 200) {
    const cx = safe + 1 + Math.floor(rng() * (MAP_SIZE - 2 * safe - 2));
    const cy = 2 + Math.floor(rng() * (MAP_SIZE - 4));
    if (tooClose(cx, cy)) continue;
    const blobSize = 3 + Math.floor(rng() * 5);     // 3..7 格
    const got = growBlob(put, rng, cx, cy, blobSize);
    if (got > 0) { seeds.push([cx, cy]); count += got; }
  }
  // main 仅作为「中路争夺点」的参考列保留（不再有墙）；gaps 已无意义
  return { main: mid, gaps: [], count };
}

/** 底色决定这台战场长什么样：山林里不会凭空冒出水洼。 */
const THEME_FAMILY = {
  平地: ['草丛', '水洼', '乱石'],
  草地: ['草丛', '树林', '草地'],
  草丛: ['草丛', '树林'],
  树林: ['树林', '草丛', '乱石'],
  泥地: ['沼泽', '泥地', '草丛'],
  沼泽: ['沼泽', '水洼'],
  毒沼: ['毒沼', '沼泽'],
  水洼: ['水洼', '沼泽'],
  乱石: ['乱石', '草丛'],
  耸峰: ['乱石', '草丛'],
  灵脉: ['灵脉', '草地', '阵纹'],
  阵纹: ['阵纹', '灵脉', '乱石'],
};

function addFeatures(grid, base, rng, put, mainCol, need = 0) {
  const notes = [];
  const fam = THEME_FAMILY[base] || THEME_FAMILY.平地;
  const pick = () => fam[Math.floor(rng() * fam.length)];

  const mid = Math.floor(MAP_SIZE / 2);
  // ① 中路争夺点：双方都想抢的那一格。放在隔断缺口边上，谁先到谁占便宜。
  const prize = rng() < 0.5 ? '灵脉' : '阵纹';
  const px = Math.min(MAP_SIZE - 1, Math.max(1, (mainCol ?? mid) + (rng() < 0.5 ? -1 : 1)));
  const py = mid - 3 + Math.floor(rng() * 7);    // 中线上下 3 行，正好在缺口带附近
  let placed = 0;
  for (const [dx, dy] of [[0, 0], [0, 1], [1, 0]]) {
    if (put(px + dx, py + dy, prize)) placed++;
  }
  if (placed) notes.push(`中路设了一处「${prize}」作为争夺点`);

  // ② 两翼掩体：给弱势方一个能伏身/避远程的地方（3×3），分处对角两侧
  const beds = [
    { x: 1 + Math.floor(rng() * 3), y: 1 + Math.floor(rng() * 4), t: rng() < 0.5 ? '草丛' : '树林' },
    { x: MAP_SIZE - 6 + Math.floor(rng() * 3), y: MAP_SIZE - 6 + Math.floor(rng() * 4), t: rng() < 0.5 ? '树林' : '草丛' },
  ];
  let bedCount = 0;
  for (const b of beds) {
    for (let y = b.y; y < b.y + 3; y++) {
      for (let x = b.x; x < b.x + 3; x++) if (put(x, y, b.t)) bedCount++;
    }
  }
  if (bedCount) notes.push('两翼各铺了一片掩体（草丛 / 树林）');

  // ③ 零散点缀：让地面不要一整块同色（数量随面积缩放）
  const dotN = Math.max(3, Math.round((MAP_SIZE * MAP_SIZE) / 225 * 3));
  for (let i = 0; i < dotN; i++) {
    const cx = 1 + Math.floor(rng() * (MAP_SIZE - 2));
    const cy = 1 + Math.floor(rng() * (MAP_SIZE - 2));
    const t = pick();
    for (let y = cy; y < cy + 2; y++) for (let x = cx; x < cx + 2; x++) put(x, y, t);
  }

  // 2026-09-20：大地图顶满战术地形配额。在空位上单格补同主题地形，
  // put 只落在「还是底色」的格上，不会覆盖 AI 布置，也不影响通行。
  let guard = 0;
  while (need > 0 && guard++ < 800) {
    const cx = Math.floor(rng() * MAP_SIZE);
    const cy = Math.floor(rng() * MAP_SIZE);
    if (put(cx, cy, pick())) need--;
  }
  return { notes };
}

/**
 * 保证「从左走得到右」。走不通就拆掉最靠中线的一块石头 —— 优先拆中线，
 * 是因为那最像「打通一条要道」，而不是把边角挖个洞让人从地图外面绕。
 * @returns {number} 拆掉了几块
 */
function ensureCrossable(grid, base, added) {
  const left = firstWalkable(grid, 0, FIELD_QUOTA.safeCols - 1);
  const right = firstWalkable(grid, MAP_SIZE - FIELD_QUOTA.safeCols, MAP_SIZE - 1);
  if (!left || !right) return 0;                 // 整侧都站不住：出生区清理已经处理过，这里只是保险
  let opened = 0;
  for (let guard = 0; guard < 60; guard++) {
    const seen = floodFrom(grid, left);
    if (seen.has(key(right.x, right.y))) return opened;
    const rocks = [];
    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        if (grid[y][x] !== base && !terrainOf(grid[y][x]).passable) rocks.push({ x, y, d: Math.abs(x - Math.floor(MAP_SIZE / 2)) });
      }
    }
    if (!rocks.length) return opened;
    rocks.sort((a, b) => a.d - b.d);
    const hit = rocks[0];
    grid[hit.y][hit.x] = base === '耸峰' ? DEFAULT_TERRAIN_ID : base;
    const i = added.findIndex(a => a[0] === hit.x && a[1] === hit.y);
    if (i >= 0) added.splice(i, 1);
    opened++;
  }
  return opened;
}

/** 这局战场的人话说明（写进场景备注，AI 写正文时才知道场上有山有水）。 */
export function describeBattlefield(recipe) {
  const grid = bakeMap(recipe);
  const base = normalizeTerrainId(recipe?.base);
  const s = battlefieldStats(grid, base);
  const parts = [`底色是${base}`];
  if (s.blocked) parts.push(`${s.blocked} 格山岩无法通行`);
  const kinds = new Set();
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      const id = grid[y][x];
      if (id === base) continue;
      if (terrainOf(id).passable) kinds.add(id);
    }
  }
  if (kinds.size) parts.push(`另有${[...kinds].join('、')}`);
  return parts.join('，');
}
