// ===== 战斗界面（15×15 战棋 + 行动条 + 玩家操作面板）=====
// 需求：程序完全接管战斗；轮到用户行动时，用户可以普攻、选择技能、选择其他行动（逃遁、威吓、投降）、调用背包物品。
//
// 本组件只做三件事：
//   ① 把引擎的 viewFrame 画出来（地图 / 单位 / 行动条 / 战报）
//   ② 把玩家的点击翻译成引擎的 moveTo / doAction / endTurn
//   ③ 对手是程序控制的，按节拍自动推进（让玩家看得清发生了什么）
// 任何数值都不在这里计算 —— 界面上的每个数字都直接来自引擎。
//
// ── 回合规则（2026-09-19 改）──
// 一个回合 = 一次走位额度 + 一次出手额度，两笔各自独立、互不锁死：
//   · 走位不结束回合，出手**也不结束回合**；
//   · 所以可以「走 → 打 → 再走」；
//   · 真正交出回合只有一条路 —— 底部那个「结束回合」按钮（敌方由 battleAI 自己收尾）。
//
// ── 出手流程（2026-09-19 改）──
//   ① 在右侧面板点一个技能（＝选中）
//   ② 在战场上点一个闪烁的目标（＝释放）
// 不再有「自动去打最近的那个」——打谁由玩家决定。瞄准期间鼠标停在谁身上，
// 提示条会报出这一击的预计（伤害 / 暴击率 / 是不是打到了背面），数字与真正结算同源。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  legalActions, validTargets, moveTo, doAction, endTurn, viewFrame, currentReach,
  battleOutcome, previewAttack, attackSpec, critProfile, TUNING,
} from '../data/battleEngine.js';
import { runEnemyTurn } from '../data/battleAI.js';
import { beatsFromLog, BEAT_ACT } from '../data/battleBeats.js';
import { terrainOf } from '../data/battleTerrain.js';
import { cellKey } from '../data/battleGrid.js';
import {
  CAM_DEFAULT, CAM_ZOOM_MIN, CAM_ZOOM_MAX, clampView, outLabel, lookOf,
} from '../data/battleSceneModels.js';
import BattleScene3D from './BattleScene3D.jsx';

// 敌方每一步之间的间隔，给玩家留出观看时间。
// 注意它只是「最早可以开始下一步」—— 真正能不能推进还要看演出有没有演完（见下面的演出单队列）。
const AI_STEP_MS = 520;
const MAX_AI_STEPS = 400;    // 死循环保险

// ===== 演出单：把「引擎一瞬间算完的事」按先后演出来 =====
// 引擎是"一点就算完"的：一次点击可能同时产生「移动 + 命中 + 倒下」三行战报。
// 若界面照着战报立刻弹伤害数字，就会变成"人还在走、数字先冒出来"。
// 所以这里做三件事：
//   ① 把新战报翻译成演出单（battleBeats），一条一条排好；
//   ② 一次只发一条给 3D 场景，演完（场景回报）才发下一条；
//   ③ 伤害数字不是收到战报就弹，而是等场景回报「手打到人身上那一刻」才弹。
// 一个人连着走、打、再走也不乱：三条演出单按原顺序排队，谁也不许抢。

// ===== 看战场的视角（放大缩小 / 旋转）=====
// 三个数喂给 three 的透视相机：俯角 rx、方位角 rz、远近 zoom。
// 默认值与夹取范围都在 battleSceneModels 里（那边才是"场景怎么摆"的唯一出口），
// 这里只是本地取一份、方便界面按钮用。
const VIEW_DEFAULT = CAM_DEFAULT;
const VIEW_ZOOM_MIN = CAM_ZOOM_MIN, VIEW_ZOOM_MAX = CAM_ZOOM_MAX;
/**
 * 滚一档／点一下 ＋－ 按钮，远近档**乘**这个倍数。
 * 为什么是等比而不是加减一个固定量：远近档从 0.5 到 16 跨了 32 倍，
 * 老写法每档加 0.08，要从 100% 搓到 1600% 得滚 187 格 —— 想凑近看张脸根本搓不到；
 * 等比则是每档手感一致（1.16 倍／档，19 格到顶），拉近拉远的"速度感"永远一样。
 */
const VIEW_ZOOM_STEP = 1.16;
/**
 * 平移灵敏度最多按这个倍数折算（见 onMove 里的 pk）。
 * 越凑近，同样一像素对应的世界越少（按 zoom 除，保持"抓住地图"的 1:1 手感）；
 * 但若一路除下去，放到 16 倍时想把镜头挪到另一个人身上得拖几千像素 —— 够不着。
 * 所以除到 3 倍就打住：再近也不更慢，"从这头挪到那头"始终是几把拖拽的事。
 */
const PAN_ZOOM_CAP = 3;

// 方位角变化 deg 时，视野中心**不动**。
// 为什么不动才对：pan 记的是"镜头盯着的那块地"在世界里的位置（见 battleSceneModels.viewBasis）。
// 转方位角 = 镜头绕着这块地公转一圈，那块地自然一直待在画面中央 —— 这正是 BG3 的手感。
// （旧写法把 pan 跟着一起转，等于让"盯着的那块地"绕着棋盘中心划圈，转起来整个视野会自己横漂。）
const orbitGoal = (g, deg) => ({ ...g, rz: g.rz + deg });

