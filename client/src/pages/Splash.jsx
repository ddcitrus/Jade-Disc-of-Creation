import React, { useState } from 'react';
import { readTheme, applyTheme, THEMES } from '../theme.js';

// 主菜单：新人生 / 读取 / 设置 三个入口
export default function Splash({ setPage }) {
  const [theme, setTheme] = useState(readTheme);
  return (
    <div className="splash">
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
      {/* 主题：玄墨是"夜里读"的那套（默认），宣纸是白天的浅色版。
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
      {/* 底部原有一行版本来源说明，已清除；空壳留着做底部留白锚点（实测它不影响上方三块的位置）*/}
      <div className="footer" aria-hidden="true" />
    </div>
  );
}
