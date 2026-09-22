// ===== 立体战场「怎么摆」的纯逻辑层 =====
// 这一层只回答三个问题，一个 three 对象都不碰、一个 DOM 都不碰：
//   ① 15×15 的地表在三维里长多高、什么颜色（地表网格要连成一片，不能有缝）
//   ② 每一格上摆哪些物件、朝哪边、多高（必须**确定性**：同一格每次摆得一模一样）
//   ③ 相机在哪、某个世界坐标投影到屏幕的哪个位置（界面上的名字牌/血条要贴在人头上）
//
// 为什么单独拆出来：这些都能在 node 里直接断言（见 _unused/battletest/scene.probe），
// 而 three 的渲染只在真浏览器里才跑得起来。把"算"和"画"分开，"画"错了才好定位。
//
// 模型来源（CC0，可商用、无需署名，已随包放在 client/public/models/）：
//   Kenney Nature Kit（57 个自然物件）＋ Kenney Mini Characters（12 个带骨骼动画的小人）
//   许可证与出处见 client/public/models/README.md

import { MAP_SIZE, terrainOf } from './battleTerrain.js';

const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ============================================================
// 一、模型清单
// ============================================================

// ----- 角色：高精度 VRM（国风/动漫虚拟人，2026-09-20 第 10 轮替换原 Kenney 低模小人）-----
// 文件放在 client/public/models/vrm/<名>.vrm；由 three-vrm 运行时载入、VrmAnimator 程序化驱动动作。
// 按性别分池，assignCharacterModels 会让男角色配男模、女角色配女模（见下方）。
/** 中式女角池（汉服短襦 / 道袍 / 狐妖）。 */
export const VRM_FEMALE_FILES = [
  '247388737517495633', // 07 Reira：紫发双髻、紫色中式短襦（用户原始、画风基准）
  'rinrin-red',          // 棕发双环髻、红金刺绣短襦
  'yelin-taiji',         // 紫发、黑衣太极道袍（露脸）
  '7992258660052641462', // 蓝发双髻、太极道袍（夜鈴萌款）
  '4016288974706667434', // 紫发、蓝紫白花中式萝莉
  '2242715922012264712', // 金发狐妖、黑唐装（狐耳狐尾）
];
/** 中式男角池（唐装 / 武侠 / 黑袍披风）。 */
export const VRM_MALE_FILES = [
  '5737808116595966447', // 黑高马尾、紫竹短袖唐装（最像武侠）
  '3907542556277918053', // 青马尾、红唐装长裤
  '4208207731251171789', // 银短发、红唐装七分裤
  '6573787659153691105', // Vamp1：黑燕尾＋红披风（当魔修/长袍）
];
/** 全部角色 VRM（按名，不含扩展名）。 */
export const CHARACTER_MODEL_FILES = [...VRM_FEMALE_FILES, ...VRM_MALE_FILES];

/** VRM 文件路径：'rinrin-red' → '/models/vrm/rinrin-red.vrm'。 */
export function vrmUrl(name) {
  return `${SCENE_MODEL_ROOT}/vrm/${name}.vrm`;
}

// 物件池：按"这一格该有什么感觉"分组，摆的时候从池里按格坐标取，人不挑、程序挑。
// 2026-09-20（第 11 轮）：树 / 灌木 / 岩石 / 草 / 花 / 蘑菇整体改用 Quaternius
// 「Stylized Nature MegaKit」（CC0，Ghibli 风格高精度 glTF，mk: 前缀，见
// public/models/nature 下 .gltf）；竹 / 睡莲 / 木栅栏 / 残碑经幢 / 石环等主题件仍是
// 程序化高精度 PBR（proc: 前缀）；耸峰巨石沿用 Poly Haven 大卵石/崖面。
const mk = (s) => `mk:${s}`;
const TREE_POOL = [
  'CommonTree_1', 'CommonTree_2', 'CommonTree_3', 'CommonTree_4', 'CommonTree_5',
  'Pine_1', 'Pine_2', 'Pine_3', 'Pine_4',
].map(mk);
const BUSH_POOL = [
  'Bush_Common', 'Bush_Common_Flowers', 'Plant_1', 'Plant_7', 'Fern_1', 'Clover_1',
].map(mk);
const ROCK_POOL = [
  'Rock_Medium_1', 'Rock_Medium_2', 'Rock_Medium_3',
  'RockPath_Square_Wide', 'RockPath_Round_Wide', 'Pebble_Square_6',
].map(mk);
const FLOWER_POOL = [
  'Flower_3_Single', 'Flower_4_Single', 'Petal_1', 'Petal_2', 'Petal_3', 'Petal_5',
].map(mk);
const GRASS_POOL = [
  'Grass_Common_Short', 'Grass_Common_Tall', 'Grass_Wispy_Short', 'Grass_Wispy_Tall',
  'Fern_1', 'Clover_2', 'Plant_7',
].map(mk);
// 沼泽：睡莲 ＋ 高草/蕨 ＋ 一截倒木（log 沿用旧模型）
const REED_POOL = ['proc:lily', 'mk:Grass_Wispy_Tall', 'mk:Fern_1', 'log', 'mk:Grass_Common_Tall'];
// 毒沼：睡莲 ＋ 蘑菇 ＋ 蕨/矮草
const BOG_POOL = [
  'proc:lily', 'mk:Mushroom_Common', 'mk:Mushroom_Laetiporus', 'mk:Fern_1', 'mk:Grass_Wispy_Short',
];
const PEBBLE_POOL = [
  'Pebble_Round_1', 'Pebble_Round_2', 'Pebble_Round_3', 'Pebble_Square_2', 'Pebble_Square_4',
  'RockPath_Round_Small_1', 'RockPath_Square_Small_2',
].map(mk);
const MUD_POOL = [
  'DeadTree_2', 'DeadTree_3', 'DeadTree_5', 'TwistedTree_2', 'TwistedTree_4',
].map(mk);

// 古迹石雕（灵脉/阵纹一带的修仙遗迹，程序化高精度 PBR）
const RUIN_POOL = ['proc:pillar', 'proc:column_broken', 'proc:stele', 'proc:obelisk'];
// 营地生活摆件（平地/草地上偶有前人驻足痕迹；栅栏程序化，其余为 Kenney）
const CAMP_POOL = ['proc:fence', 'log_stack', 'sign', 'campfire_logs', 'tent_smallClosed'];
// 清雅竹林（程序化）
const BAMBOO_POOL = ['proc:bamboo'];

// 耸峰＝巨石（第 12 轮起统一用 MegaKit 的 Rock_Medium 三件放大铺满崖块；由 cliffExtraProps 按整块布置）
const CLIFF_POOL = [
  mk('Rock_Medium_1'), mk('Rock_Medium_2'), mk('Rock_Medium_3'),
];
export const FLAT_TILES = ['path_stoneCircle'];

/**
 * 巨石模型的实测水平尺寸/高度（probe_bbox 量得，与 GLB 真实包围盒一致）。
 * 用来给每个巨石块挑「比例最接近」的模型，避免把崖壁硬塞进小块导致比例失调。
 */
const CLIFF_SIZE = {
  'mk:Rock_Medium_1': { wx: 3.225, wz: 2.989, h: 2.260 },
  'mk:Rock_Medium_2': { wx: 3.049, wz: 2.479, h: 1.899 },
  'mk:Rock_Medium_3': { wx: 3.420, wz: 3.476, h: 2.316 },
};

/**
 * 为 bw×bd 的巨石块挑模型：按「宽深比匹配 ＋ 成石高度合适」打分，
 * 在最优的一小撮里用格哈希挑一个（既自然又有变化）。
 * @param {number} bw 块宽（世界）
 * @param {number} bd 块深（世界）
 * @param {number} r 0~1 哈希
 */
function pickCliffModel(bw, bd, r) {
  const targetH = Math.min(Math.max(bw, bd) * 0.72, 2.2);
  const scored = CLIFF_POOL.map((name) => {
    const s = CLIFF_SIZE[name];
    const sx = bw / s.wx, sz = bd / s.wz, sy = Math.min(sx, sz);
    const finalH = s.h * sy;
    const aspectScore = Math.abs(Math.log((bw / bd) / (s.wx / s.wz)));
    const heightScore = Math.abs(Math.log(Math.max(0.05, finalH) / targetH));
    return { name, score: aspectScore + heightScore * 0.5 };
  }).sort((a, b) => a.score - b.score);
  const best = scored[0].score;
  const eligible = scored.filter(s => s.score <= best + 0.12);
  return eligible[Math.min(eligible.length - 1, Math.floor(r * eligible.length))].name;
}


