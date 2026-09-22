// Mixamo 动捕 → VRM 重定向（2026-09-20 第 13 轮：动作换成 ACT 文件夹里的四段）
//
// 本轮规矩（玩家原话）：
//   移动 → Running、近战 → Cross Punch、远程 → Magic Attack、防御与威吓 → Blocking，其余动作不做动作。
//   动作速度**与素材一致**（不加速、不减速）；跑动的位移也要跟动作对得上，不许走成慢动作。
//
// 三条要命的细节，改这里的代码前先读：
//   ① **Running 自带「向前走」的根位移**：一个循环髋部前进 374（FBX 单位）≈3.7 米。
//      如果不抹掉它，重定向后每个循环人物会被动作推着往前飘一大截，再叠加棋盘自己的走位
//      ⇒ 人物像被风吹着滑过去。所以移动动作要**先量出这段位移、再抹掉**：
//      位移量用来定「棋盘上每秒走几格」（这样脚步与地面永远不打滑），抹掉之后由棋盘决定位置。
//   ② **命中时刻是量出来的**，不是拍的（见 IMPACT_AT）：
//      把动作真播一遍，逐帧取「出招那只手」相对髋部的前伸量，峰值就是打中的那一帧。
//      有了它，伤害数字才可能在「手打出去的那一刻」才冒出来，而不是一点技能就先弹数字。
//   ③ **ACT 的文件里带着一整套角色网格**（Beta_Surface/Beta_Joints，一个文件 2MB）。
//      我们只要骨骼，解析完就把网格摘掉，省内存也免得有人不小心把它挂进场景。
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { retargetAnimation } from 'vrm-mixamo-retarget';
import { ACTION_IMPACT, measurePlanarTravel, removePlanarDrift } from '../data/battleSceneModels.js';

/**
 * 一段动作的素材出处（键 = 场景里的动作名，值 = public/models/anim/<值>.fbx）。
 * 文件名对应关系（原素材在仓库根的 ACT/ 里，已拷进 public/models/anim/）：
 *   act-run    ←  ACT/Running.fbx
 *   act-melee  ←  ACT/Cross Punch.fbx
 *   act-ranged ←  ACT/Standing 1H Magic Attack 01.fbx
 *   act-block  ←  ACT/Blocking.fbx
 */
export const ANIM_SOURCE = {
  idle: 'idle',             // 待机（沿用原有素材）
  run: 'act-run',           // 移动
  melee: 'act-melee',       // 近战
  ranged: 'act-ranged',     // 远程
  block: 'act-block',       // 防御 / 威吓
  down: 'death',            // 倒下（沿用原有素材）
};

/** 循环播放的动作。其余一律「播一遍停住」。 */
export const LOOPING = new Set(['idle', 'run', 'blockHold']);

/** 播一遍就结束的动作。 */
export const ONE_SHOT = new Set(['melee', 'ranged', 'block', 'down']);

/** 移动用哪段动作。 */
export const RUN_ANIM = 'run';

/**
 * 命中时刻 = 整段动作播到第几成时「真打中」（数值出处见 battleSceneModels.ACTION_IMPACT）。
 * 量法：把 FBX 真播一遍，逐帧取出招那只手相对髋部的前伸量（沿角色朝向），取峰值。
 *   近战 57.5%（右拳伸到最远）／远程 50.4%（掌推出去、法力离体）／防御 23.8%（护架抬到位）。
 */
export const IMPACT_AT = ACTION_IMPACT;

/** 护架保持的那一帧取整段的几成（＝出招曲线里护架抬到最高的那一刻）。 */
export const BLOCK_HOLD_AT = IMPACT_AT.block;

const fbxCache = new Map();

function fbxUrl(name) {
  return `/models/anim/${name}.fbx`;
}

/**
 * 读一份 FBX（全局只读一次），顺手把用不上的角色网格摘掉，只留骨骼。
 *
 * ⚠ 返回的不只是 fbx，还有一份**原件快照**（pristine）。原因见 restorePristine：
 * `retargetAnimation` 是**就地改**片段数值的，不还原就会「越转越歪」。
 */
async function loadFbx(name) {
  if (!fbxCache.has(name)) {
    fbxCache.set(name, (async () => {
      const fbx = await new FBXLoader().loadAsync(fbxUrl(name));
      const drop = [];
      fbx.traverse((o) => { if (o.isMesh || o.isSkinnedMesh || o.isPoints || o.isLine) drop.push(o); });
      for (const o of drop) {
        if (o.parent) o.parent.remove(o);
        o.geometry?.dispose?.();
      }
      // 把每份片段的轨道数值原样抄一遍留底（关键帧时间不动，只抄 values）
      const pristine = new Map();
      for (const clip of fbx.animations || []) {
        pristine.set(clip, clip.tracks.map((t) => new Float32Array(t.values)));
      }
      return { fbx, pristine };
    })());
  }
  return fbxCache.get(name);
}

