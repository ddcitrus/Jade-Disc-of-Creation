// ===== 立体战场：真的用 three.js 画一个 3D 场景 =====
// 需求：「从网上找山体、草地等 3D 模型，让场景完全变成 3D」。
//
// 这一层只负责"画"和"点"：
//   · 把 battleSceneModels.js 算好的地表、摆件、朝向、相机参数交给 three
//   · 把鼠标点击翻译成「点到了哪一格」（射线拾取），其余什么都不算
//   · 名字牌 / 血条 / 伤害数字做成贴在画面上的 DOM 层 —— 3D 里画字要么糊成贴图、
//     要么得引进字体文件；DOM 层的字永远清晰，代价只是每帧更新几个 left/top
//
// 四条硬约束：
//   ① **渲染只能在 useEffect 里做**。SSR（回归测试）不跑 useEffect，所以服务端渲染出来的
//      只是「一个空容器 ＋ 名字牌」，不会因为拿不到 WebGL 而抛异常。
//   ② **确定性**。摆哪个模型、转多少度全部来自哈希（见 battleSceneModels），
//      这里一个 Math.random 都不许有，否则每次重渲染整片林子都会跳。
//   ③ **拾取要准**。射线不只打地表，还要打摆件和小人 —— 只打地表的话，点在树冠上会
//      穿过树打到它**后面**那一格，"点树想挪过去"就永远挪错地方。
//   ④ **只清自己造的东西**。模型库是全局缓存、反复进出战斗复用，清场时若把它的
//      几何/材质一起 dispose 掉，第二次进战斗整场就全是空白。

import React, { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMUtils } from '@pixiv/three-vrm';
import {
  TERRAIN_LOOK, NATURE_MODEL_FILES, MEGAKIT_MODEL_FILES, modelUrl, mkUrl,
  buildTileGeometry, buildOverlayGeometry, propsForCell, cellTopY, cellRand,
  cellToWorld, worldToCell, facingYawRad, characterYawRad, assignCharacterModels,
  downClipFor, outLabel, outFade, FACING_RING_RADIUS,
  vrmUrl, VRM_TARGET_H, UNIT_TAG_Y, UNIT_DMG_Y,
  viewBasis, projectPoint, unitTagAnchor, lookOf, CAM_FOV, BASE_THICK,
  GROUND_ATLAS_COLS, GROUND_ATLAS_ROWS, GROUND_TONE_ORDER,
  buildGridLinePositions, buildTileBorderGeometry, FLAT_TILES, cliffExtraProps,
  actionTiming, runSpeedOf,
} from '../data/battleSceneModels.js';
import { terrainOf, MAP_SIZE } from '../data/battleTerrain.js';
import { isProc, buildProc } from '../three/procNature.js';
import { buildWater } from '../three/buildWater.js';
import { buildPostFX } from '../three/buildPostFX.js';
import { loadVrm } from '../three/loadVrm.js';
import { VrmAnimator } from '../three/vrmAnimator.js';
import { buildClips, RUN_ANIM } from '../three/mixamoRig.js';
import { reachable as gridReachable, pathTo, cellKey } from '../data/battleGrid.js';

const FLAT_TILE_SET = new Set(FLAT_TILES);

// 角色 VRM 按需异步加载（见下方 units effect）；这里预载自然物件：旧版 .glb ＋ MegaKit .gltf。
const ALL_MODEL_JOBS = [
  ...NATURE_MODEL_FILES.map(name => ({ name, url: modelUrl(name) })),
  ...MEGAKIT_MODEL_FILES.map(name => ({ name, url: mkUrl(name) })),
];

const WALK_MS = 360;           // 走一格用多久（程序化兜底用）
/**
 * 棋盘上每秒走几格 —— **兜底值**，只在动捕片段还没烤好时用。
 * 正常情况下这个数由动作自己说了算（见 runSpeedOf）：素材里跑一个循环髋部被带着往前走多远，
 * 棋盘就每秒走多少格，这样每一脚都踩在实地上（既不脚底打滑，也不会变成慢动作）。
 * 一格＝1 米（见 battleSceneModels.cellToWorld），所以「米/秒」与「格/秒」是同一个数。
 */
const WALK_SPEED = 2.7;
const ATTACK_MS = 620;         // 程序化挥砍动作放多久
const HIT_MS = 300;            // 被打之后"闪一下"多久
const BEAT_MAX_S = 12;         // 单条演出单的兜底上限（秒）：万一动作没到位，队列不许卡死整局

/**
 * 渲染分辨率倍数（＝超采样）。**清晰度最划算的一处**：几何边缘靠 4× MSAA 已经干净，
 * 但地表纹理、小人身上的贴图细不细，只由"实际画了多少像素"决定。
 * 屏幕本身够细（视网膜屏 dpr ≥ 1.5）就按原样画；普通屏（dpr = 1）则按 1.5 倍画再缩回显示尺寸 ——
 * 等于每个显示像素用两个多采样点平均，边缘与纹理都更"实"。上限 2 倍，再高只是白烧显卡。
 */
function pickPixelRatio() {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const ss = dpr >= 1.5 ? 1 : 1.5;
  return Math.min(2, dpr * ss);
}
// 棋盘那层土的厚度从 battleSceneModels 导入（BASE_THICK）—— 相机取景的下边界也按它算，
// 所以这个数只能有一处出处，别在本地再写一份。

// ============================================================
// 自然物件的配色
// ============================================================
// Kenney 这套模型用的是**青绿色系**的调色板（草 44,216,184 / 石头 184,226,232 偏白蓝），
// 摆在仙侠场景里"叶子发青、石头发蓝"，很出戏。这些材质都是纯色、没有贴图，
// 所以按材质名把颜色换掉最省事，也不影响模型本身的造型。
// 注意：**只换自然物件**。小人的材质叫 colormap、贴着调色贴图，一个都不许动。
const NATURE_PALETTE = {
  grass: 0x84a94e,          // 草
  leafsGreen: 0x5f9138,     // 树冠
  leafsDark: 0x46702a,      // 深一些的树冠
  woodBark: 0x8a6242,       // 树皮
  woodBarkDark: 0x6b4a30,
  woodInner: 0xd6bb92,
  dirt: 0xb08a5e,           // 土
  dirtDark: 0x8a6a45,
  stone: 0x9d968a,          // 石（原来是偏白的浅蓝）
  stoneDark: 0x7d776c,
  water: 0x6ba6c4,          // 水（原来接近白色）
  colorRed: 0xb8453f,       // 花
  colorTan: 0xc98d55,
  colorYellow: 0xc9a03f,
  _defaultMat: 0xb9b2a4,
};

/**
 * 自然物件的材质：按名字换色后的**副本**（模型库里的原材质是共用的，绝不能改）。
 * cache 只在建一次场景的生命周期里活着 —— 副本是要在散场时 dispose 掉的，
 * 缓存留到下次进来就会拿到一堆"已经销毁"的材质。
 *
 * modelName 要传进来，是因为**同一个材质名在不同模型上该有不同的下场**：
 * 崖壁方块顶面用的也是 `grass`，照调色板一换就成了一座绿草包的山 ——
 * 耸峰要的是"过不去的石山"，所以 cliff_* 一律按石头色。
 */
function makeNatureMaterial(mat, modelName, glow) {
  const c = mat.clone();
  let want = null;
  if (modelName === 'tent_smallClosed') {
    // 原色是刺眼大红（colorRed/colorRedDark），改成素雅的行旅麻布色
    if (mat.name === 'colorRed') want = 0xc6b48c;
    else if (mat.name === 'colorRedDark') want = 0x95835e;
  } else if (/^cliff_/.test(String(modelName || '')) &&
      (mat.name === 'grass' || mat.name === 'leafsGreen' || mat.name === 'leafsDark')) {
    want = NATURE_PALETTE.stone;
  } else {
    want = NATURE_PALETTE[mat.name];
  }
  if (want != null) c.color.setHex(want);
  if (c.roughness != null) c.roughness = Math.max(0.72, c.roughness || 0.9);   // 别太反光
  if (c.metalness != null) c.metalness = 0;
  if (glow && c.emissive) {
    c.emissive.setHex(0xffe9a8);        // 灵脉的石碑、阵纹的石圈：自己会亮
    c.emissiveIntensity = 0.42;
  }
  return c;
}

// ============================================================
// 模型库：整个会话只加载一次，反复进出战斗不重复下载
// ============================================================
let LIB = null;

function loadLibrary() {
  if (LIB) return LIB;
  const loader = new GLTFLoader();
  const models = new Map();
  const failed = [];
  const jobs = ALL_MODEL_JOBS.map(({ name, url }) => new Promise(resolve => {
    loader.load(
      url,
      (gltf) => { models.set(name, gltf); resolve(); },
      undefined,                                // ⚠️ 进度回调必须显式留空：写错位置会把"进度"当成"失败"
      // 单个模型没下下来不该让整场战斗打不开：记下来、跳过，其余照加载
      () => { failed.push(name); resolve(); },
    );
  }));
  LIB = { promise: Promise.all(jobs).then(() => ({ models, failed })) };
  return LIB;
}

function boxOf(root) {
  return new THREE.Box3().setFromObject(root);
}

/** 一块模型的原生尺寸、底边与水平中心（缩放/重定位要用）。 */
function sizeOf(root) {
  const b = boxOf(root);
  const sz = b.getSize(new THREE.Vector3());
  const c = b.getCenter(new THREE.Vector3());
  return {
    h: Math.max(0.001, sz.y),
    wx: Math.max(0.001, sz.x),          // X 宽
    wz: Math.max(0.001, sz.z),          // Z 宽
    w: Math.max(0.001, sz.x, sz.z),     // 较大水平边
    diag: Math.hypot(sz.x, sz.z),       // 水平对角线（旋转安全占地）
    yMin: b.min.y,
    cx: c.x, cz: c.z,                   // 水平中心（不少 GLB 原点不在中心）
  };
}

// ============================================================
// 格线已并入地表纹理图集（见上方 makeGroundAtlas）
// ============================================================

// ============================================================
// 地表纹理图集：按地形 tone 分区，每 tile「白底 + 风格化灰度细节 + 边缘格线」
// ============================================================
// 与顶点色相乘：白不改变顶点色，灰度细节表现明暗斑驳，边缘深色形成格线。
// 印成贴图就等于「长在地表上」，跟着起伏走、永远贴合，不会像悬空线那样穿模。

