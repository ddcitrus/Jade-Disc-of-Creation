import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';

/* ============ Toast 通知（状态可见性 + 即时反馈） ============ */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const push = useCallback((type, text) => {
    const id = ++idRef.current;
    setToasts(t => [...t.slice(-4), { id, type, text }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), type === 'err' ? 5000 : type === 'warn' ? 4200 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`} role="status">
            <span className="toast-icon" aria-hidden="true">{t.type === 'ok' ? '✓' : t.type === 'err' ? '✕' : t.type === 'warn' ? '!' : '⋯'}</span>
            <span className="toast-text">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ============ 确认对话框（用户控制与自由，替代原生 confirm） ============ */
const ConfirmCtx = createContext(() => Promise.resolve(false));
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const confirm = useCallback(opts => new Promise(resolve => {
    setState({ title: '确认操作', okText: '确定', ...opts, resolve });
  }), []);
  const close = val => { state?.resolve(val); setState(null); };

  useEffect(() => {
    if (!state) return;
    const onKey = e => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state]);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={state.title}>
          <div className="modal confirm-modal">
            <div className="modal-body confirm-body">
              <h3>{state.title}</h3>
              <p>{state.text}</p>
            </div>
            <div className="modal-foot">
              <button onClick={() => close(false)}>取消</button>
              <button className={state.danger ? 'danger' : 'primary'} autoFocus onClick={() => close(true)}>{state.okText}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}

/* ============ Spinner（加载状态） ============ */
export function Spinner({ label = '加载中' }) {
  return <span className="spinner" role="status" aria-label={label} />;
}