/** 场景会加载的全部「旧版 .glb」自然物件（proc / mk 都不是 glb，不在此列）。 */
export const NATURE_MODEL_FILES = [...new Set([
  ...TREE_POOL, ...BUSH_POOL, ...ROCK_POOL, ...FLOWER_POOL, ...GRASS_POOL,
  ...REED_POOL, ...BOG_POOL, ...PEBBLE_POOL, ...MUD_POOL, ...CLIFF_POOL,
  ...CAMP_POOL,
  ...FLAT_TILES, 'cactus_tall', 'mushroom_red',
])].filter(n => !n.startsWith('proc:') && !n.startsWith('mk:'));

/** 场景会加载的全部 Quaternius MegaKit（.gltf）自然物件（含巨石崖块）。 */
export const MEGAKIT_MODEL_FILES = [...new Set([
  ...TREE_POOL, ...BUSH_POOL, ...ROCK_POOL, ...FLOWER_POOL, ...GRASS_POOL,
  ...REED_POOL, ...BOG_POOL, ...PEBBLE_POOL, ...MUD_POOL, ...CLIFF_POOL,
])].filter(n => n.startsWith('mk:'));

export const SCENE_MODEL_ROOT = '/models';
/** 旧版自然物件路径：'tree_oak' → '/models/nature/tree_oak.glb'。角色 VRM 见 vrmUrl。 */
export function modelUrl(name) {
  return `${SCENE_MODEL_ROOT}/nature/${name}.glb`;
}
/** MegaKit 自然物件路径：'mk:CommonTree_1' → '/models/nature/CommonTree_1.gltf'。 */
export function mkUrl(name) {
  return `${SCENE_MODEL_ROOT}/nature/${name.slice(3)}.gltf`;
}

// ============================================================
// 二、地表：高度与颜色
// ============================================================

/**
 * 每种地形在三维里的长相。
 *   relief  地表相对基准面的高度（单位＝1 格）。负数＝陷下去（沼泽、水洼），正数＝鼓起来（乱石、耸峰）
 *   color   地表反射的颜色。**图例的小色块也用这一份**，免得"图例是浅绿、地面是深绿"两套说法
 *   rough   表面粗糙度：水洼低＝反光，其他高＝哑光
 */
export const TERRAIN_LOOK = {
  平地: { relief: 0.000, color: '#cfc4a6', rough: 0.92 },
  草地: { relief: 0.015, color: '#8fae5e', rough: 0.88 },
  泥地: { relief: -0.020, color: '#a08657', rough: 0.95 },
  沼泽: { relief: -0.045, color: '#6f8455', rough: 0.80 },
  毒沼: { relief: -0.050, color: '#5f7a48', rough: 0.80 },
  树林: { relief: 0.030, color: '#5d7c43', rough: 0.90 },
  草丛: { relief: 0.020, color: '#7e9a55', rough: 0.90 },
  乱石: { relief: 0.055, color: '#9a9083', rough: 0.94 },
  水洼: { relief: -0.050, color: '#6f9fbc', rough: 0.18 },
  灵脉: { relief: 0.020, color: '#e6cf8a', rough: 0.55 },
  阵纹: { relief: 0.010, color: '#c3aede', rough: 0.60 },
  耸峰: { relief: 0.200, color: '#8a8073', rough: 0.94 },
};

/** 兜底：地块表里出现了 TERRAIN_LOOK 没写的地形时，别炸，按平地处理。 */
export function lookOf(terrainId) {
  return TERRAIN_LOOK[terrainId] || TERRAIN_LOOK.平地;
}

/** '#8fae5e' → 0x8fae5e（three 的颜色要数字）。 */
export function hexToInt(hex) {
  return parseInt(String(hex).replace('#', ''), 16);
}

// ============================================================
// 三、确定性伪随机（严禁 Math.random）
// ============================================================
// 为什么必须确定性：225 格每渲染一次就重新摆一遍草石，用随机数的话整片草地会在
// 每次重渲染时"抽搐"一下（而且 SSR 测试也会每次不一样，断不住）。
// 下面的哈希把「格坐标 + 一个用途编号」映射到 0~1，同一格同一用途永远同一个值。
export function cellRand(x, y, salt = 0) {
  let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul((salt | 0) + 1, 83492791) ^ 0x9e3779b9) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (((h ^ (h >>> 16)) >>> 0) % 100000) / 100000;
}

/** 字符串 → 0~1（给单位 id 用，保证同一个人每次都分到同一个模型）。 */
export function strRand(s) {
  let h = 2166136261;
  const t = String(s);
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (((h ^ (h >>> 16)) >>> 0) % 100000) / 100000;
}

// ============================================================
// 四、地表网格的角点高度（连成一片的关键）
// ============================================================
// 每一格的四角高度 = 它周围最多 4 格 relief 的平均值。
// 这样相邻两格**共用同一个角点高度**，格子之间不会出现裂缝或台阶错位，
// 沼泽与平地相接的地方就是一个缓坡，而不是一面墙。
/**
 * 网格交点 (gx,gy) 的高度。gx/gy 取 0..size（有 size+1 条网格线）。
 * @param {string[][]} grid
 * @param {number} gx 交点列号 0..size
 * @param {number} gy 交点行号 0..size
 */
export function cornerRelief(grid, gx, gy) {
  let sum = 0, n = 0;
  for (const [cx, cy] of [[gx - 1, gy - 1], [gx, gy - 1], [gx - 1, gy], [gx, gy]]) {
    if (cx < 0 || cy < 0 || cx >= MAP_SIZE || cy >= MAP_SIZE) continue;
    const id = grid?.[cy]?.[cx];
    if (id == null) continue;
    sum += lookOf(id).relief;
    n++;
  }
  return n ? sum / n : 0;
}

// ============================================================
// 五、每格摆什么
// ============================================================

/**
 * 一条摆放指令。组件照着它把模型放下去：
 *   model  模型名（见 NATURE_MODEL_FILES）
 *   dx,dz  在本格内的偏移，单位＝格（0 = 正中；±0.3 以内不会戳到邻格）
 *   rotY   绕竖轴转多少弧度
 *   h      摆好之后**世界高度**（格为单位）。组件用模型原始包围盒按这个高度缩放
 *   w      摆好之后**占地宽度**（给平铺在地面的贴片用：石板、水面）
 *   sink   往地里埋多深（树埋一点看着才像长在地里，崖壁要埋掉大半）
 *   at     从地表往上抬多少再摆（耸峰是往下垒，第二、三块要抬到第一块顶上）
 *   glow   会发光的（灵脉、阵纹）—— 组件给它加自发光
 *   big    巨石（耸峰）：允许略大于一格，不做"单格内"约束
 *   wx,wz  巨石（整块布置）的世界中心；不填则用「格心＋dx/dz」
 *   fitW,fitD  巨石要铺满的世界宽/深（非均匀缩放），用于让巨石正好盖住整块不可通行格
 * @typedef {{model:string,dx:number,dz:number,rotY:number,h?:number,w?:number,
 *            sink?:number,at?:number,glow?:boolean,big?:boolean,
 *            wx?:number,wz?:number,fitW?:number,fitD?:number}} SceneProp
 */

const pick = (pool, r) => pool[Math.min(pool.length - 1, Math.floor(r * pool.length))];
/** 0~1 → [-a, a] */
const around = (r, a = 0.26) => (r * 2 - 1) * a;

/** 营地摆件的世界高度（按各自原生高度，避免缩放失真）。 */
const CAMP_H = {
  fence_simple: 0.36, log_stack: 0.36, sign: 0.42,
  campfire_logs: 0.12, tent_smallClosed: 0.58,
};
const campH = (c) => CAMP_H[c] ?? 0.4;

/**
 * 某一格上摆什么。纯函数：同样的地形 + 同样的格子，永远给出同样的清单。
 * @param {string} terrainId
 * @param {number} x
 * @param {number} y
 * @returns {SceneProp[]}
 */