/**
 * 把缓存里的片段数值还原成**刚读进来的样子**。
 *
 * 为什么非做不可（2026-09-20 实测，脚本 _unused/battletest/retarget.idem.js）：
 * `vrm-mixamo-retarget` 的 retarget 是**原地改写** `track.values` 的
 * （`_quatA = parentRest * q * restInverse`，算完写回同一块数组）。
 * 而我们的 FBX 是缓存的 —— 于是同一页里第 2 个角色的重定向，是在"已经被转过一次的"
 * 数值上再转一次：第 N 个角色被转了 N 次。
 * 症状正是玩家报的「**有一个男孩模型严重穿模 / 折成一团**」：一场里排后面的那个角色
 * 全身被反复旋转，姿态彻底走形（实测第 2、5、7、9 个模型直接头朝下 / 悬空）；
 * 而第 1 个角色永远正常，所以看起来像"只有某一个模型有问题"。
 *
 * 这条也正是项目老规矩里那句「迁移/自愈必须幂等、绝不就地改传入对象」。
 */
function restorePristine(pristine) {
  for (const [clip, values] of pristine) {
    clip.tracks.forEach((t, i) => {
      const v = values[i];
      if (v && v.length === t.values.length) t.values.set(v);
    });
  }
}

/** 重定向后的髋部位移轨（只有髋部有 position 轨）。 */
function hipsTrackOf(clip) {
  return clip.tracks.find(t => /\.position$/.test(t.name)) || null;
}

/** 一个循环里髋部实际走了多远（水平面）—— 算法在 battleSceneModels.measurePlanarTravel。 */
function planarTravelOf(clip) {
  const tr = hipsTrackOf(clip);
  return tr ? measurePlanarTravel(tr.values) : 0;
}

/**
 * 抹掉「动作自带的向前走」—— 算法在 battleSceneModels.removePlanarDrift。
 * 一句话：只减水平两轴的线性趋势，**Y 绝不动**（那是髋部的绝对高度，动一下人就被按进地里）。
 */
function stripPlanarDrift(clip) {
  const tr = hipsTrackOf(clip);
  if (tr) removePlanarDrift(tr.values);
}

/**
 * 把某一个瞬间的姿势**冻成静止片段**：每条轨道两个关键帧、值一模一样，
 * 于是循环多少次都是同一个姿势（原地不动）。
 *
 * 为什么不再「截一小段来循环」（2026-09-20 踩过）：
 * 截出来的那一小段**本身还在动**（抬手、压腕），循环播就成了「举着盾一直抖」——
 * 玩家原话「点击防御之后角色不断抽动」「防御、威吓的动作演出一遍就行」。
 * 真机实测（_unused/scene3d/diag.cjs）：防御之后 3.9 秒里那段时间轴绕了 7 圈，
 * 等于同一段动作被反复演 7 遍。冻住之后就没有"演几遍"这回事了 —— 架着就是架着。
 *
 * @param {number} t 冻在哪个时刻（秒）
 * @param {number} len 这个静止片段有多长（秒）。随便给，反正姿势不变；给 1 秒是让淡入淡出有余地。
 */
function freezeClip(clip, name, t, len = 1) {
  const tt = Math.min(clip.duration, Math.max(0, t));
  const tracks = [];
  for (const tr of clip.tracks) {
    const vs = tr.getValueSize();
    let v = null;
    // 用轨道自己的插值器在任意时刻取值（关键帧之间也能取到真正的姿势）
    try { v = Array.from(tr.createInterpolant().evaluate(tt)); } catch { /* 取不出来就跳过这条轨道 */ }
    if (!v || v.length < vs) continue;
    const values = new Float32Array(vs * 2);
    for (let k = 0; k < vs; k++) { values[k] = v[k]; values[vs + k] = v[k]; }
    tracks.push(new tr.constructor(tr.name, new Float32Array([0, len]), values));
  }
  if (!tracks.length) return null;
  return new THREE.AnimationClip(name, len, tracks);
}

/**
 * 为某个 VRM 烤出全部动捕片段。
 * @returns {Promise<{clips: Record<string, THREE.AnimationClip>,
 *                    info: {durations: Record<string, number>, run: {travel:number, duration:number}|null}}>}
 */
export async function buildClips(vrm) {
  const clips = {};
  const durations = {};
  let runInfo = null;
  for (const [key, file] of Object.entries(ANIM_SOURCE)) {
    const { fbx, pristine } = await loadFbx(file);
    // ★ 重定向是就地改值的：每次烤之前先把片段还原成原件，否则第 N 个角色被转 N 次
    restorePristine(pristine);
    const clip = retargetAnimation(fbx, vrm, { logWarnings: false, animationClipName: 'mixamo.com' });
    if (!clip) continue;
    if (key === RUN_ANIM) {
      // 先量后抹：量出来的位移决定「棋盘上一秒走几格」，抹掉的那份交给棋盘自己走
      runInfo = { travel: planarTravelOf(clip), duration: clip.duration };
      stripPlanarDrift(clip);
    }
    clips[key] = clip;
    durations[key] = clip.duration;
    if (key === 'block') {
      // 「举着护架」用的姿势 = 护架抬到位的那一帧（与出招命中点同源，都是量出来的 ACTION_IMPACT.block）。
      // 冻住它：防御姿态要挂一整回合，播的是姿势不是动作。
      const hold = freezeClip(clip, 'blockHold', clip.duration * ACTION_IMPACT.block);
      if (hold) { clips.blockHold = hold; durations.blockHold = hold.duration; }
    }
  }
  return { clips, info: { durations, run: runInfo } };
}
