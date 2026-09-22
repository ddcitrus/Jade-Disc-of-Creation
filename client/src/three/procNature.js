// ===== 程序化高精度自然摆件（仙侠主题）=====
// 为什么用程序化：CC0 的「照片级扫描」资源里没有竹、睡莲、中式残碑经幢、木栅栏这些主题件；
// 而 Kenney/Quaternius 的同类件仍是低模。这里用较高分段的几何 + PBR 材质（石材/木纹用
// 程序生成的 Canvas 纹理）直接搭建，配合场景的 PMREM 环境反射，观感精致、风格统一。
//
// 关键约束：
//   · 全部**确定性**：不使用 Math.random；每类摆件只构建一次，再由战场的「包围盒重定位 +
//     单格收敛」流水线按格哈希缩放/旋转/摆放 —— 与 GLB 模型走同一条路，天然保证不越界。
//   · buildProc 返回普通 THREE.Group（子节点是 Mesh），BattleScene3D 像对待 GLB 一样遍历它。
import * as THREE from 'three';

export const PROC_PREFIX = 'proc:';
export const isProc = (name) => typeof name === 'string' && name.startsWith(PROC_PREFIX);

// ------------------------------------------------------------
// 程序纹理（确定性 Canvas 纹理，同步可用，避免异步加载与网络依赖）
// ------------------------------------------------------------
function grainTexture(base, kind, seed0) {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, s, s);
  let seed = seed0;
  const rnd = () => { seed = (seed * 1664525 + 1013904273) >>> 0; return seed / 4294967296; };
  if (kind === 'stone') {
    for (let i = 0; i < 70; i++) {
      const g = 30 + Math.floor(rnd() * 70);
      ctx.fillStyle = `rgba(${g},${g},${g},${0.05 + rnd() * 0.12})`;
      ctx.beginPath();
      ctx.arc(rnd() * s, rnd() * s, 1 + rnd() * 9, 0, 7);
      ctx.fill();
    }
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = `rgba(28,26,24,${0.18 + rnd() * 0.22})`;
      ctx.lineWidth = 1 + rnd() * 1.4;
      let x = rnd() * s, y = rnd() * s;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let k = 0; k < 4; k++) { x += (rnd() - 0.5) * 42; y += (rnd() - 0.5) * 42; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  } else {
    for (let i = 0; i < 46; i++) {
      const g = 55 + Math.floor(rnd() * 60);
      ctx.strokeStyle = `rgba(${g},${Math.floor(g * 0.72)},${Math.floor(g * 0.45)},${0.10 + rnd() * 0.2})`;
      ctx.lineWidth = 1 + rnd() * 2;
      const x = rnd() * s;
      ctx.beginPath(); ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + (rnd() - 0.5) * 16, s * 0.33, x + (rnd() - 0.5) * 16, s * 0.66, x + (rnd() - 0.5) * 10, s);
      ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------
// 材质（名字刻意避开战场的 NATURE_PALETTE，颜色不被覆盖）
// ------------------------------------------------------------
function makeMaterials() {
  const stoneTex = grainTexture('#969084', 'stone', 101);
  const woodTex = grainTexture('#8a6240', 'wood', 202);
  return {
    procStone: new THREE.MeshStandardMaterial({ map: stoneTex, color: 0xffffff, roughness: 0.98, metalness: 0 }),
    procWood: new THREE.MeshStandardMaterial({ map: woodTex, color: 0xffffff, roughness: 0.92, metalness: 0 }),
    procCulm: new THREE.MeshStandardMaterial({ color: 0x86a85c, roughness: 0.7, metalness: 0 }),
    procNode: new THREE.MeshStandardMaterial({ color: 0xa7c47a, roughness: 0.7, metalness: 0 }),
    procLeaf: new THREE.MeshStandardMaterial({ color: 0x5d9240, roughness: 0.8, metalness: 0, side: THREE.DoubleSide }),
    procPad: new THREE.MeshStandardMaterial({ color: 0x4f9240, roughness: 0.72, metalness: 0, side: THREE.DoubleSide }),
    procPetal: new THREE.MeshStandardMaterial({ color: 0xf3b9cc, roughness: 0.66, metalness: 0 }),
    procPetalWhite: new THREE.MeshStandardMaterial({ color: 0xf7eef0, roughness: 0.66, metalness: 0 }),
    procCenter: new THREE.MeshStandardMaterial({ color: 0xf3d36b, roughness: 0.6, metalness: 0 }),
  };
}

let MATS = null;
function mats() { if (!MATS) MATS = makeMaterials(); return MATS; }

// ------------------------------------------------------------
// 各摆件构建
// ------------------------------------------------------------

/** 一丛清雅小竹：3 根竹竿（带节）＋顶部散叶。 */
function buildBamboo() {
  const M = mats();
  const g = new THREE.Group();
  const culm = (h, r, ox, oz, leanZ) => {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.92, r, h, 10, 8), M.procCulm);
    c.position.set(ox, h / 2, oz);
    c.rotation.z = leanZ;
    c.castShadow = true;
    g.add(c);
    for (let i = 1; i <= 4; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.06, r * 0.12, 6, 12), M.procNode);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(ox, (h * i) / 5, oz);
      g.add(ring);
    }
    // 顶部叶片
    for (let i = 0; i < 5; i++) {
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(r * 14, r * 4.2), M.procLeaf);
      const a = (i / 5) * Math.PI * 2;
      leaf.position.set(ox + Math.cos(a) * r * 2.2, h - r * 2, oz + Math.sin(a) * r * 2.2);
      leaf.rotation.set(0.5, a, 0.6);
      g.add(leaf);
    }
  };
  culm(0.92, 0.045, -0.08, 0.02, 0.05);
  culm(0.78, 0.04, 0.07, -0.05, -0.04);
  culm(0.66, 0.035, 0.02, 0.09, 0.02);
  return g;
}

