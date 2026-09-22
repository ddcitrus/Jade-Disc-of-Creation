// ===== 拖拽自动滚动 =====
// 背景：HTML5 拖拽（draggable + dragover/drop）期间浏览器会吞掉滚轮事件，
// 分段列表又常常长过一屏 —— 用户把段落往下拖就再也拖不回来了。
// 这里不做「依赖浏览器原生 autoscroll」的假设（嵌套滚动容器里各浏览器表现不一致，
// Chromium 在 flex + overflow:hidden 的布局里经常完全不滚），改为自己按指针位置驱动滚动。

/** 距容器上下边缘多少像素内开始自动滚动 */
export const DRAG_SCROLL_EDGE = 80;
/** 每帧最大滚动像素（约 60fps → 1320px/s） */
export const DRAG_SCROLL_MAX = 22;
/** 指针在触发区内越靠边、速度越快的曲线（0..1 的幂次） */
export const DRAG_SCROLL_CURVE = 1.6;

/**
 * 计算当前指针位置对应的滚动速度（纯函数，便于单测）。
 * @param {number} clientY 指针的视口 Y 坐标
 * @param {{top:number,bottom:number}} rect 滚动容器的视口矩形
 * @param {{edge?:number,max?:number,curve?:number}} [opts]
 * @returns {number} 每帧滚动像素；负=向上，正=向下，0=不滚
 */
export function dragScrollSpeed(clientY, rect, opts = {}) {
  const edge = opts.edge ?? DRAG_SCROLL_EDGE;
  const max = opts.max ?? DRAG_SCROLL_MAX;
  const curve = opts.curve ?? DRAG_SCROLL_CURVE;
  if (!rect || !Number.isFinite(clientY) || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return 0;
  const h = rect.bottom - rect.top;
  if (h <= 0) return 0;
  const zone = Math.min(edge, h / 3); // 容器很矮时收窄触发区，避免整屏都在滚
  if (zone <= 0) return 0;

  const distTop = clientY - rect.top;
  const distBottom = rect.bottom - clientY;
  let ratio = 0;
  let dir = 0;
  if (distTop < zone) { dir = -1; ratio = 1 - Math.max(0, distTop) / zone; }
  else if (distBottom < zone) { dir = 1; ratio = 1 - Math.max(0, distBottom) / zone; }
  if (!dir) return 0;

  const speed = max * Math.pow(Math.max(0, Math.min(1, ratio)), curve);
  return dir * speed;
}

/**
 * 按指针 Y 与各行矩形算出「落点是第几个下标」（纯函数，便于单测）。
 *
 * 判定规则：指针在某一行的中线上方 → 插到这一行前面；都在中线上方之外 → 排到最后。
 * 返回的是**搬走之后**的目标下标（即 reorder(from, to) 里 to 的语义）：
 * 自身占了一位，所以落点在自身之后时要减 1。
 *
 * @param {Array<{top:number,bottom:number}>} rects 拖动开始时各行（不含被拖行也行）的视口矩形，顺序即列表顺序
 * @param {number} clientY 指针视口 Y 坐标
 * @param {number} [fromIndex] 被拖动行的当前下标；-1 / 省略 = 不换算，直接返回插入槽位
 * @returns {number} 目标下标；无法判定返回 -1
 */
export function dropIndexFromRows(rects, clientY, fromIndex = -1) {
  if (!Array.isArray(rects) || !rects.length || !Number.isFinite(clientY)) return -1;
  let slot = rects.length; // 默认落到最后一行之后
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (!r) continue;
    const mid = (Number(r.top) + Number(r.bottom)) / 2;
    if (Number.isFinite(mid) && clientY < mid) { slot = i; break; }
  }
  if (!Number.isInteger(fromIndex) || fromIndex < 0) return Math.min(slot, rects.length - 1);
  return slot > fromIndex ? slot - 1 : slot;
}