export default function BattleView({ setup, onFinish, onClose }) {
  const stateRef = useRef(null);
  if (!stateRef.current) stateRef.current = setup.state;
  const [frame, setFrame] = useState(() => viewFrame(stateRef.current));
  const [mode, setMode] = useState('move');       // 'move' | 'target'
  const [pending, setPending] = useState(null);   // 待选目标的动作
  const [hover, setHover] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [tab, setTab] = useState('skill');        // 动作面板页签：action | skill | item
  const [showAudit, setShowAudit] = useState(true); // 战报是否展开「算式明细」
  const [fx, setFx] = useState(null);             // 正在播放的一击：{actorId,targetId,dmg,crit,dx,dy,truncated}
  const [shake, setShake] = useState(false);      // 命中时沙盘震一下
  const [beat, setBeat] = useState(null);         // 正在演的那一条演出单（null＝场上没在演）
  const [beatsLeft, setBeatsLeft] = useState(0);  // 排队等着演的还有几条
  const logRef = useRef(null);
  const stepsRef = useRef(0);
  const fxTimerRef = useRef(null);
  // 演出单队列。activeBeatRef 与 beat 同步，用来识别"回报是不是当前这一条的"。
  const beatQueueRef = useRef([]);
  const activeBeatRef = useRef(null);
  const loggedRef = useRef(new WeakSet());        // 已经翻译过的战报（按对象身份去重；战报对象每条都是新建的）
  const sceneLiveRef = useRef(false);             // 三维场景起没起来（起不来就不走演出、数字直接弹）
  // ===== 血条与伤害数字同步 =====
  // 引擎是"一瞬间"把血扣掉的，可伤害数字要等拳头真打中（约 1.2 秒后）才弹。
  // 血条若照 frame 立刻塌下去，玩家看到的就是「血先掉一截、数字过一会儿才到」。
  // 所以把"还没演到的那几笔伤害"记在账上（按演出单编号），**显示时加回血条**；
  // 演到那一刻（onBeatImpact）销账 —— 数字与血条同一帧变。
  // 为什么按编号而不是按人：同一个人可能连挨两下，两笔各有各的"打中时刻"，得分开销。
  const hpPendingRef = useRef(new Map());         // 演出单编号 → { targetId, dmg }
  const [hpPending, setHpPending] = useState({}); // targetId → 累计待扣（只给渲染读）
  const syncHpPending = () => {
    const m = {};
    for (const it of hpPendingRef.current.values()) {
      if (!it) continue;
      m[it.targetId] = (m[it.targetId] || 0) + it.dmg;
    }
    setHpPending(m);
  };
  // ===== 视角：放大缩小 / 旋转 =====
  const [view, setView] = useState(VIEW_DEFAULT);
  const stageRef = useRef(null);
  const sceneRef = useRef(null);                  // 三维场景：把「屏幕坐标 → 哪一格」借出来
  const dragRef = useRef(null);                   // 正在拖动的起点（null = 没在拖）
  const dragEndAtRef = useRef(0);                 // 拖动结束的时刻：刚拖完的那一下 click 不算「走位」
  const hoverKeyRef = useRef('');                 // 上一次悬停的格 —— 同一格来回移动不重复渲染
  const [dragging, setDragging] = useState(false); // 正在转视角：整块界面换成「抓着」的手型
  // 镜头目标值：所有操作（拖拽 / 滚轮 / 按钮）只改 goal，渲染视角每帧向 goal 做指数平滑 —— BG3 式阻尼手感
  const goalRef = useRef(VIEW_DEFAULT);
  const pushGoal = (updater) => {
    const g = goalRef.current;
    goalRef.current = clampView(typeof updater === 'function' ? updater(g) : updater);
  };
  useEffect(() => {
    let raf = 0, last = performance.now();
    const tick = (t) => {
      const dt = Math.min(0.05, (t - last) / 1000); last = t;
      const g = goalRef.current;
      setView((v) => {
        let drz = g.rz - v.rz;                 // 方位角走最短弧
        while (drz > 180) drz -= 360;
        while (drz < -180) drz += 360;
        const k = 1 - Math.exp(-dt * 16);      // 越大越跟手；16 ≈ BG3 的利落阻尼
        const nv = {
          rx: v.rx + (g.rx - v.rx) * k,
          rz: v.rz + drz * k,
          zoom: v.zoom + (g.zoom - v.zoom) * k,
          panX: v.panX + (g.panX - v.panX) * k,
          panZ: v.panZ + (g.panZ - v.panZ) * k,
        };
        if (Math.abs(g.rx - nv.rx) < 0.005 && Math.abs(drz) < 0.005 &&
            Math.abs(g.zoom - nv.zoom) < 0.0005 &&
            Math.abs(g.panX - nv.panX) < 0.005 && Math.abs(g.panZ - nv.panZ) < 0.005) {
          return (v.rx === g.rx && v.rz === g.rz && v.zoom === g.zoom &&
                  v.panX === g.panX && v.panZ === g.panZ) ? v : g;
        }
        return nv;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const state = stateRef.current;
  const refresh = () => setFrame(viewFrame(state));

  const actor = frame.units.find(u => u.id === frame.actorId) || null;
  const isMyTurn = !!actor && actor.side === 'left' && !frame.finished;
  // 主角单位（left 方）。玩家回合时 actor 就是主角；战斗结束后 actorId 未必还指主角，所以单独找。
  const meUnit = frame.units.find(u => u.side === 'left') || actor;

  const actions = useMemo(() => {
    if (isMyTurn) return legalActions(state, actor.id);
    // 战斗结束后仍算出主角的技能 / 物品 / 动作清单用于查看（只读，按钮整体禁用）
    if (frame.finished && meUnit) return legalActions(state, meUnit.id);
    return [];
  }, [frame, isMyTurn, actor?.id, frame.finished, meUnit?.id]);

  const reachableCells = useMemo(() => {
    if (!isMyTurn || mode !== 'move' || actor?.out) return new Map();
    const r = currentReach(state);
    const m = new Map();
    for (const c of r.cells) m.set(cellKey(c.x, c.y), c.cost);
    return m;
  }, [frame, isMyTurn, mode, actor?.id]);

  const targetIds = useMemo(() => {
    if (!isMyTurn || mode !== 'target' || !pending) return new Set();
    return new Set(validTargets(state, actor.id, pending).map(t => t.id));
  }, [frame, isMyTurn, mode, pending, actor?.id]);

  // 瞄准时的预估：鼠标停在哪个候选目标身上，就报出这一击的预计。
  // 数字走引擎里与真正结算**同一份**公式（attackSpec + previewAttack + critProfile），
  // 不是界面自己估的 —— 免得出现「界面写预计 120、真打出来 80」。
  const aimPreview = useMemo(() => {
    if (!isMyTurn || mode !== 'target' || !pending || !hover) return null;
    const t = frame.units.find(u => u.x === hover.x && u.y === hover.y && targetIds.has(u.id));
    if (!t) return null;
    const me = state.units[actor?.id];
    const foe = state.units[t.id];
    if (!me || !foe) return null;
    const pv = previewAttack(state, me, foe, attackSpec(me, foe, pending));
    const angle = critProfile(state, me, foe).angle;
    return {
      name: t.name,
      dmg: Math.round(pv.expDamage),
      crit: Math.round(pv.critChance * 100),
      angleText: angle === 'back' ? '背击' : angle === 'side' ? '侧击' : '正面',
    };
  }, [isMyTurn, mode, pending, hover, frame, targetIds, actor?.id]);

  // ===== 敌方（与已结束后的自动）推进 =====
  // 背压：场上只要还有没演完的演出，就不许推进下一步 —— 否则敌方会趁上一拳还在飞的时候
  // 就把下一件事算完，战报与画面同时堆两拨，玩家根本看不清谁打了谁。
  const beatBusy = !!beat || beatsLeft > 0;
  // 「结算」什么时候才准落屏：引擎在投降 / 被打倒的那一瞬间就把胜负写好了，可画面上人还在走最后三格。
  // 这时候若顶栏直接盖上「胜」字、还把「结束战斗并生成正文」亮出来，读起来就是「先出结果、后演过程」，
  // 和「先投降后移动」是同一个毛病。玩家原话：**所有动作的结算必须和演出同时**。
  // 所以胜负要等最后一条演出演完才显示（数值本身仍以引擎为准，这里只影响"什么时候给玩家看"）。
  const settled = frame.finished && !beatBusy;
  // 血条上该显示多少血 = 引擎已经扣掉的 ＋ 还没演到的那几笔（＝回到"这一拳还没打中"的样子）。
  // 演到的那一刻这笔账被销掉，血条与伤害数字同一帧变（数值本身仍以引擎为准，这里只影响显示）。
  const hpShown = (u) => Math.max(0, Math.round((Number(u.hp) || 0) + (hpPending[u.id] || 0)));
  useEffect(() => {
    if (frame.finished) { setAiBusy(false); return; }
    const cur = frame.units.find(u => u.id === frame.actorId);
    if (!cur || cur.side === 'left') { setAiBusy(false); return; }
    if (stepsRef.current > MAX_AI_STEPS) { setAiBusy(false); return; }
    if (beatBusy) return;                       // 等演出演完；beat 一变这个 effect 会重跑
    setAiBusy(true);
    const t = setTimeout(() => {
      stepsRef.current += 1;
      runEnemyTurn(stateRef.current, cur.id);
      refresh();
    }, AI_STEP_MS);
    return () => clearTimeout(t);
  }, [frame.actorId, frame.finished, frame.round, frame.log.length, beatBusy]);

  // 战报自动滚到底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [frame.log.length]);

  // ===== 演出单：① 新战报 → 演出单；② 一次只发一条；③ 命中那一刻才弹伤害数字 =====
  //
  // 为什么按对象身份去重而不是按条数：viewFrame 只带最近 60 条，条数到顶就不再变，
  // 用条数会在长战斗里彻底失灵。战报对象每次都是新建的，比身份最稳。

  // 三维场景起没起来。它若起不来（浏览器不支持 WebGL，退回格子视图），就没人回报"演完了"，
  // 队列会被一条演不完的演出单卡死 —— 所以那种情况下改成"不要演出、数字直接弹"。
  const onSceneLive = (live) => { sceneLiveRef.current = !!live; };

  // 场景回报：手打到人身上那一刻 —— 伤害数字现在才弹，震动现在才抖，**血条也现在才掉**。
  const onBeatImpact = (b) => {
    if (!b || b.kind !== BEAT_ACT) return;
    const a = frame.units.find(u => u.id === b.actorId);
    const t = frame.units.find(u => u.id === b.targetId);
    if (!a || !t) return;
    // 这一笔演到了：把血条上的"欠账"销掉（数字与血条同帧变）
    if (hpPendingRef.current.delete(b.id)) syncHpPending();
    setFx({
      key: `${b.id}-${b.targetId}-${b.dmg}`,
      actorId: a.id, targetId: t.id,
      dmg: b.dmg, crit: !!b.crit, truncated: !!b.truncated,
      dx: Math.sign(t.x - a.x), dy: Math.sign(t.y - a.y),
    });
    setShake(true);
    if (fxTimerRef.current) clearTimeout(fxTimerRef.current);
    fxTimerRef.current = setTimeout(() => { setFx(null); setShake(false); }, 720);
  };

  const pumpBeat = () => {
    if (activeBeatRef.current) return;
    const nxt = beatQueueRef.current.shift() || null;
    activeBeatRef.current = nxt;
    setBeat(nxt);
    setBeatsLeft(beatQueueRef.current.length);
  };

  // 场景回报：这一条演完了 → 发下一条。
  // 只认「当前这一条」的回报 —— 迟到的、重复的一律丢掉（否则队列会被推着往前跳过一整条）。
  //
  // ⚠ **只能比 id，不能比对象身份**（2026-09-20 修的，代价是玩家走完一格后要干等 15 秒）。
  // 三维那一层收到演出单之后会把它**复制**一份再演（它要往上面挂"几点开播、打中没打中、
  // 播的哪一段"这些现场账，不能改我们这份），回报过来的就是那个副本。
  // 早期这里写的是 `activeBeatRef.current !== b`，副本永远对不上 ⇒ 回报被当成"迟到的"丢掉，
  // 整条队列只能靠下面那个 15 秒兜底超时往前挪。玩家看到的就是
  // 「人都走到目的地了，面板还挂着'正在演出上一手'」，实测卡了 16137ms。
  const onBeatDone = (b) => {
    if (!b || activeBeatRef.current?.id !== b.id) return;
    // 保险：这一条从头到尾没能回报"打中"（三维中途被切走、片段缺失走兜底……），
    // 账也得销掉，否则血条会永远停在"没挨打"的样子上。
    if (hpPendingRef.current.delete(b.id)) syncHpPending();
    activeBeatRef.current = null;
    setBeat(null);
    pumpBeat();
  };

  const beatPrimedRef = useRef(false);            // 首帧的"已经在演的"战报不算新条目

  useEffect(() => {
    const log = frame.log;
    // 首帧：这一屏上原本就躺着的战报（重新进战斗、上一局留下的记录）一律当作"早演过了"，
    // 否则一进来就会把历史里的移动与命中重放一遍 —— 场上凭空走位、数字乱冒。
    if (!beatPrimedRef.current) {
      beatPrimedRef.current = true;
      for (const e of log) if (e) loggedRef.current.add(e);
      return;
    }
    const fresh = [];
    for (const e of log) {
      if (!e || loggedRef.current.has(e)) continue;
      loggedRef.current.add(e);
      fresh.push(e);
    }
    if (!fresh.length) return;

    // 没有三维场景可演：按战报顺序把命中的数字直接放出来（移动/护架跳过）。
    // 这条路是"三维起不来"的降级态，观感差一点可以接受，但绝不能把推进卡死。
    if (!sceneLiveRef.current) {
      for (const e of fresh) {
        if (e.kind !== 'hit') continue;
        const b = beatsFromLog([e])[0];
        if (b) onBeatImpact(b);
      }
      return;
    }

    const beats = beatsFromLog(fresh);          // 顺序 = 战报顺序，绝不重排
    if (beats.length) {
      // 记账：这几笔伤害要等"打中"那一刻才允许从血条上掉下来（数字同时弹，见 onBeatImpact）
      for (const b of beats) {
        if (b.kind === BEAT_ACT && b.targetId && b.dmg > 0) {
          hpPendingRef.current.set(b.id, { targetId: b.targetId, dmg: b.dmg });
        }
      }
      syncHpPending();
      beatQueueRef.current.push(...beats);
      pumpBeat();
    }
  }, [frame]);

  // 兜底保险：万一场景那头因为任何原因没能回报（被切到后台、显存掉了……），
  // 这一条也不能永远挂着 —— 超时强制判它演完，整局继续往下走。
  // 15 秒远大于任何一条真实演出（最长的一次走位约 5 秒、动作最长 2.3 秒），不会误伤。
  useEffect(() => {
    if (!beat) return;
    const t = setTimeout(() => onBeatDone(beat), 15000);
    return () => clearTimeout(t);
  }, [beat]);

  useEffect(() => () => { if (fxTimerRef.current) clearTimeout(fxTimerRef.current); }, []);

  // 开发期出口：探针页要问「这一手演完没有」（演的时候点哪儿都不算数），
  // 以及「转视角时注视点有没有跟着跑」（pan 该不该动）。
  // 设了 window.__BS3_DEBUG__ 才挂，正式运行时不产生任何全局变量 —— 与三维那一层同一套约定。
  useEffect(() => {
    if (typeof window === 'undefined' || !window.__BS3_DEBUG__) return;
    window.__viewGoal = () => ({ ...goalRef.current });
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.__BS3_DEBUG__) window.__beatBusy = beatBusy;
  }, [beatBusy]);
  // 开发期出口②：让真机件能把「引擎状态被改过」这件事逼着界面重新读一遍。
  // 为什么需要它：敌方 AI 的一整个回合是**一次调用里**走完再出手（battleAI.runEnemyTurn），
  // 所以「移动 + 投降」两条战报是同一批冒出来的 —— 真机件要复现玩家报的那个顺序 bug，
  // 就得能自己走一次这条路径，然后叫界面 refresh 一次（setFrame 只有在 React 里才调得到）。
  // 同样只在 __BS3_DEBUG__ 下挂，正式运行不留任何全局变量。
  useEffect(() => {
    if (typeof window === 'undefined' || !window.__BS3_DEBUG__) return;
    window.__pokeBattle = () => { refresh(); return true; };
  }, []);

  // 滚轮缩放：绑原生监听（passive:false）——React 的 onWheel 是被动监听，拦不住页面滚动
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let acc = 0;
    const STEP_PX = 80;      // 累积 80px 触发一档缩放（鼠标滚轮一格≈100px）
    const onWheel = (e) => {
      e.preventDefault();
      // deltaMode：1＝按行、2＝按页，统一换算成像素
      acc += e.deltaMode === 1 ? e.deltaY * 16
        : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
      // 触控板惯性末段的小幅反向抖动达不到阈值，被直接忽略 —— 不会再「缩着缩着回缩」
      while (acc >= STEP_PX) { acc -= STEP_PX; pushGoal(g => ({ ...g, zoom: g.zoom / VIEW_ZOOM_STEP })); }
      while (acc <= -STEP_PX) { acc += STEP_PX; pushGoal(g => ({ ...g, zoom: g.zoom * VIEW_ZOOM_STEP })); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 轮到玩家时回到「移动」模式
  useEffect(() => {
    if (isMyTurn) { setMode('move'); setPending(null); }
  }, [isMyTurn, frame.round, actor?.id]);

  // ===== 拖动：左键平移 / 右键旋转 =====
  // 拖完那一下手会停在某个格子上，浏览器随后还会补一次 click —— 不拦掉就成了「顺手走了一步」。
  // 所以拖动过就把时刻记下来，紧接着 260ms 内的点击一律不当操作（纯点击不会留下这个时刻）。
  //
  // 操作分工（参考主流战棋 / RTS：《文明》《XCOM》《星际》）：
  //   · 左键按住拖动 = 平移（pan）地图，方向与屏幕一致（已按当前方位角换算到世界 XZ）；
  //   · 右键按住拖动 = 旋转沙盘（横向转方位角、纵向改俯角）；
  //   · 滚轮 = 缩放。
  //
  // ⚠️ 两条实盘踩过的坑，都别再踩：
  //  ① 这里**绝对不能调 setPointerCapture**。指针一旦被舞台（.battle-stage）捕获，浏览器会把
  //     随后的 click 派发到「被捕获的那个元素」上，而不是真正被点中的格子 ⇒ 格子的 onClick
  //     永远收不到，表现为「战斗里点哪儿都不动、走不了位」。
  //     所以改成在 window 上跟 pointermove / pointerup：拖出舞台也跟得住，而且不抢 click。
  //  ② **场景里不许留下选中文字**。上一次拖动若在页面上选中了一段文字，之后再按住拖动，浏览器会
  //     认为你在「把这段选中的文字拖走」，于是立刻发 pointercancel 把拖动掐断 —— 表现为
  //     「转了一下之后就再也转不动了」。
  //     主力防线在 CSS（.battle-overlay 整体 user-select:none，见 theme.css），这里再清一次残留。
  /**
   * 平移灵敏度：每拖 1 像素，视野中心在地面上挪多少格。
   * 基准是"抓住地图拖"的 1:1 手感 —— 默认远近下整块棋盘差不多占满画面高度，
   * 一格约合 (画面高度 × 0.89) / 一格，换算下来 1 像素≈0.021 格，所以 0.022 就是 1:1。
   * 现在取 **0.045 ≈ 1:1 的两倍**（按玩家要求"加快"）：手拖一掌，地图走两掌，赶路时不用来回搓鼠标。
   * 觉得太快/太慢改这一个数就行（它只影响手感，不影响任何战斗规则）。
   */
  const PAN_K = 0.045;
  const onStageDown = (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.target?.closest?.('button, a, input, select, textarea')) return;   // 点在按钮上 = 点按钮
    try {
      const s = window.getSelection();
      if (s && !s.isCollapsed) s.removeAllRanges();
    } catch { /* 拿不到选区就算了，CSS 那一层已经挡住 */ }
    // 拖拽起点按镜头「目标值」记录（平滑中的视角不影响拖拽基准）
    const g0 = goalRef.current;
    if (e.button === 0) {
      dragRef.current = { mode: 'pan', x: e.clientX, y: e.clientY, panX: g0.panX, panZ: g0.panZ, rz: g0.rz, zoom: g0.zoom, moved: false };
    } else {
      dragRef.current = { mode: 'rotate', x: e.clientX, y: e.clientY, rx: g0.rx, rz: g0.rz, panX: g0.panX, panZ: g0.panZ, moved: false };
    }
    setDragging(true);
  };
  useEffect(() => {
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (!d.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;   // 手抖不算拖
      d.moved = true;
      if (d.mode === 'pan') {
        const a = d.rz * Math.PI / 180, cosA = Math.cos(a), sinA = Math.sin(a);
        // 屏幕（dx 向右、dy 向下）→ 世界 XZ：画面右方向 [cos,-sin]、水平前方向 [-sin,-cos]。
        // 2026-09-20：按玩家要求把拖动方向整体取反（类似「抓地图」）。
        // 按缩放自适应：放大后视野变小、每像素对应的世界更少（除以 zoom），拉近时仍保持 1:1 的抓取手感。
        // 但除法有上限（PAN_ZOOM_CAP）—— 见那个常量的注释：不封顶的话放大档下根本挪不到别处。
        const pk = PAN_K / Math.max(0.5, Math.min(d.zoom || 1, PAN_ZOOM_CAP));
        pushGoal(g => ({
          ...g,
          panX: d.panX - pk * (dx * cosA + dy * sinA),
          panZ: d.panZ - pk * (-dx * sinA + dy * cosA),
        }));
      } else {
        // 右键旋转：横向转方位角、纵向改俯角 —— **镜头绕着当前注视的那块地公转**（BG3 式）。
        // 关键是 pan 不动：pan 就是"注视的那块地"，镜头转一圈它还钉在那儿，所以画面中心始终不变。
        // 灵敏度：横向 0.4°/像素（拖满一屏约转 150°）、纵向 0.2°/像素（俯角区间 18°~82°，
        // 从最能看清脸的低角度拖到近乎正俯视要大半屏）—— 与 BG3 的手感同档，不飘也不钝。
        pushGoal(g => ({ ...g, rx: d.rx + dy * 0.2, rz: d.rz + dx * 0.4 }));
      }
    };
    const onUp = () => {
      if (dragRef.current?.moved) dragEndAtRef.current = Date.now();
      dragRef.current = null;
      setDragging(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onUp);   // 在窗口外松手时兜底，免得拖动态一直挂着
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, []);

  // 走位。**出手之后照样能走** —— 走位与出手是两笔独立额度（引擎 currentReach / moveTo 已改）。
  const doMove = (x, y) => {
    if (!isMyTurn || mode !== 'move') return;
    const r = moveTo(state, actor.id, { x, y });
    if (!r.ok) return;
    refresh();
  };

  /**
   * 出手。**它不结束回合**（引擎 2026-09-19 起改了）——
   * 打完之后回合还在自己手里，还能拿剩下的走位额度继续挪，收手要点「结束回合」。
   */
  const runAction = (act, targetId) => {
    const r = doAction(state, actor.id, {
      kind: act.kind, skill: act.skill, item: act.item, skillName: act.skill?.name, itemName: act.item?.name, targetId,
    });
    setPending(null);
    setMode('move');          // 出手完回到走位模式：还能继续挪
    refresh();
    return r;
  };

  /** 交出本回合 —— 界面上唯一会换手的按钮。走位不换手，出手也不换手。 */
  const endMyTurn = () => {
    if (!isMyTurn || beatBusy) return;
    setPending(null);
    setMode('move');
    endTurn(state);
    refresh();
  };

  /**
   * 点右侧面板上的一个动作，分两类：
   *   · 要打人的（普攻 / 伤害功法 / 威吓）→ 一律进「选目标」态，打谁由玩家在战场上点。
   *     旧写法是「场上只有一个目标就替他打」，那等于替玩家做决定；现在哪怕只剩一个敌人，也要你点他。
   *   · 不挑人的（恢复功法给自己、器物、防御、蓄力、逃遁、投降）→ 直接结算。
   */
  const onPickAction = (act) => {
    if (!act.enabled || !isMyTurn || beatBusy) return;
    const needsTarget = act.kind === 'attack'
      || (act.kind === 'skill' && act.skill?.type === '伤害')
      || act.kind === 'intimidate';
    if (needsTarget) {
      if (!validTargets(state, actor.id, act).length) return;   // 没有合法目标就不进入瞄准（按钮此时本来就是灰的）
      setPending(act);
      setMode('target');
      return;
    }
    if (act.kind === 'skill' && act.skill?.type === '恢复') { runAction(act, actor.id); return; }
    runAction(act, null);
  };

  const onCellClick = (x, y) => {
    if (Date.now() - dragEndAtRef.current < 260) return;   // 刚转过战场，这一下不算走位
    if (!isMyTurn || beatBusy) return;                      // 上一手还在演：这一下不算数
    if (mode === 'target') {
      const u = frame.units.find(t => t.x === x && t.y === y && targetIds.has(t.id));
      if (u) runAction(pending, u.id);
      return;
    }
    doMove(x, y);
  };

  // ===== 点哪一格：现在是「屏幕坐标 → 射线打进三维场景 → 落在哪一格」 =====
  // 相机、地表起伏、树冠挡在前面这些事全由场景那边算；这里只负责把格号转成引擎的走位/出手。
  const onStageClick = (e) => {
    const c = sceneRef.current?.pickCell?.(e.clientX, e.clientY);
    if (!c) return;
    onCellClick(c.x, c.y);
  };

  // 悬停高亮：同一格来回移动不重复渲染（不然鼠标一动就整棵树重画一遍）
  const onStageMove = (e) => {
    if (dragRef.current) return;              // 正在拖着转视角，不更新悬停
    const c = sceneRef.current?.pickCell?.(e.clientX, e.clientY) || null;
    const k = c ? `${c.x},${c.y}` : '';
    if (k === hoverKeyRef.current) return;
    hoverKeyRef.current = k;
    setHover(c);
  };

  const finish = () => {
    const outcome = battleOutcome(state);
    onFinish(outcome);
  };

  // ===== 行动条排序（下次出手由近到远）=====
  const timeline = [...frame.units].filter(u => !u.out).sort((a, b) => a.nextAt - b.nextAt);
  // 已经退出战斗的人：不再参与出手排序，但也不从画面上抹掉 —— 单独挂在行动条底部，写明怎么退出的。
  const gone = [...frame.units].filter(u => u.out);
  // 快慢用「间隔」比，不用脚力数值 —— 出手速度由境界档位决定，同档位脚力不同也照样是同一速度。
  // 显示成全场最慢者的倍数，一眼看出谁快。
  const slowestInterval = Math.max(...timeline.map(u => (u.interval > 0 ? u.interval : 1)), 0.000001);
  const relSpeed = (u) => slowestInterval / (u.interval > 0 ? u.interval : slowestInterval);

  return (
    <div className={`battle-overlay${dragging ? ' bt-drag' : ''}`}>
      <div className="battle-shell">
        {/* 顶栏 */}
        <div className="battle-top">
          <div className="bt-title">
            <span className="bt-tag">⚔ 战斗</span>
            <span className="bt-round">第 {frame.round} 回合</span>
            {settled
              ? <span className={`bt-result r-${frame.result}`}>{frame.resultText}</span>
              : <span className="bt-turn">{actor ? `${actor.name} 的回合` : '推进中…'}</span>}
          </div>
          <div className="bt-actions">
            <button className="ghost small" onClick={onClose} title="退出战斗界面（战斗状态保留）">收起</button>
            {settled && <button className="primary small" onClick={finish}>结束战斗并生成正文</button>}
          </div>
        </div>

        <div className="battle-body">
          {/* 左：三维战场 */}
          <div className="battle-map-wrap">
            <div
              className="battle-stage"
              ref={stageRef}
              onPointerDown={onStageDown}
              onClick={onStageClick}
              onPointerMove={onStageMove}
              onContextMenu={(e) => e.preventDefault()}
              onPointerLeave={() => { hoverKeyRef.current = ''; setHover(null); }}
              title="左键拖动平移地图；右键拖动旋转视角；滚轮缩放；点格子走位"
            >
              <BattleScene3D
                ref={sceneRef}
                grid={frame.grid}
                units={frame.units}
                view={view}
                actorId={frame.actorId}
                reachable={reachableCells}
                targetIds={targetIds}
                hover={hover}
                fx={fx}
                shake={shake}
                beat={beat}
                hpPend={hpPending}
                onBeatDone={onBeatDone}
                onBeatImpact={onBeatImpact}
                onSceneLive={onSceneLive}
                onFallbackPick={onCellClick}
              />
            </div>
            <div className="battle-map-legend">
              <span className="bm-hint">
                {mode === 'target'
                  ? `已选【${pending?.label || '技能'}】：点一个闪烁的目标释放${aimPreview
                    ? ` · 对 ${aimPreview.name}：预计 ${aimPreview.dmg} 伤害（暴击 ${aimPreview.crit}%｜${aimPreview.angleText}）`
                    : ''}`
                  : isMyTurn
                    ? (frame.turn?.acted
                      ? '本回合已出手，还能继续走位；想收手就点右下「结束回合」'
                      : '淡绿＝所有能走的地块，蓝底＝本回合走得到的位置。走位与出手都不结束回合 —— 可以走→打→再走')
                    : '对方行动中…'}
              </span>
              {/* 视角控件：左键拖动平移、右键拖动旋转，滚轮也能缩放 */}
              <span className="bm-view">
                <button className="bmv" onClick={() => pushGoal(g => ({ ...g, zoom: g.zoom / VIEW_ZOOM_STEP }))}
                  disabled={view.zoom <= VIEW_ZOOM_MIN + 1e-6} title="缩小（滚轮向下同效）">－</button>
                <span className="bmv-zoom" title="当前远近（100% = 整块棋盘刚好装满画面）">{Math.round(view.zoom / VIEW_DEFAULT.zoom * 100)}%</span>
                <button className="bmv" onClick={() => pushGoal(g => ({ ...g, zoom: g.zoom * VIEW_ZOOM_STEP }))}
                  disabled={view.zoom >= VIEW_ZOOM_MAX - 1e-6} title="放大（滚轮向上同效）">＋</button>
                <button className="bmv" onClick={() => pushGoal(g => orbitGoal(g, -15))} title="向左转 15°">↺</button>
                <button className="bmv" onClick={() => pushGoal(g => orbitGoal(g, 15))} title="向右转 15°">↻</button>
                <button className="bmv bmv-reset" onClick={() => pushGoal(VIEW_DEFAULT)} title="回到默认视角并居中（俯角 54°、方位 45°）">复位</button>
              </span>
              <span className="bm-facing" title="每个角色脚下的圈：红色那 1/4 是他背后。站在红色一侧出招即背击（伤害与暴击都更高），45° 斜后与正后都算背面。">
                <i className="bm-facing-demo" aria-hidden="true" />
                红弧＝背面（从红的一侧打过去算背击）
              </span>
              <span className="bm-terrains">
                {[...new Set(frame.grid.flat())].map(id => {
                  const t = terrainOf(id);
                  // 色块用 3D 地表那份颜色（同一个出口），否则"图例是浅绿、地上是深绿"两套说法
                  return <span key={id} className="bm-terrain" style={{ background: lookOf(id).color }} title={t.desc}>{t.id}</span>;
                })}
              </span>
            </div>
          </div>

          {/* 右：行动条 + 面板 */}
          <div className="battle-side">
            <div className="battle-timeline">
              <div className="bs-title">行动顺序</div>
              <div className="tl-list">
                {timeline.map((u, i) => (
                  <div key={u.id} className={`tl-item side-${u.side} ${u.id === frame.actorId ? 'now' : ''}`}>
                    <span className="tl-idx">{i + 1}</span>
                    <span className="tl-name">{u.name}</span>
                    <span className="tl-realm">{u.realm}</span>
                    <span className="tl-speed" title={`出手间隔 ${(u.interval ?? 0).toFixed(3)}（越小越快）｜脚力 ${Math.round(u.speed)}`}>⚡×{relSpeed(u).toFixed(2)}</span>
                  </div>
                ))}
              </div>
              {gone.length > 0 && (
                <div className="tl-gone">
                  {gone.map(u => (
                    <div key={u.id} className={`tl-item gone side-${u.side}`}
                      title={`${u.name}｜${outLabel(u)}｜仍留在场上，不再出手`}>
                      <span className="tl-idx">✕</span>
                      <span className="tl-name">{u.name}</span>
                      <span className="tl-realm">{outLabel(u)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 行动面板：战斗中可操作；战斗结束后仍保留（只读），不再像之前那样整块消失 */}
            <div className="battle-panel">
                <div className="bp-pools">
                  {frame.units.filter(u => u.side === 'left').map(u => (
                    <div key={u.id} className={`bp-unit ${u.id === frame.actorId ? 'acting' : ''}`}>
                      <div className="bpu-name">{u.name} <span className="bpu-realm">{u.realm}</span></div>
                      <div className="bpu-bars">
                        <span className="bpu-bar hp"><i style={{ width: `${Math.round(hpShown(u) / Math.max(1, u.hpMax) * 100)}%` }} /></span>
                        <span className="bpu-num">{hpShown(u)}/{u.hpMax}</span>
                      </div>
                      <div className="bpu-bars">
                        <span className="bpu-bar mp"><i style={{ width: `${u.mpMax ? Math.round(u.mp / u.mpMax * 100) : 0}%` }} /></span>
                        <span className="bpu-num">{u.mp}/{u.mpMax}</span>
                      </div>
                      <div className="bpu-stats">
                        物攻 {u.atk.phys}｜物防 {u.def.phys}｜法攻 {u.atk.mag}｜法防 {u.def.mag}｜穿 {u.pen.phys}/{u.pen.mag}｜脚力 {Math.round(u.speed)}（出手 ⚡×{relSpeed(u).toFixed(2)}）｜会心 {Math.round(u.crit)}%｜气运 {Math.round(u.luck ?? 0)}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bp-tabs">
                  <button className={tab === 'skill' ? 'on' : ''} onClick={() => setTab('skill')} title="角色面板「技能」里的那几门功法，同一份数据">技能</button>
                  <button className={tab === 'item' ? 'on' : ''} onClick={() => setTab('item')} title="储物袋里能应急的丹药、符箓之类">物品</button>
                  <button className={tab === 'action' ? 'on' : ''} onClick={() => setTab('action')} title="人人都会、不耗资源的常规动作">动作</button>
                </div>

                <div className="bp-list">
                  {settled && (
                    <div className="bp-wait bp-readonly">战斗已结束 —— 以下为最终的技能 / 物品 / 动作（只读查看）</div>
                  )}
                  {/* 胜负已定、但最后一手还在演：先说清楚"在演什么"，别让面板空着像卡住 */}
                  {frame.finished && beatBusy && (
                    <div className="bp-wait">胜负已定 —— 正在演出最后几手…</div>
                  )}
                  {!isMyTurn && !frame.finished && <div className="bp-wait">{aiBusy ? '对手正在行动…' : '等待中…'}</div>}
                  {isMyTurn && beatBusy && <div className="bp-wait">正在演出上一手…演完就能继续操作</div>}
                  {isMyTurn && frame.turn?.acted && (
                    <div className="bp-empty bp-acted">本回合已出手。还能继续走位，或者点右下「结束回合」把回合交出去。</div>
                  )}
                  {(isMyTurn || frame.finished) && tab === 'skill' && (
                    <>
                      {actions.filter(a => a.kind === 'attack').map((a, i) => (
                        <button key={'atk' + i} className="bp-act" disabled={!isMyTurn || !a.enabled || mode === 'target' || beatBusy}
                          title={a.reason} onClick={() => onPickAction(a)}>
                          <span className="bp-act-name">普通攻击</span>
                          <span className="bp-act-meta">距离 1｜倍率 ×1｜不耗蓝</span>
                        </button>
                      ))}
                      {actions.filter(a => a.kind === 'skill').map((a, i) => (
                        <button key={'sk' + i} className="bp-act" disabled={!isMyTurn || !a.enabled || mode === 'target' || beatBusy}
                          title={a.reason || a.skill?.effect} onClick={() => onPickAction(a)}>
                          <span className="bp-act-name">
                            {a.label}
                            <em className="bp-act-kind">{a.skill?.type}{a.skill?.dmgKind ? '·' + a.skill.dmgKind : ''}</em>
                          </span>
                          <span className="bp-act-meta">
                            {a.skill?.type === '伤害'
                              ? `倍率 ×${a.skill.mult}｜运气骰 ${a.skill.dice}｜距离 ${a.skill.range}`
                              : a.skill?.type === '恢复'
                                ? `回血 ${a.skill.hpRecover}｜回蓝 ${a.skill.mpRecover}｜距离 ${a.skill.range}`
                                : `距离 ${a.range}｜特攻`}
                            {a.mpCost ? `｜耗蓝 ${a.mpCost}` : '｜不耗蓝'}
                          </span>
                        </button>
                      ))}
                      {!(isMyTurn && frame.turn?.acted) && !actions.some(a => a.kind === 'attack' || a.kind === 'skill') && <div className="bp-empty">没有可用技能</div>}
                    </>
                  )}
                  {(isMyTurn || frame.finished) && tab === 'item' && (
                    <>
                      {actions.filter(a => a.kind === 'item').map((a, i) => (
                        <button key={'it' + i} className="bp-act" disabled={!isMyTurn || !a.enabled || mode === 'target' || beatBusy}
                          title={a.reason} onClick={() => onPickAction(a)}>
                          <span className="bp-act-name">{a.item?.name} <em className="bp-act-kind">×{a.item?.quantity}</em></span>
                          <span className="bp-act-meta">
                            {a.item?.heal?.hp ? `回血 ${a.item.heal.hp}` : ''}{a.item?.heal?.mp ? ` 回蓝 ${a.item.heal.mp}` : ''}
                          </span>
                        </button>
                      ))}
                      {!(isMyTurn && frame.turn?.acted) && !actions.some(a => a.kind === 'item') && <div className="bp-empty">储物袋里没有能应急的东西</div>}
                    </>
                  )}
                  {(isMyTurn || frame.finished) && tab === 'action' && actions.filter(a => ['intimidate', 'defend', 'charge', 'flee', 'surrender'].includes(a.kind)).map((a, i) => (
                    <button key={'ac' + i} className="bp-act" disabled={!isMyTurn || !a.enabled || mode === 'target' || beatBusy}
                      title={a.reason || a.hint || ''} onClick={() => onPickAction(a)}>
                      <span className="bp-act-name">{a.label}</span>
                      <span className="bp-act-meta">
                        {a.kind === 'defend' ? `本回合受伤 ×${TUNING.DEFEND_TAKEN_MUL}`
                          : a.kind === 'charge' ? `下一击 ×${TUNING.CHARGE_DEALT_MUL}，耗蓝减半`
                            : a.kind === 'intimidate' ? '3 格内，压低对手下一击威力'
                              : a.kind === 'flee' ? (a.hint || '脱离战斗')
                                : '立即结束战斗'}
                      </span>
                    </button>
                  ))}
                  {isMyTurn && mode === 'target' && (
                    <button className="bp-act cancel" onClick={() => { setPending(null); setMode('move'); }}>取消选择</button>
                  )}
                </div>
                {isMyTurn && (
                  <div className="bp-foot">
                    <span className="bp-turn-state">
                      剩余移动 {Math.max(0, (frame.turn?.budget || 0) - (frame.turn?.spent || 0))} 格
                      <em className={`bp-flag ${frame.turn?.acted ? 'done' : 'ready'}`}>
                        {frame.turn?.acted ? '本回合已出手' : '还可出手一次'}
                      </em>
                    </span>
                    <button className="bp-end" onClick={endMyTurn} disabled={beatBusy}
                      title="交出本回合。走位与出手都不会自动结束回合 —— 想收手就点这里。">
                      结束回合
                    </button>
                  </div>
                )}
            </div>

            <div className="battle-log" ref={logRef}>
              <div className="bl-head">
                <span className="bs-title">战报</span>
                <button
                  className={`bl-toggle ${showAudit ? 'on' : ''}`}
                  onClick={() => setShowAudit(v => !v)}
                  title="显示每一击的完整算式：攻击力 × 倍率 → 减防御 → 乘各种加成 → 来势。只看这里，战斗结果不受影响。"
                >
                  算式明细：{showAudit ? '开' : '关'}
                </button>
              </div>
              {frame.log.map((e, i) => (
                <React.Fragment key={i}>
                  <div className={`bl-line k-${e.kind}`}>{e.text}</div>
                  {showAudit && Array.isArray(e.audit) && e.audit.length > 0 && (
                    <div className="bl-audit">
                      {e.audit.map((t, j) => <div key={j} className="bl-audit-line">{t}</div>)}
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
