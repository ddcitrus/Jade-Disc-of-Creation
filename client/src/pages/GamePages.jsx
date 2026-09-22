import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { api } from '../api.js';
import { newWorldbookEntry, newCharacter, PLOT_STYLES, CHARACTER_GROUPS, migrateSave } from '../saveModel.js';
import { WORLD_FACTORS } from '../data/gameData.js';
import { buildDirectorPrompt } from '../engine/narrative.js';
import { useToast, useConfirm, Spinner } from '../ui.jsx';

// ===== JSON 导入解析 =====
// 世界书：支持 mortal-standalone / SillyTavern 世界书导出（entries: { uid: {...} }）与本站条目数组
export function parseWorldbookImport(json) {
  const out = [];
  const push = (name, keywords, content, enabled, always) => {
    if (!name && !content) return;
    out.push({
      name: String(name || '未命名条目'),
      keywords: (keywords || []).map(String).filter(Boolean),
      content: String(content || ''),
      enabled: enabled !== false,
      always: !!always,
    });
  };
  if (json && typeof json === 'object' && json.entries && typeof json.entries === 'object') {
    for (const e of Object.values(json.entries)) {
      push(e.comment || e.name || e.uid, [...(e.key || []), ...(e.keysecondary || [])], e.content, !e.disable, e.constant);
    }
    return out;
  }
  const arr = Array.isArray(json) ? json : (Array.isArray(json?.worldbook) ? json.worldbook : null);
  if (arr) {
    for (const e of arr) push(e.name, e.keywords, e.content, e.enabled !== false, !!e.always);
    return out;
  }
  return null;
}

// 世界因子：支持 {name, desc, effect} 数组、{factors:[...]}、mortal 单因子对象
export function parseFactorsImport(json) {
  const arr = Array.isArray(json) ? json
    : (Array.isArray(json?.factors) ? json.factors
      : (Array.isArray(json?.world?.factors) ? json.world.factors : null));
  const out = [];
  if (arr) {
    for (const f of arr) {
      if (!f?.name) continue;
      out.push({ name: String(f.name), desc: String(f.desc || ''), effect: String(f.effect || '导入的世界规则。') });
    }
    return out;
  }
  if (json && typeof json === 'object' && json.name) {
    return [{ name: String(json.name), desc: String(json.desc || ''), effect: String(json.effect || '导入的世界规则。') }];
  }
  return null;
}

// 通用：游戏内页面壳
export function GamePage({ title, actions, footer, children }) {
  return (
    <div className="gamepage">
      <div className="gamepage-head">
        <div className="section-head-row" style={{ marginBottom: 0, maxWidth: 'none' }}>
          <h2>{title}</h2>
          <span className="spacer" />
          {actions}
        </div>
      </div>
      <div className="gamepage-body">{children}</div>
      {footer && <div className="gamepage-foot">{footer}</div>}
    </div>
  );
}

