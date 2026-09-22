// ===== 快照 / 天道助手 / 地图 页面（参照原站功能） =====
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api.js';
import {
  buildSnapshotPayload, snapshotSummaryText, applySnapshotPayload, applyAssistantOps, persistCharSnapshots,
  PLOT_STYLES, CHARACTER_GROUPS,
} from '../saveModel.js';
import { snapshotFromCharacter } from '../data/snapshotSchema.js';
import {
  buildAssistantQueryMessages, buildAssistantModifyMessages, parseOpsBlock, ASSISTANT_OP_TYPES,
} from '../engine/promptSystem.js';
import { WORLD_MAP, MAP_POIS, findPoi } from '../data/gameData.js';
import { GamePage } from './GamePages.jsx';
import { SnapshotView } from './CharacterPanel.jsx';
import { useToast, useConfirm, Spinner } from '../ui.jsx';

// 可折叠卡片（快照页当前状态模块）
function FoldCard({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="fold-card">
      <div className="fold-head" onClick={() => setOpen(o => !o)} role="button" tabIndex={0}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setOpen(o => !o)}>
        <h4>{title}</h4><span className="fold-arrow">{open ? '▾' : '▸'}</span>
      </div>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

/* ============================================================
   人生快照（前后端联通的核心页面）
   快照 = 某一时刻的角色/世界/剧情/记忆状态，存于服务端，
   可手动创建、自动创建（每 N 回合）、天道助手修改前备份，
   可查看、改名、删除、恢复。
   ============================================================ */
const SOURCE_TAGS = { manual: '手动', turn: '回合自动', assistant: '助手备份' };

export function SnapshotsPage({ save, updateSave, saveNow, worldbook = [] }) {
  const [list, setList] = useState(null);
  const [selId, setSelId] = useState(null);
  const [detail, setDetail] = useState(null);   // 快照详情（含 payload）
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [renaming, setRenaming] = useState(null); // 改名草稿
  const [busyId, setBusyId] = useState(null);
  const toast = useToast();
  const confirmDlg = useConfirm();

  const load = useCallback(() => {
    api.listSnapshots(save.id).then(setList).catch(() => setList([]));
  }, [save.id]);

  const openDetail = useCallback(async (meta) => {
    setSelId(meta.id); setDetail(null); setLoadingDetail(true);
    try { setDetail(await api.getSnapshot(meta.id)); }
    catch (e) { toast('err', '读取快照失败：' + e.message); setSelId(null); }
    finally { setLoadingDetail(false); }
  }, [toast]);

  useEffect(() => {
    api.listSnapshots(save.id)
      .then(l => { setList(l); if (l[0]) openDetail(l[0]); })
      .catch(() => setList([]));
  }, [save.id, openDetail]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const payload = buildSnapshotPayload(save);
      const meta = await api.createSnapshot(save.id, {
        label: newLabel.trim() || `人生快照 · 第 ${save.turnCount || 0} 回合`,
        source: 'manual',
        summary: snapshotSummaryText(save),
        turnCount: save.turnCount || 0,
        timeLabel: save.world?.timeLabel || '',
        payload,
      });
      toast('ok', `快照「${meta.label}」已创建`);
      setNewLabel('');
      load();
      setSelId(meta.id);
      openDetail(meta);
    } catch (e) { toast('err', '创建快照失败：' + e.message); }
    finally { setCreating(false); }
  };

  const rename = async () => {
    if (!renaming || !renaming.label.trim()) return setRenaming(null);
    try {
      await api.updateSnapshot(selId, { label: renaming.label.trim() });
      toast('ok', '快照已改名');
      setRenaming(null); load();
      if (detail) setDetail({ ...detail, label: renaming.label.trim() });
    } catch (e) { toast('err', '改名失败：' + e.message); }
  };

  const del = async (meta) => {
    if (!await confirmDlg({ title: '删除快照', text: `确定删除快照「${meta.label}」？此操作不可恢复。`, danger: true, okText: '删除' })) return;
    setBusyId(meta.id);
    try {
      await api.deleteSnapshot(meta.id);
      toast('ok', `快照「${meta.label}」已删除`);
      load();
    } catch (e) { toast('err', '删除失败：' + e.message); }
    finally { setBusyId(null); }
  };

  const restore = async () => {
    if (!detail?.payload) return;
    const ok = await confirmDlg({
      title: '恢复快照',
      text: `将存档状态回滚到「${detail.label}」，第 ${detail.turnCount ?? '?'} 回合？\n当前的角色、世界、剧情、记忆与角色快照状态会被覆盖，世界书保留当前版本；故事正文保留。`,
      okText: '恢复',
    });
    if (!ok) return;
    setBusyId(selId);
    try {
      const next = applySnapshotPayload(save, detail.payload, { keepWorldbook: true });
      updateSave(next);
      await saveNow(next);
      toast('ok', `已恢复到「${detail.label}」`);
    } catch (e) { toast('err', '恢复失败：' + e.message); }
    finally { setBusyId(null); }
  };

  // ===== 当前实时状态（全部模块，可折叠） =====
  const b1Snap = save.charSnapshots?.B1 || snapshotFromCharacter(save.character, {
    id: 'B1', kind: 'player', isPlayer: true, locationName: save.world?.location?.name,
  });
  const w = save.world || {};
  const plot = save.plot || {};
  const activeStyleNames = PLOT_STYLES.filter(s => plot.styles?.[s.id]?.selected).map(s => s.name);
  const npcs = save.npcs || [];
  const memories = save.memories || [];
  // 世界书跨存档共用：由 props 传入（不在存档里），这里只做展示

  return (
    <GamePage
      title="快照 · 当前状态"
      actions={<button className="ghost small" onClick={load}>刷新历史快照</button>}
      footer={<span>上半部分是当前实时状态，与 AI 提示词同源；下半部分是历史快照，可作状态回滚点，恢复时故事正文保留。</span>}
    >
      {/* ===== 当前状态：可折叠模块 ===== */}
      <FoldCard title="🕰️ 主角状态 · 实时快照与 AI 同源">
        <SnapshotView snap={b1Snap} save={save} />
      </FoldCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        <FoldCard title="🌏 世界状态">
          <div className="kv"><span className="k">时间</span><span className="v">{w.timeLabel || '？'} · {w.season} · {w.weather}</span></div>
          <div className="kv"><span className="k">地点</span><span className="v" style={{ fontSize: 12 }}>{w.location?.name || '未知'}{w.location?.aura ? ` · 灵气 ${w.location.aura}` : ''}</span></div>
          <div className="kv"><span className="k">回合数</span><span className="v">第 {save.turnCount || 0} 回合</span></div>
          <div className="kv"><span className="k">世界因子</span><span className="v" style={{ fontSize: 12 }}>{(w.factors || []).map(f => f.name).join('、') || '无'}</span></div>
        </FoldCard>

        <FoldCard title="⚡ 剧情演化" defaultOpen={false}>
          <div className="kv"><span className="k">长期方向</span><span className="v" style={{ fontSize: 12 }}>{plot.direction || '未设定'}</span></div>
          <div className="kv"><span className="k">已选风格</span><span className="v" style={{ fontSize: 12 }}>{activeStyleNames.join('、') || '无'}</span></div>
          {plot.guidance && (
            <div style={{ marginTop: 6 }}>
              <div className="hint" style={{ marginBottom: 4 }}>当前剧情指导：</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{plot.guidance}</div>
            </div>
          )}
        </FoldCard>

        <FoldCard title="👥 人物名册" defaultOpen={false}>
          {npcs.length ? npcs.map(n => (
            <div className="kv" key={n.id}><span className="k" style={{ fontSize: 12 }}>{n.name}</span><span className="v" style={{ fontSize: 12 }}>{n.group} · {n.subtitle || n.realm || ''}</span></div>
          )) : <div className="empty-tip" style={{ padding: '8px 0' }}>暂无 NPC</div>}
        </FoldCard>

        <FoldCard title="🧠 叙事记忆" defaultOpen={false}>
          {memories.length ? memories.slice(-12).map((m, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>· [{m.timeLabel || '第' + (m.turn ?? '?') + '回合'}] {m.summary}</div>
          )) : <div className="empty-tip" style={{ padding: '8px 0' }}>暂无叙事记忆</div>}
          {(save.memoryRecaps || []).length > 0 && (
            <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid var(--border, #333)' }}>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>📌 阶段总结 · 每 10 回合</div>
              {save.memoryRecaps.slice(-5).map((r, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>· [第{r.fromTurn ?? '?'}-{r.toTurn ?? '?'}回合] {r.summary}</div>
              ))}
            </div>
          )}
        </FoldCard>

        <FoldCard title="📚 世界书" defaultOpen={false}>
          {worldbook.length ? (() => {
            // 按导入批次分组折叠展示
            const order = [];
            const map = new Map();
            for (const e of worldbook) {
              const g = e.source || '未分组';
              if (!map.has(g)) { map.set(g, []); order.push(g); }
              map.get(g).push(e);
            }
            return order.map(g => (
              <details key={g} className="wb-group" open>
                <summary className="wb-group-head"><span>📦 {g}</span><span className="wb-meta">{map.get(g).length} 条</span></summary>
                {map.get(g).map(e => (
                  <div className="kv" key={e.id}>
                    <span className="k" style={{ fontSize: 12 }}>{e.name}</span>
                    <span className="v" style={{ fontSize: 12 }}>{e.always ? '恒定注入' : `关键字×${(e.keywords || []).length}`} · {e.enabled ? '启用' : '停用'}</span>
                  </div>
                ))}
              </details>
            ));
          })() : <div className="empty-tip" style={{ padding: '8px 0' }}>暂无世界书条目</div>}
        </FoldCard>

        <FoldCard title="📜 人物生平" defaultOpen={false}>
          {(save.plotProgress || []).length ? (save.plotProgress || []).slice(-10).map((p, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>· [{p.timeLabel || '第' + (p.turn ?? '?') + '回合'}] {p.text}</div>
          )) : <div className="empty-tip" style={{ padding: '8px 0' }}>暂无生平记录</div>}
        </FoldCard>
      </div>

      {/* ===== 历史快照时间轴 ===== */}
      <FoldCard title="💾 人生快照 · 历史回滚点" defaultOpen={false}>
      <div className="snap-layout">
        {/* 左：快照时间轴 */}
        <div className="snap-list-col">
          <div className="snap-create">
            <input type="text" value={newLabel} onChange={e => setNewLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && create()}
              placeholder="快照备注 · 可留空…" aria-label="快照备注" />
            <button className="primary small" onClick={create} disabled={creating}>
              {creating ? <Spinner /> : '＋ 落此一照'}
            </button>
          </div>
          {list === null ? (
            <div className="loading-tip"><Spinner /> 读取快照列表…</div>
          ) : list.length === 0 ? (
            <div className="empty-tip" style={{ padding: '24px 0' }}>暂无快照<br /><span className="hint">手动创建，或到「设置 → 故事设定」开启每 N 回合自动快照</span></div>
          ) : (
            <div className="snap-timeline">
              {list.map(m => (
                <div key={m.id} className={`snap-item ${selId === m.id ? 'active' : ''}`}
                  onClick={() => openDetail(m)} role="button" tabIndex={0}
                  onKeyDown={e => e.key === 'Enter' && openDetail(m)}>
                  <span className="snap-dot" aria-hidden="true" />
                  <div className="snap-item-main">
                    <div className="snap-item-label">{m.label}</div>
                    <div className="snap-item-meta">
                      <span className={`tag ${m.source}`}>{SOURCE_TAGS[m.source] || m.source}</span>
                      第 {m.turnCount ?? '?'} 回合 · {m.timeLabel || new Date(m.createdAt).toLocaleString('zh-CN')}
                    </div>
                    {m.summary && <div className="snap-item-summary">{m.summary}</div>}
                  </div>
                  <button className="danger small" title="删除"
                    onClick={e => { e.stopPropagation(); del(m); }} disabled={busyId === m.id}>✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 右：快照详情 */}
        <div className="snap-detail-col">
          {loadingDetail ? (
            <div className="loading-tip"><Spinner /> 读取快照详情…</div>
          ) : !detail ? (
            <div className="empty-tip">从左侧选择快照查看详情</div>
          ) : (
            <div className="snap-detail">
              <div className="section-head-row">
                {renaming ? (
                  <>
                    <input type="text" autoFocus value={renaming.label}
                      onChange={e => setRenaming({ ...renaming, label: e.target.value })}
                      onKeyDown={e => e.key === 'Enter' && rename()} />
                    <button className="primary small" onClick={rename}>保存</button>
                    <button className="ghost small" onClick={() => setRenaming(null)}>取消</button>
                  </>
                ) : (
                  <>
                    <h3 style={{ margin: 0 }}>{detail.label}</h3>
                    <span className="tag">{SOURCE_TAGS[detail.source] || detail.source}</span>
                    <span className="spacer" />
                    <button className="ghost small" onClick={() => setRenaming({ label: detail.label })}>改名</button>
                    <button className="primary small" onClick={restore} disabled={busyId === selId}>
                      {busyId === selId ? <Spinner /> : '恢复此快照'}
                    </button>
                  </>
                )}
              </div>
              <SnapPayloadView payload={detail.payload} summary={detail.summary} />
            </div>
          )}
        </div>
      </div>
      </FoldCard>
    </GamePage>
  );
}

// 快照载荷只读视图
function SnapPayloadView({ payload, summary }) {
  const p = payload || {};
  const c = p.character || {};
  const w = p.world || {};
  const plot = p.plot || {};
  const styles = PLOT_STYLES.filter(s => plot.styles?.[s.id]?.selected).map(s => s.name);
  return (
    <div className="snap-payload">
      {summary && <div className="snap-summary-line">{summary}</div>}
      <div className="card">
        <h4>主角状态</h4>
        <div className="kv"><span className="k">姓名</span><span className="v">{c.name || '？'}</span></div>
        <div className="kv"><span className="k">境界 / 灵根</span><span className="v">{c.realm?.name || '凡人'} · {c.root ? (c.root.name || '无灵根') : '无灵根'}</span></div>
        <div className="kv"><span className="k">年龄</span><span className="v">{c.age ?? '?'} 岁</span></div>
        <div className="kv"><span className="k">特质 / 技能</span><span className="v">{(c.traits || []).map(t => t.name).join('、') || '无'} ｜ {(c.skills || []).map(s => s.name).join('、') || '无'}</span></div>
        <div className="kv"><span className="k">物品</span><span className="v">{(c.items || []).map(i => `${i.name}×${i.count || 1}`).join('、') || '无'}</span></div>
      </div>
      <div className="card">
        <h4>世界状态</h4>
        <div className="kv"><span className="k">时间</span><span className="v">{w.timeLabel || '？'} · {w.season} · {w.weather}</span></div>
        <div className="kv"><span className="k">地点</span><span className="v">{w.location?.name || '未知'}</span></div>
        <div className="kv"><span className="k">世界因子</span><span className="v">{(w.factors || []).map(f => f.name).join('、') || '无'}</span></div>
      </div>
      <div className="card">
        <h4>剧情与记忆</h4>
        <div className="kv"><span className="k">长期方向</span><span className="v">{plot.direction || '未设定'}</span></div>
        <div className="kv"><span className="k">已选风格</span><span className="v">{styles.join('、') || '无'}</span></div>
        <div className="kv"><span className="k">叙事记忆</span><span className="v">{(p.memories || []).length} 条</span></div>
        <div className="kv"><span className="k">人物名册</span><span className="v">{(p.npcs || []).length} 人</span></div>
      </div>
      {(p.storyTail || []).length > 0 && (
        <div className="card">
          <h4>落照时剧情 · 尾 3 节节选</h4>
          {p.storyTail.map((b, i) => (
            <div className="snap-story-tail" key={i}>
              <span className="tag">{b.role === 'user' ? '玩家' : '天道'} · 第 {b.turn} 节</span>
              <span>{(b.text || '').slice(0, 120)}{(b.text || '').length > 120 ? '…' : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   天道助手（查询 / 修改双模式，参照原站）
   查询：基于存档数据问答；修改：自然语言 → 变更提案 → 人工确认应用
   ============================================================ */
export function AssistantPage({ save, updateSave, saveNow, mode }) {
  const [tab, setTab] = useState('query'); // query | modify
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]); // { q, mode, answer?, ops?, checked? }
  const [manualOps, setManualOps] = useState(null); // 本地模式手动提案
  const toast = useToast();
  const confirmDlg = useConfirm();
  const scrollRef = useRef(null);
  const aiMode = mode === 'ai';

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [history, manualOps]);

  const ask = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput('');
    setBusy(true);
    const entry = { q, mode: tab, answer: null, ops: null, checked: null };
    setHistory(h => [...h, entry]);
    try {
      if (tab === 'query') {
        if (aiMode) {
          const r = await api.aiGenerate(buildAssistantQueryMessages(save, q));
          entry.answer = r.text || '未返回内容';
        } else {
          entry.answer = localQuery(save, q);
        }
      } else {
        if (aiMode) {
          const r = await api.aiGenerate(buildAssistantModifyMessages(save, q));
          const ops = parseOpsBlock(r.text);
          entry.ops = ops;
          entry.checked = ops ? ops.map(() => true) : null;
          entry.answer = ops ? null : (r.text || '未解析出变更提案');
        } else {
          // 本地模式：给出手动提案模板
          entry.answer = '本地旁白模式不支持自动提案，可使用下方「手动提案」填写操作后应用。';
          setManualOps(manualOps || { type: 'addItem', name: '', count: 1, desc: '', path: '', value: '', field: '' });
        }
      }
    } catch (e) {
      entry.answer = '请求失败：' + e.message;
    } finally {
      setHistory(h => h.map(x => x === entry ? { ...entry } : x));
      setBusy(false);
    }
  };

  const applyOps = async (entry) => {
    const ops = (entry.ops || []).filter((_, i) => entry.checked?.[i]);
    if (!ops.length) return toast('err', '请至少勾选一条操作');
    const ok = await confirmDlg({
      title: '应用变更提案',
      text: `将应用 ${ops.length} 条操作到当前存档。\n应用前会自动创建一份「助手备份」快照，可随时回滚。`,
      okText: '应用',
    });
    if (!ok) return;
    setBusy(true);
    try {
      // 先备份（快照联通：修改前自动落照）
      await api.createSnapshot(save.id, {
        label: `助手备份 · ${new Date().toLocaleTimeString('zh-CN')}`,
        source: 'assistant',
        summary: `应用前：${snapshotSummaryText(save)}`,
        turnCount: save.turnCount || 0,
        timeLabel: save.world?.timeLabel || '',
        payload: buildSnapshotPayload(save),
      });
      const { save: next, applied, rejected } = applyAssistantOps(save, ops);
      updateSave(next);
      await saveNow(next);
      // 移除角色：同步删除服务端快照文件（否则下次演化/名册补全会用残留快照复活角色）
      ops.filter(o => o.type === 'removeNpc' && o.name).forEach(o => {
        const cid = Object.keys(save.charSnapshots || {}).find(k => k !== 'B1' && (save.charSnapshots[k]?.identity?.name === o.name || k === o.name));
        if (cid) api.deleteCharSnapshot(save.id, cid).catch(() => {});
      });
      // 快照修改：同步到服务端角色快照存储（否则下次演化会用旧快照覆盖）
      if (ops.some(o => o.type === 'patchSnapshot' || o.type === 'removeNpc')) persistCharSnapshots(save.id, next.charSnapshots || {}).catch(() => {});
      entry.applied = applied;
      entry.rejected = rejected || [];
      setHistory(h => h.map(x => x === entry ? { ...entry } : x));
      toast('ok', applied.length ? `已应用 ${applied.length} 条变更` : '没有产生实际变更');
    } catch (e) {
      toast('err', '应用失败：' + e.message);
    } finally { setBusy(false); }
  };

  const applyManual = async () => {
    const op = buildManualOp(manualOps);
    if (!op) return toast('err', '请填写完整的操作内容');
    await applyOps({ ops: [op], checked: [true], q: `手动提案：${manualOps.type}`, mode: 'modify', answer: null, applied: null, __manual: true });
    setManualOps({ type: 'addItem', name: '', count: 1, desc: '', path: '', value: '', field: '' });
  };

  return (
    <GamePage
      title="天道助手"
      actions={
        <div className="seg-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'query'} className={tab === 'query' ? 'active' : ''} onClick={() => setTab('query')}>查询模式</button>
          <button role="tab" aria-selected={tab === 'modify'} className={tab === 'modify' ? 'active' : ''} onClick={() => setTab('modify')}>修改模式</button>
        </div>
      }
      footer={<span>{tab === 'query' ? '查询模式：基于当前存档数据回答问题，不会改动任何内容。' : '修改模式：描述想要的修改 → 生成变更提案 → 勾选确认后应用；应用前自动创建备份快照。'}</span>}
    >
      <div className="assistant-layout">
        <div className="assistant-chat" ref={scrollRef}>
          {history.length === 0 && (
            <div className="empty-tip" style={{ padding: '32px 0' }}>
              {tab === 'query'
                ? <>向天道询问你的故事，例如：<br />「我现在有哪些物品？」「李默是什么人？」「最近的剧情进展如何？」</>
                : <>描述想要的修改，例如：<br />「给主角添加特质『剑心通明』」「把天气改成雪」「新增一位神秘老者，是离场人物」</>}
            </div>
          )}
          {history.map((entry, idx) => (
            <div className="assistant-item" key={idx}>
              <div className="assistant-q"><span className="tag">{entry.mode === 'query' ? '问' : '令'}</span>{entry.q}</div>
              {entry.answer && <div className="assistant-a">{entry.answer}</div>}
              {entry.ops && (
                <div className="assistant-ops">
                  {entry.ops.length === 0 ? (
                    <div className="hint">提案为空：该需求无法用受支持的操作表达。</div>
                  ) : entry.ops.map((op, i) => (
                    <label className="op-row" key={i}>
                      <input type="checkbox" checked={!!entry.checked?.[i]} disabled={!!entry.applied}
                        onChange={e => {
                          const checked = [...(entry.checked || [])];
                          checked[i] = e.target.checked;
                          const next = { ...entry, checked };
                          setHistory(h => h.map(x => x === entry ? next : x));
                        }} />
                      <code>{opSummary(op)}</code>
                    </label>
                  ))}
                  {entry.applied ? (
                    <div className="assistant-applied">
                      <span className="tag ok">已应用</span>
                      {entry.applied.map((a, i) => <div key={i}>· {a}</div>)}
                      {(entry.rejected || []).length > 0 && entry.rejected.map((a, i) => (
                        <div key={'r' + i} style={{ color: 'var(--danger, #c0392b)' }}>· {a}</div>
                      ))}
                    </div>
                  ) : (
                    <button className="primary small" disabled={busy} onClick={() => applyOps(entry)}>
                      应用勾选的变更 {((entry.checked || []).filter(Boolean)).length}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="loading-tip"><Spinner /> 天道推演中…</div>}
        </div>

        {/* 修改模式：本地手动提案 / 操作类型说明 */}
        {tab === 'modify' && (
          <div className="assistant-side">
            {!aiMode && manualOps && (
              <div className="card">
                <h4>手动提案</h4>
                <div className="field">
                  <label>操作类型</label>
                  <select value={manualOps.type} onChange={e => setManualOps({ ...manualOps, type: e.target.value })}>
                    {ASSISTANT_OP_TYPES.map(t => <option key={t.type} value={t.type}>{t.type} · {t.desc}</option>)}
                  </select>
                </div>
                {manualOps.type === 'set' ? (
                  <>
                    <div className="field"><label>字段路径</label><input type="text" value={manualOps.path} onChange={e => setManualOps({ ...manualOps, path: e.target.value })} placeholder="如 character.age" /></div>
                    <div className="field"><label>新值 <span className="lbl-note">JSON 或文本</span></label><input type="text" value={manualOps.value} onChange={e => setManualOps({ ...manualOps, value: e.target.value })} placeholder='如 19 或 "雪"' /></div>
                  </>
                ) : manualOps.type === 'setNpcField' ? (
                  <>
                    <div className="field"><label>角色名</label><input type="text" value={manualOps.name} onChange={e => setManualOps({ ...manualOps, name: e.target.value })} /></div>
                    <div className="field"><label>字段</label><input type="text" value={manualOps.field} onChange={e => setManualOps({ ...manualOps, field: e.target.value })} placeholder="realm / subtitle / group" /></div>
                    <div className="field"><label>新值</label><input type="text" value={manualOps.value} onChange={e => setManualOps({ ...manualOps, value: e.target.value })} /></div>
                  </>
                ) : (
                  <>
                    <div className="field"><label>名称</label><input type="text" value={manualOps.name} onChange={e => setManualOps({ ...manualOps, name: e.target.value })} /></div>
                    {manualOps.type === 'addItem' && <div className="field"><label>数量</label><input type="number" min="1" value={manualOps.count} onChange={e => setManualOps({ ...manualOps, count: Number(e.target.value) || 1 })} /></div>}
                    {manualOps.type === 'addNpc' && (
                      <div className="field"><label>分组</label>
                        <select value={manualOps.group || '在场人物'} onChange={e => setManualOps({ ...manualOps, group: e.target.value })}>
                          {CHARACTER_GROUPS.filter(g => g !== '主角').map(g => <option key={g}>{g}</option>)}
                        </select>
                      </div>
                    )}
                    {['addTrait', 'addItem', 'addNpc'].includes(manualOps.type) && (
                      <div className="field"><label>描述</label><input type="text" value={manualOps.desc} onChange={e => setManualOps({ ...manualOps, desc: e.target.value })} /></div>
                    )}
                  </>
                )}
                <button className="primary small" onClick={applyManual} disabled={busy}>应用手动提案</button>
              </div>
            )}
            <div className="card">
              <h4>可用操作类型</h4>
              {ASSISTANT_OP_TYPES.map(t => (
                <div className="kv" key={t.type}><span className="k"><code>{t.type}</code></span><span className="v" style={{ fontSize: 12 }}>{t.desc}</span></div>
              ))}
              <div className="hint" style={{ marginTop: 8 }}>所有应用都会先创建「助手备份」快照，可在快照页回滚。</div>
            </div>
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div className="assistant-input-row">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(); } }}
          placeholder={tab === 'query' ? '向天道询问存档相关的问题… Ctrl+Enter 发送' : '描述你想对存档做的修改… Ctrl+Enter 发送'}
          aria-label="天道助手输入"
        />
        <button className="primary" onClick={ask} disabled={busy || !input.trim()}>发送</button>
      </div>
    </GamePage>
  );
}

function buildManualOp(m) {
  const op = { type: m.type };
  if (m.type === 'set') {
    if (!m.path.trim()) return null;
    let v = m.value;
    try { v = JSON.parse(m.value); } catch { /* 当作文本 */ }
    op.path = m.path.trim(); op.value = v;
  } else if (m.type === 'setNpcField') {
    if (!m.name.trim() || !m.field.trim()) return null;
    let v = m.value;
    try { v = JSON.parse(m.value); } catch { /* 当作文本 */ }
    op.name = m.name.trim(); op.field = m.field.trim(); op.value = v;
  } else {
    if (!m.name.trim()) return null;
    op.name = m.name.trim();
    if (m.type === 'addItem') op.count = Number(m.count) || 1;
    if (m.desc?.trim()) op.desc = m.desc.trim();
    if (m.type === 'addNpc') op.group = m.group || '在场人物';
  }
  return op;
}

function opSummary(op) {
  switch (op.type) {
    case 'set': return `设置 ${op.path} = ${JSON.stringify(op.value)}`;
    case 'addTrait': return `新增特质「${op.name}」${op.desc ? ` · ${op.desc}` : ''}`;
    case 'addItem': return `添加物品「${op.name}」×${op.count || 1}${op.desc ? ` · ${op.desc}` : ''}`;
    case 'addNpc': return `新增角色「${op.name}」· ${op.group || '在场人物'}${op.subtitle ? ` · ${op.subtitle}` : ''}`;
    case 'removeNpc': return `移除角色「${op.name}」`;
    case 'setNpcField': return `角色「${op.name}」.${op.field} = ${JSON.stringify(op.value)}`;
    case 'patchSnapshot': return `快照「${op.charName || op.charId}」.${op.path} = ${JSON.stringify(op.value)}`;
    default: return JSON.stringify(op);
  }
}

// 本地查询（离线兜底：在存档数据里做关键词检索）
function localQuery(save, q) {
  const kws = q.split(/[\s，。？?！!、]+/).filter(k => k.length >= 2);
  if (!kws.length) kws.push(q);
  const hits = [];
  const c = save.character;
  const charLine = `主角 ${c.name}：${c.race?.name} · ${c.realm?.name} · ${c.age}岁 · 特质[${(c.traits || []).map(t => t.name).join('/') || '无'}] · 物品[${(c.items || []).map(i => i.name).join('/') || '无'}]`;
  if (kws.some(k => charLine.includes(k))) hits.push(charLine);
  for (const n of save.npcs || []) {
    const line = `${n.name} · ${n.group} · ${n.subtitle || n.realm}`;
    if (kws.some(k => line.includes(k))) hits.push(line);
  }
  const wLine = `世界：${save.world?.timeLabel} · ${save.world?.location?.name} · ${save.world?.weather} · 因子[${(save.world?.factors || []).map(f => f.name).join('/') || '无'}]`;
  if (kws.some(k => wLine.includes(k))) hits.push(wLine);
  const mems = (save.memories || []).filter(m => kws.some(k => (m.summary || '').includes(k)));
  if (mems.length) hits.push(...mems.slice(-3).map(m => `[记忆] ${m.summary}`));
  if (!hits.length) {
    return `本地检索未命中「${q}」。\n当前概要：${charLine}\n${wLine}\n接入 AI 接口后可获得更智能的问答`;
  }
  return '本地检索结果：\n' + hits.join('\n');
}

/* ============================================================
   世界地图（参照原站：4000×4000 坐标系 + 区域多边形 + 兴趣点）
   支持缩放 / 拖拽平移 / 定位当前位置
   ============================================================ */
export function MapPage({ save, updateSave, saveNow }) {
  const { width: MW, height: MH } = WORLD_MAP;
  const curPoi = findPoi(save.world?.location?.name);
  const [selPoi, setSelPoi] = useState(null);
  const [filterRegion, setFilterRegion] = useState('全部');
  const [view, setView] = useState(() => initialView(curPoi));
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const toast = useToast();

  const regions = ['全部', ...WORLD_MAP.main_regions.map(r => r.name)];
  const shownPois = filterRegion === '全部' ? MAP_POIS : MAP_POIS.filter(p => p.region === filterRegion);

  // ---- 缩放 / 平移 ----
  const zoomAt = (factor, cx, cy) => {
    setView(v => {
      const w = Math.min(MW, Math.max(300, v.w * factor));
      const h = w / VIEW_ASPECT;
      const kx = (cx - v.x) / v.w, ky = (cy - v.y) / v.h;
      return { x: cx - kx * w, y: cy - ky * h, w, h };
    });
  };
  const onWheel = (e) => {
    e.preventDefault();
    const rect = svgRef.current.getBoundingClientRect();
    const cx = view.x + ((e.clientX - rect.left) / rect.width) * view.w;
    const cy = view.y + ((e.clientY - rect.top) / rect.height) * view.h;
    zoomAt(e.deltaY > 0 ? 1.2 : 1 / 1.2, cx, cy);
  };
  const onPointerDown = (e) => {
    dragRef.current = { px: e.clientX, py: e.clientY, view };
    svgRef.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const rect = svgRef.current.getBoundingClientRect();
    const scale = view.w / rect.width;
    setView({ ...d.view, x: d.view.x - (e.clientX - d.px) * scale, y: d.view.y - (e.clientY - d.py) * scale });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const locate = () => {
    if (curPoi) { setView(centeredView(curPoi)); setSelPoi(curPoi); toast('ok', `已定位：${curPoi.fullName}`); }
    else toast('err', `当前位置「${save.world?.location?.name || '未知'}」不在地图兴趣点中`);
  };

  const travel = async (poi) => {
    const next = { ...save, world: { ...save.world, location: { ...(save.world.location || {}), name: poi.fullName } } };
    updateSave(next);
    await saveNow(next);
    toast('ok', `主角位置已改为「${poi.fullName}」`);
  };

  return (
    <GamePage
      title="世界地图"
      actions={<>
        <select value={filterRegion} onChange={e => setFilterRegion(e.target.value)} aria-label="筛选区域">
          {regions.map(r => <option key={r}>{r}</option>)}
        </select>
        <button className="ghost small" onClick={locate}>定位当前位置</button>
        <button className="ghost small" onClick={() => setView(initialView(curPoi))}>重置视图</button>
      </>}
      footer={<span>坐标系 4000×4000，1 坐标 = 10 公里。滚轮缩放 · 拖拽平移 · 点击兴趣点查看详情。移动需通过故事内行动或天道助手完成，此处仅做位置登记。</span>}
    >
      <div className="map-layout">
        <div className="map-svg-wrap">
          <svg
            ref={svgRef}
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            role="application"
            aria-label="世界地图"
          >
            {/* 海洋底 */}
            <rect x={0} y={0} width={MW} height={MH} fill="rgba(51, 96, 143, 0.18)" />
            {/* 地形 */}
            {WORLD_MAP.terrains.filter(t => t.type === 'land').map((t, i) => (
              <polygon key={i} points={t.points.map(p => p.join(',')).join(' ')} fill={t.color} />
            ))}
            {/* 大区域 */}
            {WORLD_MAP.main_regions.map(r => (
              <g key={r.name}>
                <polygon points={r.points.map(p => p.join(',')).join(' ')} fill={r.color} fillOpacity={0.4}
                  stroke={r.color} strokeWidth={3} strokeOpacity={0.8} />
                <text x={centroid(r.points)[0]} y={centroid(r.points)[1]}
                  textAnchor="middle" className="map-region-name">{r.name}</text>
              </g>
            ))}
            {/* 兴趣点 */}
            {shownPois.map(p => {
              const isCur = curPoi && (curPoi.name === p.name);
              const isSel = selPoi?.name === p.name;
              return (
                <g key={p.name} className="map-poi" onClick={() => setSelPoi(p)}>
                  {isCur && <circle cx={p.x} cy={p.y} r={55} fill="none" stroke="#c5a95e" strokeWidth={5} className="map-cur-ring" />}
                  <circle cx={p.x} cy={p.y} r={isCur ? 34 : 24}
                    fill={isCur ? '#c5a95e' : isSel ? '#7c5f18' : '#fffdf8'}
                    stroke={isCur ? '#7c5f18' : '#8f7426'} strokeWidth={5} />
                  <text x={p.x} y={p.y - 55} textAnchor="middle" className={`map-poi-name ${isCur ? 'cur' : ''}`}>{p.name}</text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* 右侧信息栏 */}
        <div className="map-side">
          <div className="card">
            <h4>当前位置</h4>
            <div className="kv"><span className="k">地点</span><span className="v" style={{ fontSize: 12 }}>{save.world?.location?.name || '未知'}</span></div>
            <div className="kv"><span className="k">区域</span><span className="v">{curPoi?.region || '未收录'}</span></div>
            <div className="kv"><span className="k">灵气</span><span className="v">{save.world?.location?.aura ?? curPoi?.aura ?? '—'}</span></div>
          </div>
          {selPoi ? (
            <div className="card">
              <div className="section-head-row">
                <h4>{selPoi.name}</h4>
                <span className="spacer" />
                <button className="ghost small" onClick={() => setView(centeredView(selPoi))}>居中</button>
              </div>
              <div className="kv"><span className="k">全名</span><span className="v" style={{ fontSize: 12 }}>{selPoi.fullName}</span></div>
              <div className="kv"><span className="k">区域</span><span className="v">{selPoi.region}</span></div>
              <div className="kv"><span className="k">灵气浓度</span><span className="v">{selPoi.aura}</span></div>
              <p style={{ fontSize: 13, color: 'var(--text-dim)', margin: '8px 0' }}>{selPoi.desc}</p>
              {curPoi?.name !== selPoi.name && (
                <button className="small" onClick={() => travel(selPoi)}>登记为主角位置</button>
              )}
              {(() => {
                const region = WORLD_MAP.main_regions.find(r => r.name === selPoi.region);
                return region ? <p className="hint" style={{ marginTop: 8 }}>{region.name}：{region.description}</p> : null;
              })()}
            </div>
          ) : (
            <div className="empty-tip" style={{ padding: '16px 0' }}>点击地图上的兴趣点查看详情</div>
          )}
          <div className="card">
            <h4>兴趣点 <span className="tab-cnt">{shownPois.length}</span></h4>
            <div className="map-poi-list">
              {shownPois.map(p => (
                <button key={p.name} className={`map-poi-row ${selPoi?.name === p.name ? 'active' : ''} ${curPoi?.name === p.name ? 'cur' : ''}`}
                  onClick={() => { setSelPoi(p); setView(centeredView(p)); }}>
                  <span>{curPoi?.name === p.name ? '◎ ' : '· '}{p.name}</span>
                  <span className="hint">{p.region} · 灵气 {p.aura}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </GamePage>
  );
}

const VIEW_ASPECT = 4 / 3;
function centeredView(poi) {
  const w = 900;
  return { x: poi.x - w / 2, y: poi.y - w / VIEW_ASPECT / 2, w, h: w / VIEW_ASPECT };
}
function initialView(curPoi) {
  if (curPoi) return centeredView(curPoi);
  // 默认视野：天南一带
  const w = 1600;
  return { x: 2400, y: 1200, w, h: w / VIEW_ASPECT };
}
// 多边形质心（区域名标注位置）
function centroid(points) {
  const n = points.length;
  const sx = points.reduce((a, p) => a + p[0], 0) / n;
  const sy = points.reduce((a, p) => a + p[1], 0) / n;
  return [sx, sy];
}
