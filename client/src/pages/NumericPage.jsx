// ===== 游戏内「数值表」页 =====
// 一页把数值规则表（Mortal 数值体系）摊开来改：
//   左栏各表清单可搜索选择 → 右栏网格直编（行=条目，列=字段，中文标签）
//   改动自动落 settings.numericTuning.tables（只存被碰过的表，未碰的走内置默认——见 getEffectiveTables）
//   底部可「立即校验人物属性」：拿境界基准表对照主角 + 名册 NPC 的属性，越界强制写回边界值
// 注意：表级覆盖是「整表替换」，因此编辑时始终写入合并后的完整表，避免丢掉未编辑的条目。

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { GamePage } from './GamePages.jsx';
import {
  TABLE_META, DEFAULT_NUMERIC_TUNING, getEffectiveTables,
  tableFieldLabel, tableKeyLabel, serializeNumericTuning,
} from '../data/numericTuning.js';
import { enforceSnapshotLimits, REALM_STAT_MAP, UNCOVERED_STATS } from '../data/attrClamp.js';
import { persistCharSnapshots } from '../saveModel.js';
import { api } from '../api.js';
import { useToast } from '../ui.jsx';

const DEFAULT_TABLES = DEFAULT_NUMERIC_TUNING.tables || {};

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

// 条目数（列表里显示）
const countEntries = (t) => (t && typeof t === 'object' ? Object.keys(t).length : 0);