/**
 * 从节点向上找第一个「能滚且还有内容没显示完」的祖先（含根滚动元素兜底）。
 * @param {Element} node
 * @param {(el:Element)=>CSSStyleDeclaration} [getStyle] 便于测试注入
 * @returns {Element|null}
 */
export function findScrollableAncestor(node, getStyle) {
  if (!node || typeof node !== 'object') return null;
  const styleOf = getStyle || (typeof window !== 'undefined' && window.getComputedStyle
    ? (el) => window.getComputedStyle(el)
    : null);
  if (!styleOf) return null;
  const doc = node.ownerDocument || (typeof document !== 'undefined' ? document : null);
  let el = node.parentElement;
  while (el && el.nodeType === 1) {
    let oy = '';
    try { oy = styleOf(el).overflowY || ''; } catch { oy = ''; }
    const canScroll = (oy === 'auto' || oy === 'scroll' || oy === 'overlay')
      && el.scrollHeight > el.clientHeight + 1;
    if (canScroll) return el;
    el = el.parentElement;
  }
  const root = doc ? (doc.scrollingElement || doc.documentElement) : null;
  return root || null;
}

/**
 * 取滚动容器用于计算边缘的视口矩形。
 * 根滚动元素（html/body）自身矩形是整页高度，必须换用视口高度，
 * 否则「下边缘」永远在屏幕外、往下拖不会滚。
 */
export function scrollViewportRect(el, win) {
  if (!el) return { top: 0, bottom: 0 };
  const w = win || (typeof window !== 'undefined' ? window : null);
  const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const isRoot = !!(doc && (el === doc.scrollingElement || el === doc.documentElement || el === doc.body));
  if (isRoot) {
    const vh = (w && w.innerHeight) || el.clientHeight || 0;
    return { top: 0, bottom: vh };
  }
  const r = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
  if (!r) return { top: 0, bottom: 0 };
  return { top: r.top, bottom: r.bottom };
}

/**
 * 创建一个按帧驱动的滚动控制器（与 React 解耦，方便在测试里直接调用）。
 * @param {{raf?:Function,caf?:Function,win?:object,onTick?:Function}} [env]
 *   onTick：每滚一帧后回调。滚动时指针没动 → 浏览器不会再派发 dragover，
 *   落点高亮会停在拖动开始时的位置，所以需要回调方用 elementFromPoint 重新取当前指针下的行。
 */
export function createDragScroller(env = {}) {
  const win = env.win || (typeof window !== 'undefined' ? window : null);
  const raf = env.raf || (win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : (cb) => setTimeout(() => cb(Date.now()), 16));
  const caf = env.caf || (win && win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : clearTimeout);
  const state = { el: null, speed: 0, handle: null, onTick: env.onTick || null };

  const stopLoop = () => {
    if (state.handle != null) { try { caf(state.handle); } catch { /* ignore */ } }
    state.handle = null;
  };

  const tick = () => {
    state.handle = null;
    if (!state.el || !state.speed) return;
    const before = state.el.scrollTop;
    state.el.scrollTop = before + state.speed;
    if (state.el.scrollTop === before) { state.speed = 0; return; } // 已到顶/底，等指针再次移动再重启
    if (state.onTick) { try { state.onTick(); } catch { /* 落点刷新失败不影响滚动 */ } }
    state.handle = raf(tick);
  };

  return {
    state,
    setOnTick(fn) { state.onTick = fn || null; },
    /** 指针移动时调用：更新目标容器与速度 */
    update(clientY, node) {
      if (!state.el) state.el = findScrollableAncestor(node);
      const el = state.el;
      if (!el) return 0;
      const speed = dragScrollSpeed(clientY, scrollViewportRect(el, win));
      state.speed = speed;
      if (speed && state.handle == null) state.handle = raf(tick);
      else if (!speed) stopLoop();
      return speed;
    },
    /** 拖动结束（drop / dragend / 离开列表）时调用 */
    stop() {
      stopLoop();
      state.speed = 0;
      state.el = null;
    },
  };
}
