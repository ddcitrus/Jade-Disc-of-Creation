import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { migrateSave } from '../saveModel.js';
import { useToast, useConfirm, Spinner } from '../ui.jsx';

// 存档列表页
export default function SavesPage({ onOpen, onBack }) {
  const [saves, setSaves] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const toast = useToast();
  const confirmDlg = useConfirm();

  const load = useCallback(() => api.listSaves().then(() => api.listSaves()).then(setSaves).catch(e => setError(String(e.message))), []);
  useEffect(() => { api.listSaves().then(setSaves).catch(e => setError(String(e.message))); }, []);

  const open = async (id) => {
    setBusyId(id);
    try { onOpen(migrateSave(await api.getSave(id))); }
    catch (e) { toast('err', '读取存档失败：' + e.message); setBusyId(null); }
  };
  const del = async (id, name) => {
    if (!await confirmDlg({ title: '删除存档', text: `确定删除存档「${name}」？此操作不可恢复。`, danger: true, okText: '删除' })) return;
    setBusyId(id);
    try {
      await api.deleteSave(id);
      toast('ok', `存档「${name}」已删除`);
      api.listSaves().then(setSaves);
    } catch (e) { toast('err', '删除失败：' + e.message); }
    finally { setBusyId(null); }
  };

  return (
    <div className="page-shell">
      <div className="top-bar">
        <button className="ghost small" onClick={onBack}>返回主页</button>
        <h1>读取人生</h1>
      </div>
      <div className="page-body">
        {error && <div className="notice">加载失败：{error}</div>}
        {saves === null ? (
          <div className="loading-tip"><Spinner /> 正在读取存档…</div>
        ) : saves.length === 0 ? (
          <div className="empty-tip">暂无存档 · 快去开始一段新的人生吧</div>
        ) : (
          <div className="save-list" style={{ maxWidth: 760, margin: '0 auto' }}>
            {saves.map(s => (
              <div className="card save-item" key={s.id}>
                <div className="info">
                  <h3>{s.name}</h3>
                  <div className="meta">
                    {s.summary?.charName} · {s.summary?.gender} · {s.summary?.race} · {s.summary?.realm} · {s.summary?.root}
                    <br />
                    {s.summary?.timeLabel} · 第 {s.summary?.turnCount} 回合 · {new Date(s.updatedAt).toLocaleString('zh-CN')}
                  </div>
                </div>
                <button className="primary" disabled={busyId === s.id} onClick={() => open(s.id)}>
                  {busyId === s.id ? <Spinner /> : '读取'}
                </button>
                <button className="danger small" disabled={busyId === s.id} onClick={() => del(s.id, s.name)}>删除</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="wizard-footer">
        <button onClick={onBack}>返回主页</button>
        <button className="ghost" onClick={() => { api.listSaves().then(setSaves); }}>刷新</button>
      </div>
    </div>
  );
}