export function propsForCell(terrainId, x, y) {
  const R = (s) => cellRand(x, y, s);
  const rot = (s) => R(s) * Math.PI * 2;
  const out = [];

  switch (terrainId) {
    case '树林': {
      // 一格两棵、高度相近：密林整齐、看得出"远程减伤"，又不杂乱（2026-09-20）
      for (let i = 0; i < 2; i++) {
        out.push({
          model: pick(TREE_POOL, R(10 + i)),
          dx: around(R(20 + i), 0.20),
          dz: around(R(30 + i), 0.20),
          rotY: rot(40 + i),
          h: 1.30 + R(50 + i) * 0.35,
          sink: 0.02,
        });
      }
      return out;
    }

    case '草丛': {
      const n = R(1) < 0.5 ? 1 : 2;
      for (let i = 0; i < n; i++) {
        out.push({
          model: pick(BUSH_POOL, R(10 + i)),
          dx: around(R(20 + i), 0.22),
          dz: around(R(30 + i), 0.22),
          rotY: rot(40 + i),
          h: 0.32 + R(50 + i) * 0.14,
          sink: 0.02,
        });
      }
      return out;
    }

    case '草地': {
      if (R(1) > 0.70) return out;                 // 约三成格子干干净净，草地上才看得见格线
      // 约两成格子长出一丛清雅小竹（与花草互斥，避免一格堆三样）
      if (R(15) < 0.22) {
        out.push({
          model: pick(BAMBOO_POOL, R(16)),
          dx: around(R(17), 0.22), dz: around(R(18), 0.22),
          rotY: rot(19), h: 0.85, sink: 0.02,
        });
        return out;
      }
      out.push({
        model: pick(GRASS_POOL, R(2)),
        dx: around(R(3), 0.20), dz: around(R(4), 0.20),
        rotY: rot(5), h: 0.17 + R(6) * 0.12, sink: 0.02,
      });
      if (R(7) < 0.40) {                            // 偶有几朵花，标出"回合末回血"的好地
        out.push({
          model: pick(FLOWER_POOL, R(8)),
          dx: around(R(11), 0.30), dz: around(R(12), 0.30),
          rotY: rot(13), h: 0.16 + R(14) * 0.08, sink: 0.01,
        });
      }
      return out;
    }

    case '乱石': {
      const n = R(1) < 0.5 ? 1 : 2;
      for (let i = 0; i < n; i++) {
        out.push({
          model: pick(ROCK_POOL, R(10 + i)),
          dx: around(R(20 + i), 0.22),
          dz: around(R(30 + i), 0.22),
          rotY: rot(40 + i),
          h: 0.26 + R(50 + i) * 0.16,
          sink: 0.03,
        });
      }
      return out;
    }

    case '耸峰': {
      // 巨石改为「整块布置」：由 cliffExtraProps(grid) 把相连的耸峰格切成整块，一块巨石正好
      // 落在不可通行的格子上（不会再出现人穿模走进石头）。逐格函数这里不再单独放石头。
      return out;
    }

    case '水洼': {
      // 水面由高精度着色器铺（BattleScene3D 收集全部水洼格），这里只点缀睡莲，不再摆船
      const n = R(1) < 0.5 ? 1 : 2;
      for (let i = 0; i < n; i++) {
        out.push({
          model: 'proc:lily',
          dx: around(R(10 + i), 0.26), dz: around(R(20 + i), 0.26),
          rotY: rot(30 + i), h: 0.10, sink: 0.01,
        });
      }
      return out;
    }

    case '沼泽': {
      const n = R(1) < 0.5 ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const m = pick(REED_POOL, R(10 + i));
        out.push({
          model: m,
          dx: around(R(20 + i), 0.28), dz: around(R(30 + i), 0.28),
          rotY: rot(40 + i),
          h: m === 'log' ? 0.18
            : m === 'proc:lily' ? 0.10
            : 0.26 + R(50 + i) * 0.14,
          sink: m === 'log' ? 0.05 : 0.02,
        });
      }
      return out;
    }

    case '毒沼': {
      const n = R(1) < 0.5 ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const m = pick(BOG_POOL, R(10 + i));
        out.push({
          model: m,
          dx: around(R(20 + i), 0.28), dz: around(R(30 + i), 0.28),
          rotY: rot(40 + i),
          h: m === 'proc:lily' ? 0.08 : /mushroom/i.test(m) ? 0.20 : 0.16,
          sink: 0.02,
        });
      }
      return out;
    }

    case '灵脉': {
      // 中心遗迹：经幢 / 断柱 / 残碑 / 望柱（程序化高精度 PBR），按格哈希变化
      const center = pick(RUIN_POOL, R(2));
      const centerH = center === 'proc:pillar' ? 1.05
        : center === 'proc:column_broken' ? 0.70
        : center === 'proc:stele' ? 0.90 : 0.95;
      out.push({ model: center, dx: 0, dz: 0, rotY: rot(2), h: centerH, sink: 0.02, glow: center === 'proc:obelisk' });
      if (R(3) < 0.6) {
        out.push({ model: 'mk:Pebble_Round_2', dx: around(R(4), 0.28), dz: around(R(5), 0.28), rotY: rot(6), h: 0.18, sink: 0.03 });
      }
      return out;
    }

    case '阵纹': {
      // 地上的石阵圈 ＋ 中央残环，对应"在此施法伤害 ×1.10"
      out.push({ model: 'path_stoneCircle', dx: 0, dz: 0, rotY: rot(2), w: 0.96, sink: 0.010, glow: true });
      out.push({ model: 'proc:ring', dx: 0, dz: 0, rotY: rot(3), h: 0.46, sink: 0.02, glow: true });
      return out;
    }

    case '泥地': {
      if (R(1) > 0.55) return out;
      out.push({
        model: pick(MUD_POOL, R(2)),
        dx: around(R(3), 0.26), dz: around(R(4), 0.26),
        rotY: rot(5), h: 0.16 + R(6) * 0.10, sink: 0.03,
      });
      return out;
    }

    default: {   // 平地
      // 约 5% 的平地留有一处小营地（栅栏/帐篷/篝火/柴堆/木牌），是前人驻足的痕迹
      if (R(30) < 0.05) {
        const c = pick(CAMP_POOL, R(31));
        out.push({
          model: c,
          dx: around(R(32), 0.12), dz: around(R(33), 0.12),
          rotY: rot(34), h: campH(c), sink: 0.02,
          campfire: c === 'campfire_logs',
        });
        return out;
      }
      // 阈值 0.18 是按实测定的：15×15 这张网格上，salt=1 的哈希有 75.6% 的格子落在 0.18 以上，
      // 也就是约四分之一的平地长点东西 —— 再多整片地就看不出格线了（见 scene.probe 的留白断言）
      if (R(1) > 0.18) return out;
      out.push({
        model: pick(PEBBLE_POOL, R(2)),
        dx: around(R(3), 0.26), dz: around(R(4), 0.26),
        rotY: rot(5), h: 0.15 + R(6) * 0.08, sink: 0.01,
      });
      return out;
    }
  }
}

/** 整张棋盘上所有格子的摆放清单（预载模型时用来核对"用到的都下下来了"）。 */
export function allUsedModels() {
  const set = new Set();
  for (const t of Object.keys(TERRAIN_LOOK)) {
    for (const [x, y] of [[0, 0], [1, 2], [3, 5], [6, 7], [9, 11], [12, 13], [14, 1], [7, 3]]) {
      for (const p of propsForCell(t, x, y)) set.add(p.model);
    }
  }
  return [...set].sort();
}

/**
 * 把所有耸峰格切成「整块」并为每块配一块巨石（grid 感知，解决穿模）。
 *
 * 做法：贪心把尚未覆盖的耸峰格切成最大 3×3 的**实心**矩形块；每块放一块巨石，
 * 非均匀缩放恰好铺满该块（fitW/fitD）、中心对准块中心。这样巨石的视觉占地**完全落在
 * 不可通行格上**，相邻可走格不再被石头盖住，人物也就不可能穿模走进石头。
 * 孤立的单块耸峰（1×1）则放一块收在单格内的石头（big=false）。
 *
 * @param {string[][]} grid
 * @param {number} [size]
 * @returns {Map<string, SceneProp>} 锚点格 key（"x,y"）→ 巨石摆件
 */
export function cliffExtraProps(grid, size = MAP_SIZE) {
  const blocked = (x, y) => x >= 0 && y >= 0 && x < size && y < size && grid[y][x] === '耸峰';
  const covered = new Set();
  const map = new Map();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k0 = `${x},${y}`;
      if (!blocked(x, y) || covered.has(k0)) continue;
      // 先沿宽度长（最多 3）
      let w = 0;
      while (w < 3 && blocked(x + w, y) && !covered.has(`${x + w},${y}`)) w++;
      // 再沿高度长（最多 3），每加一行都要求整行 w 格是未覆盖的耸峰
      let h = 1;
      grow: for (let hh = 2; hh <= 3; hh++) {
        for (let xx = x; xx < x + w; xx++) {
          if (!blocked(xx, y + hh - 1) || covered.has(`${xx},${y + hh - 1}`)) break grow;
        }
        h = hh;
      }
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) covered.add(`${xx},${yy}`);

      const c = (size - 1) / 2;
      const wx = x + w / 2 - 0.5 - c;
      const wz = y + h / 2 - 0.5 - c;
      const ax = x + Math.floor((w - 1) / 2);
      const az = y + Math.floor((h - 1) / 2);
      const single = w === 1 && h === 1;
      const fitW = single ? 0.92 : w * 0.98;
      const fitD = single ? 0.92 : h * 0.98;
      // 按块的宽深比挑比例最接近的巨石模型（避免崖壁硬塞小块）
      const model = pickCliffModel(fitW, fitD, cellRand(ax, az, 71));
      // 非方块只允许不旋转（转 90° 会交换宽深、可能越出块）；方块可量化 90°
      const rotY = w === h ? Math.round(cellRand(ax, az, 72) * 4) * Math.PI / 2 : 0;
      map.set(`${ax},${az}`, {
        model, dx: 0, dz: 0, rotY,
        wx, wz,
        fitW, fitD,
        sink: single ? 0.04 : 0.10,
        big: !single,
      });
    }
  }
  return map;
}

