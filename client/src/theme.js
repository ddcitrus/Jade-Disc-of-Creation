/*
 * 主题开关：'dark'（玄墨，默认）/ 'light'（宣纸）。
 *
 * 只改 <html data-theme> 这一个属性 —— 两套配色全部写在 guigu.css 的令牌里，
 * 所以切换主题不牵动任何布局、也不重新渲染任何组件（不会闪、不会丢状态）。
 *
 * 单独成文件是为了让「启动时读一次」和「顶栏按钮改一次」用同一份逻辑；
 * 若写进 main.jsx，GameDashboard 就得反过来 import main.jsx，形成循环依赖。
 */

export const THEME_KEY = 'mortal-theme';

export const THEMES = [
  { id: 'dark', name: '玄墨', hint: '夜里读' },
  { id: 'light', name: '宣纸', hint: '白天读' },
];

export function readTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }   // 隐私模式下 localStorage 会抛错，退回默认
}

export function applyTheme(id) {
  const t = id === 'light' ? 'light' : 'dark';
  if (t === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* 存不了就算了，本次会话仍然生效 */ }
  return t;
}