export default function NumericPage({ save, updateSave, saveNow, settings, onSettingsChange }) {
  const toast = useToast();
  const tuning = settings?.numericTuning || {};
  const enabled = tuning.enabled !== false;
  const enforce = tuning.enforce !== false;
  const applyTo = tuning.applyTo || { playerB1: true, npcs: true };

  const [sel, setSel] = useState('realmProfiles');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState(null);
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonErr, setJsonErr] = useState('');
  const [saveState, setSaveState] = useState(''); // '' | pending | saved
  const [showPreview, setShowPreview] = useState(false);
  const [report, setReport] = useState(null);
  const [tuningRev, setTuningRev] = useState(0); // 落盘后自增，用于让「生效表」重算
  const timer = useRef(null);
  const loadedFor = useRef(null);
  const fileRef = useRef(null);
  // 最近一次已落盘的 tuning：外部 settings 未及时回传（或页面未重挂载）时作为权威副本，
  // 避免「切到别的表再切回来」时编辑内容被旧值覆盖
  const savedTuningRef = useRef(null);

  const tables = useMemo(() => getEffectiveTables(savedTuningRef.current || tuning), [settings, tuningRev]);

  // 载入选中表的编辑副本（settings 就绪后 / 切换表时；同一张表不重复载入，避免打断输入）
  useEffect(() => {
    if (!settings) return;
    if (loadedFor.current === sel) return;
    loadedFor.current = sel;
    setDraft(structuredClone(getEffectiveTables(savedTuningRef.current || settings)[sel] || {}));
    setJsonMode(false);
    setJsonErr('');
  }, [sel, settings]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // ---------- 落盘 ----------
  const persistTable = useCallback(async (tableKey, table) => {
    const nextTables = { ...(tuning.tables || {}), [tableKey]: table };
    const nextTuning = { ...tuning, enabled, enforce, applyTo, tables: nextTables };
    try {
      const saved = await api.putSettings({ numericTuning: nextTuning });
      savedTuningRef.current = nextTuning;
      setTuningRev(v => v + 1);
      onSettingsChange?.(saved);
      setSaveState('saved');
      setTimeout(() => setSaveState(s => (s === 'saved' ? '' : s)), 1600);
    } catch (e) {
      setSaveState('');
      toast('err', '数值表保存失败：' + (e.message || '未知错误'));
    }
  }, [tuning, enabled, enforce, applyTo, onSettingsChange, toast]);

  const patchTuning = useCallback(async (patch) => {
    const nextTuning = { ...tuning, enabled, enforce, applyTo, ...patch };
    try {
      const saved = await api.putSettings({ numericTuning: nextTuning });
      savedTuningRef.current = nextTuning;
      setTuningRev(v => v + 1);
      onSettingsChange?.(saved);
    } catch (e) {
      toast('err', '设置保存失败：' + (e.message || '未知错误'));
    }
  }, [tuning, enabled, enforce, applyTo, onSettingsChange, toast]);

  // 改一张表：立即更新界面，800ms 后落盘
  const patchDraft = useCallback((next) => {
    setDraft(next);
    setSaveState('pending');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persistTable(sel, next), 800);
  }, [persistTable, sel]);

  // ---------- 网格结构 ----------
  const meta = TABLE_META[sel] || { name: sel, desc: '' };
  const entries = useMemo(() => Object.entries(draft || {}), [draft]);
  const columns = useMemo(() => {
    const cols = [];
    const seen = new Set();
    for (const [, v] of entries) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const f of Object.keys(v)) if (!seen.has(f)) { seen.add(f); cols.push(f); }
      }
    }
    return cols;
  }, [entries]);
  const isFlat = columns.length === 0; // 整张表都是标量条目

  // 数值对（xxxBase / xxxUpper）倒挂提示
  const inverted = useMemo(() => {
    if (sel !== 'realmProfiles') return new Set();
    const bad = new Set();
    for (const [rowKey, row] of entries) {
      if (!row || typeof row !== 'object') continue;
      for (const f of columns) {
        if (!f.endsWith('Base')) continue;
        const base = row[f], upper = row[f.replace(/Base$/, 'Upper')];
        if (typeof base === 'number' && typeof upper === 'number' && base > upper) bad.add(rowKey + '.' + f);
      }
    }
    return bad;
  }, [entries, columns, sel]);

  const setCell = (rowKey, field, raw) => {
    const n = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(n)) return;
    const next = structuredClone(draft || {});
    const cur = next[rowKey];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) next[rowKey] = { ...cur, [field]: n };
    else next[rowKey] = n;
    patchDraft(next);
  };

  const restoreThisTable = () => {
    const def = DEFAULT_TABLES[sel];
    if (!def) { toast('err', '内置表中没有这张表，无法恢复'); return; }
    const next = structuredClone(def);
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    persistTable(sel, next);
    toast('ok', `「${meta.name}」已恢复内置默认`);
  };

  const importJson = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        const t = obj?.tables?.[sel] || obj?.[sel] || obj;
        if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('未找到表对象');
        patchDraft(structuredClone(t));
        toast('ok', `已用 JSON 替换「${meta.name}」`);
      } catch (err) { toast('err', '导入失败：' + (err.message || '不是合法 JSON')); }
      finally { e.target.value = ''; }
    };
    reader.readAsText(f);
  };

  const exportJson = () => {
    const payload = { schemaVersion: DEFAULT_NUMERIC_TUNING.schemaVersion || 1, enabled, applyTo, tables: { [sel]: draft } };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `numeric-${sel}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---------- 立即校验人物属性 ----------
  const runCheck = () => {
    const r = enforceSnapshotLimits(save, tuning, { force: true });
    setReport({ changes: r.changes, scanned: r.scanned, skipped: r.skipped, at: Date.now() });
    if (r.changes.length) {
      updateSave(r.save);
      saveNow(r.save);
      persistCharSnapshots(save.id, r.save.charSnapshots);
      toast('ok', `已按数值表强制修正 ${r.changes.length} 处越界属性`);
    } else {
      toast('ok', `校验完成：${r.scanned} 名角色的属性都在表内区间`);
    }
  };

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    const list = Object.entries(TABLE_META);
    if (!key) return list;
    return list.filter(([k, m]) => k.toLowerCase().includes(key) || m.name.includes(q.trim()) || m.desc.includes(q.trim()));
  }, [q]);

  const overriddenCount = useMemo(
    () => Object.keys(tables).filter(k => !deepEqual(tables[k], DEFAULT_TABLES[k])).length,
    [tables],
  );

  if (!settings) {
    return <GamePage title="数值规则表"><div className="notice">设置加载中…</div></GamePage>;
  }

  const previewText = serializeNumericTuning(enabled ? tuning : { enabled: false });

  return (
    <GamePage
      title="数值规则表"
      actions={(
        <div className="btn-row">
          <button className={enabled ? 'primary' : 'ghost'} onClick={() => { patchTuning({ enabled: !enabled }); toast('ok', enabled ? '已停用数值表注入' : '已启用数值表注入'); }}>
            {enabled ? '注入已开' : '注入已关'}
          </button>
          <button className={enforce ? 'primary' : 'ghost'} onClick={() => { patchTuning({ enforce: !enforce }); toast('ok', enforce ? '已关闭强制校界' : '已开启强制校界：属性越界将自动写回边界'); }}>
            {enforce ? '强制校界：开' : '强制校界：关'}
          </button>
        </div>
      )}
      footer={(
        <>
          <span className="hint" style={{ margin: 0 }}>
            {Object.keys(TABLE_META).length} 张表 · 已改动 {overriddenCount} 张 · 注入文本 {previewText.length} 字符
            {saveState === 'pending' && ' · 保存中…'}
            {saveState === 'saved' && ' · 已保存'}
          </span>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="ghost small" onClick={() => setShowPreview(p => !p)}>{showPreview ? '收起注入预览' : '注入预览'}</button>
          <button className="primary" onClick={runCheck} title="按当前数值表对照主角与名册 NPC 的属性，越界强制写回边界">立即校验人物属性</button>
        </>
      )}
    >
      <div className="nt-layout">
        {/* 左栏：表选择 */}
        <aside className="nt-list-col">
          <input placeholder="搜索表名 / 字段…" value={q} onChange={e => setQ(e.target.value)} style={{ width: '100%' }} />
          <div className="hint" style={{ margin: '2px 0 4px' }}>选中一张表后可在右侧直接改数值</div>
          {filtered.map(([k, m]) => {
            const over = !deepEqual(tables[k], DEFAULT_TABLES[k]);
            return (
              <button key={k} className={`nt-table-btn ${sel === k ? 'active' : ''}`} onClick={() => setSel(k)} title={m.desc}>
                <span className="nt-name">{m.name}{over && <em className="nt-dot" title="已改动" />}</span>
                <span className="nt-count">{countEntries(tables[k])} 条</span>
              </button>
            );
          })}
          {!filtered.length && <div className="hint">没有匹配的表</div>}
        </aside>

        {/* 右栏：编辑区 */}
        <section className="nt-main">
          <div className="nt-head">
            <div style={{ minWidth: 0 }}>
              <h3 style={{ margin: 0 }}>{meta.name}</h3>
              <div className="hint" style={{ margin: '2px 0 0' }}>
                <code>{sel}</code> · {meta.desc} · {entries.length} 条
                {!deepEqual(draft, DEFAULT_TABLES[sel]) && ' · 与本表内置默认不同'}
              </div>
            </div>
            <div className="btn-row" style={{ flexShrink: 0 }}>
              <button className="ghost small" onClick={() => { setJsonMode(m => !m); setJsonErr(''); setJsonText(JSON.stringify(draft, null, 2)); }}>
                {jsonMode ? '返回网格' : 'JSON 编辑'}
              </button>
              <button className="ghost small" onClick={restoreThisTable}>恢复本表默认</button>
              <button className="ghost small" onClick={exportJson}>导出本表</button>
              <button className="ghost small" onClick={() => fileRef.current?.click()}>导入替换</button>
              <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={importJson} />
            </div>
          </div>

          {sel === 'realmProfiles' && (
            <div className="notice" style={{ margin: '8px 0' }}>
              「立即校验人物属性」按此表逐境界校界：<b>上限值 <span className="lbl-note">max</span></b>压到 <code>xxUpper</code>、低于 <code>xxBase</code> 时抬回基准；
              <b>当前值 <span className="lbl-note">current</span></b>只压不抬（受伤、耗蓝是正常状态），天花板取 min(上限, max)。
              表内未收录的属性：{UNCOVERED_STATS.map(u => u.label).join('、')}，不参与校界。
              校界映射：{REALM_STAT_MAP.map(s => `${s.label}→${s.field}`).join('、')}。
            </div>
          )}

          {jsonMode ? (
            <div>
              <textarea className="nt-json" value={jsonText} spellCheck={false}
                onChange={e => { setJsonText(e.target.value); setJsonErr(''); }}
                onBlur={() => {
                  try {
                    const obj = JSON.parse(jsonText);
                    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('根必须是对象');
                    patchDraft(obj);
                    setJsonErr('');
                  } catch (err) { setJsonErr(err.message || '不是合法 JSON'); }
                }} />
              {jsonErr && <div className="hint" style={{ color: 'var(--danger)' }}>JSON 未应用：{jsonErr}</div>}
            </div>
          ) : (
            <div className="nt-grid-wrap">
              <table className="nt-grid">
                <thead>
                  <tr>
                    <th className="nt-key">{sel === 'realmProfiles' ? '境界' : '条目'}</th>
                    {isFlat
                      ? <th title="value">值</th>
                      : columns.map(f => <th key={f} title={f}>{tableFieldLabel(sel, f)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([rowKey, row]) => {
                    const isObj = row && typeof row === 'object' && !Array.isArray(row);
                    return (
                      <tr key={rowKey}>
                        <td className="nt-key" title={rowKey}>{sel === 'realmProfiles' ? rowKey : tableKeyLabel(rowKey)}</td>
                        {isFlat ? (
                          <td><input type="number" step="any" value={row ?? ''} onChange={e => setCell(rowKey, 'value', e.target.value)} /></td>
                        ) : columns.map(f => {
                          const bad = inverted.has(rowKey + '.' + f);
                          const val = isObj ? row[f] : undefined;
                          return (
                            <td key={f}>
                              <input type="number" step="any" className={bad ? 'bad' : ''}
                                title={bad ? `下限大于上限：${f}` : f}
                                value={val === undefined || val === null ? '' : val}
                                onChange={e => setCell(rowKey, f, e.target.value)} />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {!entries.length && <tr><td className="nt-key">—</td><td colSpan={Math.max(1, columns.length)} className="hint">本表暂无条目</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {inverted.size > 0 && (
            <div className="hint" style={{ color: 'var(--danger)', marginTop: 6 }}>
              ⚠ 有 {inverted.size} 处的「下限」大于「上限」，校界时会以两者中较小值作为天花板，建议先修正。
            </div>
          )}

          {/* 校验报告 */}
          {report && (
            <div className="nt-report">
              <div className="section-head-row" style={{ marginBottom: 6 }}>
                <b>属性校验报告</b>
                <span className="hint" style={{ margin: 0 }}>
                  扫描 {report.scanned} 名角色 · 修正 {report.changes.length} 处
                  {report.skipped.length ? ` · 跳过 ${report.skipped.length} 人` : ''}
                </span>
              </div>
              {report.changes.length ? (
                <table className="nt-grid" style={{ width: '100%' }}>
                  <thead>
                    <tr><th className="nt-key">角色</th><th>境界</th><th>属性</th><th>项目</th><th>原值</th><th>修正为</th><th>依据</th></tr>
                  </thead>
                  <tbody>
                    {report.changes.slice(0, 60).map((c, i) => (
                      <tr key={i}>
                        <td className="nt-key">{c.name || c.id}</td>
                        <td>{c.realmText}{c.realmKey && c.realmKey !== c.realmText ? ` → ${c.realmKey}` : ''}</td>
                        <td>{c.statLabel}</td>
                        <td>{c.field === 'max' ? '上限' : c.field === 'current' ? '当前值' : c.field}</td>
                        <td style={{ color: c.bound === 'upper' ? 'var(--red)' : 'var(--blue)' }}>{c.from}</td>
                        <td><b>{c.to}</b></td>
                        <td className="hint" style={{ margin: 0 }}>{c.bound === 'upper' ? '超上限' : '低于下限'} · {c.table}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="hint" style={{ margin: 0 }}>全部角色属性都在数值表区间内，无需修正。</div>}
              {report.skipped.length > 0 && (
                <div className="hint" style={{ marginTop: 6 }}>
                  跳过：{report.skipped.slice(0, 6).map(s => `${s.name} · ${s.msg}`).join('；')}{report.skipped.length > 6 ? ' …' : ''}
                </div>
              )}
            </div>
          )}

          {showPreview && (
            <div className="prompt-preview" style={{ maxHeight: 300, marginTop: 10 }}>
              {enabled ? previewText : '已停用注入'}
            </div>
          )}
        </section>
      </div>
    </GamePage>
  );
}
