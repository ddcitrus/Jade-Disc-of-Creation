import React, { useRef } from 'react';
import { PERSONALITY_DIMENSIONS } from '../data/gameData.js';

// 性格维度：紧凑双列 + 可拖的小条（0-6，3 居中）。
// 口径统一为「左名强度」——左名亮起 = 偏这一侧，右侧同理；悬停看该维度的说明。
const CELLS = [0, 1, 2, 3, 4, 5];

// 指针横坐标 → 0-6（条宽等分七档，取整）；未布局时返回 null，表示不动数据
export function dimFromPointer(clientX, rect) {
  if (!rect || !rect.width) return null;
  return Math.max(0, Math.min(6, Math.round(((clientX - rect.left) / rect.width) * 6)));
}

export default function PersonalityDims({ dims, onChange, readOnly = false, showDesc = false, columns = 2 }) {
  const dragging = useRef(null);

  const set = (key, clientX, el) => {
    const v = dimFromPointer(clientX, el.getBoundingClientRect());
    if (v === null) return;
    onChange?.(key, v);
  };

  return (
    <div className={`pers-grid${columns === 1 ? ' one-col' : ''}`}>
      {PERSONALITY_DIMENSIONS.map(d => {
        const v = Number.isFinite(Number(dims?.[d.left])) ? Math.max(0, Math.min(6, Number(dims[d.left]))) : 3;
        const leftOn = v > 3;
        const rightOn = v < 3;
        const nowText = leftOn ? `${d.left} ${v}/6，${d.hi}` : rightOn ? `${d.right} ${6 - v}/6，${d.lo}` : '居中';
        return (
          <div className="pers-item" key={d.left}>
            <div className="pers-head">
              <span className={`pers-pole${leftOn ? ' on' : ''}`}>{d.left}{leftOn ? ` ${v}` : ''}</span>
              <span className={`pers-pole r${rightOn ? ' on' : ''}`}>{rightOn ? `${6 - v} ` : ''}{d.right}</span>
            </div>
            <div
              className={`pers-bar${readOnly ? ' ro' : ''}`}
              role="slider"
              tabIndex={readOnly ? -1 : 0}
              aria-label={`${d.left}与${d.right}`}
              aria-valuemin={0}
              aria-valuemax={6}
              aria-valuenow={v}
              aria-valuetext={nowText}
              title={`${d.desc}\n当前：${nowText}`}
              onPointerDown={e => {
                if (readOnly) return;
                e.preventDefault();
                dragging.current = d.left;
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
                set(d.left, e.clientX, e.currentTarget);
              }}
              onPointerMove={e => {
                if (readOnly || dragging.current !== d.left) return;
                set(d.left, e.clientX, e.currentTarget);
              }}
              onPointerUp={e => {
                dragging.current = null;
                try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
              }}
              onPointerCancel={() => { dragging.current = null; }}
              onKeyDown={e => {
                if (readOnly) return;
                const step = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
                if (!step) return;
                e.preventDefault();
                onChange?.(d.left, Math.max(0, Math.min(6, v + step)));
              }}
            >
              {CELLS.map(n => <span key={n} className={`pers-cell${n < v ? ' on' : ''}`} />)}
            </div>
            {showDesc && <div className="pers-desc">{d.desc}</div>}
          </div>
        );
      })}
    </div>
  );
}