/** 睡莲：两片带缺口的圆浮叶 ＋ 一朵小莲花。 */
function buildLily() {
  const M = mats();
  const g = new THREE.Group();
  const pad = (r, ox, oz, rot) => {
    // 留一个约 40° 的缺口（睡莲浮叶的典型特征）
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 20, 0.4, Math.PI * 2 - 0.4), M.procPad);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = rot;
    m.position.set(ox, 0.012, oz);
    g.add(m);
  };
  pad(0.30, -0.10, 0.02, 0.6);
  pad(0.20, 0.18, -0.12, 2.2);

  // 小莲花：6 片花瓣环绕黄花蕊
  const fx = 0.06, fz = -0.02;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6, 0, 6.28, 0, 1.7), i % 2 ? M.procPetal : M.procPetalWhite);
    p.scale.set(0.7, 1.1, 0.7);
    p.position.set(fx + Math.cos(a) * 0.06, 0.07, fz + Math.sin(a) * 0.06);
    p.rotation.set(0.5, 0, 0);
    g.add(p);
  }
  const center = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), M.procCenter);
  center.position.set(fx, 0.08, fz);
  g.add(center);
  return g;
}

/** 一段木栅栏：3 根立柱 ＋ 2 道横栏。 */
function buildFence() {
  const M = mats();
  const g = new THREE.Group();
  const post = (x) => {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.40, 0.07), M.procWood);
    p.position.set(x, 0.20, 0);
    p.castShadow = true;
    g.add(p);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.08, 4), M.procWood);
    tip.position.set(x, 0.44, 0);
    g.add(tip);
  };
  post(-0.24); post(0); post(0.24);
  for (const y of [0.16, 0.30]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.05, 0.045), M.procWood);
    rail.position.set(0, y, 0);
    rail.castShadow = true;
    g.add(rail);
  }
  return g;
}

