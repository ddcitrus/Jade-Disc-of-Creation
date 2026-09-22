// ===== 战场后处理：向《博德之门 3》的电影质感靠拢 =====
// 链路：RenderPass（场景，含水面平面反射）→ 轻微 Bloom（灵气/阳光辉光）
//       → 调色（对比/饱和）＋暗角 → OutputPass（ACES 色调映射 ＋ sRGB）。
// 说明：three 只在「渲染到屏幕」时才做色调映射（见 WebGLPrograms：currentRenderTarget===null），
//       所以场景渲染进 composer 的 HDR 缓冲时是线性的，统一由末尾 OutputPass 做 ACES，不会双重调色。
//
// 2026-09-20 「极大增加清晰度」这一轮在这里做的三件事：
//   ① **暗角从 0.38 降到 0.20** —— 暗角是"清楚"的头号敌人，它把画面四边压黑，
//      战场外围的树、地表纹理全被吃掉；只留一点点收边。
//   ② **辉光收紧**（强度 0.16→0.10、半径 0.50→0.38）—— 辉光本质是模糊，最容易把细节糊掉；
//      阈值仍是 1.0，所以只有灵气/法术这类真正的高光才发光，地面不会整体发雾。
//   ③ 对比抬到 1.10、饱和收到 1.08 —— 反差让界线更利落，但饱和过高会让贴图细节互相盖住。
// 另外清晰度的大头在渲染分辨率（超采样）与各向异性过滤，那两件事在 BattleScene3D 里。
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** 调色＋暗角（在线性 HDR 空间、色调映射之前）。 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uContrast: { value: 1.10 },
    uSat: { value: 1.08 },
    uVignette: { value: 0.20 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float uContrast;
    uniform float uSat;
    uniform float uVignette;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      // 对比（以 0.5 为枢）
      col = (col - 0.5) * uContrast + 0.5;
      // 饱和（按亮度灰阶混合）
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat);
      // 暗角：中心 1、边缘压暗
      vec2 q = vUv - 0.5;
      float vig = smoothstep(0.82, 0.28, length(q) * 1.4142);
      col *= mix(1.0, vig, uVignette);
      gl_FragColor = vec4(max(col, 0.0), c.a);
    }
  `,
};

export function buildPostFX(renderer, scene, camera, width, height, pixelRatio) {
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);
  // HDR 缓冲开 4× MSAA：RenderPass 的几何边缘在第一次被采样时 resolve，得到干净抗锯齿
  composer.renderTarget1.samples = 4;
  composer.renderTarget2.samples = 4;

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // 极克制的 Bloom：只让灵脉/阵纹自发光、太阳高光、法术特效微微发光，不糊整片。
  // 阈值 1.0（线性）：地面受光即便偏亮也不触发，只有真正的高光/自发光才辉光。
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    0.10,   // strength（2026-09-20 由 0.16 收紧 —— 辉光就是"糊"，宁可少一点）
    0.38,   // radius（由 0.50 收紧，光晕不再糊到邻近像素上）
    1.0,    // threshold（线性亮度，高于才辉光）
  );
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  const output = new OutputPass();
  composer.addPass(output);

  return {
    composer,
    bloom,
    grade,
    setSize(w, h, pr) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
    },
    dispose() {
      composer.dispose();
    },
  };
}