// ============================================================
// 七、地表几何（纯数值，组件直接塞进 BufferGeometry）
// ============================================================
// 为什么把"造顶点"放在这一层：地表有没有裂缝、颜色对不对、法线朝不朝上，
// 全都是能算出来、能断言的；留在组件里就只能靠肉眼看截图。

// ---------- 地表纹理图集（按地形 tone 分区采样）----------
// 图集为 COLS×ROWS 个 tile，每个 tile 内是「白底 + 灰度风格化细节 + 边缘格线」，
// 与顶点色相乘：白不改变顶点色，灰度细节表现明暗斑驳，边缘深色形成格线。
export const GROUND_ATLAS_COLS = 4;
export const GROUND_ATLAS_ROWS = 2;
export const GROUND_TONE_ORDER = ['soil', 'grass', 'rock', 'water', 'rune'];
const GROUND_TONE_INDEX = Object.fromEntries(GROUND_TONE_ORDER.map((t, i) => [t, i]));

/** 地形 → 地表纹理 tone。 */
const TERRAIN_GROUND_TONE = {
  平地: 'soil', 草地: 'grass', 泥地: 'soil', 沼泽: 'grass', 毒沼: 'grass',
  树林: 'grass', 草丛: 'grass', 乱石: 'rock', 水洼: 'water',
  灵脉: 'rune', 阵纹: 'rune', 耸峰: 'rock',
};
const groundToneOf = (terrainId) => TERRAIN_GROUND_TONE[terrainId] || 'soil';

/** 取某 tone tile 在图集中的 UV 区域（UV 原点在左下）。 */
export function groundTileUV(tone) {
  const idx = Object.prototype.hasOwnProperty.call(GROUND_TONE_INDEX, tone)
    ? GROUND_TONE_INDEX[tone] : 0;
  const col = idx % GROUND_ATLAS_COLS;
  const row = Math.floor(idx / GROUND_ATLAS_COLS);
  return {
    u0: col / GROUND_ATLAS_COLS,
    u1: (col + 1) / GROUND_ATLAS_COLS,
    // canvas 第 0 行在顶部、UV V 向上，所以要翻转
    v0: 1 - (row + 1) / GROUND_ATLAS_ROWS,
    v1: 1 - row / GROUND_ATLAS_ROWS,
  };
}


/**
 * 造整块地表。要点：
 *  · **每一格自己四个顶点**（颜色才能一格一个色），但四角的高度取自上面那张共享的角点表
 *    （cornerRelief）⇒ 相邻格的公共边上左右两个顶点一样高，地表连成一片、不会裂。
 *  · 法线按高度场的中心差分算，相邻格共用同一个角 → 光照连续，不会一格一个棱角。
 *  · 每格亮度用哈希微调（±8%），看得出是一格一格，又不像国际象棋盘那么硬。
 * @returns {{positions:Float32Array, normals:Float32Array, colors:Float32Array,
 *            uvs:Float32Array, indices:Uint16Array, cellCount:number}}
 */
export function buildTileGeometry(grid, size = MAP_SIZE) {
  const n = size * size;
  const positions = new Float32Array(n * 12);
  const normals = new Float32Array(n * 12);
  const colors = new Float32Array(n * 12);
  const uvs = new Float32Array(n * 8);
  const indices = new Uint16Array(n * 6);
  const c = (size - 1) / 2;

  const H = (gx, gy) => cornerRelief(grid, gx, gy);
  const normalAt = (gx, gy) => {
    const x0 = Math.max(0, gx - 1), x1 = Math.min(size, gx + 1);
    const y0 = Math.max(0, gy - 1), y1 = Math.min(size, gy + 1);
    const dhx = (H(x1, gy) - H(x0, gy)) / Math.max(1, x1 - x0);
    const dhz = (H(gx, y1) - H(gx, y0)) / Math.max(1, y1 - y0);
    const l = Math.hypot(-dhx, 1, -dhz) || 1;
    return [-dhx / l, 1 / l, -dhz / l];
  };

  let vi = 0, ii = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const terrainId = grid?.[y]?.[x];
      const rgb = rgbOf(lookOf(terrainId).color);
      // 格与格之间只做 ±4% 的明暗微调：看得出是一格一格，又不会变成国际象棋盘
      const tone = 0.96 + cellRand(x, y, 77) * 0.08;
      // 本格采样图集里对应地形 tone 的 tile
      const tile = groundTileUV(groundToneOf(terrainId));
      const base = vi;
      // 四角顺序：左上 → 右上 → 右下 → 左下
      const corners = [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]];
      for (let k = 0; k < 4; k++) {
        const [gx, gy] = corners[k];
        const o3 = (vi + k) * 3, o2 = (vi + k) * 2;
        positions[o3] = gx - 0.5 - c;
        positions[o3 + 1] = H(gx, gy);
        positions[o3 + 2] = gy - 0.5 - c;
        const nrm = normalAt(gx, gy);
        normals[o3] = nrm[0]; normals[o3 + 1] = nrm[1]; normals[o3 + 2] = nrm[2];
        colors[o3] = Math.min(1, rgb[0] * tone);
        colors[o3 + 1] = Math.min(1, rgb[1] * tone);
        colors[o3 + 2] = Math.min(1, rgb[2] * tone);
        // 格内局部 0..1 → tile 的 UV 区域
        uvs[o2] = tile.u0 + (gx - x) * (tile.u1 - tile.u0);
        uvs[o2 + 1] = tile.v0 + (gy - y) * (tile.v1 - tile.v0);
      }
      // 绕向要朝上（从上方看是逆时针），否则正面剔除会把整块地表剔掉
      indices[ii] = base; indices[ii + 1] = base + 2; indices[ii + 2] = base + 1;
      indices[ii + 3] = base; indices[ii + 4] = base + 3; indices[ii + 5] = base + 2;
      vi += 4; ii += 6;
    }
  }
  return { positions, normals, colors, uvs, indices, cellCount: n };
}

/**
 * 造一层"铺在地上的高亮片"（可走格 / 可打目标 / 鼠标悬停）。
 * 每格一片，**比格子本身缩小一点**（inset），这样相邻格的高亮不会糊成一大块；
 * 高度跟着地表起伏走（双线性插值），再抬高一点点，免得和地面打架（z-fighting）。
 * @param {Array<{x:number,y:number}>} cells
 */
export function buildOverlayGeometry(grid, cells, { size = MAP_SIZE, lift = 0.016, inset = 0.12 } = {}) {
  const list = Array.isArray(cells) ? cells : [...(cells || [])];
  const n = list.length;
  const positions = new Float32Array(Math.max(1, n) * 12);
  const indices = new Uint16Array(Math.max(1, n) * 6);
  const c = (size - 1) / 2;
  const H = (gx, gy) => cornerRelief(grid, gx, gy);

  for (let i = 0; i < n; i++) {
    const { x, y } = list[i];
    const h00 = H(x, y), h10 = H(x + 1, y), h11 = H(x + 1, y + 1), h01 = H(x, y + 1);
    const bil = (u, v) => h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h11 * u * v + h01 * (1 - u) * v;
    const lo = inset, hi = 1 - inset;
    const pts = [[lo, lo], [hi, lo], [hi, hi], [lo, hi]];
    for (let k = 0; k < 4; k++) {
      const u = pts[k][0], v = pts[k][1];
      const o3 = (i * 4 + k) * 3;
      positions[o3] = x - 0.5 - c + u;
      positions[o3 + 1] = bil(u, v) + lift;
      positions[o3 + 2] = y - 0.5 - c + v;
    }
    const b = i * 4, o = i * 6;
    indices[o] = b; indices[o + 1] = b + 2; indices[o + 2] = b + 1;
    indices[o + 3] = b; indices[o + 4] = b + 3; indices[o + 5] = b + 2;
  }
  return { positions, indices, count: n };
}

/**
 * 地块边界分类（用于"一眼看出能走 / 特殊 / 不能走"）：
 *   walk     普通可走：只画整图统一的淡格线
 *   special  特殊地块：发光粗描边，颜色按地形（灵脉金 / 阵纹紫 / 水洼蓝 / 险地橙）
 *   blocked  不可走（耸峰）：醒目红色粗描边
 */