/** 残碑：一方微微倾斜、顶部残破的石碑 ＋ 底座，旁落一小块碎石。 */
function buildStele() {
  const M = mats();
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.10, 0.18), M.procStone);
  base.position.y = 0.05;
  g.add(base);
  const slab = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.56, 0.09), M.procStone);
  slab.position.set(0.02, 0.40, 0);
  slab.rotation.z = -0.07;
  slab.castShadow = true;
  g.add(slab);
  // 残破的顶部（斜切的小块）
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.12, 4), M.procStone);
  cap.position.set(0.02, 0.72, 0);
  cap.rotation.z = -0.07;
  g.add(cap);
  const chip = new THREE.Mesh(new THREE.DodecahedronGeometry(0.05, 0), M.procStone);
  chip.position.set(-0.16, 0.06, 0.08);
  g.add(chip);
  return g;
}

/** 经幢：八角须弥座 ＋ 多棱石柱 ＋ 顶盖，是修仙遗迹里的石幢。 */
function buildPillar() {
  const M = mats();
  const g = new THREE.Group();
  const base1 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 0.10, 8), M.procStone);
  base1.position.y = 0.05; g.add(base1);
  const base2 = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.20, 0.08, 8), M.procStone);
  base2.position.y = 0.14; g.add(base2);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.125, 0.72, 14, 1), M.procStone);
  shaft.position.y = 0.54; shaft.castShadow = true; g.add(shaft);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.14, 0.10, 8), M.procStone);
  cap.position.y = 0.95; g.add(cap);
  const top = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8, 0, 6.28, 0, 1.6), M.procStone);
  top.position.y = 1.04; g.add(top);
  return g;
}

/** 望柱/石笋：四方收分的修长石柱 ＋ 方座。 */
function buildObelisk() {
  const M = mats();
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.12, 0.30), M.procStone);
  base.position.y = 0.06; g.add(base);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.15, 0.82, 4, 1), M.procStone);
  shaft.position.y = 0.53; shaft.rotation.y = Math.PI / 4; shaft.castShadow = true; g.add(shaft);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.10, 4), M.procStone);
  tip.position.y = 0.99; tip.rotation.y = Math.PI / 4; g.add(tip);
  return g;
}

/** 断柱：八角底座 ＋ 一截折断的石柱（参差顶）。 */
function buildBrokenColumn() {
  const M = mats();
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.22, 0.10, 8), M.procStone);
  base.position.y = 0.05; g.add(base);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.42, 12, 1), M.procStone);
  shaft.position.y = 0.31; shaft.castShadow = true; g.add(shaft);
  // 参差断口：一块斜搭的碎石
  const jag = new THREE.Mesh(new THREE.DodecahedronGeometry(0.10, 0), M.procStone);
  jag.position.set(0.03, 0.55, 0.02);
  jag.rotation.set(0.4, 0.2, 0.1);
  g.add(jag);
  return g;
}

/** 石环：半环形立石（阵纹中央的残环）。 */
function buildRing() {
  const M = mats();
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.20, 0.05, 8, 22, Math.PI * 1.5), M.procStone);
  ring.position.y = 0.22;
  ring.castShadow = true;
  g.add(ring);
  for (const sx of [-0.20, 0.20]) {
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.10), M.procStone);
    foot.position.set(sx, 0.03, 0);
    g.add(foot);
  }
  return g;
}

const BUILDERS = {
  bamboo: buildBamboo,
  lily: buildLily,
  fence: buildFence,
  stele: buildStele,
  pillar: buildPillar,
  obelisk: buildObelisk,
  column_broken: buildBrokenColumn,
  ring: buildRing,
};

/** 按名构建（去掉 proc: 前缀）。未知名返回 null。 */
export function buildProc(name) {
  const key = String(name).slice(PROC_PREFIX.length);
  const fn = BUILDERS[key];
  return fn ? fn() : null;
}

/** 全部程序化摆件名（供枚举/测试）。 */
export const PROC_MODEL_NAMES = Object.keys(BUILDERS).map(k => `${PROC_PREFIX}${k}`);
