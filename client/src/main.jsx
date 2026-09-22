import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './theme.css';
import './polish.css';
import './guigu.css';
import './guigu-fx.css';
import { applyTheme, readTheme } from './theme.js';
import { applyFonts, readFonts } from './fontPrefs.js';

/*
 * 主题与字体都必须在 render 之前落地 —— 否则会先按默认画一帧再翻，闪一下。
 * 取值与缓存的实现分别在 theme.js / fontPrefs.js（设置页、顶栏与这里共用同一份）。
 */
applyTheme(readTheme());
applyFonts(readFonts());

// 全局错误边界：组件崩溃时显示错误信息而非整页空白
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      // 配色一律走令牌：这样报错页也跟着当前主题走，不会在深底上突然闪一块白
      return (
        <div style={{ padding: 32, color: 'var(--danger)', background: 'var(--bg-0)', minHeight: '100vh', fontFamily: 'var(--font-ui)' }}>
          <h2 style={{ marginTop: 0, color: 'var(--gold)' }}>界面出现异常</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{String(this.state.error?.message || this.state.error)}</pre>
          <p>
            <button onClick={() => location.reload()} style={{ padding: '6px 18px' }}>刷新重试</button>
            {'　'}
            <button onClick={() => this.setState({ error: null })} style={{ padding: '6px 18px' }}>尝试恢复</button>
          </p>
          <p style={{ color: 'var(--text-faint)', fontSize: 12 }}>若反复出现，请将上方错误信息反馈给开发者。</p>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
