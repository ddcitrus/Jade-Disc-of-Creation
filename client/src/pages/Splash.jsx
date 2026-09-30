import React, { useState } from 'react';
import { readTheme, applyTheme, THEMES } from '../theme.js';

// 主菜单：新人生 / 读取 / 设置 三个入口
//
// ⚠ 2026-09-23：改成「封面画 + 右侧落款」的版式。
//   · 封面：client/public/splash/cover.jpg 整屏铺满（.splash-cover，绝对定位在最底层）
//   · 标题与按钮移到界面右侧、靠右居中成一竖列（.splash-side）
//   · 整页用自备的「飞波正点体」—— 字体在 guigu.css 的 @font-face 里，
//     通过 --font-cover 生效。字体是**精确子集**，改文案要重跑 mksubset2.py。
//     ⚠ --font-cover 是**刻意不可调**的变量（不属于设置页那三个字体槽）：
//       曾用 --font-title，结果被玩家存的字体偏好内联改写成宋体，见 guigu.css :root。
//   底层的 .splash 只剩一张柔化用的暗罩，保证右侧文字在亮色山水上也读得清。
export default function Splash({ setPage }) {
  const [theme, setTheme] = useState(readTheme);
  return (
    <div className="splash">
      {/* 封面画：整屏铺满，不可交互，纯装饰 */}
      <div className="splash-cover" aria-hidden="true" />
      {/* 右侧压暗罩：由右向左渐隐，让标题与按钮有落脚的暗底 */}
      <div className="splash-scrim" aria-hidden="true" />

      {/* 右侧内容列：靠右居中 */}
      <div className="splash-side">
        <div className="title-block">
          <div className="main-title">造化玉碟</div>
          <div className="sub-title">◆ 沉浸式的修仙文字世界 · 独立版 ◆</div>
          <div className="version">V 1.0.0</div>
        </div>
        <div className="menu-list">
          <button className="primary" onClick={() => setPage('create')}>开始新人生</button>
          <button onClick={() => setPage('saves')}>读取人生</button>
          <button onClick={() => setPage('settings')}>系统设置</button>
        </div>
        {/* 主题：浓墨（深青，默认）是"纸色沉"的那套，淡墨是宣纸浅色版。
            切换只改 <html data-theme>，两套配色都在 guigu.css 的令牌里。 */}
        <div className="theme-switch" role="group" aria-label="界面主题">
          <span className="theme-switch-label">纸色</span>
          {THEMES.map(t => (
            <button
              key={t.id}
              className={`theme-opt${theme === t.id ? ' on' : ''}`}
              title={t.hint}
              aria-pressed={theme === t.id}
              onClick={() => setTheme(applyTheme(t.id))}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