/* ============ 剧情演化（原站结构：方向 + 风格指令 + 剧情指导） ============ */
export function EvolutionPage({ save, updateSave, saveNow, mode }) {
  const plot = save.plot || { direction: '', styles: {}, guidance: '' };
  const [expanded, setExpanded] = useState(null);
  const [genBusy, setGenBusy] = useState(false);
  const [showSpoiler, setShowSpoiler] = useState(false);
  const toast = useToast();

  const setPlot = (p, persist = true) => {
    const s = { ...save, plot: p };
    updateSave(s);
    if (persist) saveNow(s).then(() => toast('ok', '剧情演化配置已保存'));
  };
  const patchPlot = (patch, persist = true) => setPlot({ ...plot, ...patch }, persist);

  const toggleStyle = (id) => {
    const styles = { ...plot.styles };
    if (styles[id]?.selected) delete styles[id];
    else styles[id] = { selected: true, hits: 0, total: 0, lastHitTurn: 0 };
    patchPlot({ styles });
  };

  const selectedCount = Object.values(plot.styles || {}).filter(x => x.selected).length;

  const genGuidance = async () => {
    if (genBusy) return;
    setGenBusy(true);
    try {
      if (mode === 'ai') {
        const r = await api.aiGenerate(buildDirectorPrompt(save));
        patchPlot({ guidance: r.text || '' });
      } else {
        const chosen = PLOT_STYLES.filter(s => plot.styles?.[s.id]?.selected);
        const main = chosen.length ? chosen[(save.turnCount || 0) % chosen.length] : null;
        const lines = [];
        if (plot.direction?.trim()) lines.push(`围绕长期方向「${plot.direction.trim()}」推进。`);
        if (main) lines.push(`本回合以「${main.name}」为主导：${main.instructions[0]}`);
        if (chosen.filter(s => s !== main).length) lines.push(`同时叠加：${chosen.filter(s => s !== main).map(s => s.name).join('、')}的气息。`);
        if (!lines.length) lines.push('按当前处境自然推进，保持张力和悬念的平衡。');
        patchPlot({ guidance: lines.join('\n') });
      }
      setShowSpoiler(true);
      toast('ok', '剧情指导已生成');
    } catch (e) {
      toast('err', '生成剧情指导失败：' + e.message);
    } finally { setGenBusy(false); }
  };

  return (
    <GamePage
      title="剧情演化"
      actions={
        <>
          {selectedCount > 0 && <button className="ghost small" onClick={() => patchPlot({ styles: {} })}>清空风格 {selectedCount}</button>}
          <button className="primary small" disabled={genBusy} onClick={genGuidance}>
            {genBusy ? <><Spinner /> 生成中…</> : '生成剧情指导'}
          </button>
        </>
      }
      footer={<span>剧情演化是导演层：每回合正文生成前，按长期方向与已选风格指令驱动剧情走向。</span>}
    >
      {/* 长期剧情方向 */}
      <div className="section">
        <h3>长期剧情方向</h3>
        <textarea
          className="direction-input"
          value={plot.direction || ''}
          onChange={e => patchPlot({ direction: e.target.value }, false)}
          onBlur={() => setPlot(plot)}
          placeholder="例如：我想体验不同性格女角色之间的恋爱竞争与喜剧拉扯；不要生死存亡危机，也不想拯救世界。"
        />
        <div className="hint">告诉天道你想讲一个什么样的故事，会作为最高指导注入每一回合。</div>
      </div>

      {/* 剧情风格倾向（紧凑双列，一行一个风格） */}
      <div className="section">
        <div className="section-head-row">
          <h3>剧情风格倾向</h3>
          <span className="hint" style={{ margin: 0 }}>已选 {selectedCount} 项 · 可多选叠加</span>
        </div>
        <div className="style-grid">
          {PLOT_STYLES.map(s => {
            const st = plot.styles?.[s.id];
            const on = !!st?.selected;
            return (
              <div key={s.id} className={`style-row ${on ? 'on' : ''}`}>
                <div className="style-row-top">
                  <button className="style-toggle" onClick={() => toggleStyle(s.id)} aria-pressed={on}>
                    <span className="style-check" aria-hidden="true">✓</span>
                    <span className="style-name">{s.name}</span>
                    <span className="style-state">{on ? '已选' : '未选'}</span>
                  </button>
                  {on && <span className="style-hits">命中 {st.hits || 0}/{st.total || 0}</span>}
                </div>
                <div className="style-desc">{s.desc}</div>
                <button className="style-ins-btn" onClick={() => setExpanded(expanded === s.id ? null : s.id)} aria-expanded={expanded === s.id}>
                  {expanded === s.id ? '收起指令 ▴' : '查看指令 ▾'}
                </button>
                {expanded === s.id && (
                  <ul className="style-ins-list">
                    {s.instructions.map((ins, i) => <li key={i}>{ins}</li>)}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 当前剧情指导 */}
      <div className="section">
        <div className="section-head-row">
          <h3>当前剧情指导</h3>
          <button className="ghost small" onClick={() => setShowSpoiler(v => !v)}>{showSpoiler ? '隐藏剧情指导' : '显示剧情指导'}</button>
        </div>
        {showSpoiler ? (
          <textarea
            className="guidance-input"
            value={plot.guidance || ''}
            onChange={e => patchPlot({ guidance: e.target.value }, false)}
            onBlur={() => setPlot(plot)}
            placeholder="导演层指令——可点上方「生成剧情指导」，也可手写。每回合正文将优先遵守此指导。"
          />
        ) : (
          <div className="spoiler-blur">剧情指导已隐藏 · 含剧透</div>
        )}
      </div>
    </GamePage>
  );
}

/* ============ 存档管理（游戏内） ============ */
export function SavesManagerPage({ save, onSwitchSave, onNewSave, refreshKey }) {
  const [saves, setSaves] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const toast = useToast();
  const confirmDlg = useConfirm();

  const load = useCallback(() => api.listSaves().then(setSaves).catch(() => setSaves([])), []);
  useEffect(() => { load(); }, [refreshKey, load]);

  const del = async (id, name) => {
    if (id === save.id) return toast('err', '不能删除当前正在游玩的存档');
    if (!await confirmDlg({ title: '删除存档', text: `确定删除存档「${name}」？此操作不可恢复。`, danger: true, okText: '删除' })) return;
    setBusyId(id);
    try {
      await api.deleteSave(id);
      toast('ok', `存档「${name}」已删除`);
      load();
    } catch (e) { toast('err', '删除失败：' + e.message); }
    finally { setBusyId(null); }
  };

  const switchTo = async (id) => {
    setBusyId(id);
    try {
      const s = migrateSave(await api.getSave(id));
      onSwitchSave(s);
      toast('ok', `已切换到「${s.name}」`);
    } catch (e) { toast('err', '读取失败：' + e.message); setBusyId(null); }
  };

  return (
    <GamePage
      title="存档管理"
      actions={<>
        <button className="primary small" onClick={onNewSave}>＋ 新建人生</button>
        <button className="ghost small" onClick={load}>刷新</button>
      </>}
      footer={<span>切换存档会离开当前故事，当前进度已自动保存。</span>}
    >
      {saves === null ? (
        <div className="loading-tip"><Spinner /> 正在读取存档…</div>
      ) : saves.length === 0 ? (
        <div className="empty-tip">暂无其他存档 · 点击「新建人生」开始新故事</div>
      ) : (
        <div className="save-list">
          {saves.map(s => (
            <div className={`card save-item ${s.id === save.id ? 'selected' : ''}`} key={s.id}>
              <div className="info">
                <h3>{s.name}{s.id === save.id && <span className="tag" style={{ color: 'var(--green)', marginLeft: 8 }}>当前</span>}</h3>
                <div className="meta">
                  {s.summary?.charName} · {s.summary?.race} · {s.summary?.realm} · 第 {s.summary?.turnCount} 回合 · {new Date(s.updatedAt).toLocaleString('zh-CN')}
                </div>
              </div>
              {s.id !== save.id && (
                <button disabled={busyId === s.id} onClick={() => switchTo(s.id)}>
                  {busyId === s.id ? <Spinner /> : '切换'}
                </button>
              )}
              <button className="danger small" disabled={busyId === s.id || s.id === save.id} onClick={() => del(s.id, s.name)}>删除</button>
            </div>
          ))}
        </div>
      )}
    </GamePage>
  );
}

/* ============ 世界因子（批量操作 + 因子组合 + 自定义因子库） ============ */
export function FactorsPage({ save, updateSave, saveNow }) {
  const saved = Array.isArray(save.world?.factors) ? save.world.factors : [];
  const [lib, setLib] = useState({ custom: [], sets: [] });   // 本机因子库（跨存档共享）
  const [libReady, setLibReady] = useState(false);
  const [libErr, setLibErr] = useState('');                    // 因子库接口不可用时的提示
  const [checked, setChecked] = useState(() => new Set());    // 批量勾选（按因子名）
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({ name: '', desc: '', effect: '' });
  const [setName, setSetName] = useState('');
  const importRef = useRef(null);
  const toast = useToast();
  const confirmDlg = useConfirm();

  // 读取因子库；顺便把本存档里已有的自定义因子并入库，保证切到别的存档也能看到
  useEffect(() => {
    let alive = true;
    api.getFactorLibrary().then(l => {
      if (!alive) return;
      const builtinNames = new Set(WORLD_FACTORS.map(f => f.name));
      const known = new Set((l.custom || []).map(f => f.name));
      const adopt = saved
        .filter(f => f && f.name && !builtinNames.has(f.name) && !known.has(f.name))
        .map(f => ({ name: f.name, desc: f.desc || '', effect: f.effect || '自定义世界规则。' }));
      const next = adopt.length ? { ...l, custom: [...(l.custom || []), ...adopt] } : l;
      setLib(next);
      setLibReady(true);
      setLibErr('');
      if (adopt.length) api.putFactorLibrary(next).catch(() => {});
    }).catch(e => { if (alive) { setLibReady(true); setLibErr(String(e?.message || e)); } });
    return () => { alive = false; };
  }, [save.id]); // 切存档时重新读取

  // 可操作的因子池 = 内置 + 库内自定义 + 本存档里未知来源的因子
  const pool = useMemo(() => {
    const map = new Map();
    for (const f of WORLD_FACTORS) map.set(f.name, { name: f.name, desc: f.desc, effect: f.effect, builtin: true });
    for (const f of (lib.custom || [])) if (!map.has(f.name)) map.set(f.name, { name: f.name, desc: f.desc || '', effect: f.effect || '', builtin: false });
    for (const f of saved) if (!map.has(f.name)) map.set(f.name, { name: f.name, desc: f.desc || '', effect: f.effect || '', builtin: false });
    return [...map.values()];
  }, [lib, saved]);

  const builtins = pool.filter(f => f.builtin);
  const customs = pool.filter(f => !f.builtin);
  const onNames = useMemo(() => new Set(saved.map(f => f.name)), [saved]);
  const asFactor = (f) => ({ name: f.name, desc: f.desc || '', effect: f.effect || '自定义世界规则。' });

  // 存档写入：只改当前存档的 world.factors
  const persist = (list, msg) => {
    const s = { ...save, world: { ...save.world, factors: list } };
    updateSave(s);
    saveNow(s).then(() => msg && toast('ok', msg));
  };
  // 因子库写入：自定义因子定义 + 组合
  const saveLib = async (next, msg) => {
    const prev = lib; // 乐观更新的回滚点：写盘失败就撤回，免得显示"看着存了其实没存"的组合
    setLib(next);
    try {
      const l = await api.putFactorLibrary(next);
      setLib(l);
      setLibErr('');
      if (msg) toast('ok', msg);
    } catch (e) {
      setLib(prev);
      setLibErr(String(e?.message || e));
      toast('err', '因子库保存失败：' + e.message);
    }
  };

  // ---- 单个启停 ----
  const toggle = (f) => {
    const on = onNames.has(f.name);
    persist(on ? saved.filter(x => x.name !== f.name) : [...saved, asFactor(f)],
      on ? `已停用「${f.name}」` : `已启用「${f.name}」`);
  };

  // ---- 批量勾选 ----
  const toggleCheck = (name) => setChecked(prev => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });
  const checkAll = (list) => setChecked(prev => {
    const next = new Set(prev);
    const all = list.length > 0 && list.every(f => next.has(f.name));
    for (const f of list) all ? next.delete(f.name) : next.add(f.name);
    return next;
  });
  const selectAll = () => setChecked(new Set(pool.map(f => f.name)));
  const selectNone = () => setChecked(new Set());

  // ---- 批量动作 ----
  const applyBatch = async (action) => {
    const targets = pool.filter(f => checked.has(f.name));
    if (!targets.length) return toast('err', '请先勾选因子');
    if (action === 'enable') {
      const add = targets.filter(f => !onNames.has(f.name));
      if (!add.length) return toast('err', '所选因子都已启用');
      persist([...saved, ...add.map(asFactor)], `已批量启用 ${add.length} 项`);
    } else if (action === 'disable') {
      const names = new Set(targets.map(f => f.name));
      const hit = saved.filter(f => names.has(f.name)).length;
      if (!hit) return toast('err', '所选因子都未启用');
      persist(saved.filter(f => !names.has(f.name)), `已批量停用 ${hit} 项`);
    } else {
      const removable = targets.filter(f => !f.builtin);
      const skipped = targets.length - removable.length;
      if (!removable.length) return toast('err', '内置因子只能停用，不能删除');
      const ok = await confirmDlg({
        title: '批量删除自定义因子',
        text: `将从因子库彻底移除 ${removable.length} 个自定义因子${skipped ? ` · 另有 ${skipped} 个内置因子已跳过` : ''}，所有存档都不再显示。此操作不可恢复。`,
        danger: true, okText: '删除'
      });
      if (!ok) return;
      const names = new Set(removable.map(f => f.name));
      persist(saved.filter(f => !names.has(f.name)), `已删除 ${removable.length} 个自定义因子`);
      await saveLib({ ...lib, custom: (lib.custom || []).filter(f => !names.has(f.name)) });
    }
    setChecked(new Set());
  };
  const disableAll = async () => {
    if (!saved.length) return;
    const ok = await confirmDlg({ title: '全部停用', text: `将停用当前存档的全部 ${saved.length} 项世界因子？`, okText: '全部停用' });
    if (ok) persist([], '已停用全部世界因子');
  };

  // ---- 自定义因子 ----
  const addCustom = async () => {
    const name = draft.name.trim();
    if (!name) return;
    if (WORLD_FACTORS.some(f => f.name === name)) return toast('err', `「${name}」与内置因子重名，请换个名称`);
    const f = asFactor({ name, desc: draft.desc.trim(), effect: draft.effect.trim() });
    await saveLib({ ...lib, custom: [...(lib.custom || []).filter(x => x.name !== name), f] });
    persist([...saved.filter(x => x.name !== name), f], `已添加并启用「${name}」`);
    setDraft({ name: '', desc: '', effect: '' });
    setShowForm(false);
  };
  const removeCustom = async (f) => {
    const ok = await confirmDlg({ title: '删除自定义因子', text: `确定从因子库中删除「${f.name}」？所有存档都不再显示它。`, danger: true, okText: '删除' });
    if (!ok) return;
    persist(saved.filter(x => x.name !== f.name));
    await saveLib({ ...lib, custom: (lib.custom || []).filter(x => x.name !== f.name) }, `已删除「${f.name}」`);
  };

  // ---- 因子组合 ----
  const saveSet = async (overwriteOf = null) => {
    const name = (overwriteOf?.name || setName).trim();
    if (!name) return;
    if (!saved.length) return toast('err', '当前没有启用任何因子，先启用再保存组合');
    const exist = overwriteOf || (lib.sets || []).find(s => s.name === name);
    if (exist && !overwriteOf) {
      const ok = await confirmDlg({ title: '覆盖组合', text: `已有同名组合「${name}」，用当前启用的 ${saved.length} 项因子覆盖它？`, okText: '覆盖' });
      if (!ok) return;
    }
    const now = Date.now();
    const next = {
      id: exist?.id || `fset_${now.toString(36)}`, name, note: '',
      factors: saved.map(asFactor), createdAt: exist?.createdAt || now, updatedAt: now
    };
    await saveLib({ ...lib, sets: [...(lib.sets || []).filter(s => s.name !== name), next] },
      exist ? `已更新组合「${name}」` : `已保存组合「${name}」`);
    setSetName('');
  };
  const applySet = async (set) => {
    const names = set.factors.map(f => f.name);
    const ok = await confirmDlg({
      title: '应用组合',
      text: `当前存档的世界因子将被替换为「${set.name}」的 ${names.length} 项：${names.join('、')}`,
      okText: '应用'
    });
    if (!ok) return;
    persist(set.factors.map(asFactor), `已应用组合「${set.name}」`);
    // 组合里带的自定义因子定义补进库（这样换存档应用也不会丢定义）
    const missing = set.factors.filter(f => !WORLD_FACTORS.some(w => w.name === f.name) && !(lib.custom || []).some(c => c.name === f.name));
    if (missing.length) saveLib({ ...lib, custom: [...(lib.custom || []), ...missing.map(asFactor)] });
  };
  const dropSet = async (set) => {
    const ok = await confirmDlg({ title: '删除组合', text: `确定删除组合「${set.name}」？`, danger: true, okText: '删除' });
    if (!ok) return;
    await saveLib({ ...lib, sets: (lib.sets || []).filter(s => s.id !== set.id) }, `已删除组合「${set.name}」`);
  };

  // ---- JSON 导入 ----
  const doImport = async (file) => {
    try {
      const json = JSON.parse(await file.text());
      const list = parseFactorsImport(json);
      if (!list || !list.length) return toast('err', '未识别出可导入的因子 · 支持 {name,desc,effect} 数组或 {factors:[...]}');
      const known = new Set(pool.map(f => f.name));
      const fresh = list.filter(f => !known.has(f.name));
      if (!fresh.length) return toast('err', `识别出 ${list.length} 条，但都已存在，未新增`);
      persist([...saved, ...fresh], `已导入并启用 ${fresh.length} 条世界因子 · 重复 ${list.length - fresh.length} 条已跳过`);
      const customAdds = fresh.filter(f => !WORLD_FACTORS.some(w => w.name === f.name));
      if (customAdds.length) saveLib({ ...lib, custom: [...(lib.custom || []), ...customAdds.map(asFactor)] });
    } catch (e) { toast('err', '导入失败：' + e.message); }
  };

  const renderRow = (f) => {
    const on = onNames.has(f.name);
    return (
      <div key={f.name} className={`factor-row ${on ? 'on' : ''}`} onClick={() => toggle(f)}
        role="switch" aria-checked={on} tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(f); } }}>
        <input type="checkbox" className="fx-check" checked={checked.has(f.name)}
          aria-label={`选择 ${f.name}`} onClick={e => e.stopPropagation()} onChange={() => toggleCheck(f.name)} />
        <span className="factor-switch" aria-hidden="true" />
        <span className="factor-info">
          <span className="factor-name">{f.name}{!f.builtin && <span className="tag">自定义</span>}</span>
          {f.desc && <span className="factor-desc">{f.desc}</span>}
          {f.effect && <span className="factor-effect">效果：{f.effect}</span>}
        </span>
        {!f.builtin && (
          <button className="fx-remove" title="从因子库删除" aria-label={`删除 ${f.name}`}
            onClick={e => { e.stopPropagation(); removeCustom(f); }}>×</button>
        )}
      </div>
    );
  };

  return (
    <GamePage
      title={`世界因子 · 启用 ${saved.length} / 共 ${pool.length}`}
      actions={<>
        <button className="ghost small" onClick={() => importRef.current?.click()}>📥 导入 JSON</button>
        <input ref={importRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) doImport(f); }} />
        <button className={showForm ? 'ghost small' : 'primary small'} onClick={() => setShowForm(v => !v)}>{showForm ? '取消' : '＋ 自定义因子'}</button>
      </>}
      footer={<span>点卡片 = 单独启停；勾选框 = 批量启用 / 停用 / 删除。因子组合钉在左侧，存在本机，切换到其它存档也能一键套用。</span>}
    >
      <div className="fx-layout">
        {/* 左栏：因子组合（吸顶，不随右侧因子池滚动） */}
        <aside className="fx-side">
          <div className="fx-side-card">
            <div className="fx-block-head">
              <h3>因子组合</h3>
              <span className="spacer" />
              <span className="fx-hint">{(lib.sets || []).length} 套</span>
            </div>
            <p className="fx-side-tip">把当前启用的 {saved.length} 项存成一套，换存档时一键套用。</p>

            {libErr && (
              <div className="notice fx-lib-err">
                因子库读写失败：{libErr}
              </div>
            )}

            <div className="fx-set-save">
              <input type="text" value={setName} placeholder="组合名称，如：末法女尊乱世"
                onChange={e => setSetName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveSet(); }} />
              <button className="primary small" disabled={!setName.trim() || !saved.length} onClick={() => saveSet()}>保存为组合</button>
            </div>

            <div className="fx-set-scroll">
              {!libReady ? (
                <div className="empty-tip" style={{ padding: '12px 0' }}>读取因子库…</div>
              ) : (lib.sets || []).length === 0 ? (
                <div className="empty-tip" style={{ padding: '12px 0' }}>还没有组合。启用几个因子后保存，就能在别的存档一键套用。</div>
              ) : (
                <div className="fx-set-grid">
                  {(lib.sets || []).map(s => {
                    const names = s.factors.map(f => f.name);
                    const same = names.length === saved.length && names.every(n => onNames.has(n));
                    return (
                      <div key={s.id} className={`fx-set ${same ? 'on' : ''}`}>
                        <div className="fx-set-head">
                          <span className="fx-set-name" title={s.name}>{s.name}</span>
                          {same && <span className="tag">当前</span>}
                          <span className="spacer" />
                          <span className="fx-set-count">{names.length} 项</span>
                        </div>
                        <div className="fx-set-list" title={names.join('、')}>{names.join('、')}</div>
                        <div className="fx-set-actions">
                          <button className="primary small fx-apply" disabled={same} onClick={() => applySet(s)}>{same ? '已应用' : '应用到此存档'}</button>
                          <button className="small" disabled={!saved.length} title="把当前启用的因子写回这套组合，其它存档套用时就是新内容"
                            onClick={() => saveSet(s)}>以当前设置覆盖该组合</button>
                          <button className="ghost small" onClick={() => dropSet(s)}>删除</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </aside>

        {/* 右栏：自定义因子表单 + 因子池 */}
        <section className="fx-main">
          {showForm && (
            <div className="card fx-form">
              <h4>新增自定义因子</h4>
              <p className="fx-form-tip">自定义因子会存进本机因子库，所有存档都能选用；同名内置因子请勿重复添加。</p>
              <div className="field"><label>名称</label><input type="text" autoFocus value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="如：灵潮复苏" /></div>
              <div className="field"><label>描述</label><input type="text" value={draft.desc} onChange={e => setDraft({ ...draft, desc: e.target.value })} placeholder="世界背景描述…" /></div>
              <div className="field"><label>效果</label><input type="text" value={draft.effect} onChange={e => setDraft({ ...draft, effect: e.target.value })} placeholder="对游戏规则的影响…" /></div>
              <button className="primary" disabled={!draft.name.trim()} onClick={addCustom}>添加并启用</button>
            </div>
          )}

          <section className="fx-block">
            <div className="fx-block-head">
              <h3>因子池</h3>
              <span className="fx-hint">共 {pool.length} 项 · 已启用 {saved.length} 项</span>
            </div>
            <div className="fx-bar">
              <button className="ghost small" onClick={selectAll}>全选</button>
              <button className="ghost small" disabled={!checked.size} onClick={selectNone}>清空选择</button>
              <span className="fx-divider" aria-hidden="true" />
              <span className="fx-picked">已选 {checked.size} 项</span>
              <button className="small primary" disabled={!checked.size} onClick={() => applyBatch('enable')}>批量启用</button>
              <button className="small" disabled={!checked.size} onClick={() => applyBatch('disable')}>批量停用</button>
              <button className="small danger" disabled={!checked.size} onClick={() => applyBatch('delete')}>批量删除</button>
              <span className="spacer" />
              <button className="ghost small" disabled={!saved.length} onClick={disableAll}>全部停用</button>
            </div>

            <div className="fx-group-head">
              <h4>内置因子</h4>
              <span className="fx-hint">{builtins.filter(f => onNames.has(f.name)).length} / {builtins.length} 已启用</span>
              <span className="spacer" />
              <button className="ghost small" onClick={() => checkAll(builtins)}>本组全选</button>
            </div>
            <div className="factor-grid">{builtins.map(renderRow)}</div>

            <div className="fx-group-head">
              <h4>自定义因子</h4>
              <span className="fx-hint">{customs.filter(f => onNames.has(f.name)).length} / {customs.length} 已启用</span>
              <span className="spacer" />
              {customs.length > 0 && <button className="ghost small" onClick={() => checkAll(customs)}>本组全选</button>}
            </div>
            {customs.length === 0
              ? <div className="empty-tip" style={{ padding: '12px 0' }}>还没有自定义因子。点右上角「＋ 自定义因子」新建，或用「导入 JSON」批量带入。</div>
              : <div className="factor-grid">{customs.map(renderRow)}</div>}
          </section>
        </section>
      </div>
    </GamePage>
  );
}

/* ============ 世界书（主从布局：左列表 + 右编辑器 + JSON 导入） ============
   世界书是**跨存档共用**的：所有存档共用 server/data/worldbook.json 这一份，
   存在设置里随 /api/settings 一起下发（props.worldbook），保存走 /api/worldbook。 */
export function WorldBookPage({ worldbook, onSave }) {
  const entries = worldbook || [];
  const [selId, setSelId] = useState(null);       // 选中的条目 id（null = 无选择）
  const [creating, setCreating] = useState(false); // 新建模式
  const [draft, setDraft] = useState(null);        // 编辑草稿
  const [search, setSearch] = useState('');
  const [checkedIds, setCheckedIds] = useState(() => new Set()); // 批量勾选
  const importRef = useRef(null);
  const toast = useToast();
  const confirmDlg = useConfirm();

  // 世界书是跨存档共用文件：改动只写那一份，不碰存档（因此也不会被回合落盘覆盖）
  const persist = (list, msg) => {
    onSave(list)
      .then(() => msg && toast('ok', msg))
      .catch(e => toast('err', '保存失败：' + (e?.message || e)));
  };

  // ---- 批量操作 ----
  const toggleCheck = (id) => setCheckedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleGroupCheck = (groupEntries) => setCheckedIds(prev => {
    const next = new Set(prev);
    const all = groupEntries.every(e => next.has(e.id));
    for (const e of groupEntries) all ? next.delete(e.id) : next.add(e.id);
    return next;
  });
  const selectAllShown = () => setCheckedIds(new Set([...checkedIds, ...shown.map(e => e.id)]));
  const clearChecked = () => setCheckedIds(new Set());
  const applyBatch = async (action) => {
    const targets = entries.filter(e => checkedIds.has(e.id));
    if (!targets.length) return toast('err', '请先勾选条目');
    const labels = { enable: '启用', disable: '停用', delete: '删除' };
    if (action === 'delete') {
      const ok = await confirmDlg({ title: '批量删除', text: `确定删除勾选的 ${targets.length} 条条目？此操作不可恢复。`, danger: true, okText: '删除' });
      if (!ok) return;
      const ids = new Set(targets.map(e => e.id));
      persist(entries.filter(e => !ids.has(e.id)), `已批量删除 ${targets.length} 条`);
      if (selId && ids.has(selId)) { setSelId(null); setDraft(null); }
    } else {
      const enabled = action === 'enable';
      const ids = new Set(targets.map(e => e.id));
      persist(entries.map(e => ids.has(e.id) ? { ...e, enabled } : e), `已批量${labels[action]} ${targets.length} 条`);
    }
    clearChecked();
  };
  const delDisabled = async () => {
    const targets = entries.filter(e => !e.enabled);
    if (!targets.length) return toast('ok', '没有未启用的条目');
    const chars = targets.reduce((s, e) => s + (e.content || '').length, 0);
    const ok = await confirmDlg({ title: '删除未启用条目', text: `确定删除全部 ${targets.length} 条未启用条目，共约 ${chars} 字？此操作不可恢复。`, danger: true, okText: '删除' });
    if (!ok) return;
    const ids = new Set(targets.map(e => e.id));
    persist(entries.filter(e => !ids.has(e.id)), `已删除 ${targets.length} 条未启用条目`);
    if (selId && ids.has(selId)) { setSelId(null); setDraft(null); }
    clearChecked();
  };

  // JSON 导入：mortal-standalone / SillyTavern 世界书导出，或本站条目数组；同名跳过
  const doImport = async (file) => {
    try {
      const json = JSON.parse(await file.text());
      const list = parseWorldbookImport(json);
      if (!list || !list.length) {
        return toast('err', '未识别出可导入的条目 · 支持 mortal-standalone / SillyTavern 世界书导出，或本站条目数组');
      }
      const merged = [...entries];
      let added = 0;
      for (const e of list) {
        if (merged.some(x => x.name === e.name)) continue;
        merged.push(newWorldbookEntry({ ...e, source: file.name })); added++;
      }
      persist(merged, `已导入 ${added} 条世界书条目 · 批次「${file.name}」· 重复 ${list.length - added} 条已跳过`);
    } catch (e) { toast('err', '导入失败：' + e.message); }
  };

  const shown = search.trim()
    ? entries.filter(e => e.name.includes(search.trim()) || (e.keywords || []).some(k => k.includes(search.trim())))
    : entries;

  // 按导入批次分组（source = 导入文件名 / 手动创建；空 = 早期条目），每组独立可折叠
  const groupOrder = [];
  const groupMap = new Map();
  for (const e of shown) {
    const g = e.source || '未分组';
    if (!groupMap.has(g)) { groupMap.set(g, []); groupOrder.push(g); }
    groupMap.get(g).push(e);
  }

  const startCreate = () => { setDraft(newWorldbookEntry({ source: '手动创建' })); setCreating(true); setSelId(null); };
  const startEdit = (e) => { setDraft({ ...e }); setCreating(false); setSelId(e.id); };
  const saveDraft = () => {
    if (!draft.name.trim()) return toast('err', '条目名称不能为空');
    const exists = entries.find(x => x.id === draft.id);
    persist(exists ? entries.map(x => x.id === draft.id ? draft : x) : [...entries, draft], `条目「${draft.name}」已保存`);
    setSelId(draft.id);
    setCreating(false);
    setDraft(null);
  };
  const del = async (e) => {
    if (!await confirmDlg({ title: '删除条目', text: `确定删除世界书条目「${e.name}」？`, danger: true, okText: '删除' })) return;
    persist(entries.filter(x => x.id !== e.id), `条目「${e.name}」已删除`);
    if (selId === e.id) { setSelId(null); setDraft(null); }
  };
  // 删除整组：按 id 集合过滤，避免同组内改名等场景漏删
  const delGroup = async (g, groupEntries) => {
    if (!await confirmDlg({ title: '删除分组', text: `确定删除分组「${g}」的全部 ${groupEntries.length} 条条目？此操作不可恢复。`, danger: true, okText: '删除' })) return;
    const ids = new Set(groupEntries.map(x => x.id));
    persist(entries.filter(x => !ids.has(x.id)), `分组「${g}」已删除 · ${groupEntries.length} 条`);
    if (selId && ids.has(selId)) { setSelId(null); setDraft(null); }
  };

  return (
    <GamePage
      title={`世界书 · ${entries.length} 条`}
      actions={<>
        <button className="ghost small" onClick={() => importRef.current?.click()}>📥 导入 JSON</button>
        <input ref={importRef} type="file" accept=".json,application/json" style={{ display: 'none' }}
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) doImport(f); }} />
        <button className="primary small" onClick={startCreate}>＋ 新增条目</button>
      </>}
      footer={<span>「恒定注入」始终进入 AI 上下文；其余条目在正文或行动命中关键字时注入。</span>}
    >
      <div className="wb-layout">
        {/* 左：条目列表 */}
        <div className="wb-list-col">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索条目或关键字…" aria-label="搜索世界书条目" />
          {/* 批量操作工具条（sticky：列表滚动时保持可见） */}
          <div className="wb-batch-bar">
            <button className="ghost small" onClick={selectAllShown}>全选筛选结果</button>
            {checkedIds.size > 0 && <>
              <span className="tag">已选 {checkedIds.size} 条</span>
              <button className="small primary" onClick={() => applyBatch('enable')}>启用</button>
              <button className="small" onClick={() => applyBatch('disable')}>停用</button>
              <button className="small danger" onClick={() => applyBatch('delete')}>删除</button>
              <button className="ghost small" onClick={clearChecked}>清空选择</button>
            </>}
            <span className="spacer" />
            <button className="small danger" onClick={delDisabled} title="一键删除所有未启用条目">删除未启用</button>
          </div>
          {shown.length === 0 ? (
            <div className="empty-tip" style={{ padding: '20px 0' }}>暂无条目</div>
          ) : groupOrder.map(g => (
            <details key={g} className="wb-group" open>
              <summary className="wb-group-head">
                <input type="checkbox" title="全选本组"
                  checked={groupMap.get(g).length > 0 && groupMap.get(g).every(e => checkedIds.has(e.id))}
                  onClick={ev => { ev.preventDefault(); ev.stopPropagation(); toggleGroupCheck(groupMap.get(g)); }}
                  onChange={() => {}} />
                <span>📦 {g}</span>
                <span className="wb-meta" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {groupMap.get(g).length} 条
                  <button className="small danger" title="删除本组全部条目"
                    onClick={ev => { ev.preventDefault(); ev.stopPropagation(); delGroup(g, groupMap.get(g)); }}>删除分组</button>
                </span>
              </summary>
              {groupMap.get(g).map(e => (
                <div key={e.id}
                  className={`wb-item ${!creating && selId === e.id ? 'active' : ''} ${e.enabled ? '' : 'disabled'}`}
                  onClick={() => { setCreating(false); setDraft(null); setSelId(e.id); }} role="button" tabIndex={0}
                  onKeyDown={ev => ev.key === 'Enter' && (() => { setCreating(false); setDraft(null); setSelId(e.id); })()}>
                  <input type="checkbox" checked={checkedIds.has(e.id)}
                    onClick={ev => ev.stopPropagation()}
                    onChange={() => toggleCheck(e.id)} />
                  <span className="wb-name">{e.name}</span>
                  <span className="wb-meta">
                    {e.always ? '恒定注入' : `关键字×${(e.keywords || []).length}`} · {e.enabled ? '启用' : '停用'}
                  </span>
                </div>
              ))}
            </details>
          ))}
        </div>

        {/* 右：编辑器 */}
        <div className="wb-editor-col">
          {creating || draft ? (
            <div className="card">
              <div className="section-head-row">
                <h3>{creating ? '新增条目' : `编辑：${draft.name}`}</h3>
                <span className="spacer" />
                <button className="ghost small" onClick={() => { setDraft(null); setCreating(false); }}>取消</button>
                <button className="primary small" onClick={saveDraft}>保存</button>
              </div>
              <div className="field"><label>条目名称</label>
                <input type="text" autoFocus value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="field"><label>触发关键字 <span className="lbl-note">逗号分隔</span></label>
                <input type="text" value={(draft.keywords || []).join(',')} onChange={e => setDraft({ ...draft, keywords: e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) })} placeholder="如：黄枫谷,宗门,掌门" />
              </div>
              <div className="field"><label>内容</label>
                <textarea style={{ minHeight: 140 }} value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} />
              </div>
              <div className="field"><label>注入方式</label>
                <div className="btn-row">
                  <button className={!draft.always ? 'primary' : 'ghost'} onClick={() => setDraft({ ...draft, always: false })}>关键字触发</button>
                  <button className={draft.always ? 'primary' : 'ghost'} onClick={() => setDraft({ ...draft, always: true })}>恒定注入</button>
                </div>
              </div>
            </div>
          ) : selId ? (
            (() => {
              const e = entries.find(x => x.id === selId);
              if (!e) return <div className="empty-tip">条目不存在</div>;
              return (
                <div className="card">
                  <div className="section-head-row">
                    <h3>{e.name}</h3>
                    <span className="spacer" />
                    <button className="ghost small" onClick={() => persist(entries.map(x => x.id === e.id ? { ...x, enabled: !x.enabled } : x), e.enabled ? `已停用「${e.name}」` : `已启用「${e.name}」`)}>{e.enabled ? '停用' : '启用'}</button>
                    <button className="ghost small" onClick={() => startEdit(e)}>编辑</button>
                    <button className="danger small" onClick={() => del(e)}>删除</button>
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <span className="tag">{e.always ? '恒定注入' : '关键字触发'}</span>
                    <span className="tag">{e.enabled ? '启用' : '停用'}</span>
                    {(e.keywords || []).map(k => <span className="tag" key={k}>{k}</span>)}
                  </div>
                  <p style={{ whiteSpace: 'pre-wrap', color: 'var(--text-dim)', fontSize: 'var(--fs-md)', lineHeight: 1.8 }}>{e.content || '无内容'}</p>
                </div>
              );
            })()
          ) : (
            <div className="empty-tip">从左侧选择条目查看，或点击「新增条目」创建</div>
          )}
        </div>
      </div>
    </GamePage>
  );
}