export const TILE_BORDER_COLOR = {
  blocked: '#ff5348',
  灵脉: '#ffd76a',
  阵纹: '#c99bff',
  水洼: '#69c8ff',
  险地: '#ff9a4d',
};

/** 某地块的边界类别与描边色（纯函数，渲染层与图例共用）。 */
export function tileBorderOf(terrainId) {
  const t = terrainOf(terrainId);
  if (!t.passable) return { cls: 'blocked', color: TILE_BORDER_COLOR.blocked };
  if (terrainId === '灵脉') return { cls: 'special', color: TILE_BORDER_COLOR.灵脉 };
  if (terrainId === '阵纹') return { cls: 'special', color: TILE_BORDER_COLOR.阵纹 };
  if (terrainId === '水洼') return { cls: 'special', color: TILE_BORDER_COLOR.水洼 };
  if (terrainId === '毒沼' || terrainId === '沼泽') return { cls: 'special', color: TILE_BORDER_COLOR.险地 };
  return { cls: 'walk', color: null };
}

/**
 * 整图统一的淡格线（所有格子的 X/Z 网格线，一次 LineSegments 画完）。
 * 只给"普通可走"区域打底，让一格一格看得清、又不抢眼。
 * @returns {Float32Array} 线段顶点（每段两个点）
 */
export function buildGridLinePositions(grid, size = MAP_SIZE, lift = 0.024) {
  const c = (size - 1) / 2;
  const H = (gx, gy) => cornerRelief(grid, gx, gy);
  const yAt = (wx, wz) => {
    const fx = wx + c + 0.5, fz = wz + c + 0.5;
    let gx = Math.min(size, Math.max(0, Math.floor(fx)));
    let gz = Math.min(size, Math.max(0, Math.floor(fz)));
    const u = fx - gx, v = fz - gz;
    const gx1 = Math.min(size, gx + 1), gz1 = Math.min(size, gz + 1);
    return H(gx, gz) * (1 - u) * (1 - v) + H(gx1, gz) * u * (1 - v)
      + H(gx1, gz1) * u * v + H(gx, gz1) * (1 - u) * v;
  };
  const positions = [];
  for (let i = 0; i <= size; i++) {
    const w = i - 0.5 - c;
    // 横线（沿 x，固定 z=w）
    positions.push(-c - 0.5, yAt(-c - 0.5, w) + lift, w, c + 0.5, yAt(c + 0.5, w) + lift, w);
    // 竖线（沿 z，固定 x=w）
    positions.push(w, yAt(w, -c - 0.5) + lift, -c - 0.5, w, yAt(w, c + 0.5) + lift, c + 0.5);
  }
  return new Float32Array(positions);
}

/**
 * 特殊 / 不可走地块的"发光粗描边"：每格一圈 4 条贴地 quad，顶点色按地形上色。
 * 全部合并进一个 BufferGeometry（顶点色），一次 draw call。
 * @returns {{positions:Float32Array, colors:Float32Array, indices:Uint32Array, count:number}}
 */
export function buildTileBorderGeometry(grid, { size = MAP_SIZE, lift = 0.034, inset = 0.02, width = 0.1 } = {}) {
  const c = (size - 1) / 2;
  const H = (gx, gy) => cornerRelief(grid, gx, gy);
  const yAt = (wx, wz) => {
    const fx = wx + c + 0.5, fz = wz + c + 0.5;
    let gx = Math.min(size, Math.max(0, Math.floor(fx)));
    let gz = Math.min(size, Math.max(0, Math.floor(fz)));
    const u = fx - gx, v = fz - gz;
    const gx1 = Math.min(size, gx + 1), gz1 = Math.min(size, gz + 1);
    return H(gx, gz) * (1 - u) * (1 - v) + H(gx1, gz) * u * (1 - v)
      + H(gx1, gz1) * u * v + H(gx, gz1) * (1 - u) * v;
  };
  const positions = [], colors = [], indices = [];
  let vbase = 0;
  const rgb = rgbOf;
  const addQuad = (x0, z0, x1, z1, [r, g, b]) => {
    const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
    for (const [wx, wz] of corners) positions.push(wx, yAt(wx, wz) + lift, wz);
    for (let k = 0; k < 4; k++) colors.push(r, g, b);
    indices.push(vbase, vbase + 2, vbase + 1, vbase, vbase + 3, vbase + 2);
    vbase += 4;
  };
  let count = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const binfo = tileBorderOf(grid[y][x]);
      if (binfo.cls === 'walk') continue;
      const x0 = x - 0.5 - c + inset, x1 = x + 0.5 - c - inset;
      const z0 = y - 0.5 - c + inset, z1 = y + 0.5 - c - inset;
      const col = rgb(binfo.color);
      addQuad(x0, z0, x1, z0 + width, col);           // 下边
      addQuad(x0, z1 - width, x1, z1, col);           // 上边
      addQuad(x0, z0, x0 + width, z1, col);           // 左边
      addQuad(x1 - width, z0, x1, z1, col);           // 右边
      count++;
    }
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    count,
  };
}

