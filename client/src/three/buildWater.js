// ===== 高精度水面：平面反射 ＋ 透明碧色水体 ＋ 太阳高光 ＋ 解析波纹 =====
// 参考《博德之门 3》《古剑奇谭》一类的水体观感：
//   · 用 three 的 Reflector 以「镜面反射相机」把整幅场景倒映出来（真实反射，不是假贴图）；
//   · 自己的水面着色器采样这张反射图，用波纹法线扰动 → 倒影随波轻晃；
//   · 视角越斜、反射越强（菲涅尔）；俯视时水体半透明，看得到水下的洼地；
//   · 锐利的太阳高光 ＋ 细碎波光。
// 水洼是小片碧潭，不做湖泊式的大浪，也不再摆船。
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

const WATER_Y = -0.018;          // 水面高度（略低于地表，装在 relief −.05 的洼地里）
const REFL_SIZE = 1024;          // 反射图分辨率

/**
 * 为所有水洼格构建一张连续水面。
 * @param {{x:number,y:number}[]} cells 水洼格
 * @param {number} size 棋盘边长
 */
export function buildWater(cells, size) {
  const list = cells || [];

  // ---- ① 镜面反射器：一块覆盖整张棋盘的水平反射面，自身不显示（colorWrite=false） ----
  const planeW = size + 6;
  const reflector = new Reflector(new THREE.PlaneGeometry(planeW, planeW), {
    textureWidth: REFL_SIZE,
    textureHeight: REFL_SIZE,
    color: 0xe6ecea,
    clipBias: 0.003,
    multisample: 4,
  });
  reflector.rotation.x = -Math.PI / 2;
  reflector.position.y = WATER_Y;
  reflector.frustumCulled = false;       // 保证每帧 onBeforeRender 都跑、反射图随相机更新
  reflector.renderOrder = 1;
  reflector.material.colorWrite = false; // 反射面本身不画出来（只要它产出的反射图）
  reflector.material.depthWrite = false;

  // ---- ② 合并的水面几何：每格一片水平四边形（世界坐标），略微放大避免发丝缝 ----
  const n = list.length;
  const grow = 0.012;                   // 每片外扩，消缝
  const positions = new Float32Array(n * 12);
  const uvs = new Float32Array(n * 8);
  const indices = new Uint32Array(n * 6);
  const c = (size - 1) / 2;
  let vi = 0, ii = 0;
  for (const cell of list) {
    const wx = cell.x - c, wz = cell.y - c;
    const x0 = wx - 0.5 - grow, x1 = wx + 0.5 + grow;
    const z0 = wz - 0.5 - grow, z1 = wz + 0.5 + grow;
    // 四角（y 先放水面高度，顶点着色器再按波纹起伏）
    positions.set([x0, WATER_Y, z0, x1, WATER_Y, z0, x1, WATER_Y, z1, x0, WATER_Y, z1], vi * 3);
    uvs.set([0, 0, 1, 0, 1, 1, 0, 1], vi * 2);
    indices.set([vi, vi + 2, vi + 1, vi, vi + 3, vi + 2], ii);
    vi += 4; ii += 6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));

  // ---- ③ 水面着色器 ----
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      tDiffuse: { value: null },                 // 反射图（下面别名到反射器的 RT）
      textureMatrix: { value: new THREE.Matrix4() },
      uSunDir: { value: new THREE.Vector3(-9, 17, 7).normalize() },
      uSunColor: { value: new THREE.Color(0xfff2d4) },
      uShallow: { value: new THREE.Color(0x227a7c) },   // 浅水碧色（线性观感值）
      uDeep: { value: new THREE.Color(0x07222a) },      // 深水色
    },
    vertexShader: /* glsl */`
      uniform mat4 textureMatrix;
      uniform float uTime;
      varying vec3 vW;
      varying vec4 vUv;

      // 多倍频小波（水面是小水洼，振幅很小，不做大浪）
      float waveH(vec2 p, float t) {
        float h = 0.0;
        h += sin(p.x * 0.9 + t * 1.10) * 0.010;
        h += sin(p.y * 1.1 - t * 0.90) * 0.010;
        h += sin(p.x * 2.3 + p.y * 1.7 + t * 1.90) * 0.006;
        h += sin(p.x * 1.9 - p.y * 2.4 - t * 1.60) * 0.005;
        h += sin(p.x * 5.0 + t * 2.60) * 0.0028;
        h += sin(p.y * 4.4 - t * 2.20) * 0.0028;
        return h;
      }

      void main() {
        vec3 wp = position;
        float h = waveH(wp.xz, uTime);
        wp.y += h;
        // 解析法线（有限差分）
        float e = 0.08;
        float hx = waveH(wp.xz + vec2(e, 0.0), uTime);
        float hz = waveH(wp.xz + vec2(0.0, e), uTime);
        vec3 n = normalize(vec3((h - hx) / e, 1.0, (h - hz) / e));

        vW = wp;
        // 反射器本地平面坐标：反射器 local (lx,ly,0) 经旋转后 world (lx, y, -ly)
        vec3 reflLocal = vec3(wp.x, -wp.z, 0.0);
        vUv = textureMatrix * vec4(reflLocal, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime;
      uniform sampler2D tDiffuse;
      uniform vec3 uSunDir, uSunColor, uShallow, uDeep;
      varying vec3 vW;
      varying vec4 vUv;

      // 片元级细密法线（给高光与波光用）
      vec3 fineNormal(vec2 p, float t) {
        float e = 0.05;
        float hc = sin(p.x * 6.0 + t * 2.2) * 0.004 + sin(p.y * 5.4 - t * 1.9) * 0.004;
        float hx = sin((p.x + e) * 6.0 + t * 2.2) * 0.004 + sin(p.y * 5.4 - t * 1.9) * 0.004;
        float hz = sin(p.x * 6.0 + t * 2.2) * 0.004 + sin((p.y + e) * 5.4 - t * 1.9) * 0.004;
        return normalize(vec3((hc - hx) / e, 1.0, (hc - hz) / e));
      }

      void main() {
        vec3 N = fineNormal(vW.xz, uTime);
        vec3 V = normalize(cameraPosition - vW);
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = pow(1.0 - ndv, 3.0);

        // 用波纹法线扰动反射采样，倒影随波轻晃
        vec4 rUv = vUv;
        rUv.xy += N.xz * 0.07 * rUv.w;
        vec3 refl = texture2DProj(tDiffuse, rUv).rgb;

        // 水体本色：浅水碧、深水暗；俯视时半透明，露出下方洼地
        vec3 body = mix(uShallow, uDeep, 0.35);
        float bodyA = 0.46;
        // 反射收敛：俯视几乎不混反射（不发奶白），掠射才接近镜面；反射整体压一点避免纯白
        vec3 reflT = refl * 0.92;
        vec3 col = mix(body, reflT, clamp(fres * 1.0, 0.0, 0.9));
        float a = mix(bodyA, 0.92, fres);

        // 锐利太阳高光
        vec3 H = normalize(V + uSunDir);
        float spec = pow(max(dot(N, H), 0.0), 260.0);
        col += uSunColor * spec * 1.0;
        // 细碎波光
        float gl = pow(
          max(0.0, sin(vW.x * 12.0 + uTime * 2.0) * sin(vW.z * 10.0 - uTime * 1.7)),
          18.0);
        col += uSunColor * gl * 0.22;

        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;

  // 反射图与纹理矩阵别名到反射器：反射器每帧 onBeforeRender 会更新它们，水面自动拿到最新值
  material.uniforms.tDiffuse.value = reflector.getRenderTarget().texture;
  material.uniforms.textureMatrix.value = reflector.material.uniforms.textureMatrix.value;

  // 反射器做镜像渲染时，把水面也藏起来 —— 否则水面采样的反射图正是当前正在写入的 RT，
  // 形成「同一纹理既读又写」的反馈回环（WebGL 非法）。
  const origBefore = reflector.onBeforeRender;
  reflector.onBeforeRender = function (renderer, scene, camera) {
    mesh.visible = false;
    origBefore.call(this, renderer, scene, camera);
    mesh.visible = true;
  };

  return {
    mesh,
    material,
    reflector,
    set time(t) { material.uniforms.uTime.value = t; },
    dispose() {
      geo.dispose();
      material.dispose();
      reflector.dispose();
    },
  };
}
