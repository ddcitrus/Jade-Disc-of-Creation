import React from 'react';
import { PERSONALITY_DIMENSIONS } from '../data/gameData.js';

// 性格维度：紧凑双列 + 水墨滑块（0-6，3 居中）。
// 口径统一为「左名强度」——左名亮起 = 偏这一侧，右侧同理；悬停看该维度的说明。
// 滑块用原生 range，款式取自 guigu.css 第 5b 节（与设置页同一套水墨滑块）：
// 原生 range 的值传不到 CSS，已选段的宽度得由这里按当前值下发 --fill（0~1 的小数）。
export default function PersonalityDims({ dims, onChange, readOnly = false, showDesc = false, columns = 2 }) {
  return (
    <div className={`pers-grid${columns === 1 ? ' one-col' : ''}`}>
      {PERSONALITY_DIMENSIONS.map(d => {
        const v = Number.isFinite(Number(dims?.[d.left])) ? Math.max(0, Math.min(6, Number(dims[d.left]))) : 3;
        const leftOn = v > 3;
        const rightOn = v < 3;
        const nowText = leftOn ? `${d.left} ${v}/6，${d.hi}` : rightOn ? `${d.right} ${6 - v}/6，${d.lo}` : '居中';
        // 滑块摆位置用的是「偏向右名的程度」：手柄靠右 = 偏右名、靠左 = 偏左名。
        // 存进档案的数字（v）口径相反（v 越大越偏左名），所以这里翻转一次再给控件，
        // 免得出现「手柄在右端、亮的却是左边那个词」。
        const slider = 6 - v;
        return (
          <div className="pers-item" key={d.left}>
            <div className="pers-head">
              <span className={`pers-pole${leftOn ? ' on' : ''}`}>{d.left}{leftOn ? ` ${v}` : ''}</span>
              <span className={`pers-pole r${rightOn ? ' on' : ''}`}>{rightOn ? `${6 - v} ` : ''}{d.right}</span>
            </div>
            <input
              type="range"
              className="pers-slider"
              min={0}
              max={6}
              step={1}
              value={slider}
              disabled={readOnly}
              aria-label={`${d.left}与${d.right}`}
              aria-valuetext={nowText}
              title={`${d.desc}\n当前：${nowText}`}
              style={{ '--fill': slider / 6 }}
              onChange={e => onChange?.(d.left, 6 - Number(e.target.value))}
            />
            {showDesc && <div className="pers-desc">{d.desc}</div>}
          </div>
        );
      })}
    </div>
  );
}