/** '#8fae5e' → [0.56, 0.68, 0.37]，0~1 的分量。 */
export function rgbOf(hex) {
  const n = hexToInt(hex);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// ============================================================
// 八、坐标换算
// ============================================================
// 世界坐标：棋盘正中是原点，一格＝1 个单位，格子 (x,y) 的中心在
//   worldX = x - (size-1)/2     worldZ = y - (size-1)/2
// 地图的 +y 对应世界的 +z（"往下走"＝"往镜头这边走"），+x 就是 +x。

export function cellToWorld(x, y, size = MAP_SIZE) {
  const c = (size - 1) / 2;
  return { x: x - c, z: y - c };
}

/** 世界坐标 → 格子号（四舍五入到最近的格）。越界返回 null。 */
export function worldToCell(wx, wz, size = MAP_SIZE) {
  const c = (size - 1) / 2;
  const x = Math.round(wx + c);
  const y = Math.round(wz + c);
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  return { x, y };
}

/** 地表在该格中心的高度（格的 relief ＋ 格内的微小起伏）。 */
export function cellTopY(terrainId, x, y) {
  return lookOf(terrainId).relief + (cellRand(x, y, 900) - 0.5) * 0.012;
}

// ============================================================
// 九、朝向 → 绕竖轴的角度
// ============================================================
/**
 * 一个人的朝向（地图坐标里的 {x,y}，八方向）→ 绕竖轴转多少弧度。
 *
 * 约定：**地面上的东西（朝向圈、地板贴片）与小人共用这一个函数**，都按「局部 +z 就是脸朝的方向」来建模。
 * 推导：把「朝 +z」的基准绕竖轴转 θ 之后指向 (sinθ, 0, cosθ)，要让它等于 (fx, 0, fy)，
 *       就得 θ = atan2(fx, fy)。
 * 地图的 +y 对应世界的 +z，所以朝地图下方（+y）＝朝镜头，转 180°；朝 +x ＝转 90°，都对得上。
 */
export function facingYawRad(facing) {
  const fx = Number(facing?.x) || 0;
  const fy = Number(facing?.y) || 0;
  if (!fx && !fy) return 0;
  return Math.atan2(fx, fy);
}

/**
 * 小人模型的朝向修正：模型自己的"脸"未必朝着 +z，实测后在这里补一个角度。
 * 补 0 = 模型本来就面朝 +z；补 π = 模型面朝 −z。改这一个数就能整体翻面。
 */
export const CHARACTER_YAW_OFFSET = 0;

/** 小人该转多少（朝向 ＋ 模型自身的修正）。 */
export function characterYawRad(facing) {
  return facingYawRad(facing) + CHARACTER_YAW_OFFSET;
}

/** 一圈里"背面"占多少（与引擎判定共用 battleGrid 的常量，见那里的 45°）。 */
export const FACING_BACK_HALF_DEG = 45;

// ============================================================
// 十、小人：分模型 & 选动作
// ============================================================

const isFemaleGender = (g) => /女/.test(String(g || ''));
const isMaleGender = (g) => /男/.test(String(g || ''));

/**
 * 给每个参战者分一个 VRM 模型（2026-09-20：性别感知）。
 *  · 女角色 → 女池、男角色 → 男池、性别「无/未知」→ 全池；
 *  · 同一池内按 id 哈希定起点、撞了顺延，所以同池人数 ≤ 模型数时**不会重脸**；
 *  · 某一性别人数超过该池（池被占满）时，再从全池里挑未用的；实在全占满（人数 > 模型总数）
 *    才允许重复 —— 无论哪种都保证每个人都分到模型，且同一局结果确定（按 id 排序）。
 * @returns {Record<string,string>} id → VRM 名
 */
export function assignCharacterModels(units) {
  const list = [...(units || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const used = new Set();
  const map = {};
  // 在 pool 里按哈希挑一个**尚未使用**的；全用过则返回 null（交给上层回退）
  const pickFree = (pool, u) => {
    if (!pool.length) return null;
    let i = Math.floor(strRand(u.id) * pool.length) % pool.length;
    for (let k = 0; k < pool.length; k++) {
      if (!used.has(pool[i])) return pool[i];
      i = (i + 1) % pool.length;
    }
    return null;
  };
  for (const u of list) {
    let pool;
    if (isFemaleGender(u.gender)) pool = VRM_FEMALE_FILES;
    else if (isMaleGender(u.gender)) pool = VRM_MALE_FILES;
    else pool = CHARACTER_MODEL_FILES;
    let m = pickFree(pool, u);
    if (m == null) m = pickFree(CHARACTER_MODEL_FILES, u);
    if (m == null) {
      // 人数多于模型总数：按哈希重复一个（确定性）
      m = CHARACTER_MODEL_FILES[Math.floor(strRand(u.id) * CHARACTER_MODEL_FILES.length) % CHARACTER_MODEL_FILES.length];
    }
    used.add(m);
    map[u.id] = m;
  }
  return map;
}

/** 模型自带的动画名（12 个小人共用同一套）。 */
export const CLIPS = {
  idle: 'idle',
  walk: 'walk',
  die: 'die',
};

/**
 * 退出战斗的人摆什么姿势。
 * 引擎的"退出"只表示不再出手，人还留在原格上（褪色 ＋ 状态牌），所以姿势要跟原因对上：
 *   死亡 → 倒地不起（停在最后一帧，不循环）
 *   投降 → 坐下
 *   逃遁 / 伤重不支 / 被逼入绝境 → 蹲身
 */
export function downClipFor(outReason) {
  if (outReason === '死亡') return 'die';
  if (outReason === '投降') return 'sit';
  return 'crouch';
}

/** 退场后姿势要停在最后一帧（倒地不能爬起来循环）。 */
export const HOLD_LAST_FRAME = new Set(['die', 'sit', 'crouch']);

// ---------- 动捕动作的节奏：**量出来的，不许拍脑袋** ----------
// 为什么要有这几个数：引擎是「一点就算完」的，可画面上必须按先后演 ——
// 先走过去、站稳、再出手，手真打到人身上那一刻伤害数字才冒出来。
// 于是必须知道「一段动作播到第几成算真打中」。量法：
// 把 FBX 真播一遍，逐帧取出招那只手相对髋部的前伸量（沿角色朝向），取峰值所在的那一帧。
//   近战 57.5%（右拳伸到最远）｜远程 50.4%（掌推出去、法力离体）｜防御 23.8%（护架抬到位）
// 换了素材就要重新量一遍、把数改回来 —— 数错的表现就是「手还没打出去，伤害数字先弹」。
export const ACTION_IMPACT = { melee: 0.575, ranged: 0.504, block: 0.238 };

// 「护架怎么保持」不在这里定：保持用的那个姿势直接取上面 ACTION_IMPACT.block 那一帧
//（同一份量测出来的数，不另立一个），冻成静止片段的做法见 three/mixamoRig.freezeClip。

/** 动作片段没烤出来时的兜底时长（毫秒）。只影响观感时长，不影响任何数值。 */
export const ACTION_FALLBACK_MS = 800;

/**
 * 一段动作「播多久」与「第几秒算打中」。
 * @param {string} style 'melee' | 'ranged' | 'block' | 其它
 * @param {number} duration 该片段真实时长（秒）；拿不到就按兜底值
 * @returns {{dur:number, impact:number}} 单位都是秒
 */
export function actionTiming(style, duration) {
  const dur = Number.isFinite(duration) && duration > 0 ? duration : ACTION_FALLBACK_MS / 1000;
  const frac = ACTION_IMPACT[style];
  return { dur, impact: dur * (frac == null ? 0.5 : frac) };
}

/**
 * 「跑一格要多久」不是拍出来的，是动作自己说出来的。
 *
 * 素材里人物跑一个循环，髋部被带着往前走了 travel 个单位、用了 duration 秒；
 * 那么棋盘上就该每秒走 travel×模型缩放/duration 格 —— 这样每一脚都踩在实地上
 * （不会脚在原地打滑），也不会因为棋盘走得比动作慢而变成慢动作。
 * @param {{travel:number,duration:number}|null} runInfo 由 mixamoRig 量出
 * @param {number} modelScale 该角色 VRM 缩放到战场尺度用的倍率
 * @returns {number|null} 格/秒；量不出来返回 null（调用方退回默认值）
 */
export function runSpeedOf(runInfo, modelScale) {
  if (!runInfo || !(runInfo.duration > 0) || !(runInfo.travel > 0)) return null;
  const s = (runInfo.travel * (Number(modelScale) || 1)) / runInfo.duration;
  return Number.isFinite(s) && s > 0 ? s : null;
}

// ---------- 动作素材自带的那段「向前走」：先量出来，再抹掉 ----------
// 为什么要有这两步：Mixamo 的跑动素材是「带位移」的 —— 一个循环里髋部被动画带着往前挪一段。
// 重定向到 VRM 之后这段位移仍然在轨上。若不处理，人物每个循环都会被动作推着往前飘一截，
// 再叠加棋盘自己算的走位 ⇒ 看着像被风吹着滑过去。
// 所以：**先量**（量出来的距离决定棋盘每秒走几格，脚步才不打滑）→ **再抹**（位置交给棋盘决定）。
// values 是扁平排列的位移轨数据 [x,y,z, x,y,z, ...]。
// 这两个函数放在这一层（纯算术、不碰 three）是为了能在 node 里直接断言 —— 尤其
// removePlanarDrift 那条「不许动 Y」的规矩，一旦破了人就被按进地里，肉眼很难一眼看出。

/** 一个循环里髋部水平走了多远（只看 X/Z，Y 轴上下起伏不算路程）。 */
export function measurePlanarTravel(values) {
  const n = Math.floor((values?.length || 0) / 3);
  if (n < 2) return 0;
  const last = (n - 1) * 3;
  return Math.hypot(values[last] - values[0], values[last + 2] - values[2]);
}

/**
 * 抹掉「动作自带的向前走」：逐帧减去首末的线性趋势，**只动水平两轴**。
 * ⚠️ 下标 1（y）是髋部的绝对高度（站立约 0.9 米），碰一下人就被按进地里 —— 所以循环只跑 [0, 2]。
 * @returns {boolean} 是否真的改动了（全零位移的片段不用改）
 */
export function removePlanarDrift(values) {
  const n = Math.floor((values?.length || 0) / 3);
  if (n < 2) return false;
  const last = (n - 1) * 3;
  let touched = false;
  for (const off of [0, 2]) {
    const d = values[last + off] - values[off];
    if (!d) continue;
    touched = true;
    for (let i = 0; i < n; i++) values[i * 3 + off] -= d * (i / (n - 1));
  }
  return touched;
}


/**
 * 出手用哪只手挥。纯看"目标在我的左手边还是右手边"——只是个观感，不影响结算。
 * 算法：把"我 → 目标"的方向投到我的右手方向上。
 *   前方向是 (fx, 0, fy)、上方是 (0,1,0)，右手方向就是两者的叉积 = (−fy, 0, fx)，
 *   投到地图坐标（+y 即世界的 +z）就是 (−fy, fx)。
 *   验算：面朝 +x（地图向右）时右手指向地图 +y（向下），与"面朝东、右手朝南"一致。
 */
export function attackClip(facing, from, to) {
  const fx = Number(facing?.x) || 1, fy = Number(facing?.y) || 0;
  const dx = (to?.x ?? 0) - (from?.x ?? 0);
  const dy = (to?.y ?? 0) - (from?.y ?? 0);
  const rightDot = (-fy) * dx + fx * dy;
  return rightDot >= 0 ? 'attack-melee-right' : 'attack-melee-left';
}

/**
 * 退出战斗的人该写什么字。
 * 「退出战斗」是引擎的记法（退出 = 不再出手、不再被计算），但在画面上他必须**继续留在原格**，
 * 所以界面上要说人话：死亡＝已陨落、逃遁＝已遁走，其余（重伤昏迷 / 被逼入绝境）＝已倒下。
 */
export function outLabel(u) {
  if (u?.outReason === '死亡') return '已陨落';
  if (u?.outReason === '逃遁') return '已遁走';
  if (u?.outReason === '投降') return '已投降';
  return '已倒下';
}

/** 退出原因 → 棋子该被压暗到什么程度（0 = 完全透明，1 = 原色）。 */
export function outFade(u) {
  if (u?.outReason === '死亡') return 0.45;     // 陨落的压得最暗
  if (u?.outReason === '逃遁') return 0.30;     // 遁走的淡到近乎虚影
  return 0.55;
}

/**
 * VRM 角色最终身高（格为单位）。VRM 原生约 1.6 世界单位（真人比例），
 * 一格约当一丈/一米见方，人物约 1.55 格高最自然（也比旧的 0.85 低模清楚得多）。
 */
export const VRM_TARGET_H = 1.55;
/** 名字牌挂的高度（约在头顶）。 */
export const UNIT_TAG_Y = 1.50;
/** 伤害数字飘的高度（头顶再往上一点）。 */
export const UNIT_DMG_Y = 1.74;

/** 小人脚下的朝向圈半径（格为单位）。 */
export const FACING_RING_RADIUS = 0.40;

// ============================================================
// 十一、相机与投影
// ============================================================
// 视角沿用玩家已经熟悉的那三个数（俯角 rx / 方位 rz / 远近 zoom），
// 只是这次真的喂给透视相机，而不是 CSS 的 rotate。
// zoom 的含义：**1 = 刚好把整块棋盘装满画面**，比 1 大＝凑近看细节（边缘会出画，这是玩家自己要的），
// 比 1 小＝退远看全局。所以默认就是 1，而不是以前那个 0.7。
export const CAM_DEFAULT = { rx: 54, rz: 45, zoom: 1, panX: 0, panZ: 0 };
export const CAM_RX_MIN = 18, CAM_RX_MAX = 82;
/**
 * 远近档的范围。**1 = 刚好把整块棋盘装进画面**，比 1 大＝凑近看细节（棋盘会被裁掉，这是玩家自己要的）。
 *
 * 上限为什么是 16（2026-09-20 从 3 抬到这里）：3 倍时相机离棋盘还有 17 格，
 * 一个 1.55 格高的人在 820px 高的画面上只有 100px 上下、脸约 17px —— 玩家原话是
 * 「300% 放大但是根本看不清人物的脸」。16 倍时相机离人 3.25 格，人占画面高约 66%、
 * 脸约 90px，这才是真的能看清。**但这个数只有在取景公式修好之后才有意义**：
 * 老写法把 zoom 塞进取景迭代里，凑近之后最近的角会跑到镜头背后，迭代直接发散，
 * 实测 zoom 2.75 起距离反而变大、zoom 3 时相机被扔到 1252 格之外 —— 也就是玩家报的
 * 「滚轮到 280% 之后地图越拉越远」（详见 frameBoard）。
 */
export const CAM_ZOOM_MIN = 0.5, CAM_ZOOM_MAX = 16;
/**
 * 凑近看人时，镜头（连同它盯的那一点）整体抬高多少格。
 * 为什么要有它：相机永远盯着"地面上那个点"，凑近之后画面上半截全是空气，
 * 人物的头会顶出画面 —— 低俯角下更是只看得见腰腿。0.85 格 ≈ 成年人胸口高度（一格＝一米），
 * 抬到这里，人正好落在画面正中，脸对着镜头。
 */
export const CAM_CLOSE_LIFT_Y = 0.85;
/**
 * 放到几倍才算"就是来看人的"：到这个倍数，视线才完全抬到胸口高度。
 * 倍数以下按比例过渡（1 倍时一点不抬，保证拉远看全局时棋盘仍然居中）。
 */
export const CAM_ZOOM_LOOK_UP = 6;
/** 平移（pan）最多把视野中心挪出棋盘中心多远（世界单位＝格）。约半张地图，保证不会彻底看不到棋盘。 */
export const CAM_PAN_MAX = MAP_SIZE * 0.55;
export const CAM_FOV = 40;
// 取景要把「棋盘上所有能看见的东西」都框进去，所以得知道它们的上下边界。
// 这两个数不是拍脑袋来的：把 12 种地形 × 225 格全跑一遍 propsForCell，量出真实包络 ——
//   最高的东西 1.815（树林里的松树，不是山；山只到 1.626）
//   最低的东西：棋盘本身那块土（下到 −0.76）比任何摆件都低（摆件最低只到 −0.146）
// 量测脚本见 _unused/battletest/envelope.js 与 slabbottom.js；
// scene.probe 里有断言盯着它们，将来谁把树调高、或把土加厚，都会当场炸。
/**
 * 棋盘下面那层土的厚度。**渲染层画那块土用的就是这个数**（BattleScene3D 从这里导入），
 * 取景的底线也照它算 —— 一个数一个出处，不会两边各改各的。
 */
export const BASE_THICK = 0.7;
/** 棋盘下方要留的高度 = 土的厚度 ＋ 地表最低那档起伏（向下的坑）＋ 一点余量。 */
export const BOARD_THICK = BASE_THICK + Math.abs(Math.min(...Object.values(TERRAIN_LOOK).map(l => l.relief))) + 0.05;
/** 棋盘上方要留的高度（够装下最高的树）。 */
export const BOARD_TOP_Y = 1.90;
/** 取景留白：相机退到"刚好框住"的距离之上再乘这个系数，1.12 = 画面四周各留约 6%。 */
export const CAM_FIT_PAD = 1.12;

/** 视角数字：允许缺省，但**不许把 0 当成"没传"**（0 是合法的极值，会被夹到边界）。 */
const num = (v, d) => {
  if (typeof v === 'string' && v.trim() === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function clampView(v) {
  return {
    rx: clamp(num(v?.rx, CAM_DEFAULT.rx), CAM_RX_MIN, CAM_RX_MAX),
    rz: ((num(v?.rz, 0) % 360) + 360) % 360,
    zoom: clamp(num(v?.zoom, CAM_DEFAULT.zoom), CAM_ZOOM_MIN, CAM_ZOOM_MAX),
    panX: clamp(num(v?.panX, 0), -CAM_PAN_MAX, CAM_PAN_MAX),
    panZ: clamp(num(v?.panZ, 0), -CAM_PAN_MAX, CAM_PAN_MAX),
  };
}

/** 当前视角的三个画面坐标轴：往右 r / 往上 u / 往里 f，外加相机位置相对棋盘中心的方向 dir。 */
function axesOf(view) {
  const v = clampView(view);
  const p = v.rx * RAD;
  const a = v.rz * RAD;
  const dir = [Math.cos(p) * Math.sin(a), Math.sin(p), Math.cos(p) * Math.cos(a)];
  return {
    dir,
    right: [Math.cos(a), 0, -Math.sin(a)],
    up: [-Math.sin(a) * Math.sin(p), Math.cos(p), -Math.cos(a) * Math.sin(p)],
    forward: [-dir[0], -dir[1], -dir[2]],
    tan: Math.tan(CAM_FOV / 2 * RAD),
  };
}

/**
 * 「刚好把整块棋盘框住、并且横竖都居中」要退多远 —— **按 zoom = 1 算的基准取景**。
 * 算出 dist＝相机距离，offX/offY＝镜头沿"画面往右/往上"要挪多少。
 *
 * ① 退多远：把棋盘看成一个长方体 —— 横向半边长 = 棋盘的半个边长，高度下到
 *    −BOARD_THICK（山底座扎进地里那截）、上到 BOARD_TOP_Y（最高的那棵树）。
 *    取它的八个角，逐个问「这个角要留在画面里，相机至少得多远」，取最苛刻的那个。
 *    ⚠ 这两个预留值是量出来的，不是估的：改高任何摆件都要同步改它，否则低角度下会切掉树梢
 *    （scene.probe 里有一条断言盯着，见 _unused/battletest/envelope.js）。
 * ② 挪多少：先当镜头瞄着棋盘正中，再看这八个角投在画面上偏了多少，把镜头整个挪回去，
 *    让棋盘在画面里**横竖都居中**。这一步不能省 —— 离镜头近的那头角离得近，
 *    投影被透视放大，只做 ① 会让棋盘沉到画面下半截、还偏到一边去（早期实拍就是这样）。
 *
 * ① 和 ② 互相牵动（挪镜头就改变了要退多远；把相机拉远，居中该挪的量也跟着变），
 * 所以一遍遍来回算到不再变为止 —— 收敛条件就是"已经居中了"，所以停下来时一定是对的。
 *
 * ⚠ **这个函数只能在"整块棋盘都装得下"的前提下算**（也就是 zoom = 1 的那份基准）。
 * 它的居中式迭代有个隐含前提：八个角都在镜头**前方**（进深 > 0）。一旦相机凑得比棋盘还近，
 * 最近的角会跑到镜头背后（进深 ≤ 0），(偏出量 ÷ 进深) 就翻了符号，居中那一步的增益 > 1，
 * 迭代发散 —— 实测：zoom 2.75 时距离不降反升，zoom 3 时相机被扔到 1252 格之外（棋盘只剩 2% 画面），
 * 低俯角下相邻视角之间 off 值能跳 132 格。玩家看到的正是「滚轮到 280% 之后地图越拉越远」
 * 和「一拖右键地图上下乱飞」。所以**远近档一律不进这个函数**，由 frameBoard 在外面整体缩放。
 *
 * @param {number} pad 留白系数，见 CAM_FIT_PAD
 * @returns {{dist:number, offX:number, offY:number}}
 */
function fitBoardFull(v, size = MAP_SIZE, aspect = 1.6, pad = CAM_FIT_PAD) {
  const ax = axesOf(v);
  const tanX = ax.tan * Math.max(aspect, 0.2);  // 横向能容下多少（aspect = 宽/高，太窄就按 0.2 兜底）
  const h = size / 2;
  // 八个角先各自算好「进深 / 左右偏出多少 / 上下偏出多少」——这三个量都与相机远近无关，
  // 只有进深要加上相机后退的距离，所以扫描一遍就够了。
  const P = [];
  for (const x of [-h, h]) {
    for (const z of [-h, h]) {
      for (const y of [-BOARD_THICK, BOARD_TOP_Y]) {
        P.push([
          x * ax.forward[0] + y * ax.forward[1] + z * ax.forward[2],
          x * ax.right[0] + z * ax.right[2],
          x * ax.up[0] + y * ax.up[1] + z * ax.up[2],
        ]);
      }
    }
  }
  let offX = 0, offY = 0, dist = 0;
  // 一遍遍算到不再变为止（俯角越低、透视越强，收敛越慢；上限 12 遍只是防呆，正常三遍就稳了）
  for (let round = 0; round < 12; round++) {
    const prevX = offX, prevY = offY;
    dist = 0;
    for (const c of P) {
      // 角的进深是 c[0] + dist，偏出画面中线的量不能超过进深 × 半张角
      dist = Math.max(dist, Math.abs(c[1] - offX) / tanX - c[0], Math.abs(c[2] - offY) / ax.tan - c[0]);
    }
    dist = dist * pad;      // 留白在这里就生效 —— 后面居中要按最终距离来算
    let loX = Infinity, hiX = -Infinity, loY = Infinity, hiY = -Infinity;
    for (const c of P) {
      const z = c[0] + dist;
      const nx = (c[1] - offX) / (z * tanX);   // 画面上的横向位置，±1 = 左右边缘
      const ny = (c[2] - offY) / (z * ax.tan); // 纵向位置，±1 = 上下边缘
      if (nx < loX) loX = nx;
      if (nx > hiX) hiX = nx;
      if (ny < loY) loY = ny;
      if (ny > hiY) hiY = ny;
    }
    // 棋盘整个偏了多少，把镜头往反方向挪同样的量（挪动量与画面上的偏移成正比）
    offX += (loX + hiX) / 2 * dist * tanX;
    offY += (loY + hiY) / 2 * dist * ax.tan;
    if (Math.abs(offX - prevX) < dist * 1e-6 && Math.abs(offY - prevY) < dist * 1e-6) break;
  }
  return { dist, offX, offY };
}

/**
 * 玩家的远近档怎么作用到取景上：**先按"整块棋盘刚好装满"算出基准，再整体按 1/zoom 缩放**。
 * 距离、以及为了居中而平移镜头的量，一起按同一个倍数缩 —— 于是画面上的构图完全不变，
 * 只是越凑越近（棋盘被裁掉、中心那块地始终钉在画面正中）。
 *
 * 为什么不像老写法那样把 zoom 塞进迭代里：见 fitBoardFull 上面那段（凑近之后迭代会发散，
 * 那正是「越拉越远」和「右键乱飞」的根）。缩放是线性的，zoom 再大也不会退化成负距离。
 *
 * @returns {{dist:number, offX:number, offY:number}} dist = 相机距离，offX/offY = 镜头横向/纵向挪的量
 */
export function frameBoard(view, size = MAP_SIZE, aspect = 1.6, pad = CAM_FIT_PAD) {
  const v = clampView(view);
  const ref = fitBoardFull(v, size, aspect, pad);
  const z = v.zoom > 1e-6 ? v.zoom : 1;
  return { dist: ref.dist / z, offX: ref.offX / z, offY: ref.offY / z };
}

/**
 * 相机摆在哪、朝哪看。
 *
 * 距离不写死：先由 frameBoard 按「整块棋盘刚好装满画面」算出基准距离与居中偏移，
 * 再整体按 1/zoom 缩（远近档），最后叠上 pan 与「凑近时抬视线」。
 * （俯角 rx 直接当仰角用：rx 越大相机越高、越接近俯视。）
 * 注意 target 不一定是棋盘正中 —— 为了把棋盘摆在画面中央，镜头是整体挪过的，
 * 渲染那一层必须用这里返回的 target 去看，否则 DOM 上的名字牌会和画面错位。
 *
 * @returns {{pos:number[], target:number[], fov:number, tan:number, aspect:number,
 *            right:number[], up:number[], forward:number[], dist:number}}
 */
export function viewBasis(view, size = MAP_SIZE, aspect = 1.6) {
  const v = clampView(view);
  const { dir, right: r, up: u, forward: f, tan } = axesOf(v);
  const fr = frameBoard(v, size, aspect);
  const dist = fr.dist;    // 留白与远近档已经在 frameBoard 里算进去了
  const pos = [
    dir[0] * dist + r[0] * fr.offX + u[0] * fr.offY,
    dir[1] * dist + r[1] * fr.offX + u[1] * fr.offY,
    dir[2] * dist + r[2] * fr.offX + u[2] * fr.offY,
  ];
  const target = [pos[0] + f[0] * dist, pos[1] + f[1] * dist, pos[2] + f[2] * dist];
  // 平移（pan）：把相机和注视点整体在地面（XZ）上挪动同样的量 —— 等价于移动视野中心。
  // frameBoard 仍按"框住整块棋盘"算基准，pan 只在最终结果上偏移，所以缩放/旋转逻辑不受影响。
  const panX = v.panX, panZ = v.panZ;
  // 凑近看人时，视线整体抬到胸口高度（相机与注视点一起抬，方向不变）。
  // 为什么不是"把注视点单独抬一下"：projectPoint（名字牌/伤害数字用它贴到人头上）拼的是
  // pos + forward/right/up 这套正交基，只抬注视点就等于偷偷改了朝向，DOM 和 3D 会错位。
  // 一起抬就只是"整幅画面上下平移"，投影那套仍然自洽。
  const visH = 2 * dist * tan;                        // 这个距离上画面能装多高（世界单位）
  const near = clamp((v.zoom - 1) / (CAM_ZOOM_LOOK_UP - 1), 0, 1);
  const lift = CAM_CLOSE_LIFT_Y * near;
  const posP = [pos[0] + panX, pos[1] + lift, pos[2] + panZ];
  const targetP = [target[0] + panX, target[1] + lift, target[2] + panZ];
  return { pos: posP, target: targetP, fov: CAM_FOV, tan, aspect, right: r, up: u, forward: f, dist, visH, lift };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * 世界坐标 → 屏幕上第几%。镜头背后的点返回 null（要藏起来）。
 * 界面上的名字牌、血条、伤害数字都靠它贴到人头上 —— 与 three 用同一套相机参数，
 * 所以 DOM 层和 3D 层永远不会各说各话。
 * @param {number[]} pt [x,y,z]
 * @returns {{left:number, top:number, depth:number}|null} left/top 为 0~100 的百分比
 */
export function projectPoint(pt, basis) {
  const d = sub(pt, basis.pos);
  const z = dot(d, basis.forward);
  if (!(z > 0.05)) return null;
  const x = dot(d, basis.right);
  const y = dot(d, basis.up);
  const ndcX = x / (z * basis.tan * (basis.aspect || 1.6));
  const ndcY = y / (z * basis.tan);
  return { left: (ndcX + 1) / 2 * 100, top: (1 - ndcY) / 2 * 100, depth: z };
}

/** 一个人头顶上方那个点（名字牌/血条挂这儿）。 */
export function unitTagAnchor(unit, size = MAP_SIZE) {
  const w = cellToWorld(unit.x, unit.y, size);
  return [w.x, UNIT_TAG_Y, w.z];
}

// 注：不再提供"棋盘正中的那个点"。相机瞄哪儿由 viewBasis 的 target 决定（为了取景居中，
// 它一般不在正中央），谁需要"看哪儿"就去问 viewBasis，别再拿棋盘中心代替。