/** 纹理绘制用的确定性伪随机（静态纹理，同样禁 Math.random）。 */
function gRand(a, b, salt = 0) {
  let h = Math.imul(a + 9, 2654435761) ^ Math.imul(b + 17, 2246822519) ^ Math.imul(salt + 5, 3266489917);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const GROUND_TILE_PX = 256;

function makeGroundAtlas(aniso = 8) {
  const cv = document.createElement('canvas');
  cv.width = GROUND_ATLAS_COLS * GROUND_TILE_PX;
  cv.height = GROUND_ATLAS_ROWS * GROUND_TILE_PX;
  const ctx = cv.getContext('2d');
  GROUND_TONE_ORDER.forEach((tone, i) => {
    const col = i % GROUND_ATLAS_COLS, row = Math.floor(i / GROUND_ATLAS_COLS);
    drawGroundTile(ctx, tone, col * GROUND_TILE_PX, row * GROUND_TILE_PX, GROUND_TILE_PX, i);
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  return tex;
}

/** 画单个地形 tone 的 tile：白底 + 该地形的风格化细节 + 一圈格线。 */
function drawGroundTile(ctx, tone, x0, y0, T, ti) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, T, T); ctx.clip();
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x0, y0, T, T);
  const R = (s, k = 0) => gRand(ti, s, k);
  const qx = (s, k) => x0 + R(s, k) * T;
  const qy = (s, k) => y0 + R(s, k) * T;
  const softBlob = (x, y, rad, color) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
  };

  switch (tone) {
    case 'soil': {
      for (let s = 0; s < 7; s++) softBlob(qx(s, 1), qy(s, 2), T * (0.06 + R(s, 3) * 0.12), 'rgba(74,58,34,0.10)');
      for (let s = 0; s < 150; s++) {
        ctx.fillStyle = `rgba(60,46,26,${0.04 + R(s, 4) * 0.08})`;
        const sz = 1 + R(s, 5) * 1.5;
        ctx.fillRect(qx(s, 6), qy(s, 7), sz, sz);
      }
      break;
    }
    case 'grass': {
      for (let s = 0; s < 11; s++) {
        const dark = R(s, 4) < 0.5;
        softBlob(qx(s, 1), qy(s, 2), T * (0.08 + R(s, 3) * 0.16),
          dark ? 'rgba(40,70,24,0.10)' : 'rgba(255,255,255,0.10)');
      }
      for (let s = 0; s < 30; s++) {
        ctx.strokeStyle = `rgba(38,66,22,${0.06 + R(s, 7) * 0.08})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(qx(s, 5), qy(s, 6));
        ctx.lineTo(qx(s, 5) + (R(s, 8) - 0.5) * 6, qy(s, 6) - 4 - R(s, 9) * 7);
        ctx.stroke();
      }
      break;
    }
    case 'rock': {
      for (let s = 0; s < 13; s++) {
        const cx = qx(s, 1), cy = qy(s, 2), rad = T * (0.07 + R(s, 3) * 0.14);
        ctx.fillStyle = `rgba(60,60,60,${0.05 + R(s, 4) * 0.07})`;
        ctx.beginPath();
        const n = 4 + Math.floor(R(s, 5) * 3);
        for (let k = 0; k < n; k++) {
          const a = k / n * 6.283, r2 = rad * (0.6 + gRand(s, k, 6));
          const ax = cx + Math.cos(a) * r2, ay = cy + Math.sin(a) * r2;
          if (k) ctx.lineTo(ax, ay); else ctx.moveTo(ax, ay);
        }
        ctx.closePath(); ctx.fill();
      }
      for (let s = 0; s < 5; s++) {
        ctx.strokeStyle = `rgba(48,48,48,${0.08 + R(s, 7) * 0.08})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        let x = qx(s, 8), y = qy(s, 9); ctx.moveTo(x, y);
        for (let k = 0; k < 3; k++) {
          x += (R(s, 10 + k) - 0.5) * T * 0.4;
          y += (R(s, 20 + k) - 0.5) * T * 0.4;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'water': {
      for (let s = 0; s < 11; s++) {
        ctx.strokeStyle = `rgba(40,72,92,${0.06 + R(s, 2) * 0.08})`;
        ctx.lineWidth = 1.3 + R(s, 3);
        ctx.beginPath();
        for (let k = 0; k <= 8; k++) {
          const x = x0 + k / 8 * T;
          const yy = y0 + R(s, 1) * T + Math.sin(k / 8 * 6.283 + R(s, 4) * 6) * 4;
          if (k) ctx.lineTo(x, yy); else ctx.moveTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k <= 10; k++) {
        const x = x0 + k / 10 * T, y = y0 + T * 0.28 + Math.sin(k) * 3;
        if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
      break;
    }
    case 'rune': {
      for (let s = 0; s < 3; s++) {
        ctx.strokeStyle = `rgba(96,74,30,${0.06 + R(s, 1) * 0.08})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.arc(x0 + T / 2, y0 + T / 2, T * (0.16 + s * 0.13), 0, 7); ctx.stroke();
      }
      for (let s = 0; s < 14; s++) {
        ctx.strokeStyle = `rgba(80,60,24,${0.07 + R(s, 2) * 0.08})`;
        ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(qx(s, 3), qy(s, 4));
        ctx.lineTo(qx(s, 3) + (R(s, 5) - 0.5) * 10, qy(s, 4) + (R(s, 6) - 0.5) * 10);
        ctx.stroke();
        if (R(s, 7) < 0.4) { ctx.beginPath(); ctx.arc(qx(s, 3), qy(s, 4), 1.6, 0, 7); ctx.stroke(); }
      }
      break;
    }
  }

  // 每 tile 一圈格线（相邻格之间的分隔）
  ctx.strokeStyle = 'rgba(70,58,38,0.30)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 + 1, y0 + 1, T - 2, T - 2);
  ctx.restore();
}

// ============================================================
// 小工具
// ============================================================

/** 单位在世界里的落脚点（y 含地表起伏，所以站在坡上也贴地）。 */
function anchorOf(u, grid) {
  const w = cellToWorld(u.x, u.y, MAP_SIZE);
  const tid = grid?.[u.y]?.[u.x] || '平地';
  return [w.x, cellTopY(tid, u.x, u.y), w.z];
}

// ============================================================
// 动捕动作的播放助手
// ============================================================
// 场景里的动作名一共六段（见 mixamoRig.ANIM_SOURCE）：
//   idle（待机）｜run（移动）｜melee（近战）｜ranged（远程）｜block（防御/威吓）｜down（倒下）
// 其中只有 idle / run / blockHold 是循环的，其余一律「播一遍停在最后一帧」。
//
// 循环动作里 blockHold 不是原始素材，而是把 Blocking 里「护架抬到位」的那一帧**冻住**的姿势：
// 整个人一个回合都举着护架时，若整段循环播就成了「一直抬手放手」，截一小段来循环也会
// 「架着盾一直抖」—— 冻住才是真正的"保持"（做法见 mixamoRig.freezeClip）。
const LOOP_CLIPS = ['idle', RUN_ANIM, 'blockHold'];

/** 播放一个循环动作（idle / run / blockHold），同名不重启、其余循环动作淡出。 */
function playLoop(rec, name) {
  if (!rec.actions || !rec.actions[name]) return;
  if (rec.loopName === name) return;
  for (const n of LOOP_CLIPS) {
    const act = rec.actions[n];
    if (!act) continue;
    if (n === name) { act.enabled = true; act.reset().fadeIn(0.12).play(); }
    else act.fadeOut(0.15);
  }
  rec.loopName = name;
  rec.shotName = null;      // 循环动作接管了，一次性动作那笔账清掉
}

/**
 * 播放一个一次性动作（melee / ranged / block / down）：只播一遍并停在最后一帧。
 * 播放倍速**一律 1** —— 需求原话是「动作速度需要和素材一样」，不许为了凑时间加速或放慢。
 * @returns {boolean} 真的播起来了没有（片段缺失时返回 false，调用方按"演完了"处理，免得队列卡死）
 */
function playShot(rec, name) {
  const act = rec.actions?.[name];
  if (!act) return false;
  for (const n of LOOP_CLIPS) {
    const a = rec.actions[n];
    if (a) a.fadeOut(0.1);
  }
  act.enabled = true;
  act.setLoop(THREE.LoopOnce, 1);
  act.clampWhenFinished = true;
  act.timeScale = 1;
  act.reset();
  act.play();
  rec.shotName = name;
  rec.shotStartAt = performance.now();   // 一次性动作开播时刻（命中判定 / 节拍推进都看它）
  rec.loopName = null;
  return true;
}

/** 这个角色现在是不是「举着挡」——防御姿态整回合保持，靠循环 blockHold 表现。 */
function isDefending(u) {
  return u?.stance === 'defend' && !u.out;
}

// ============================================================
// 路径化移动：沿真实格子折线恒速行走（拐角转身），不再直线越障
// ============================================================

/**
 * 由逻辑格的起点/终点，用 battleGrid 重建逐格路径并转成世界锚点。
 *
 * ⚠ occupied 必须传「别人站着的格」：不传（旧写法传的是空数组）算出来的路径会**从同伴身上穿过去**，
 * 看上去就是两个小人叠在一起、彼此穿模。这里的口径要和引擎的走位判定**完全一致**
 *（battleEngine.moveTo 用的是 occupiedCells(state, id)），否则会出现「引擎说走不进去、
 * 画面上却已经从人家身上踩过去」这种两套说法。
 *
 * @param {{x:number,y:number}} fromTile 出发格（上一次所在格）
 * @param {{x:number,y:number}} toTile 目标格
 * @param {THREE.Vector3} startPos 当前视觉位置（路径第一锚点，避免起跳）
 * @param {string[]} occupied 别人站着的格（cellKey 格式），引擎同一份口径
 */
function makePath(grid, fromTile, toTile, startPos, occupied = []) {
  const reach = gridReachable(grid, fromTile, MAP_SIZE * 4, occupied);
  const cells = pathTo(reach, toTile);
  const pts = [[startPos.x, startPos.y, startPos.z]];
  const pushCell = (c) => {
    const tid = grid[c.y][c.x];
    const w = cellToWorld(c.x, c.y, MAP_SIZE);
    pts.push([w.x, cellTopY(tid, c.x, c.y), w.z]);
  };
  if (cells) cells.forEach(pushCell);      // 绕开有人的格；绕不过去才退化成直线（见下）
  else pushCell(toTile);
  const lens = [];
  for (let i = 0; i < pts.length - 1; i++) {
    lens.push(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]));
  }
  return { pts, lens, seg: 0, segT: 0 };
}

/** 别人站着的格（含倒地者 —— 引擎也不许踩上去）。自己那格不算阻挡（reachable 内部也会删掉起点）。 */
function occupiedKeys(units, exceptId) {
  const out = [];
  for (const v of units) if (v.id !== exceptId) out.push(cellKey(v.x, v.y));
  return out;
}

/** 沿路径推进一帧。走完返回 false（并把人钉在终点），否则更新位置/朝向并返回 true。 */
function advancePath(rec, dt) {
  const p = rec.path;
  if (!p) return false;
  // 每秒走几格由动作自己定（rec.runSpeed，见 loadVrm 里 runSpeedOf 那一步）——
  // 用兜底值 2.7 的话，脚会以 5.9 米/秒的节奏迈步、身体却只走 2.7 米，看着就是原地打滑。
  let d = (rec.runSpeed || WALK_SPEED) * dt;
  while (d > 0) {
    if (p.seg >= p.pts.length - 1) {
      const last = p.pts[p.pts.length - 1];
      rec.root.position.set(last[0], last[1], last[2]);
      return false;
    }
    const len = p.lens[p.seg];
    const left = len - p.segT;
    if (d >= left) { d -= left; p.seg++; p.segT = 0; }
    else { p.segT += d; d = 0; }
  }
  if (p.seg >= p.pts.length - 1) {
    const last = p.pts[p.pts.length - 1];
    rec.root.position.set(last[0], last[1], last[2]);
    return false;
  }
  const a = p.pts[p.seg], b = p.pts[p.seg + 1];
  const k = p.segT / p.lens[p.seg];
  rec.root.position.set(
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  );
  rec.pathYaw = Math.atan2(b[0] - a[0], b[2] - a[2]);
  return true;
}

/**
 * 脚下的朝向圈：整圈描边，**背后那 1/4 涂红**。
 * 为什么要有它：背击/侧击一直在悄悄生效（战报里会写「背击」），可 3D 里从来没画过
 * "他脸朝哪边"——玩家没法判断从哪一侧绕过去才有加成。红的那一段就是背面。
 * 扇区角度与引擎判定共用同一组常量（battleGrid 的 45°），所以"看见红弧"与"打出背击"永远是同一件事。
 */
function makeFacingRing(side) {
  const mine = side === 'left';
  const S = Math.PI / 4;
  const R = FACING_RING_RADIUS;
  const grp = new THREE.Group();
  // 几何空间里 +Y 经 rotateX(−90°) 之后指向世界的 −z；而局部正前方是 +z，
  // 所以"正面"对应几何角 −90°，"背面"对应 +90°，各自占 90° 宽。
  const flat = (m) => { m.rotation.x = -Math.PI / 2; return m; };
  const front = flat(new THREE.Mesh(
    new THREE.CircleGeometry(R, 14, -Math.PI * 3 / 4, S * 2),
    new THREE.MeshBasicMaterial({ color: mine ? 0x8fe4ff : 0xffc7a8, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
  ));
  const back = flat(new THREE.Mesh(
    new THREE.CircleGeometry(R, 14, Math.PI / 4, S * 2),
    new THREE.MeshBasicMaterial({ color: 0xff5c5c, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }),
  ));
  const edge = flat(new THREE.Mesh(
    new THREE.RingGeometry(R * 0.90, R, 44),
    new THREE.MeshBasicMaterial({ color: mine ? 0x2f7fb5 : 0xb5532f, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }),
  ));
  const aim = new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.006, R * 0.62),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.70, depthWrite: false }),
  );
  aim.position.set(0, 0, R * 0.50);
  grp.add(front, back, edge, aim);
  grp.position.y = 0.022;
  grp.renderOrder = 2;
  return grp;
}

/** 退场者脚下的暗痕：人还在场上，但一眼看得出他"不算数了"。 */
function makeOutMark() {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(0.46, 28),
    new THREE.MeshBasicMaterial({ color: 0x2a2118, transparent: true, opacity: 0.40, depthWrite: false, side: THREE.DoubleSide }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

/**
 * 角色"在场 / 正在退场"该怎么画。
 *
 * ⚠ 这里最要紧的一条：**在场时必须原样不动，绝不能把材质改成"不透明"**。
 *   这些 VRM 的眼睛是分层的半透明贴片（虹膜 / 高光 / 眼线 / 睫毛都是 BLEND）：
 *   虹膜那张贴图里只有眼睛那一小块是实的（约 17%），其余部分是透明的，
 *   透明的部分底下垫的是眼白。一旦按"不透明"去画，**透明区域会以它自己的底色糊出来**，
 *   把眼白、瞳孔、高光一起盖成一团白 —— 也就是玩家 2026-09-20 报的
 *   「角色没有眼珠子只有眼白」。（真机 A/B 实证：同一模型同一机位，
 *   模型原样眼睛完好；执行过一次 `m.transparent = false` 就变成两个白洞。）
 *   所以：把模型自己的设置记在原处，只有真在褪色时才临时改，演完原样还回去。
 *
 * 另一个坑：切换"混合 / 不混合"要让 three 重编一次着色器，所以只在值真的变了时才置
 *   `needsUpdate`，否则每帧都重编译会卡。
 */
function applyCharFade(rec, fade) {
  const fading = fade < 1;
  for (const m of rec.materials) {
    let base = m.userData.__base;
    if (!base) {
      base = m.userData.__base = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
    }
    const wantT = fading ? true : base.transparent;
    const wantO = fading ? base.opacity * fade : base.opacity;
    const wantD = fading ? false : base.depthWrite;   // 半透明时不写深度，免得自己把自己裁掉
    let dirty = false;
    if (m.transparent !== wantT) { m.transparent = wantT; dirty = true; }
    if (Math.abs(m.opacity - wantO) > 1e-4) { m.opacity = wantO; dirty = true; }
    if (m.depthWrite !== wantD) { m.depthWrite = wantD; dirty = true; }
    if (dirty) m.needsUpdate = true;
  }
}

// ============================================================
// 天空、环境反射、远景、氛围粒子、篝火（纯观感，不碰任何规则）
// ============================================================

/** 天空穹顶：大球 BackSide，顶点按高度做暖色晨曦渐变。 */
function makeSkyDome(radius = 80) {
  const geo = new THREE.SphereGeometry(radius, 32, 18);
  const top = new THREE.Color(0x8fb6cf);    // 顶部淡青
  const mid = new THREE.Color(0xe9ddc2);    // 地平线暖米
  const low = new THREE.Color(0xf6ecd6);    // 下方暖白
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / radius;
    if (y >= 0) c.copy(mid).lerp(top, Math.pow(y, 0.7));
    else c.copy(mid).lerp(low, Math.min(1, -y * 1.6));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
  });
  return new THREE.Mesh(geo, mat);
}

/** 用「天空穹 + 亮太阳」烘一张 PMREM 环境贴图：水面/石头/金属因此有真实反射。 */
function buildEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  env.add(makeSkyDome(50));
  const sunDisk = new THREE.Mesh(
    new THREE.SphereGeometry(2.6, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff5da }),
  );
  sunDisk.position.set(-18, 26, -14);
  env.add(sunDisk);
  // 下半部一点暖色大地反光
  const under = new THREE.Mesh(
    new THREE.SphereGeometry(60, 24, 12),
    new THREE.MeshBasicMaterial({ color: 0xb39a72, side: THREE.BackSide }),
  );
  under.position.y = -40;
  env.add(under);
  const rt = pmrem.fromScene(env, 0.05);
  pmrem.dispose();
  return rt;
}

/** 远景：棋盘外围一圈低模远山（配合雾淡出）＋ 高空缓慢漂移的低模云。 */
function makeDistantScenery() {
  const group = new THREE.Group();
  // 远山：两圈错落峰岭。外圈更高、色调偏冷（空气透视），内圈低矮；半径推到 36 以外，
  // 近处的峰落在相机身后不入画、远处的峰被雾轻轻淡出 —— 不再是一圈大块低模山挤在棋盘边。
  const rings = [
    { n: 12, r0: 36, r1: 44, h0: 3.5, h1: 6, rad0: 2.2, rad1: 3.6, colors: [0x9aa58e, 0x8f9c8a, 0xa3ac96] },
    { n: 12, r0: 47, r1: 58, h0: 6, h1: 12, rad0: 3, rad1: 5, colors: [0x8b9aa0, 0x82939b, 0x95a2a8] },
  ];
  let ri = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.n; i++) {
      const a = (i / ring.n) * Math.PI * 2 + cellRand(ri, i, 41) * 0.3;
      const r = ring.r0 + cellRand(ri, i, 42) * (ring.r1 - ring.r0);
      const h = ring.h0 + cellRand(ri, i, 43) * (ring.h1 - ring.h0);
      const rad = ring.rad0 + cellRand(ri, i, 44) * (ring.rad1 - ring.rad0);
      const geo = new THREE.ConeGeometry(rad, h, 5 + (i % 3));
      const mat = new THREE.MeshStandardMaterial({
        color: ring.colors[i % ring.colors.length], roughness: 1, flatShading: true,
      });
      const m = new THREE.Mesh(geo, mat);
      m.position.set(Math.cos(a) * r, h / 2 - 3, Math.sin(a) * r);
      m.rotation.y = cellRand(ri, i, 45) * Math.PI;
      group.add(m);
    }
    ri++;
  }
  // 云：推到高空（y 18~30）与外圈半径，稀疏 5 朵，绝不贴着棋盘。
  const clouds = [];
  for (let i = 0; i < 5; i++) {
    const cg = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0xf8f4ea, roughness: 1, flatShading: true });
    const puffs = 3 + (i % 2);
    for (let p = 0; p < puffs; p++) {
      const s = 1.4 + cellRand(i, p, 50) * 1.2;
      const pu = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), mat);
      pu.position.set((p - (puffs - 1) / 2) * 1.8, cellRand(i, p, 51) * 0.5, 0);
      pu.scale.y = 0.65;
      cg.add(pu);
    }
    const a = cellRand(i, 1, 52) * Math.PI * 2;
    const r = 34 + cellRand(i, 2, 53) * 22;
    cg.position.set(Math.cos(a) * r, 18 + cellRand(i, 3, 54) * 12, Math.sin(a) * r);
    cg.userData.drift = 0.2 + cellRand(i, 4, 55) * 0.3;
    group.add(cg); clouds.push(cg);
  }
  return { group, clouds };
}

/** 软圆形 sprite（灵气光点用）。 */
function makeSoftDotTexture() {
  const s = 64;
  const cv = document.createElement('canvas'); cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 灵气光点：漂浮在棋盘上方的暖色微光（灵脉/阵纹附近更密）。 */
function makeSpiritMotes(grid) {
  // 2026-09-20：110 → 42，画面更干净（地块边界成为主角，光点只在灵脉附近点缀）
  const COUNT = 42;
  const positions = new Float32Array(COUNT * 3);
  const data = [];
  const special = [];
  for (let y = 0; y < MAP_SIZE; y++) for (let x = 0; x < MAP_SIZE; x++) {
    const t = grid?.[y]?.[x];
    if (t === '灵脉' || t === '阵纹') special.push(cellToWorld(x, y, MAP_SIZE));
  }
  for (let i = 0; i < COUNT; i++) {
    let bx, bz;
    if (i % 3 === 0 && special.length) {
      const sp = special[i % special.length];
      bx = sp.x + (cellRand(i, 1, 60) - 0.5) * 1.2;
      bz = sp.z + (cellRand(i, 2, 60) - 0.5) * 1.2;
    } else {
      bx = (cellRand(i, 3, 60) - 0.5) * (MAP_SIZE - 1);
      bz = (cellRand(i, 4, 60) - 0.5) * (MAP_SIZE - 1);
    }
    const baseY = 0.25 + cellRand(i, 5, 60) * 1.6;
    data.push({
      bx, bz, baseY, phase: cellRand(i, 6, 60) * Math.PI * 2,
      amp: 0.12 + cellRand(i, 7, 60) * 0.22, sway: 0.1 + cellRand(i, 8, 60) * 0.2,
    });
    positions[i * 3] = bx; positions[i * 3 + 1] = baseY; positions[i * 3 + 2] = bz;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const tex = makeSoftDotTexture();
  const mat = new THREE.PointsMaterial({
    color: 0xffdf9a, size: 0.14, map: tex, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.userData.motes = data;
  return { points, tex };
}

/** 飘花/落叶：从棋盘上方缓缓飘落、左右摆动的小花瓣。 */
function makeFallingPetals() {
  // 2026-09-20：70 → 24，减少飘落物的视觉噪音
  const COUNT = 24;
  const geo = new THREE.PlaneGeometry(0.08, 0.06);
  const mat = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false,
  });
  const im = new THREE.InstancedMesh(geo, mat, COUNT);
  const palette = [0xf3b8ad, 0xf0c9a0, 0xf6efe0, 0xeec0c8];
  const data = [];
  const dummy = new THREE.Object3D();
  for (let i = 0; i < COUNT; i++) {
    const d = {
      x: (cellRand(i, 1, 70) - 0.5) * (MAP_SIZE - 1),
      y: 0.4 + cellRand(i, 2, 70) * 4.5,
      z: (cellRand(i, 3, 70) - 0.5) * (MAP_SIZE - 1),
      speed: 0.25 + cellRand(i, 4, 70) * 0.35,
      phase: cellRand(i, 5, 70) * Math.PI * 2,
      sway: 0.25 + cellRand(i, 6, 70) * 0.4,
      spin: 1.5 + cellRand(i, 7, 70) * 2.5,
    };
    data.push(d);
    im.setColorAt(i, new THREE.Color(palette[i % palette.length]));
    dummy.position.set(d.x, d.y, d.z); dummy.updateMatrix();
    im.setMatrixAt(i, dummy.matrix);
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.userData.petals = data;
  return im;
}

/** 篝火火焰：几簇自发光小锥体（不加点光源，避免多个动态光影响性能）。seed 决定闪烁相位。 */
function makeCampfireFlame(seed) {
  const g = new THREE.Group();
  const flames = [];
  const layers = [
    { r: 0.07, h: 0.16, color: 0xff7a2a, y: 0.08 },
    { r: 0.05, h: 0.13, color: 0xffb13c, y: 0.10 },
    { r: 0.03, h: 0.09, color: 0xffe28c, y: 0.12 },
  ];
  layers.forEach((l, i) => {
    const mat = new THREE.MeshBasicMaterial({
      color: l.color, transparent: true, opacity: 0.92,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const m = new THREE.Mesh(new THREE.ConeGeometry(l.r, l.h, 6), mat);
    m.position.y = l.y;
    g.add(m);
    flames.push({ m, phase: cellRand(seed, i, 80) * Math.PI * 2, baseY: l.y });
  });
  g.userData.flames = flames;
  return g;
}

/** 命中点的扩散光环（普攻银白、暴击金色）。 */
function spawnHitRing(a, pos, crit) {
  const geo = new THREE.RingGeometry(0.09, 0.13, 24);
  const mat = new THREE.MeshBasicMaterial({
    color: crit ? 0xffd27a : 0xeef4ff, transparent: true, opacity: 0.95,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.position.copy(pos);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 6;
  a.scene.add(ring);
  a.fxList.push({
    mesh: ring, t0: performance.now(), dur: 340,
    update: (t) => {
      const s = 0.6 + t * 2.4;
      ring.scale.set(s, s, s);
      ring.material.opacity = 0.95 * (1 - t);
    },
  });
}

// ============================================================
// 组件
// ============================================================
const BattleScene3D = React.forwardRef(function BattleScene3D({
  grid, units, view, actorId, reachable, targetIds, hover, fx, shake, onFallbackPick,
  beat, onBeatDone, onBeatImpact, onSceneLive, hpPend,
}, ref) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const tagRefs = useRef(new Map());      // 单位 id → 名字牌元素
  const dmgRef = useRef(null);
  const api = useRef({});                 // three 侧的活对象

  const [box, setBox] = useState({ w: 0, h: 0 });
  const [status, setStatus] = useState('loading');   // loading | ready | failed
  const [lib, setLib] = useState(null);
  // 场景每建好一次就 +1。小人 / 高亮 / 特效这几个 effect 都盯着它 ——
  // 光靠 [lib, status] 判断"场景在不在"是不够的：场景重建时 api.current 会换成新对象，
  // 而它们的依赖没变，就会永远往旧对象里塞东西（表现为"人一个都没上场"）。
  const [sceneEpoch, setSceneEpoch] = useState(0);

  const aspect = box.w > 1 && box.h > 1 ? box.w / box.h : 1.6;
  const basis = useMemo(() => viewBasis(view, MAP_SIZE, aspect),
    [view.rx, view.rz, view.zoom, aspect]);

  // 一局之内谁用哪个小人：只跟"参战者是谁"有关，跟血量之类的变化无关，不然每帧都会换脸
  const unitIds = units.map(u => `${u.id}:${u.side}`).join(',');
  const modelFor = useMemo(() => assignCharacterModels(units), [unitIds]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 帧循环只建一次，所以要用最新值只能走 ref
  const gridRef = useRef(grid);
  const unitsRef = useRef(units);
  const uByIdRef = useRef(new Map());
  const viewRef = useRef(view);
  const fxRef = useRef(fx);
  useEffect(() => { gridRef.current = grid; }, [grid]);
  useEffect(() => { unitsRef.current = units; uByIdRef.current = new Map(units.map(u => [u.id, u])); }, [units]);
  useEffect(() => { viewRef.current = view; }, [view]);
  useEffect(() => { fxRef.current = fx; }, [fx]);
  // 演出单的完成/命中回报：帧循环只建一次，回调必须走 ref，否则会一直用第一次那份闭包
  const beatDoneRef = useRef(onBeatDone);
  const beatImpactRef = useRef(onBeatImpact);
  useEffect(() => { beatDoneRef.current = onBeatDone; }, [onBeatDone]);
  useEffect(() => { beatImpactRef.current = onBeatImpact; }, [onBeatImpact]);

  // 三维场景到底起没起来 —— 回报给 BattleView。
  // 为什么必须回报：演出单要靠场景演完再回报"演完了"，可三维场景若起不来（浏览器不支持 WebGL），
  // 就永远没人回报 ⇒ 整局的推进会被一条演不完的演出单卡死。所以由这一层明说"我起没起来"。
  const liveRef = useRef(onSceneLive);
  useEffect(() => { liveRef.current = onSceneLive; }, [onSceneLive]);
  useEffect(() => { liveRef.current?.(status === 'ready'); }, [status]);

  // ---------- 量容器尺寸 ----------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) setBox({ w: r.width, h: r.height });
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [status]);

  // ---------- 加载模型 ----------
  useEffect(() => {
    let alive = true;
    loadLibrary().promise
      .then(({ models, failed }) => {
        if (!alive) return;
        if (failed.length) console.warn(`[立体战场] ${failed.length} 个自然模型没加载成功，这些摆件会缺席：${failed.join(', ')}`);
        console.info(`[立体战场] 自然模型库就绪：${models.size} 个（角色 VRM 将在战斗中按需加载）`);
        setLib(models);
        setStatus(models.size > 0 ? 'ready' : 'failed');
      })
      .catch((e) => { if (alive) { console.warn('[立体战场] 模型库加载失败', e); setStatus('failed'); } });
    return () => { alive = false; };
  }, []);

  // ---------- 建场景（只建一次） ----------
  useEffect(() => {
    if (!lib || status !== 'ready' || !canvasRef.current || api.current.scene) return;
    const canvas = canvasRef.current;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (e) {
      console.warn('[立体战场] WebGL 起不来，退回格子视图', e);
      setStatus('failed');
      return;
    }
    renderer.setPixelRatio(pickPixelRatio());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    renderer.shadowMap.enabled = true;
    // three 0.186 起 PCFSoftShadowMap 已被移除（用了会在控制台刷一句警告、静默退回 PCF）。
    // 直接写 PCFShadowMap：阴影边缘利落一点，也更快 —— 清晰度这一轮本就该少点"糊"。
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // 各向异性过滤拉满：斜视角看地表和摆件时，"远处一片糊"主要就是它没开够。
    // （默认只有 1，斜着看贴图会被压成一条线采样，越远越糊。）
    const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    api.current.maxAniso = maxAniso;
    for (const gltf of lib.values()) {
      for (const root of [gltf.scene, ...(gltf.scenes || [])]) {
        root?.traverse?.((o) => {
          const mm = !o.material ? [] : (Array.isArray(o.material) ? o.material : [o.material]);
          for (const m of mm) {
            for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
              const t = m && m[k];
              if (t && t.isTexture) t.anisotropy = maxAniso;
            }
          }
        });
      }
    }

    const scene = new THREE.Scene();
    // 暖色晨曦雾：让棋盘外围远山自然淡出。2026-09-20 地图扩到 27、相机退得更远，
    // 雾距同步推远（棋盘最远约 60，故 near 取 62），保证整块棋盘清晰、只淡外围远山。
    const FOG_COLOR = 0xe9ddc2;
    scene.fog = new THREE.Fog(FOG_COLOR, 62, 112);
    // 天空穹（取代原先的 CSS 纯色背景）
    const sky = makeSkyDome(80);
    scene.add(sky);
    // 环境反射：PMREM 让水面/石头/金属有真实高光
    const envRT = buildEnvironment(renderer);
    scene.environment = envRT.texture;
    // near 从 0.5 收到 0.1：16 倍放大时相机离人只有 3 格出头，人身上朝镜头那部分
    //（肩膀、发梢）离镜头可能不到半格，near 太大就会把它们裁掉 —— 看上去像人塌了。
    const camera = new THREE.PerspectiveCamera(CAM_FOV, aspect, 0.1, 300);
    // 自己造的东西登记在这里，散场时逐个 dispose ——**绝不能** scene.traverse 一把清，
    // 那样会把全局缓存的模型几何也清掉，第二次进战斗整场空白
    const mine = { geo: [], mat: [], tex: [] };

    // ---- 光：一盏暖色斜阳 ＋ 天光地光补面。不引环境贴图，离线也能跑 ----
    // 补面光刻意压低：补得太亮，山是平的、石是扁的，"立体"就白做了
    scene.add(new THREE.HemisphereLight(0xffffff, 0xbfa87c, 0.50));
    scene.add(new THREE.AmbientLight(0xffffff, 0.12));
    const sun = new THREE.DirectionalLight(0xfff2d4, 2.05);
    sun.position.set(-9, 17, 7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 72 });
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);

    // ---- 地表 ----
    const tileGeo = buildTileGeometry(grid, MAP_SIZE);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(tileGeo.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(tileGeo.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(tileGeo.colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(tileGeo.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(tileGeo.indices, 1));
    const groundAtlas = makeGroundAtlas(maxAniso);
    const tileMat = new THREE.MeshStandardMaterial({
      vertexColors: true, map: groundAtlas, roughness: 0.96, metalness: 0, side: THREE.DoubleSide,
    });
    const tiles = new THREE.Mesh(geo, tileMat);
    tiles.receiveShadow = true;
    scene.add(tiles);
    mine.geo.push(geo); mine.mat.push(tileMat); mine.tex.push(groundAtlas);

    // ---- 地块边界（2026-09-20 新增）----
    // ① 整图统一的淡格线：一格一格看得清、又不抢眼（普通可走地块靠它分界）。
    const gridLineGeo = new THREE.BufferGeometry();
    gridLineGeo.setAttribute('position',
      new THREE.BufferAttribute(buildGridLinePositions(grid, MAP_SIZE, 0.028), 3));
    const gridLineMat = new THREE.LineBasicMaterial({
      color: 0x413826, transparent: true, opacity: 0.32, depthWrite: false,
    });
    const gridLine = new THREE.LineSegments(gridLineGeo, gridLineMat);
    gridLine.renderOrder = 2;
    scene.add(gridLine);
    mine.geo.push(gridLineGeo); mine.mat.push(gridLineMat);

    // ② 特殊 / 不可走地块的发光粗描边：灵脉金 / 阵纹紫 / 水洼蓝 / 险地橙 / 耸峰红。
    //    toneMapped:false：不被 ACES 压暗，颜色始终鲜亮，边界一眼可辨。
    const borderData = buildTileBorderGeometry(grid, { size: MAP_SIZE });
    const borderGeo = new THREE.BufferGeometry();
    borderGeo.setAttribute('position', new THREE.BufferAttribute(borderData.positions, 3));
    borderGeo.setAttribute('color', new THREE.BufferAttribute(borderData.colors, 3));
    borderGeo.setIndex(new THREE.BufferAttribute(borderData.indices, 1));
    const borderMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.96, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false,
    });
    const borderMesh = new THREE.Mesh(borderGeo, borderMat);
    borderMesh.renderOrder = 4;
    borderMesh.frustumCulled = false;
    scene.add(borderMesh);
    mine.geo.push(borderGeo); mine.mat.push(borderMat);

    // ---- 棋盘下面那层土 ----
    const lowest = Math.min(...Object.values(TERRAIN_LOOK).map(l => l.relief));
    const baseGeo = new THREE.BoxGeometry(MAP_SIZE, BASE_THICK, MAP_SIZE);
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x6b5a3e, roughness: 1, metalness: 0 });
    const base = new THREE.Mesh(baseGeo, baseMat);
    base.position.set(0, lowest - 0.01 - BASE_THICK / 2, 0);
    base.receiveShadow = true;
    scene.add(base);
    mine.geo.push(baseGeo); mine.mat.push(baseMat);

    // ---- 每格的草木山石：按模型分组做实例化，一个模型只画一次 ----
    // 分组的键是「模型 + 要不要发光」：会发光的摆件（灵脉的石碑、阵纹的石圈）得单独一份，
    // 才能给它自己的自发光材质；混在一起会把旁边的普通石头也点亮。
    const byModel = new Map();      // 键 → { name, root, glow, big, flat, matrices, cells }
    const campfireMatrices = [];   // 篝火摆件的世界矩阵（要在上面加火焰）
    // 巨石整块布置：相连的耸峰格被切成整块，一块巨石正好落在不可通行格上（解决穿模）
    const cliffMap = cliffExtraProps(grid, MAP_SIZE);
    // 程序化摆件（proc:）按需构建并缓存；其几何/材质属本场，结束时销毁
    const procGroups = new Map();
    const getRoot = (model) => {
      if (isProc(model)) {
        if (!procGroups.has(model)) {
          const g = buildProc(model);
          if (g) {
            g.traverse((o) => {
              if (o.geometry) mine.geo.push(o.geometry);
              const mm = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
              mm.forEach(mm2 => mine.mat.push(mm2));
            });
            procGroups.set(model, g);
          }
        }
        return procGroups.get(model) || null;
      }
      const gltf = lib.get(model);
      return gltf ? gltf.scene : null;
    };

    for (let y = 0; y < MAP_SIZE; y++) {
      for (let x = 0; x < MAP_SIZE; x++) {
        const tid = grid?.[y]?.[x];
        const surface = cellTopY(tid, x, y);
        const w = cellToWorld(x, y, MAP_SIZE);
        const cliffProp = cliffMap.get(`${x},${y}`);
        const props = [...propsForCell(tid, x, y), ...(cliffProp ? [cliffProp] : [])];
        for (const p of props) {
          const root = getRoot(p.model);
          if (!root) continue;                     // 模型没构建/没下下来，跳过这一个摆件
          const s0 = sizeOf(root);
          let m;
          if (p.fitW != null) {
            // 整块巨石：非均匀缩放铺满 fitW×fitD、中心对准块中心 (p.wx,p.wz)，
            // 视觉占地正好全在不可通行格上。
            const sx = p.fitW / s0.wx;
            const sz = p.fitD / s0.wz;
            const sy = Math.min(sx, sz);
            m = new THREE.Matrix4().compose(
              new THREE.Vector3(p.wx ?? w.x, surface - (p.sink || 0), p.wz ?? w.z),
              new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rotY || 0, 0)),
              new THREE.Vector3(sx, sy, sz),
            );
            m.multiply(new THREE.Matrix4().makeTranslation(-s0.cx, -s0.yMin, -s0.cz));
          } else {
            // 目标缩放：按高度（或平铺贴片的宽度）
            let s = p.w != null ? p.w / s0.w : (p.h || 0.3) / s0.h;
            // 占地约束（旋转安全）：除巨石(big)/贴片(FLAT)外，按水平对角线给占地上限，
            // 保证任意 Y 旋转后的 AABB 连同格内偏移都收在本地块内，不遮邻格。
            if (!p.big && !FLAT_TILE_SET.has(p.model)) {
              const off = Math.max(Math.abs(p.dx || 0), Math.abs(p.dz || 0));
              const sFit = (2 * (0.5 - 0.05 - off)) / s0.diag;
              if (sFit < s) s = sFit;
            }
            // 包围盒重定位：M = T(目标) · R(rotY) · S(s) · T(-中心)，
            // 让模型水平中心落在 (格心+偏移)、底边落在地表（与 GLB 原点在哪无关）。
            m = new THREE.Matrix4().compose(
              new THREE.Vector3(
                w.x + (p.dx || 0),
                surface - (p.sink || 0) + (p.at || 0),
                w.z + (p.dz || 0),
              ),
              new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rotY || 0, 0)),
              new THREE.Vector3(s, s, s),
            );
            m.multiply(new THREE.Matrix4().makeTranslation(-s0.cx, -s0.yMin, -s0.cz));
          }
          // big 也并入键：同一模型的「整块巨石」与「单格石头」必须分成两份，
          // 否则单格收敛会把大岩石也错误缩小。
          const key = `${p.model}|${p.glow ? 1 : 0}|${p.big ? 1 : 0}`;
          if (!byModel.has(key)) byModel.set(key, {
            name: p.model, root, glow: !!p.glow, big: !!p.big,
            flat: FLAT_TILE_SET.has(p.model), matrices: [], cells: [],
          });
          const bucket = byModel.get(key);
          bucket.matrices.push(m);
          bucket.cells.push({ x, y });
          if (p.campfire) campfireMatrices.push(m.clone());
        }
      }
    }
    const pickables = [{ object: tiles, cellOf: (hit) => worldToCell(hit.point.x, hit.point.z, MAP_SIZE) }];
    const matCache = new Map();
    const propStats = { models: 0, meshes: 0, instances: 0 };
    // 越界自检（渲染层）：逐个实例算世界 AABB，非巨石必须落在所属格内
    const footprint = { checked: 0, violations: [] };
    const _fm = new THREE.Matrix4();
    for (const bucket of byModel.values()) {
      const root = bucket.root;
      const n = bucket.matrices.length;
      propStats.models++;
      propStats.instances += n;
      root.updateMatrixWorld(true);
      const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();

      // 一个模型里可能有多块网格（比如树干＋树叶），各做一份实例
      root.traverse((o) => {
        if (!o.isMesh) return;
        const local = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
        // 缓存键带上"发光与否"：同一个材质既可能用来发光的摆件、也可能用来不发光的，
        // 共用一份会把旁边的普通石头一起点亮
        const ck = `${bucket.name}|${bucket.glow ? 1 : 0}|${o.material.uuid}`;
        let mat = matCache.get(ck);
        if (!mat) {
          mat = makeNatureMaterial(o.material, bucket.name, bucket.glow);
          matCache.set(ck, mat);
          mine.mat.push(mat);          // 自己造的材质，散场时逐份销毁
        }
        const im = new THREE.InstancedMesh(o.geometry, mat, n);
        const tmp = new THREE.Matrix4();
        for (let i = 0; i < n; i++) {
          tmp.multiplyMatrices(bucket.matrices[i], local);
          im.setMatrixAt(i, tmp);
        }
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = true;
        im.receiveShadow = true;
        im.userData.cellList = bucket.cells;       // 点中第 i 个实例 → 就是第 i 格
        scene.add(im);
        propStats.meshes++;
        pickables.push({ object: im, cellOf: (hit) => bucket.cells[hit.instanceId] || null });

        // 占地收口（非巨石、非贴片）：
        if (!bucket.big && !bucket.flat) {
          if (!im.geometry.boundingBox) im.geometry.computeBoundingBox();
          const bb = im.geometry.boundingBox;
          const c8 = [
            [bb.min.x, bb.min.z], [bb.max.x, bb.min.z],
            [bb.max.x, bb.max.z], [bb.min.x, bb.max.z],
          ];
          const v = new THREE.Vector3();
          const HC = 0.46;                 // 纠正目标半边长（格半 .5 留 .04 边）
          const _corr = new THREE.Matrix4();
          const aabbOf = (i) => {
            im.getMatrixAt(i, _fm);
            let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9;
            for (const c of c8) {
              v.set(c[0], 0, c[1]).applyMatrix4(_fm);
              if (v.x < mnx) mnx = v.x; if (v.x > mxx) mxx = v.x;
              if (v.z < mnz) mnz = v.z; if (v.z > mxz) mxz = v.z;
            }
            return { mnx, mxx, mnz, mxz };
          };
          // Pass A：越界就关于格中心做水平缩放，强制收进格内
          for (let i = 0; i < n; i++) {
            const cell = bucket.cells[i];
            if (!cell) continue;
            const cw = cellToWorld(cell.x, cell.y, MAP_SIZE);
            const a = aabbOf(i);
            const hx = Math.max(a.mxx - cw.x, cw.x - a.mnx);
            const hz = Math.max(a.mxz - cw.z, cw.z - a.mnz);
            const k = Math.min(1, HC / hx, HC / hz);
            if (k < 1) {
              _corr.makeTranslation(cw.x, 0, cw.z)
                .multiply(new THREE.Matrix4().makeScale(k, 1, k))
                .multiply(new THREE.Matrix4().makeTranslation(-cw.x, 0, -cw.z));
              im.getMatrixAt(i, _fm);
              im.setMatrixAt(i, _corr.multiply(_fm));
            }
          }
          im.instanceMatrix.needsUpdate = true;
          // Pass B：复核，仍越界才记为问题
          for (let i = 0; i < n; i++) {
            const cell = bucket.cells[i];
            if (!cell) continue;
            const cw = cellToWorld(cell.x, cell.y, MAP_SIZE);
            const a = aabbOf(i);
            footprint.checked++;
            const tol = 0.02;
            if (a.mnx < cw.x - 0.5 - tol || a.mxx > cw.x + 0.5 + tol ||
                a.mnz < cw.z - 0.5 - tol || a.mxz > cw.z + 0.5 + tol) {
              footprint.violations.push(
                `${bucket.name}@${cell.x},${cell.y} x[${a.mnx.toFixed(2)},${a.mxx.toFixed(2)}] z[${a.mnz.toFixed(2)},${a.mxz.toFixed(2)}]`);
            }
          }
        }
      });
    }

    // ---- 高精度水面：所有水洼格共用一张带平面反射的着色器水面 ----
    const waterCells = [];
    for (let yy = 0; yy < MAP_SIZE; yy++)
      for (let xx = 0; xx < MAP_SIZE; xx++)
        if (grid?.[yy]?.[xx] === '水洼') waterCells.push({ x: xx, y: yy });
    // 没有水就不创建反射器（省掉每帧一次的镜像渲染）
    const water = waterCells.length ? buildWater(waterCells, MAP_SIZE) : null;
    if (water) {
      scene.add(water.reflector);   // 反射面（自身不显示，只产出反射图）
      scene.add(water.mesh);
    }

    // ---- 远景：远山 ＋ 漂移的云（棋盘外，不参与拾取、不影响规则）----
    const distant = makeDistantScenery();
    scene.add(distant.group);
    distant.group.traverse((o) => {
      if (o.geometry) mine.geo.push(o.geometry);
      if (o.material) mine.mat.push(o.material);
    });

    // ---- 篝火火焰（纯视觉，跟着每堆篝火）----
    const flameGroups = [];
    campfireMatrices.forEach((m, i) => {
      const flame = makeCampfireFlame(i + 1);
      flame.position.setFromMatrixPosition(m);
      scene.add(flame);
      flameGroups.push(flame);
      flame.traverse((o) => {
        if (o.geometry) mine.geo.push(o.geometry);
        if (o.material) mine.mat.push(o.material);
      });
    });

    // ---- 灵气光点（灵脉/阵纹附近更密，氛围粒子，不参与拾取）----
    const spirit = makeSpiritMotes(grid);
    scene.add(spirit.points);
    mine.geo.push(spirit.points.geometry);
    mine.mat.push(spirit.points.material);
    mine.tex.push(spirit.tex);

    // ---- 飘花/落叶（氛围粒子，不参与拾取）----
    const petals = makeFallingPetals();
    scene.add(petals);
    mine.geo.push(petals.geometry);
    mine.mat.push(petals.material);

    // ---- 高亮层：可走格 / 可打目标 / 鼠标悬停 ----
    const mkOverlay = (hex, opacity) => {
      const g2 = new THREE.BufferGeometry();
      const m2 = new THREE.MeshBasicMaterial({
        color: hex, transparent: true, opacity, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      const mesh = new THREE.Mesh(g2, m2);
      mesh.renderOrder = 3;
      scene.add(mesh);
      mine.geo.push(g2); mine.mat.push(m2);
      return mesh;
    };
    // walkMesh：所有「可通行地块」的淡绿底（整局不变）；reachMesh：本回合走得到的蓝底（呼吸）。
    // 2026-09-20：walk .13→.07、reach .42→.28 —— 旧值让大片地面发绿、中央蓝底发灰发糊（画面不清晰）。
    const walkMesh = mkOverlay(0x9fdc8a, 0.07);
    walkMesh.renderOrder = 2;
    const reachMesh = mkOverlay(0x3f9dff, 0.28);
    const targetMesh = mkOverlay(0xff4d4d, 0.60);
    const hoverMesh = mkOverlay(0xffffff, 0.28);

    // ---- 后处理（博德之门 3 方向）：轻微 Bloom ＋ 调色暗角 ＋ ACES，HDR 缓冲 4×MSAA ----
    const fxDpr = Math.min(window.devicePixelRatio || 1, 2);
    const postFX = buildPostFX(
      renderer, scene, camera,
      canvas.clientWidth || box.w || 1280,
      canvas.clientHeight || box.h || 800,
      fxDpr,
    );

    api.current = {
      renderer, scene, camera, tiles, pickables, mine,
      walkMesh, reachMesh, targetMesh, hoverMesh, water, postFX,
      actors: new Map(),
      fxList: [],
      beat: null,                 // 当前正在演的演出单（由 BattleView 一条一条喂，见下方 beat 那段）
      distant, flameGroups, petals, spirit,
      propStats, footprint,
      aspect,
      // 自己算帧间隔（THREE.Clock 在 0.186 已标记过时）
      lastT: performance.now(),
      raf: 0,
    };
    // 开发期出口：探针页设了 window.__BS3_DEBUG__ 才挂上，正式运行时不产生任何全局变量
    if (typeof window !== 'undefined' && window.__BS3_DEBUG__) window.__bs3 = api.current;
    setSceneEpoch(e => e + 1);      // 通知小人/高亮/特效：新的场景对象好了，可以往里头放了

    // ---- 帧循环 ----
    const step = () => {
      api.current.raf = requestAnimationFrame(step);
      const a = api.current;
      if (!a.scene) return;
      const now = performance.now();
      const dt = Math.min(0.05, (now - a.lastT) / 1000);
      a.lastT = now;

      // 角色：沿格子路径行走 ＋ 动捕状态机 ＋ 被打闪红
      for (const [id, rec] of a.actors) {
        const u = uByIdRef.current.get(id);
        if (!u) continue;
        let pathYaw = null;
        if (rec.path) {
          // 一次性动作（出手/倒下）正在播时，路径暂停推进 —— 打完再继续走
          const shotBusy = rec.actions && rec.shotName &&
            rec.actions[rec.shotName] && rec.actions[rec.shotName].isRunning();
          if (!shotBusy) {
            if (!advancePath(rec, dt)) rec.path = null;
            else pathYaw = rec.pathYaw;
          }
        }
        const walking = !!rec.path;
        if (rec.ready) {
          if (rec.actions) {
            // 这里只管「同一时刻只播一件事」，不管先后 —— 先后由演出单（battleBeats）在场景层面排。
            //   退出战斗 → 摆倒下姿势（停在最后一帧，不会自己爬起来）
            //   正在播一次性动作 → 先把它播完
            //   在走 → 跑步 ／ 举着防御 → 架住 ／ 其余 → 待机
            if (rec.shownOut) {
              // 「倒下」这个姿势要保留。逃遁除外：遁走的是虚影（淡到只剩三成），站着比躺着更像"走了"。
              if (u.outReason !== '逃遁') {
                if (rec.shotName !== 'down') { rec.loopName = null; playShot(rec, 'down'); }
              } else if (rec.shotName) {
                const sh = rec.actions[rec.shotName];
                if (!sh || !sh.isRunning()) rec.shotName = null;
              }
            } else {
              // 当前一次性动作播完即清
              if (rec.shotName) {
                const sh = rec.actions[rec.shotName];
                if (!sh || !sh.isRunning()) rec.shotName = null;
              }
              if (!rec.shotName) {
                if (walking) playLoop(rec, RUN_ANIM);          // 路径没走完，先跑
                else if (isDefending(u)) playLoop(rec, 'blockHold');   // 防御姿态：一整回合举着挡
                else playLoop(rec, 'idle');
              }
            }
            rec.mixer.update(dt);
            rec.vrm.update(dt);                 // 归一化骨姿态复制到原始骨
          } else {
            // 动捕尚未就绪：程序化动作兜底（同样按走路 → 攻击 → 待机的先后顺序）
            if (u.out) rec.animator.setState(downClipFor(u.outReason));
            else if (!walking && rec.shotQueue.length) {
              const item = rec.shotQueue.shift();
              if (/attack/.test(item.name)) rec.animator.setState('attack', { side: rec.attackSide });
              else rec.animator.setState('idle');
            } else if (walking) rec.animator.setState('walk', { motion: 1 });
            else rec.animator.setState('idle');
            rec.animator.update(dt);
            rec.vrm.update(dt);
          }
          // 走路时朝当前路径段方向（拐角转身）；站定后回到引擎给的朝向（正对着要打的那个人）。
          // 两个角度都要叠上 rec.modelBaseYaw（模型自带的半圈修正，VRM0 才有）
          if (rec.vrm) rec.vrm.scene.rotation.y = rec.modelBaseYaw + (pathYaw != null ? pathYaw : rec.facingYaw);
        }
        const hit = now < (rec.hitUntil || 0);
        for (const m of rec.materials) {
          if (!m || !m.emissive) continue;        // 极少数材质没有自发光通道，跳过
          m.emissive.setHex(hit ? 0xb03a1e : 0x000000);
          const es = hit ? 1 : 0;
          if ('emissiveStrength' in m) m.emissiveStrength = es;      // VRM MToon
          else if ('emissiveIntensity' in m) m.emissiveIntensity = es;
        }
      }

      // ---- 演出单：一次只演一条，演完才轮到下一条 ----
      // 演出单由 BattleView 从战报翻译好喂进来。这里负责「演」和「什么时候算演完」：
      //   move  站定（路径走完）＝演完
      //   act   等这个人站稳 → 播近战/远程 → 播到命中那一刻回报 onBeatImpact（伤害数字
      //         与血条都是这一刻才变的）→ 整段播完 ＝ 演完
      //   guard 同上，只是播的是护架那一段（防具／威吓都只演一遍）
      //   out   退场（陨落／伤重不支／投降／逃遁成功）→ 摆倒地姿势，播完 ＝ 演完
      //         ⚠ 它是**排队演的一步**，不是照着 frame 立刻生效的 —— 否则
      //         「先移动、后投降」会演成「先躺下、再滑出去」（玩家 2026-09-20 报的正是这个）
      // 兜底：单条超过 BEAT_MAX_S 秒一律判演完，免得动作缺失把整局的推进卡死。
      if (a.beat) {
        const bx = a.beat;
        const arec = a.actors.get(bx.actorId);
        const el = (now - bx.t0) / 1000;
        let done = false;
        if (!arec || !arec.ready) {
          done = true;
        } else if (bx.kind === 'move') {
          // 已经站定（走完了，或者压根没挪窝）就算演完
          if (!arec.path) done = true;
        } else if (bx.kind === 'out') {
          // 退场：把"倒下了"这笔账在**画面上**兑现（姿势本身由帧循环按 rec.shownOut 摆）。
          // 逃遁不倒地（遁走的是虚影，站着更像"走了"），演完只等淡出；
          // 其余等倒地动作播完 —— 这样「先走完这一手、再倒下」的先后就由战报顺序定死了。
          const reason = bx.reason || uByIdRef.current.get(bx.actorId)?.outReason || '';
          if (arec.path) {
            done = false;          // 最后一段路还没走完：让他走完再倒（顺序上几乎不会同时发生）
          } else {
            if (!bx.outAt) { bx.outAt = now; arec.shownOut = true; }
            const act = arec.actions?.down;
            if (reason === '逃遁') done = (now - bx.outAt) / 1000 >= 0.3;
            else if (act) done = (now - bx.outAt) / 1000 > 0.25 && !act.isRunning();   // 先等它开播，再等它停
            else done = (now - bx.outAt) / 1000 >= 0.8;                               // 动捕没到位就按兜底时长
          }
        } else if (!arec.path) {
          // 出手：一定要等人先站稳，绝不走着走着就出手
          if (!bx.shot) {
            const name = bx.kind === 'guard' ? 'block' : (bx.style === 'ranged' ? 'ranged' : 'melee');
            // 时长按**这个角色这份**片段量（各人缩放不同，时长是同一份素材的），量不出来按兜底值
            const t = actionTiming(name, arec.clips?.[name]?.duration);
            const ok = playShot(arec, name);
            bx.shot = name; bx.shotAt = now; bx.impact = t.impact; bx.dur = t.dur; bx.noClip = !ok;
            // 动捕片段没到位（退化到程序化动作）：让程序化那一套也挥一下，别干站着
            if (!ok && arec.animator) arec.shotQueue.push({ name: 'attackR' });
          } else {
            const act = arec.actions?.[bx.shot];
            if (!bx.fired && bx.shotAt && (now - bx.shotAt) / 1000 >= bx.impact) {
              bx.fired = true;
              beatImpactRef.current?.(bx);
            }
            // 有片段：播完就算演完；没片段：按量出来的时长到点就算演完
            if (bx.noClip ? (now - bx.shotAt) / 1000 >= bx.dur : (!act || !act.isRunning())) done = true;
          }
        }
        if (el > BEAT_MAX_S) done = true;
        if (done) {
          a.beat = null;
          beatDoneRef.current?.(bx);
        }
      }

      // 名字牌：用画布真实的宽高比再投影一次，保证和 3D 里看到的位置完全一致
      const bas = viewBasis(viewRef.current, MAP_SIZE, a.aspect || 1.6);
      for (const [id, rec] of a.actors) {
        const el = tagRefs.current.get(id);
        if (!el) continue;
        const pos = rec.root.position;
        const p = projectPoint([pos.x, pos.y + UNIT_TAG_Y, pos.z], bas);
        if (!p || p.depth > 200) { el.style.visibility = 'hidden'; continue; }
        el.style.visibility = 'visible';
        el.style.left = `${p.left.toFixed(2)}%`;
        el.style.top = `${p.top.toFixed(2)}%`;
      }

      // 伤害数字：贴在被打的人头上
      if (dmgRef.current) {
        const t = fxRef.current?.targetId;
        const rec = t ? a.actors.get(t) : null;
        const p = rec ? projectPoint([rec.root.position.x, rec.root.position.y + UNIT_DMG_Y, rec.root.position.z], bas) : null;
        if (p) {
          dmgRef.current.style.left = `${p.left.toFixed(2)}%`;
          dmgRef.current.style.top = `${p.top.toFixed(2)}%`;
          dmgRef.current.style.visibility = 'visible';
        } else {
          dmgRef.current.style.visibility = 'hidden';
        }
      }

      // 出手特效（弧光/飞行光点/命中环）：各自带时长与更新函数，跑完就撤
      for (let i = a.fxList.length - 1; i >= 0; i--) {
        const f = a.fxList[i];
        const t = (now - f.t0) / (f.dur || 420);
        if (t >= 1) {
          a.scene.remove(f.mesh);
          f.mesh.geometry.dispose();
          f.mesh.material.dispose();
          a.fxList.splice(i, 1);
          continue;
        }
        if (f.update) f.update(t, f);
      }

      // 可打的目标呼吸一下，一眼看得出"点它"
      a.targetMesh.material.opacity = 0.44 + Math.sin(now / 260) * 0.18;
      // 本回合可达蓝底轻微呼吸（与淡绿「可通行」底区分开）；2026-09-20 降透明度避免中央发灰
      a.reachMesh.material.opacity = 0.28 + Math.sin(now / 320) * 0.08;
      // 水面着色器时间推进
      if (a.water) a.water.material.uniforms.uTime.value = now / 1000;

      // ---- 氛围动画（纯观感）----
      const sec = now / 1000;
      // 云缓慢横漂，超出范围绕回
      if (a.distant) for (const cg of a.distant.clouds) {
        cg.position.x += cg.userData.drift * dt;
        if (cg.position.x > 44) cg.position.x = -44;
      }
      // 灵气光点上下漂浮、左右轻摆
      if (a.spirit) {
        const arr = a.spirit.points.geometry.attributes.position;
        a.spirit.points.userData.motes.forEach((d, i) => {
          arr.setXYZ(i,
            d.bx + Math.sin(sec * 0.6 + d.phase) * d.sway,
            d.baseY + Math.sin(sec * 0.9 + d.phase) * d.amp,
            d.bz + Math.cos(sec * 0.5 + d.phase) * d.sway);
        });
        arr.needsUpdate = true;
      }
      // 花瓣飘落、摆动、翻转，落回地面后回到顶部
      if (a.petals) {
        const petalDummy = new THREE.Object3D();
        a.petals.userData.petals.forEach((d, i) => {
          d.y -= d.speed * dt;
          if (d.y < 0.08) d.y = 4.8;
          petalDummy.position.set(
            d.x + Math.sin(sec + d.phase) * d.sway,
            d.y,
            d.z + Math.cos(sec * 0.8 + d.phase) * d.sway * 0.6);
          petalDummy.rotation.set(sec * d.spin, sec * d.spin * 0.7, sec * d.spin * 1.3);
          petalDummy.scale.setScalar(1);
          petalDummy.updateMatrix();
          a.petals.setMatrixAt(i, petalDummy.matrix);
        });
        a.petals.instanceMatrix.needsUpdate = true;
      }
      // 篝火火焰闪烁
      if (a.flameGroups) for (const fg of a.flameGroups) {
        fg.userData.flames.forEach((f) => {
          const k = 0.5 + 0.5 * Math.sin(sec * 9 + f.phase);
          f.m.scale.set(1 + k * 0.25, 0.85 + k * 0.5, 1 + k * 0.25);
          f.m.material.opacity = 0.72 + k * 0.28;
        });
      }

      // 经后处理链输出（RenderPass→Bloom→调色→OutputPass/ACES）
      a.postFX.composer.render();
    };
    step();

    return () => {
      cancelAnimationFrame(api.current.raf);
      const a = api.current;
      (a.fxList || []).forEach(f => { f.mesh.geometry.dispose(); f.mesh.material.dispose(); });
      (a.actors || new Map()).forEach(rec => {
        if (rec.mixer) rec.mixer.stopAllAction();
        if (rec.vrm) VRMUtils.deepDispose(rec.vrm.scene);   // VRM 几何/材质/贴图
        rec.owned.forEach(o => o && o.dispose());           // 朝向圈 / 暗痕（自己造的）
      });
      mine.geo.forEach(g2 => g2.dispose());
      mine.mat.forEach(m2 => m2.dispose());
      mine.tex.forEach(t2 => t2.dispose());
      if (water) water.dispose();    // 水面几何/材质 ＋ 反射器与其反射 RT
      if (postFX) postFX.dispose();  // composer 的 HDR 缓冲与各 pass 资源
      envRT.dispose();
      renderer.dispose();
      if (typeof window !== 'undefined' && window.__bs3 === a) delete window.__bs3;
      api.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lib, status]);

  // ---------- 画布尺寸 ----------
  useEffect(() => {
    const a = api.current;
    if (!a.renderer || box.w < 2 || box.h < 2) return;
    a.renderer.setSize(box.w, box.h, false);   // false：尺寸交给 CSS，这里只对齐绘制缓冲
    // ⚠ 后处理的像素倍数必须和渲染器**用同一个**（曾经这里写死 min(dpr,2)，渲染器用的是超采样值，
    //   两者对不上时画面会先被降采样一次再放大 —— 看着就是"整体发糊"）。
    if (a.postFX) a.postFX.setSize(box.w, box.h, pickPixelRatio());
    a.aspect = aspect;
    a.camera.aspect = aspect;
    a.camera.updateProjectionMatrix();
  }, [box.w, box.h, lib, status, aspect, sceneEpoch]);

  // ---------- 视角：交给相机 ----------
  useEffect(() => {
    const a = api.current;
    if (!a.camera) return;
    const b = viewBasis(view, MAP_SIZE, a.aspect || aspect);
    a.camera.position.set(b.pos[0], b.pos[1], b.pos[2]);
    // 看哪儿由 viewBasis 说了算 —— 它为了把棋盘摆到画面正中会把镜头整体挪开，
    // 要是这里还死盯着棋盘正中，3D 画面和 DOM 名字牌就会朝着两个方向偏。
    a.camera.lookAt(b.target[0], b.target[1], b.target[2]);
  }, [view.rx, view.rz, view.zoom, view.panX, view.panZ, box.w, box.h, lib, status, sceneEpoch]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 高亮层 ----------
  useEffect(() => {
    const a = api.current;
    if (!a.tiles || !grid) return;
    const paint = (mesh, cells) => {
      mesh.geometry.dispose();
      const g2 = new THREE.BufferGeometry();
      const o = buildOverlayGeometry(grid, cells, { size: MAP_SIZE });
      g2.setAttribute('position', new THREE.BufferAttribute(o.positions, 3));
      g2.setIndex(new THREE.BufferAttribute(o.indices, 1));
      mesh.geometry = g2;
      mesh.visible = o.count > 0;
    };
    const mineUnit = units.find(u => u.id === actorId);
    // 所有可通行地块（与回合无关）→ 淡绿底
    const passCells = [];
    for (let yy = 0; yy < MAP_SIZE; yy++)
      for (let xx = 0; xx < MAP_SIZE; xx++)
        if (terrainOf(grid[yy][xx]).passable) passCells.push({ x: xx, y: yy });
    paint(a.walkMesh, passCells);
    const reachCells = [...(reachable || new Map()).keys()]
      .map(k => { const [x, y] = String(k).split(',').map(Number); return { x, y }; })
      // 自己脚下那一格不铺蓝 —— 那儿站着人，铺了反而看不清脚
      .filter(c => !mineUnit || c.x !== mineUnit.x || c.y !== mineUnit.y);
    paint(a.reachMesh, reachCells);
    paint(a.targetMesh, units.filter(u => targetIds && targetIds.has(u.id)).map(u => ({ x: u.x, y: u.y })));
    paint(a.hoverMesh, hover ? [hover] : []);
  }, [grid, reachable, targetIds, hover, actorId, units, lib, status, sceneEpoch]);

  // ---------- 小人：上场 / 下场 / 挪位 / 转身 / 压暗 ----------
  useEffect(() => {
    const a = api.current;
    if (!a.scene || !lib) return;
    const ids = new Set(units.map(u => u.id));

    for (const [id, rec] of [...a.actors]) {
      if (ids.has(id)) continue;
      a.scene.remove(rec.root);
      if (rec.mixer) rec.mixer.stopAllAction();
      if (rec.vrm) VRMUtils.deepDispose(rec.vrm.scene);
      rec.owned.forEach(o => o && o.dispose());
      const pi = a.pickables.indexOf(rec.pickable);
      if (pi >= 0) a.pickables.splice(pi, 1);
      a.actors.delete(id);
    }

    for (const u of units) {
      let rec = a.actors.get(u.id);
      if (!rec) {
        // 先立刻把站位 holder（含朝向圈 / 退场暗痕）建好、注册拾取，VRM 异步到位后再挂模型
        const holder = new THREE.Group();
        const ring = makeFacingRing(u.side);
        const mark = makeOutMark();
        mark.visible = false;
        holder.add(ring, mark);

        const pickable = {
          object: holder,
          cellOf: () => { const cur = uByIdRef.current.get(u.id); return cur ? { x: cur.x, y: cur.y } : null; },
        };
        const anchor0 = anchorOf(u, gridRef.current);
        holder.position.set(anchor0[0], anchor0[1], anchor0[2]);
        a.scene.add(holder);
        a.pickables.push(pickable);

        rec = {
          root: holder, ring, mark, pickable,
          vrm: null, animator: null, materials: [], ready: false,
          // 朝向圈和暗痕是自己造的，散场时要 dispose；VRM 用 deepDispose 单独释放
          owned: [...collectOwned(ring), ...collectOwned(mark)],
          path: null, pathYaw: 0, base: anchor0, tile: { x: u.x, y: u.y },
          mixer: null, clips: null, actions: null, shotName: null, loopName: null,
          shotQueue: [],                       // 只给"动捕没到位"的程序化兜底用
          runSpeed: null, modelScale: 1,       // 跑多快由动作说了算，见 runSpeedOf
          // 模型自带的朝向修正（VRM0 会在 loadVrm 里被转半圈），我们给的角度要**叠在它上面**，
          // 不能直接盖 —— 盖掉就等于把 VRM0 全转反了（见下面加载完成处那段注释）
          modelBaseYaw: 0,
          // 「退场」有没有演到（＝画面上这个人倒下了没有）。引擎的 u.out 是即时的，
          // 演出要按战报顺序来，所以画面上另开一笔账。见 units effect 与演出单里的 out 分支。
          // 初次见到这个单位时直接采纳当前状态：重进战斗时历史上已经倒下的人不该再"倒一次"。
          shownOut: !!u.out,
          facingYaw: characterYawRad(u.facing), attackSide: -1,
          hitUntil: 0,
        };
        a.actors.set(u.id, rec);

        // 异步加载该角色分到的 VRM（本地文件）。加载途中若单位已被移除，则释放、不挂载
        const vrmName = modelFor[u.id];
        loadVrm(vrmUrl(vrmName)).then((vrm) => {
          if (!a.actors.has(u.id)) { VRMUtils.deepDispose(vrm.scene); return; }
          const model = vrm.scene;
          const b = new THREE.Box3().setFromObject(model);
          const sz = b.getSize(new THREE.Vector3());
          const ctr = b.getCenter(new THREE.Vector3());
          const sc = VRM_TARGET_H / Math.max(0.001, sz.y);
          model.scale.setScalar(sc);
          // 水平居中、脚底落在 holder 原点（holder 已贴地表）
          model.position.set(-ctr.x * sc, -b.min.y * sc, -ctr.z * sc);
          const mats = [];
          model.traverse((o) => {
            if (o.isMesh || o.isSkinnedMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
              const mm = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
              for (const m of mm) {
                mats.push(m);
                // 小人身上的贴图同样把各向异性拉满（不然斜看时脸和衣纹糊成一片）
                for (const k of ['map', 'normalMap', 'emissiveMap']) {
                  const t = m && m[k];
                  if (t && t.isTexture) t.anisotropy = a.maxAniso || 8;
                }
              }
            }
          });
          // ⚠ 先记下模型**自己**的朝向修正再动手：loadVrm 里调过 VRMUtils.rotateVRM0，
          // 它对 VRM0.x 的模型会写一个 rotation.y = π（VRM1 不动）。10 个角色里 8 个是 VRM0。
          // 早先这里直接 `model.rotation.y = facingYaw` 把这半圈**盖掉了**，
          // 于是除了 VRM1 那个，所有人都是背朝前进方向 —— 玩家原话：
          // 「人物不会随自己跑步的方向旋转模型，看起来是倒着跑的」「攻击也没有面向攻击的对象」。
          rec.modelBaseYaw = model.rotation.y;
          model.rotation.y = rec.modelBaseYaw + rec.facingYaw;
          holder.add(model);
          rec.vrm = vrm;
          rec.materials = mats;
          rec.modelScale = sc;
          rec.animator = new VrmAnimator(vrm);
          rec.ready = true;

          // 动捕重定向（异步）：完成前由程序化动作兜底，完成后 mixer 接管。
          // 返回的是 { clips, info }：info.run 里记着"这段跑动素材一个循环把髋部带出去多远"，
          // 拿它换算成棋盘上每秒走几格 —— 这样每一脚都踩在实地上，不会脚底打滑、也不会变成慢动作。
          buildClips(vrm).then(({ clips, info }) => {
            if (!a.actors.has(u.id)) return;
            const mixer = new THREE.AnimationMixer(vrm.scene);
            const actions = {};
            for (const [n, clip] of Object.entries(clips)) {
              actions[n] = mixer.clipAction(clip);
              actions[n].enabled = true;
            }
            rec.mixer = mixer; rec.clips = clips; rec.actions = actions;
            // 跑速与量出来的位移都留档：跑速给 advancePath 用，位移给"跑速对不对"的核对用
            // （片段里的位移已经被抹平了，事后再从轨上量只会得到 0 —— 所以必须当场记下来）。
            rec.runTravel = info.run?.travel ?? null;
            rec.runSpeed = runSpeedOf(info.run, sc) || null;
            rec.shotName = null; rec.loopName = null;
            playLoop(rec, 'idle');
          }).catch((e) => {
            console.warn('[立体战场] 动捕重定向失败，沿用程序化动作', e);
          });
        }).catch((e) => {
          console.warn(`[立体战场] 角色 VRM 加载失败：${vrmName}`, e);
        });
      }

      // 站位：格号变了就沿真实格子路径走过去（拐角转身，不越障、不穿模）
      if (!rec.tile) rec.tile = { x: u.x, y: u.y };
      const anchor = anchorOf(u, gridRef.current);
      const tileChanged = rec.tile.x !== u.x || rec.tile.y !== u.y;
      if (tileChanged) {
        // 路径要绕开别人站着的格（不然会从同伴身上穿过去，两个小人叠成一团）
        rec.path = makePath(gridRef.current, rec.tile, { x: u.x, y: u.y }, rec.root.position,
          occupiedKeys(unitsRef.current, u.id));
        rec.tile = { x: u.x, y: u.y };
        rec.base = anchor;
      } else if (!rec.path) {
        rec.root.position.set(anchor[0], anchor[1], anchor[2]);
        rec.base = anchor;
      }

      rec.facingYaw = characterYawRad(u.facing);
      // 正在走的人由帧循环按路径方向转向（拐角转身）—— 这里别抢，否则每刷新一次就"顿一下正脸"
      // 停下来的才在这里立刻对齐；角度一样要叠模型自带的那半圈（VRM0）
      if (rec.vrm && !rec.path) rec.vrm.scene.rotation.y = rec.modelBaseYaw + rec.facingYaw;
      rec.ring.rotation.y = facingYawRad(u.facing);
      // ⚠ 这里判的是 rec.shownOut（**画面上演到的那一步**），不是 u.out（引擎的即时状态）。
      // 退场也是排队演的一步（BEAT_OUT），所以要等轮到它才开始褪色、摆状态牌；
      // 否则「先移动、后投降」会演成「先躺下、再滑出去」（玩家 2026-09-20 报的正是这个）。
      rec.ring.visible = !rec.shownOut;
      rec.mark.visible = !!rec.shownOut;

      const fade = rec.shownOut ? outFade(u) : 1;
      applyCharFade(rec, fade);
    }
  }, [units, lib, modelFor, status, sceneEpoch]);

  // ---------- 出手：弧光 ＋ 闪红 ＋ 挥砍动作 ----------
  useEffect(() => {
    const a = api.current;
    if (!a.scene || !fx || !fx.actorId) return;
    const actor = units.find(u => u.id === fx.actorId);
    const target = units.find(u => u.id === fx.targetId);
    if (!actor || !target) return;
    const at = anchorOf(target, gridRef.current);
    const ab = anchorOf(actor, gridRef.current);

    // 剑气弧光（暴击金色、普攻银白）
    const g2 = new THREE.TorusGeometry(0.42, 0.045, 5, 18, Math.PI * 1.15);
    const m2 = new THREE.MeshBasicMaterial({
      color: fx.crit ? 0xffd27a : 0xeef4ff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(g2, m2);
    const dirX = Math.sign(at[0] - ab[0]) || 1;
    mesh.position.set(at[0] - dirX * 0.16, at[1] + 0.46, at[2]);
    mesh.rotation.set(Math.PI / 2.6, dirX > 0 ? 0 : Math.PI, dirX > 0 ? -0.5 : 0.5);
    mesh.renderOrder = 5;
    a.scene.add(mesh);
    const rot0 = mesh.rotation.z;
    a.fxList.push({
      mesh, t0: performance.now(), dur: 420,
      update: (t) => {
        mesh.material.opacity = Math.max(0, 1 - t) * 0.9;
        mesh.scale.setScalar(0.75 + t * 0.7);
        mesh.rotation.z = rot0 + t * 1.4;
      },
    });

    // 飞行光点：从出手者掌中疾速飞向目标，到达时炸开命中光环
    const orbGeo = new THREE.SphereGeometry(0.07, 10, 10);
    const orbMat = new THREE.MeshBasicMaterial({
      color: fx.crit ? 0xffd27a : 0xdfeaff, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const orb = new THREE.Mesh(orbGeo, orbMat);
    const fromV = new THREE.Vector3(ab[0], ab[1] + 0.55, ab[2]);
    const toV = new THREE.Vector3(at[0], at[1] + 0.5, at[2]);
    orb.position.copy(fromV);
    a.scene.add(orb);
    let didHit = false;
    a.fxList.push({
      mesh: orb, t0: performance.now(), dur: 200,
      update: (t) => {
        orb.position.lerpVectors(fromV, toV, t);
        orb.scale.setScalar(1 - t * 0.4);
        orb.material.opacity = 1 - t * 0.3;
        if (!didHit && t >= 0.92) { didHit = true; spawnHitRing(a, toV, fx.crit); }
      },
    });

    const rec = a.actors.get(target.id);
    // 挨打的人身上闪一下红 —— 特效是**命中那一刻**才进来的（BattleView 把它挂在动作的命中帧上），
    // 所以这里不需要再算时间差，收到就闪。
    // 注意：受击**不摆动作**（需求：除移动/近战/远程/防御威吓/倒下之外都不做动作），只闪红。
    if (rec) rec.hitUntil = performance.now() + HIT_MS;
  }, [fx, units]);

  // ---------- 演出单：把「当前这一条」交给场景去演 ----------
  // BattleView 一次只发一条，演完（场景回报 onBeatDone）才发下一条，
  // 所以这里直接覆盖 a.beat 就行，不用再排一层队。真值（当前时刻/是否已命中）由帧循环维护。
  useEffect(() => {
    const a = api.current;
    if (!a.scene || !beat) return;
    a.beat = { ...beat, t0: performance.now(), shot: null, shotAt: 0, impact: 0, dur: 0, fired: false };
  }, [beat, lib, status, sceneEpoch]);

  // ---------- 拾取：屏幕坐标 → 哪一格 ----------
  useImperativeHandle(ref, () => ({
    pickCell(clientX, clientY) {
      const a = api.current;
      const canvas = canvasRef.current;
      if (!a.camera || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -(((clientY - rect.top) / rect.height) * 2 - 1),
      ), a.camera);
      const hits = ray.intersectObjects(a.pickables.map(p => p.object), true);
      if (!hits.length) return null;
      // 取最近的一个：点在树冠上就该是树那一格，不能穿过去打它后面那一格
      const top = hits[0];
      let node = top.object;
      while (node && !a.pickables.some(p => p.object === node)) node = node.parent;
      const hit = a.pickables.find(p => p.object === node);
      return (hit && hit.cellOf(top)) || worldToCell(top.point.x, top.point.z, MAP_SIZE);
    },
  }), [lib, status]);

  // ============================================================
  // 渲染
  // ============================================================
  if (status === 'failed') {
    // 3D 起不来时的兜底：一格一个方块，照样点得着、走得动 ——
    // 战斗不能因为"画不出来"就打不开
    return (
      <div className="battle-scene bs3-fallback" ref={wrapRef}>
        <div className="bs3-fb-note">三维场景起不来（浏览器不支持 WebGL），已退回格子视图，操作照旧</div>
        <div className="bs3-fb-grid" style={{ gridTemplateColumns: `repeat(${MAP_SIZE}, 1fr)` }}>
          {grid.flatMap((row, y) => row.map((tid, x) => (
            <button
              key={`${x},${y}`}
              className="bs3-fb-cell"
              style={{ background: lookOf(tid).color }}
              title={`${terrainOf(tid).id}｜${terrainOf(tid).desc}`}
              onClick={() => onFallbackPick && onFallbackPick(x, y)}
            />
          )))}
        </div>
      </div>
    );
  }

  return (
    <div className={`battle-scene${shake ? ' bs3-shake' : ''}`} ref={wrapRef}>
      <div className="bs3-inner">
        <canvas ref={canvasRef} className="bs3-canvas" />
        <div className="bs3-layer">
          {units.map((u) => {
            const p = projectPoint(unitTagAnchor(u, MAP_SIZE), basis);
            // 血条上的血 = 引擎已扣的 ＋ 还没演到的那几笔（hpPend）。
            // 这样「伤害数字弹出」与「血条掉下去」是同一帧 —— 玩家 2026-09-20 的要求。
            const pend = (hpPend && hpPend[u.id]) || 0;
            const hpNow = Math.max(0, Math.round((Number(u.hp) || 0) + pend));
            const hpPct = Math.max(0, Math.round((hpNow / Math.max(1, u.hpMax)) * 100));
            return (
              <div
                key={u.id}
                ref={(el) => { if (el) tagRefs.current.set(u.id, el); else tagRefs.current.delete(u.id); }}
                className={['bs3-tag', `side-${u.side}`, u.id === actorId ? 'acting' : '', u.out ? 'out' : ''].filter(Boolean).join(' ')}
                style={p ? { left: `${p.left}%`, top: `${p.top}%` } : { visibility: 'hidden' }}
                title={u.out
                  ? `${u.name}（${u.realm}）｜${outLabel(u)}｜退出战斗后仍留在场上，不再参与出手`
                  : `${u.name}（${u.realm}）｜气血 ${hpNow}/${u.hpMax}`}
              >
                <span className="bs3-name">{u.name.slice(0, 4)}</span>
                {u.out
                  ? <span className="bs3-state">{outLabel(u)}</span>
                  : <span className="bs3-bar"><i style={{ width: `${hpPct}%` }} /></span>}
              </div>
            );
          })}
          {fx && (
            <div ref={dmgRef} key={fx.key} className={`bs3-dmg${fx.crit ? ' crit' : ''}`}>
              {fx.dmg}{fx.truncated ? <em title="一击将剩余气血打空">终</em> : null}
            </div>
          )}
        </div>
        {status === 'loading' && <div className="bs3-loading">正在把山石草木搬进场…</div>}
      </div>
    </div>
  );
});

/** 把一个 Group 里所有网格的几何与材质收集起来（散场时要 dispose）。 */
function collectOwned(root) {
  const out = [];
  root.traverse(o => {
    if (o.geometry) out.push(o.geometry);
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => out.push(m));
  });
  return out;
}

export default BattleScene3D;
