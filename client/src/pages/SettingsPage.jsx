import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { useToast, useConfirm, Spinner } from '../ui.jsx';
import {
  DEFAULT_BIO_TEMPLATE, DEFAULT_MEMORY_TEMPLATE, STYLE_PRESETS,
  PRESET_ROLE_META, presetRoleZh, reorderPresetPrompts, presetPlaceholderUsage,
} from '../engine/promptSystem.js';
import { createDragScroller, dropIndexFromRows } from '../engine/dragAutoScroll.js';
import { MORTAL_PROTOCOL_META } from '../data/mortalProtocols.js';
import { TABLE_META, serializeNumericTuning, DEFAULT_NUMERIC_TUNING } from '../data/numericTuning.js';
import { DEFAULT_COLOR_PALETTE, normalizePalette, makeColorResolver } from '../data/colorPalette.js';
// 字体偏好：界面 / 标题 / 正文 三处分别可改。存在本机 localStorage（不进 settings.json）——
// 字体是本机资源，跨设备同步没有意义；启动即生效也要求它不能等服务端返回。
import { FONT_SLOTS, FONT_CHOICES, readFonts, applyFonts, customNameOf, builtinStackOf } from '../fontPrefs.js';
import { LAYOUT_BLOCKS, LAYOUT_ZONES, normalizePromptLayout, moveWithinZone, moveToZone, layoutBlockMeta } from '../engine/promptLayout.js';
import {
  DEFAULT_ENDPOINT, newEndpointId, normalizeEndpointList, findEndpoint,
  endpointSummary, storyEndpointOf, snapshotEndpointOf,
} from '../data/apiEndpoints.js';

// 二级导航（对应原站设置分组）
const SUBNAV = [
  { id: 'display', name: '显示与字体', icon: 'ㅤ', desc: '正文字号、行距与阅读宽度' },
  { id: 'api', name: 'API 配置', icon: 'ㅤ', desc: '接口库与正文 / 快照通道' },
  { id: 'textRules', name: '正文规则与文风', icon: 'ㅤ', desc: '字数、文风、人称与运行时协议' },
  { id: 'battle', name: '战斗模式', icon: 'ㅤ', desc: '程序接管：15×15 战棋、行动条与结算' },
  { id: 'injectOrder', name: '注入顺序', icon: 'ㅤ', desc: '各区块的位置与分区，决定缓存命中率' },
  { id: 'storyRules', name: '故事设定与数值规则', icon: 'ㅤ', desc: '快照与数值规则表' },
  { id: 'storyPreset', name: '正文预设', icon: 'ㅤ', desc: '导入 SillyTavern 风格预设 JSON' },
  { id: 'snapshotRules', name: '快照编辑规则', icon: 'ㅤ', desc: '导入物品管理.json 等演化预设' },
  { id: 'bio', name: '人物生平压缩', icon: 'ㅤ', desc: '生平条目压缩模板' },
  { id: 'memory', name: '故事记忆设置', icon: 'ㅤ', desc: '叙事记忆的生成与注入' },
];

const DEFAULT_FORM = () => ({
  fontSize: 16,
  lineHeight: 1.95,
  textRules: { minWords: 200, maxWords: 400, style: 'fanren', customStyle: '', colorPalette: null },
  // 提示词各区块的排布；null = 用默认（恒定基座 → 变化区 → 末尾契约）
  promptLayout: null,
  // 接口库（正文 / 快照两个通道各自选用）；落盘在 settings.json，跨存档共用
  apiEndpoints: [],
  storyEndpointId: '',
  snapshotEndpointId: '',
  storyMaxTokens: 32768,
  story: { narrativePerson: 'second', autoSnapshotEvery: 10 },
  prompts: null,
  storyPresets: [], // 导入的 SillyTavern 风格预设
  evolutionRules: null,
  evolutionPresets: [],
  bio: { threshold: 30, template: '' },
  bioPresets: [], // 导入的生平压缩预设（类似 default.json）
  memory: { enabled: true, summaryLen: 60, keepSummaries: 40, injectSummaries: 10, recapEnabled: true, recapEvery: 10, recapLen: 150, injectRecaps: 5, keepRecaps: 10 },
  // 战斗模式：'manual' = 程序接管（AI 只报战场布置，玩家亲手打）；
  //           其它 = 关闭（AI 自己在 <think> 里推演并给 <card>）
  battle: { mode: 'auto', floorHpPercent: 0 },
});

// 系统设置：完整页面 + 二级导航（initialTab 可指定初始分页）
// 全自动保存：改动停止 700ms 后落库；点「返回」会先等写完再离开；中途切页也有兜底写盘。
// 不再有「保存设置」按钮。
export default function SettingsPage({ settings, onSaved, onBack, initialTab }) {
  const [tab, setTab] = useState(initialTab || 'storyPreset');
  const [form, setForm] = useState(() => ({
    ...DEFAULT_FORM(),
    ...settings,
    apiEndpoints: normalizeEndpointList(settings?.apiEndpoints),
    storyEndpointId: String(settings?.storyEndpointId || ''),
    snapshotEndpointId: String(settings?.snapshotEndpointId || ''),
  }));
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false); // 正在写盘
  const [dirty, setDirty] = useState(false);   // 有改动尚未落库
  const toast = useToast();

  const formRef = useRef(form);
  const revRef = useRef(0);       // 改动版本号
  const savedRevRef = useRef(0);  // 已落库版本号
  const timerRef = useRef(null);
  const queueRef = useRef(Promise.resolve()); // 写盘串行队列：并发也按顺序落库，且永远提交最新表单
  const mountedRef = useRef(true);
  const onSavedRef = useRef(onSaved);
  const toastRef = useRef(toast);
  onSavedRef.current = onSaved;
  toastRef.current = toast;

  const commit = useCallback(() => {
    const rev = revRef.current;
    queueRef.current = queueRef.current.catch(() => {}).then(async () => {
      if (mountedRef.current) setSaving(true);
      try {
        const s = await api.putSettings(formRef.current);
        savedRevRef.current = Math.max(savedRevRef.current, rev);
        onSavedRef.current?.(s);
        if (mountedRef.current) {
          setSavedAt(Date.now());
          setSaving(false);
          setDirty(savedRevRef.current < revRef.current);
        }
      } catch (e) {
        if (mountedRef.current) { setSaving(false); toastRef.current('err', '自动保存失败：' + e.message); }
      }
    });
    return queueRef.current;
  }, []);

  // 所有改动的唯一入口：更新本地表单 + 排一次自动保存（预设类操作 immediate=true 立即落库）
  const push = useCallback((next, immediate = false) => {
    formRef.current = next;
    setForm(next);
    revRef.current += 1;
    setDirty(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (immediate) commit();
    else timerRef.current = setTimeout(() => commit(), 700);
  }, [commit]);

  const set = useCallback((k, v) => {
    const prev = formRef.current;
    push({ ...prev, [k]: typeof v === 'function' ? v(prev[k]) : v });
  }, [push]);

  // 改完即存（正文预设 / 快照演化预设用，不等防抖）
  const setAndSave = useCallback((k, v) => {
    const prev = formRef.current;
    push({ ...prev, [k]: typeof v === 'function' ? v(prev[k]) : v }, true);
  }, [push]);

  // 返回：先把未落库的改动写完，再离开（避免返回后父级重新拉取到旧值）
  const handleBack = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (savedRevRef.current < revRef.current) await commit();
    onBack?.();
  }, [commit, onBack]);

  // 其他方式离开页面（点左侧导航切页等）：兜底把未落库的改动写出去
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      if (savedRevRef.current < revRef.current) {
        api.putSettings(formRef.current).then(s => onSavedRef.current?.(s)).catch(() => {});
      }
    };
  }, []);

  const saveTip = saving ? '保存中…' : dirty ? '待保存…' : savedAt ? `已自动保存 · ${new Date(savedAt).toLocaleTimeString('zh-CN')}` : '修改后自动保存';

  return (
    <div className="settings-page">
      {/* 二级导航 */}
      <aside className="settings-subnav">
        <div className="settings-subnav-title">系统设置</div>
        {SUBNAV.map(item => (
          <button key={item.id} className={`subnav-item ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>
            <span className="subnav-name">{item.name}</span>
            <span className="subnav-desc">{item.desc}</span>
          </button>
        ))}
      </aside>

      {/* 内容区 */}
      <div className="settings-main">
        <div className="settings-main-body">
          {tab === 'display' && <DisplayTab form={form} set={set} />}
          {tab === 'api' && <ApiTab form={form} set={set} />}
          {tab === 'textRules' && <TextRulesTab form={form} set={set} />}
          {tab === 'battle' && <BattleTab form={form} set={set} />}
          {tab === 'injectOrder' && <InjectOrderTab form={form} set={set} />}
          {tab === 'storyRules' && <StoryRulesTab form={form} set={set} toast={toast} />}
          {tab === 'storyPreset' && <StoryPresetTab form={form} set={set} toast={toast} saveNow={setAndSave} />}
          {tab === 'snapshotRules' && <SnapshotRulesTab form={form} set={set} toast={toast} saveNow={setAndSave} />}
          {tab === 'bio' && <BioTab form={form} set={set} toast={toast} />}
          {tab === 'memory' && <MemoryTab form={form} set={set} />}
        </div>

        <div className="settings-main-foot">
          <button className="ghost" onClick={handleBack}>返回</button>
          <span className={`save-state ${saving || dirty ? 'pending' : ''}`} style={{ marginLeft: 'auto' }}>
            <span className="dot" />{saveTip}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ================= 显示与字体 ================= */
function DisplayTab({ form, set }) {
  return (
    <div className="section" style={{ maxWidth: 'none' }}>
      <h3>显示与字体</h3>
      <div className="field">
        <label>正文字号：{form.fontSize}px</label>
        <input type="range" min="14" max="24" value={form.fontSize} onChange={e => set('fontSize', Number(e.target.value))} style={{ width: '100%' }} />
        <div className="hint">故事正文与旁白的显示字号。</div>
      </div>
      <div className="field">
        <label>正文行距：{Number(form.lineHeight || 1.95).toFixed(2)}</label>
        <input type="range" min="1.4" max="2.8" step="0.05" value={form.lineHeight || 1.95} onChange={e => set('lineHeight', Number(e.target.value))} style={{ width: '100%' }} />
        <div className="hint">行间距倍数，与字号一起决定阅读疏密。</div>
      </div>

      <FontSection fontSize={form.fontSize} lineHeight={form.lineHeight || 1.95} />

      <div className="field">
        <label>阅读宽度：标准 720px</label>
        <div className="hint">正文栏居中显示并固定宽度。</div>
      </div>
    </div>
  );
}

/*
 * 字体：界面 / 标题 / 正文 三处**分别**选，各自独立、即时生效。
 *
 * 这一块**不走 form / set**（不写进 settings.json）—— 字体是本机资源：
 * 你在本机选了「华文楷体」，换台没装这字的机器同步过去只会掉进回退链变成另一种字，
 * 与其同步一份错的，不如各机器各选各的。启动即生效也要求它不能等服务端返回。
 * 存储与生效的实现都在 ../fontPrefs.js（写 <html> 上的内联 CSS 变量）。
 */
function FontSection({ fontSize, lineHeight }) {
  const [prefs, setPrefs] = useState(readFonts);
  const [names, setNames] = useState(() => {
    const cur = readFonts();
    const o = {};
    for (const s of FONT_SLOTS) o[s.id] = customNameOf(cur[s.id]);
    return o;
  });

  const pick = (id, val) => {
    setNames(n => ({ ...n, [id]: '' }));
    setPrefs(applyFonts({ [id]: val }));
  };
  // 自定义名边打边生效；清空即回到「默认」—— 留半截字体名的话，
  // 整条栈会从它开始回退，看起来"设置没生效"，很难自己发现。
  const typeName = (id, text) => {
    setNames(n => ({ ...n, [id]: text }));
    setPrefs(applyFonts({ [id]: text.trim() ? 'custom:' + text.trim() : '' }));
  };
  const resetAll = () => {
    const o = {};
    for (const s of FONT_SLOTS) o[s.id] = '';
    setNames(o);
    setPrefs(applyFonts(o));
  };

  return (
    <>
      <hr className="font-sep" />
      <h4 className="font-sec-title">字体</h4>
      <div className="hint" style={{ marginBottom: 10 }}>
        三处各管各的，互不影响。字体选的是<b>这台电脑</b>上装了的字，换一台电脑要重新选一次。
      </div>

      {FONT_SLOTS.map(slot => {
        const cur = prefs[slot.id] || '';
        const isCustom = cur.startsWith('custom:');
        // data-slot / data-font-id：给真机巡检留的稳定锚点。
        // 按按钮文字找元素太脆 —— 文案一改，断言就静默失效（还照样显示"通过"）。
        return (
          <div className="field font-slot" key={slot.id} data-slot={slot.id}>
            <div className="font-slot-head">
              <label>{slot.label}</label>
              <span className="hint font-slot-hint">{slot.hint}</span>
            </div>
            <div className="font-chips">
              {(FONT_CHOICES[slot.id] || []).map(c => (
                <button key={c.id} data-font-id={c.id || 'default'}
                  className={`font-chip${!isCustom && cur === c.id ? ' on' : ''}`}
                  // 「默认」那个没有自己的 stack，用启动时抓下来的**出厂**字体栈显示字形：
                  // 否则它会被当前选择带着走，看着像在骗人（见 fontPrefs.js 的 builtinStackOf）
                  style={{ fontFamily: c.stack || builtinStackOf(slot.id) || undefined }}
                  title={c.note ? `默认字体：${c.note}` : `用「${c.name}」显示`}
                  onClick={() => pick(slot.id, c.id)}>
                  {c.name}
                  {c.note && <span className="font-chip-note">{c.note}</span>}
                </button>
              ))}
            </div>
            <div className="font-custom-row">
              <input className="font-custom" value={names[slot.id] || ''}
                placeholder="也可以直接填字体名，例如：霞鹜文楷"
                onChange={e => typeName(slot.id, e.target.value)} />
              {isCustom && <button className="ghost small" onClick={() => pick(slot.id, '')}>清空</button>}
            </div>
            <div className={`font-preview font-preview--${slot.id}`}
              style={slot.id === 'prose' ? { fontSize, lineHeight } : undefined}>
              {slot.sample}
            </div>
          </div>
        );
      })}

      <div className="btn-row" style={{ marginTop: 2 }}>
        <button className="ghost small" onClick={resetAll}>三处都恢复默认</button>
        <span className="hint" style={{ margin: 0, alignSelf: 'center' }}>选完立即生效。</span>
      </div>
    </>
  );
}

/* ================= API 配置（接口库 + 正文 / 快照 通道选择） ================= */
// 单条接口的字段组：地址 / Key / 模型 / 温度 / 测试连接（展开在任意一条接口卡片里）
// onPatch：以补丁对象回传（一次点击改多个字段也不会互相覆盖）
function AIConfigFields({ cfg, onPatch }) {
  const [models, setModels] = useState(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const setK = (k, v) => { onPatch({ [k]: v }); setTestResult(null); };

  const fetchModels = async () => {
    if (!cfg.baseUrl.trim()) return setTestResult({ ok: false, error: '请先填写接口地址' });
    setLoadingModels(true); setTestResult(null);
    try {
      const r = await api.aiModels(cfg.baseUrl.trim(), cfg.apiKey.trim());
      setModels(r.models);
      if (r.models.length && !r.models.includes(cfg.model)) onPatch({ model: r.models[0] });
    } catch (e) { setTestResult({ ok: false, error: String(e.message) }); }
    finally { setLoadingModels(false); }
  };
  const test = async () => {
    if (!cfg.baseUrl.trim()) return setTestResult({ ok: false, error: '请先填写接口地址' });
    setTesting(true); setTestResult(null);
    try { setTestResult(await api.aiTest({ baseUrl: cfg.baseUrl.trim(), apiKey: cfg.apiKey.trim(), model: cfg.model.trim(), temperature: cfg.temperature })); }
    catch (e) { setTestResult({ ok: false, error: String(e.message) }); }
    finally { setTesting(false); }
  };

  return (
    <>
      <div className="field">
        <label>接口地址 <span className="lbl-note">OpenAI 兼容，填到 /v1 即可</span></label>
        <input type="text" value={cfg.baseUrl} onChange={e => setK('baseUrl', e.target.value)} placeholder="https://example.com/v1" />
        <div className="hint">填站点根地址即可，生成与模型列表路径自动拼接。</div>
      </div>
      <div className="field">
        <label>API Key</label>
        <input type="password" value={cfg.apiKey} onChange={e => setK('apiKey', e.target.value)} placeholder="sk-… · 本地服务通常留空" />
      </div>
      <div className="field">
        <label>模型</label>
        <div style={{ display: 'flex', gap: 8 }}>
          {models ? (
            <select value={cfg.model} onChange={e => setK('model', e.target.value)} style={{ flex: 1 }}>
              {models.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input type="text" style={{ flex: 1 }} value={cfg.model} onChange={e => setK('model', e.target.value)} placeholder="模型名称，或点击右侧获取" />
          )}
          <button onClick={fetchModels} disabled={loadingModels}>{loadingModels ? <Spinner /> : '获取模型列表'}</button>
        </div>
      </div>
      <div className="field">
        <label>温度（随机性）：{Number(cfg.temperature ?? 0.9).toFixed(1)}</label>
        <input type="range" min="0" max="1.5" step="0.1" value={cfg.temperature ?? 0.9} onChange={e => setK('temperature', Number(e.target.value))} style={{ width: '100%' }} />
        <div className="hint">低温度更稳定克制，高温度更有想象力。正文建议 0.7 - 1.0；快照演化建议 0.2 - 0.5，要求输出严格 JSON，越低越稳。</div>
      </div>
      <div className="btn-row">
        <button onClick={test} disabled={testing || !cfg.baseUrl.trim()}>{testing ? <><Spinner /> 测试中…</> : '测试连接'}</button>
        {testResult && (
          <span className={`test-result ${testResult.ok ? 'ok' : 'err'}`}>
            {testResult.ok ? `连接成功：${(testResult.text || '').slice(0, 40)}` : `失败：${testResult.error}`}
          </span>
        )}
      </div>
    </>
  );
}

// API 配置：接口库（多接口保存）+ 正文 / 快照两通道各自选用
function ApiTab({ form, set }) {
  const list = useMemo(() => normalizeEndpointList(form.apiEndpoints), [form.apiEndpoints]);
  const storyId = String(form.storyEndpointId || '');
  const snapId = String(form.snapshotEndpointId || '');
  const [openId, setOpenId] = useState('');

  // 展开的接口被删掉后收起，避免留下空白卡片
  useEffect(() => {
    if (openId && !list.some(e => e.id === openId)) setOpenId('');
  }, [openId, list]);

  const setList = (updater) => set('apiEndpoints', prev => updater(normalizeEndpointList(prev)));
  const patchEndpoint = (id, patch) => setList(l => l.map(e => (e.id === id ? { ...e, ...patch } : e)));

  const addEndpoint = () => {
    const ep = { ...DEFAULT_ENDPOINT, id: newEndpointId(), name: '接口 ' + (list.length + 1), temperature: 0.9 };
    setList(l => [...l, ep]);
    if (!storyId) set('storyEndpointId', ep.id);
    setOpenId(ep.id);
  };

  const removeEndpoint = (id) => {
    const rest = list.filter(e => e.id !== id);
    setList(() => rest);
    if (storyId === id) set('storyEndpointId', rest[0]?.id || '');
    if (snapId === id) set('snapshotEndpointId', '');
    if (openId === id) setOpenId('');
  };

  // 生效通道（与后端同一套解析规则）：用于「当前生效」提示与警告
  const storyEp = storyEndpointOf({ apiEndpoints: list, storyEndpointId: storyId });
  const snapEp = snapshotEndpointOf({ apiEndpoints: list, storyEndpointId: storyId, snapshotEndpointId: snapId });
  const snapSame = !!storyEp && !!snapEp && storyEp.id === snapEp.id;
  const label = ep => (ep ? (ep.name || '未命名') + ' · ' + endpointSummary(ep) : '未配置');
  const storyValue = list.some(e => e.id === storyId) ? storyId : '';

  return (
    <div className="section" style={{ maxWidth: 'none' }}>
      <h3>接口库</h3>
      <div className="hint" style={{ marginBottom: 10 }}>
        这里保存的接口供「正文」与「快照」两个通道各自选用。改动自动落盘、所有存档共用；
        只存在本机 settings.json，不会外传。点卡片标题展开编辑。
      </div>

      {!list.length && (
        <div className="ep-empty">接口库还是空的。点「新增接口」加一条 OpenAI 兼容地址，例如 https://example.com/v1。</div>
      )}

      <div className="ep-list">
        {list.map(ep => {
          const open = openId === ep.id;
          return (
            <div key={ep.id} className={open ? 'ep-card open' : 'ep-card'}>
              <div className="ep-head" onClick={() => setOpenId(open ? '' : ep.id)}>
                <span className="ep-caret">{open ? '▾' : '▸'}</span>
                <span className="ep-name">{ep.name || '未命名接口'}</span>
                <span className="ep-sum">{endpointSummary(ep)}</span>
                {storyId === ep.id && <span className="ep-tag ep-tag-story">正文</span>}
                {snapId === ep.id && <span className="ep-tag ep-tag-snap">快照</span>}
                {!ep.baseUrl.trim() && <span className="ep-tag ep-tag-warn">未填地址</span>}
                <button className="ghost small ep-del" onClick={e => { e.stopPropagation(); removeEndpoint(ep.id); }}>删除</button>
              </div>
              {open && (
                <div className="ep-body">
                  <div className="field">
                    <label>名称</label>
                    <input type="text" value={ep.name} onChange={e => patchEndpoint(ep.id, { name: e.target.value })} placeholder="给这条接口起个名字，便于区分" />
                  </div>
                  <AIConfigFields cfg={ep} onPatch={p => patchEndpoint(ep.id, p)} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="btn-row" style={{ marginTop: 10 }}>
        <button onClick={addEndpoint}>新增接口</button>
        {list.length > 1 && <span className="hint" style={{ alignSelf: 'center' }}>同一个站点想用两个温度/模型，就存成两条接口。</span>}
      </div>

      <h3 style={{ marginTop: 28 }}>通道选择</h3>
      <div className="field">
        <label>正文接口 <span className="lbl-note">生成故事正文，流式打字机输出</span></label>
        <select value={storyValue} onChange={e => set('storyEndpointId', e.target.value)} disabled={!list.length}>
          {!list.length && <option value="">接口库为空，请先新增接口</option>}
          {list.length > 0 && !storyValue && <option value="">未选择 · 将自动使用第一条已填地址的接口</option>}
          {list.map(ep => <option key={ep.id} value={ep.id}>{(ep.name || '未命名') + ' · ' + endpointSummary(ep)}</option>)}
        </select>
        <div className="hint">
          当前生效：{label(storyEp)}
          {storyEp && !storyEp.baseUrl.trim() ? ' —— 该接口还没填地址，正文会生成失败。' : ''}
        </div>
      </div>

      <div className="field">
        <label>快照接口 · 快照演化 / 初始快照 / 剧情导演 / 随身助手 / 记忆压缩</label>
        <select value={snapId} onChange={e => set('snapshotEndpointId', e.target.value)} disabled={!list.length}>
          <option value="">与正文接口相同 · 默认</option>
          {!!snapId && !list.some(e => e.id === snapId) && <option value={snapId}>原接口已删除 · 将回退正文接口</option>}
          {list.map(ep => <option key={ep.id} value={ep.id}>{(ep.name || '未命名') + ' · ' + endpointSummary(ep)}</option>)}
        </select>
        <div className="hint">
          当前生效：{label(snapEp)}
          {snapSame
            ? ' —— 与正文同一条接口。'
            : ' —— 结构化任务建议用廉价、严格遵循 JSON 的模型，温度 0.2 - 0.5。'}
        </div>
      </div>

      <h3 style={{ marginTop: 28 }}>正文输出上限</h3>
      <div className="field">
        <label>max_tokens <span className="lbl-note">0 = 不设顶</span></label>
        <input type="number" min="0" step="1024" value={form.storyMaxTokens ?? 32768}
          onChange={e => set('storyMaxTokens', Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
        <div className="hint">
          每回合正文生成的输出预算硬顶。推理模型如 gemini-3-flash 的思考过程也计入此预算。若正文常被截断，写到一半戛然而止、没有结尾选项，请调大此值；设为 0 表示不限制。截断发生时会自动提高预算重试一次。
        </div>
      </div>
    </div>
  );
}

// 注入状态条：直接告诉用户这三项到底会不会进提示词，以及从哪进
const PERSON_SHORT = { first: '第一人称 · 我', second: '第二人称 · 你', third: '第三人称 · 他/她' };
function InjectStatus({ person, preset }) {
  const items = [
    { k: '文风', byPreset: preset?.style },
    { k: '字数', byPreset: preset?.words },
    { k: '人称', byPreset: preset?.person },
  ];
  return (
    <div className="inject-status">
      <div className="inject-status-head">
        {preset ? `正文预设「${preset.name}」的引用情况` : '当前使用内置默认提示词'}
      </div>
      {items.map(it => (
        <div className="inject-status-row" key={it.k}>
          <span className={it.byPreset ? 'ok' : 'fill'}>{it.byPreset ? '预设已引用' : '程序自动补'}</span>
          <span className="name">{it.k}</span>
          <span className="note">
            {it.byPreset ? '由预设里的占位符给出' : '预设没写，每回合补在「正文规则与文风」区块'}
          </span>
        </div>
      ))}
      <div className="inject-status-foot">
        三项都会注入。当前人称：{PERSON_SHORT[person || 'second']}。
      </div>
    </div>
  );
}

/* ================= 正文规则与文风 ================= */
function TextRulesTab({ form, set }) {
  const tr = form.textRules || {};
  const setTR = (patch) => set('textRules', prev => ({ ...(prev || {}), ...patch }));
  const style = STYLE_PRESETS.find(s => s.id === (tr.style || 'fanren'));
  const activePreset = useMemo(() => presetPlaceholderUsage(form), [form.storyPresets]);
  return (
    <div className="section" style={{ maxWidth: 'none' }}>
      <h3>正文篇幅</h3>
      <div className="field">
        <label>每回合正文字数：{tr.minWords || 200} - {tr.maxWords || 400} 字</label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input type="number" min="50" max="2000" value={tr.minWords} onChange={e => setTR({ minWords: Number(e.target.value) || 200 })} />
          <span>至</span>
          <input type="number" min="100" max="3000" value={tr.maxWords} onChange={e => setTR({ maxWords: Number(e.target.value) || 400 })} />
        </div>
        <div className="hint">AI 会按此字数区间控制正文篇幅。</div>
      </div>

      <h3 style={{ marginTop: 24 }}>文风</h3>
      <div className="field">
        <div className="btn-row">
          {STYLE_PRESETS.map(s => (
            <button key={s.id} className={(tr.style || 'fanren') === s.id ? 'primary' : ''} onClick={() => setTR({ style: s.id })}>{s.name}</button>
          ))}
        </div>
        {style && style.id !== 'custom' && <div className="hint" style={{ marginBottom: 10 }}>{style.text}</div>}
        {(tr.style === 'custom' || tr.customStyle?.trim()) && (
          <div className="field" style={{ marginBottom: 0 }}>
            <label>自定义文风指令 <span className="lbl-note">叠加在预设之上</span></label>
            <textarea style={{ minHeight: 90 }} value={tr.customStyle || ''} onChange={e => setTR({ customStyle: e.target.value })} placeholder="例如：多用环境描写渲染氛围；对话简短有力；避免现代词汇……" />
            {!tr.customStyle?.trim() && (
              <div className="hint" style={{ color: 'var(--red)' }}>还没填内容，这一项当前等于「文风不限」。</div>
            )}
          </div>
        )}
        <InjectStatus person={form.story?.narrativePerson} preset={activePreset} />
      </div>

      <h3 style={{ marginTop: 24 }}>叙事人称</h3>
      <div className="field">
        <div className="btn-row">
          {[{ v: 'first', t: '我 · 第一人称' }, { v: 'second', t: '你 · 第二人称' }, { v: 'third', t: '他/她 · 第三人称' }].map(o => (
            <button key={o.v} className={(form.story?.narrativePerson || 'second') === o.v ? 'primary' : ''}
              onClick={() => set('story', prev => ({ ...(prev || {}), narrativePerson: o.v }))}>{o.t}</button>
          ))}
        </div>
        <div className="hint">决定正文如何称呼主角。</div>
      </div>

      <h3 style={{ marginTop: 24 }}>正文着色词表</h3>
      <ColorPaletteSection form={form} set={set} />

      <h3 style={{ marginTop: 24 }}>Mortal 运行时协议</h3>
      <div className="field">
        <div className="hint" style={{ marginBottom: 8 }}>
          前五份协议每轮注入正文提示词；最后一份「战后叙事协议」只在<b>战斗打完、补写正文</b>那一次注入。
          留空使用内置默认；编辑后以自定义文本为准（高于预设中的旧描述）。支持运行时占位符：{'${current_time} ${current_location} ${season} ${weather} ${time_format_rule} ${time_format_example}'}。
          <br />
          战后叙事协议另外支持：{'${proseNumbers}'} 会展开成上面那份「正文数值约束」（改一处、两处生效，不用抄两份）；
          {'${battleWords} ${battleWordsFloor} ${battleWordsMax}'} 会展开成当前字数区间算出的目标 / 下限 / 上限字数。
          <br />
          两条战斗协议<b>互斥</b>，按「战斗模式」二选一注入：开启走「战斗接管协议」，关闭走「自动战斗推演协议」。
          当前生效的是：
          <b>{MORTAL_PROTOCOL_META.filter(m => (m.scope || 'story') === 'story').filter(m => (m.mode === 'manual') === (form?.battle?.mode === 'manual')).map(m => m.name).join('、')}</b>。
        </div>
        {MORTAL_PROTOCOL_META.map(meta => (
          <ProtocolEditor
            key={meta.key}
            meta={meta}
            value={tr.protocols?.[meta.key] || ''}
            active={!meta.mode || (meta.mode === 'manual') === (form?.battle?.mode === 'manual')}
            onChange={v => setTR({ protocols: { ...(tr.protocols || {}), [meta.key]: v } })}
          />
        ))}
      </div>
    </div>
  );
}

// 正文着色词表：限定正文 <font color> 只能用哪些颜色（渲染时丢弃表外颜色 + 注入提示词告知 AI）
function ColorPaletteSection({ form, set }) {
  const raw = form.textRules?.colorPalette;
  const cp = useMemo(() => normalizePalette(raw), [raw]);
  const resolver = useMemo(() => makeColorResolver(cp), [cp]);
  const [probe, setProbe] = useState('');
  const strict = cp.mode === 'strict';
  const probeOk = probe.trim() ? resolver.resolve(probe) : '';
  const setCP = (patch) => set('textRules', prev => ({
    ...(prev || {}),
    colorPalette: { ...normalizePalette(prev?.colorPalette), ...patch },
  }));
  const patchRow = (i, patch) => setCP({ list: cp.list.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  const removeRow = (i) => setCP({ list: cp.list.filter((_, k) => k !== i) });
  const addRow = () => setCP({ list: [...cp.list, { name: '', value: '#7A5A2E', desc: '' }] });

  return (
    <div className="field">
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <button className={!strict ? 'primary' : ''} onClick={() => setCP({ mode: 'off' })}>不限制颜色</button>
        <button className={strict ? 'primary' : ''} onClick={() => setCP({ mode: 'strict' })}>仅限词表内颜色</button>
        <button className="ghost" onClick={() => setCP({ mode: 'strict', list: structuredClone(DEFAULT_COLOR_PALETTE.list) })}>恢复默认词表</button>
        <button className="ghost" onClick={() => setCP({ list: [] })}>清空词表</button>
      </div>
      <div className="hint" style={{ marginBottom: 10 }}>
        正文里的 <code>{"<font color='#RRGGBB'>"}</code> 原本由 AI 自由填色。选「仅限词表内颜色」后：
        ① 渲染时丢弃词表外的颜色，对应段落回退默认字色；② 词表随正文提示词一起下发，让 AI 只用这里的颜色。
        未命中判定忽略大小写，<code>#6B4E9E</code> 与 <code>rgb(107, 78, 158)</code> 视为同色；词表为空时限制不生效。
      </div>

      {cp.list.length > 0 && (
        <div className="cp-head">
          <span className="cp-h-label">色名</span>
          <span className="cp-h-val">色值</span>
          <span className="cp-h-desc">用途提示 · 写进提示词，可留空</span>
        </div>
      )}
      {cp.list.map((e, i) => (
        <div className="cp-row" key={i}>
          <span className="cp-swatch" style={{ background: resolver.resolve(e.value) || 'transparent' }} />
          <input className="cp-name" value={e.name} placeholder="如 淡金" onChange={ev => patchRow(i, { name: ev.target.value })} />
          <input type="color" className="cp-pick" value={/^#[0-9a-f]{6}$/i.test(e.value.trim()) ? e.value.trim() : '#7a5a2e'}
            onChange={ev => patchRow(i, { value: ev.target.value.toUpperCase() })} title="取色板" />
          <input className="cp-val" value={e.value} placeholder="#RRGGBB" onChange={ev => patchRow(i, { value: ev.target.value })} />
          <input className="cp-desc" value={e.desc} placeholder="如 灵石、法宝、机缘" onChange={ev => patchRow(i, { desc: ev.target.value })} />
          <button className="ghost small cp-del" onClick={() => removeRow(i)} title="删除该颜色">删</button>
        </div>
      ))}

      <div className="btn-row" style={{ marginTop: 6, alignItems: 'center' }}>
        <button className="ghost small" onClick={addRow}>＋ 添加颜色</button>
        <span className="hint" style={{ margin: 0, alignSelf: 'center' }}>
          {cp.list.length} 个颜色 · {strict
            ? (cp.list.length ? '限制生效中，表外颜色将被丢弃' : '词表为空，限制未生效')
            : '当前不限制颜色'}
        </span>
      </div>

      <details className="cp-preview-box" open>
        <summary>颜色预览与试色</summary>
        <div className="cp-preview">
          {cp.list.length === 0 && <span className="hint" style={{ margin: 0 }}>词表为空</span>}
          {cp.list.map((e, i) => (
            <span key={i} style={{ color: resolver.resolve(e.value) || 'var(--text)' }}>
              {e.name ? `${e.name}：` : ''}灵气流转，山雾未散。
            </span>
          ))}
        </div>
        <div className="cp-probe">
          <span className="hint" style={{ margin: 0 }}>试色：</span>
          <input value={probe} placeholder="#DEC0FF" onChange={ev => setProbe(ev.target.value)} />
          {probe.trim() !== '' && (
            probeOk
              ? <span className="cp-ok" style={{ color: probeOk }}>✓ 放行 → {probeOk}</span>
              : <span className="cp-no">✕ 被丢弃 · 不着色</span>
          )}
        </div>
      </details>
    </div>
  );
}

// ===== 注入顺序：把提示词各区块排进「恒定基座 / 变化区 / 末尾契约」 =====
// 目的：让逐回合不变的内容连成一段前缀，被接口的前缀缓存命中，省下重复计费的输入 token。
function InjectOrderTab({ form, set }) {
  const layout = normalizePromptLayout(form.promptLayout);
  const lockedItems = layout.filter(x => layoutBlockMeta(x.id)?.locked);
  const itemsOf = zone => layout.filter(x => x.zone === zone && !layoutBlockMeta(x.id)?.locked);

  const Arrow = ({ disabled, onClick, label, children }) => (
    <button className="io-mv" disabled={disabled} onClick={onClick} title={label} aria-label={label}>{children}</button>
  );

  return (
    <div>
      <h3 style={{ marginTop: 0 }}>注入顺序</h3>
      <p className="hint">
        每次请求发给 AI 的内容由若干区块拼成。把「逐回合不变」的区块往前放、把「逐回合变化」的往后放，
        不变的部分就能连成一段前缀被接口缓存命中，省下重复计费的输入 token。
        <br />
        三个分区之外，还要留意：<b>恒定基座里任何一动都会让后面的缓存全部失效</b>，所以拿不准的区块建议放在变化区。
        <br />
        预设里角色为 <b>user</b> / <b>assistant</b> 或 SillyTavern 写法 <b>model</b> 的段落<b>不参与本排序</b>：
        它们各自独立成一条消息，按原顺序附在 system 之后；只有 <b>system</b> 段会被合并进来接受排序。
      </p>

      <div className="io-grid">
        {LAYOUT_ZONES.map((zone, zi) => {
          const items = itemsOf(zone.id);
          return (
            <div key={zone.id} className={`io-col io-col-${zone.id}`}>
              <div className="io-col-name">{zone.name}</div>
              <div className="io-col-desc">{zone.desc}</div>
              <div className="io-col-body">
                {items.length === 0 && <div className="io-empty">这个分区现在是空的</div>}
                {items.map((item, idx) => {
                  const meta = layoutBlockMeta(item.id);
                  return (
                    <div key={item.id} className="io-item">
                      <div className="io-item-top">
                        <span className="io-item-name">{meta.name}</span>
                        <span className="io-item-btns">
                          <Arrow disabled={idx === 0} onClick={() => set('promptLayout', moveWithinZone(layout, item.id, -1))} label="上移">▲</Arrow>
                          <Arrow disabled={idx === items.length - 1} onClick={() => set('promptLayout', moveWithinZone(layout, item.id, 1))} label="下移">▼</Arrow>
                          <Arrow disabled={zi === 0} onClick={() => set('promptLayout', moveToZone(layout, item.id, LAYOUT_ZONES[zi - 1].id))} label={`移到「${LAYOUT_ZONES[zi - 1]?.name}」`}>◀</Arrow>
                          <Arrow disabled={zi === LAYOUT_ZONES.length - 1} onClick={() => set('promptLayout', moveToZone(layout, item.id, LAYOUT_ZONES[zi + 1].id))} label={`移到「${LAYOUT_ZONES[zi + 1]?.name}」`}>▶</Arrow>
                        </span>
                      </div>
                      <div className="io-item-desc">{meta.desc}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <div className="io-foot">
        <button className="ghost" onClick={() => set('promptLayout', null)}>恢复默认顺序</button>
        <span className="hint">
          默认顺序：恒定基座 = `预设静态段 → 世界书恒定条目 → 静态协议 → 数值表 → 着色词表`，
          变化区 = `预设动态段 → 叙事记忆 → 世界书命中 → 当前时空 → 最近剧情`。
        </span>
      </div>
      <p className="hint">
        「{lockedItems.map(x => layoutBlockMeta(x.id)?.name).join('、')}」由消息角色决定，固定排在最后，不参与调整；
        「预设 · 静态段 / 动态段」由运行时自动判定——同一条预设段若引用了会随回合变化的占位符，就归入动态段。
      </p>
    </div>
  );
}

// 单个协议编辑器：折叠展示，留空 = 内置默认
function ProtocolEditor({ meta, value, onChange, active = true }) {
  const [open, setOpen] = useState(false);
  const customized = typeof value === 'string' && value.trim();
  return (
    <div style={{ border: '1px solid var(--border-gold)', borderRadius: 'var(--radius-sm)', marginBottom: 8, overflow: 'hidden', opacity: active ? 1 : 0.55 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', background: 'rgba(197,169,94,0.06)' }} onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--gold)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 600 }}>{meta.name}</span>
        <span className="tag" style={{ fontSize: 11 }}>{customized ? '已自定义' : '默认'}</span>
        {meta.mode && <span className="tag" style={{ fontSize: 11 }}>{active ? '当前生效' : '未生效'}</span>}
        {meta.scope === 'afterBattle' && <span className="tag" style={{ fontSize: 11 }}>仅战斗后</span>}
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 'auto' }}>{meta.desc}</span>
      </div>
      {open && (
        <div style={{ padding: '8px 12px' }}>
          <textarea style={{ minHeight: 260, fontFamily: 'var(--font-ui)', fontSize: 12, lineHeight: 1.6 }} value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={`留空使用内置默认协议。点击下方「填入默认文本」可在此基础上修改。`} />
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="ghost small" onClick={() => onChange(meta.default())}>填入默认文本</button>
            {customized && <button className="ghost small" onClick={() => onChange('')}>清空并恢复内置默认</button>}
            <span className="hint" style={{ margin: 0, alignSelf: 'center' }}>{!customized
              ? `内置默认 ${meta.default().length} 字符`
              : (value === meta.default()
                ? `副本与当前内置默认相同，清空即可继续跟随内置更新`
                : `自定义 ${value.length} 字符 · 当前内置默认 ${meta.default().length} 字符`)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================= 故事设定与数值规则 ================= */
function StoryRulesTab({ form, set, toast }) {
  const st = form.story || {};
  const setST = (patch) => set('story', prev => ({ ...(prev || {}), ...patch }));
  return (
    <div className="section" style={{ maxWidth: 'none' }}>
      <h3>快照</h3>
      <div className="field">
        <label>每 N 回合自动创建人生快照 <span className="lbl-note">0 = 关闭</span></label>
        <input type="number" min="0" max="100" value={st.autoSnapshotEvery ?? 10} onChange={e => setST({ autoSnapshotEvery: Number(e.target.value) || 0 })} style={{ width: 140 }} />
        <div className="hint">回合收尾时自动落库一份快照；也可在「快照」页手动创建与恢复。</div>
      </div>

      <NumericTuningSection form={form} set={set} toast={toast} />
    </div>
  );
}

// 数值规则表 · Mortal 数值体系：总开关 / 逐表启停 / 导入 JSON / 恢复默认 / 注入预览
function NumericTuningSection({ form, set, toast }) {
  const [showPreview, setShowPreview] = useState(false);
  const fileRef = useRef(null);
  const nt = form.numericTuning || {};
  const enabled = nt.enabled !== false;
  const enforce = nt.enforce !== false;
  const disabled = new Set(Array.isArray(nt.disabledTables) ? nt.disabledTables : []);
  const setNT = (patch) => set('numericTuning', prev => ({ ...(prev || {}), ...patch }));

  const previewText = useMemo(() => serializeNumericTuning(enabled ? (form.numericTuning || null) : { enabled: false }), [form.numericTuning, enabled]);

  const importFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed.tables || typeof parsed.tables !== 'object') throw new Error('缺少 tables 字段');
      setNT({ enabled: true, tables: parsed.tables, applyTo: parsed.applyTo || { playerB1: true, npcs: true }, disabledTables: [] });
      toast('ok', `数值规则表已导入 · ${Object.keys(parsed.tables).length} 张表`);
    } catch (err) { toast('err', '导入失败：' + (err.message || '不是合法的 JSON')); }
    finally { if (fileRef.current) fileRef.current.value = ''; }
  };

  return (
    <>
      <h3 style={{ marginTop: 24 }}>数值规则表 · Mortal 数值体系</h3>
      <div className="field">
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <button className={enabled ? 'primary' : ''} onClick={() => setNT({ enabled: !enabled })}>{enabled ? '已启用注入' : '已停用注入'}</button>
          <button className={enforce ? 'primary' : ''} onClick={() => setNT({ enforce: !enforce })}>{enforce ? '强制校界：开' : '强制校界：关'}</button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>导入 JSON 数值表…</button>
          <button className="ghost" onClick={() => { set('numericTuning', null); toast('ok', '已恢复内置数值表'); }}>恢复内置默认</button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={importFile} />
        </div>
        <div className="hint">
          作为境界基准、装备品阶两项数值的唯一判定基准 · 共 {Object.keys(TABLE_META).length} 张表。
          未配置时使用内置数值表。
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          强制校界开启时，每回合快照演化与手动保存快照都会拿<b>境界基准表</b>对照人物属性：上限值超过该境界 <code>xxUpper</code> 或低于 <code>xxBase</code> 一律写回边界，当前值只压不抬
          ，受伤/耗蓝不会被抬满。改动幅度会以提示条报出。
        </div>
        <div className="hint" style={{ marginTop: 4 }}>
          逐表改数值请用游戏内左侧导航的<b>「数值表」页</b>：可逐张表直编、恢复本表默认、导入导出，并可一键「立即校验人物属性」查看修正报告。
        </div>
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--gold-dim)' }}>逐表启停 · 不勾选的表不注入，可控制提示词体积</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '2px 12px', marginTop: 6, fontSize: 12 }}>
            {Object.entries(TABLE_META).map(([key, meta]) => (
              <label key={key} style={{ display: 'flex', gap: 6, alignItems: 'center', color: disabled.has(key) ? 'var(--text-faint)' : 'var(--text)' }}>
                <input type="checkbox" checked={!disabled.has(key)}
                  onChange={e => {
                    const next = new Set(disabled);
                    if (e.target.checked) next.delete(key); else next.add(key);
                    setNT({ disabledTables: [...next] });
                  }} />
                <span title={meta.desc}>{meta.name}</span>
              </label>
            ))}
          </div>
        </details>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="ghost small" onClick={() => setShowPreview(p => !p)}>{showPreview ? '收起注入预览' : '预览实际注入文本'}</button>
          <span className="hint" style={{ margin: 0, alignSelf: 'center' }}>{enabled ? `注入文本 ${previewText.length} 字符` : '当前已停用，不注入数值表'}</span>
        </div>
        {showPreview && (
          <div className="prompt-preview" style={{ maxHeight: 420 }}>{enabled ? previewText : '已停用注入'}</div>
        )}
      </div>
    </>
  );
}

/* ================= 正文预设（导入 SillyTavern 风格 JSON，折叠式，可编辑） ================= */
function StoryPresetTab({ form, set, toast, saveNow }) {
  const presets = form.storyPresets || [];
  // 预设变更：有 saveNow（父级传入）则改完立即落库，否则仅改表单
  const setPresets = (list) => {
    if (saveNow) saveNow('storyPresets', list);
    else set('storyPresets', list);
  };
  // 每个预设独立折叠状态：默认 null（全折叠）；展开则存 preset.id
  const [openId, setOpenId] = useState(null);
  // 每个预设内的 prompt 段独立折叠：{ [presetId]: Set<identifier> }
  const [openPrompts, setOpenPrompts] = useState({});
  const [showRaw, setShowRaw] = useState(false);
  // 编辑状态：段编辑 { presetId, index, draft } / 预设重命名 { presetId, value }
  const [segEdit, setSegEdit] = useState(null);
  const [nameEdit, setNameEdit] = useState(null);
  // 段拖动排序：dragState 记录正在拖的段，dropIdx 记录悬停落点
  const [dragState, setDragState] = useState(null); // { presetId, index }
  const [dropIdx, setDropIdx] = useState(null);
  // 拖动时的边缘自动滚动：HTML5 拖拽期间浏览器吞掉滚轮事件，长列表拖到下面就上不来了，
  // 所以不依赖浏览器原生 autoscroll，自己按指针在滚动容器里的位置驱动 scrollTop。
  const dragScroller = useRef(null);
  const dragStateRef = useRef(null); // 供 rAF 回调读取最新拖动状态（闭包里的 state 会过期）
  const dragPointer = useRef({ x: 0, y: 0 });
  // 指针拖动（自实现，不用 HTML5 draggable）：draggable + dragover/drop 是否真的能起拖
  // 由浏览器各家自行判定（内嵌 iframe、触摸屏、部分 WebView 里会直接失效且无任何报错），
  // 所以改成 Pointer Events 全程自管：按下 → 移动超阈值才算拖动 → 抬起落位。
  const ptrDragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const ptrHandledClickRef = useRef(false);
  const dragListRef = useRef(null); // 当前正在拖的那份段列表（一次只会展开一个预设）
  const dragRectsRef = useRef(null); // 拖动开始时量一次行位置；拖动中只有滚动会挪行，滚一帧重量一次

  // 落点一律按「指针 Y vs 各行中线」现算（见 engine/dragAutoScroll.dropIndexFromRows）。
  // 不用 elementFromPoint：拖动中列表会滚动、行会被挪位，
  // 按几何位置算出来的落点始终与用户看到的一致。
  const measureRows = () => {
    const box = dragListRef.current;
    if (!box || typeof box.querySelectorAll !== 'function') return [];
    return Array.from(box.querySelectorAll('[data-drag-row="1"]')).map(node => {
      const rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
      return rect ? { top: rect.top, bottom: rect.bottom } : null;
    });
  };
  const captureRows = () => { dragRectsRef.current = measureRows(); return dragRectsRef.current; };
  const dropIndexAt = (clientY, from) => {
    const cached = dragRectsRef.current;
    const rows = cached && cached.length ? cached : measureRows();
    return dropIndexFromRows(rows, clientY, from);
  };

  const refreshDropUnderPointer = () => {
    const st = dragStateRef.current;
    if (!st) return;
    captureRows(); // 滚动过了，先把行位置重量一遍再算落点
    const idx = dropIndexAt(dragPointer.current.y, st.index);
    if (idx >= 0) setDropIdx(prev => (prev === idx ? prev : idx));
  };

  const getScroller = () => {
    if (!dragScroller.current) dragScroller.current = createDragScroller({ onTick: () => refreshDropUnderPointer() });
    return dragScroller.current;
  };
  const stopDragScroll = () => { try { getScroller().stop(); } catch { /* 无 rAF 的环境忽略 */ } };

  /** 拖动结束（落下 / 取消 / dragend）：清干净拖动态 */
  const endDrag = () => {
    stopDragScroll();
    dragStateRef.current = null;
    dragRectsRef.current = null;
    setDragState(null); setDropIdx(null);
  };

  /**
   * 指针拖动：按下记起点 → 移动超过阈值才进入拖动（否则算点击，交给段头展开/折叠）
   * → 抬起按几何落点重排。不依赖 HTML5 draggable / dragover / drop，
   * 因此不会出现「浏览器判定此处不接受 drop，于是整行完全拖不动」的情况。
   */
  const beginPtrDrag = (preset, i, promptId) => (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 只认左键
    const t = e.target;
    const tag = String((t && t.tagName) || '').toUpperCase();
    // 表单控件 / 展开区里的正文：交还给浏览器做文本选择
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (t && typeof t.closest === 'function' && (t.closest('button') || t.closest('.sp-prompt-body'))) return;
    const canClosest = !!(t && typeof t.closest === 'function');
    ptrDragRef.current = {
      presetId: preset.id, index: i, promptId, pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY, active: false,
      // 按下点是否落在段头：setPointerCapture 会把随后的 click 目标改成整行，
      // 段头的 onClick 就收不到了，所以「没拖动=点击展开」得在这里自己记下来、自己补上。
      inHead: canClosest ? !!t.closest('.sp-prompt-head') : true,
    };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const movePtrDrag = (e) => {
    const st = ptrDragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    if (!st.active) {
      if (Math.abs(e.clientX - st.x0) + Math.abs(e.clientY - st.y0) < 5) return; // 还在抖动范围内
      st.active = true;
      dragStateRef.current = { presetId: st.presetId, index: st.index };
      dragPointer.current = { x: e.clientX, y: e.clientY };
      captureRows();
      setDragState({ presetId: st.presetId, index: st.index });
      setDropIdx(null);
      try { document.body.style.userSelect = 'none'; } catch { /* ignore */ }
    }
    if (e.cancelable) e.preventDefault();
    dragPointer.current = { x: e.clientX, y: e.clientY };
    const idx = dropIndexAt(e.clientY, st.index);
    if (idx >= 0) setDropIdx(prev => (prev === idx ? prev : idx));
    try { getScroller().update(e.clientY, dragListRef.current || e.currentTarget); } catch { /* ignore */ }
  };

  const finishPtrDrag = (e) => {
    const st = ptrDragRef.current;
    if (!st || st.pointerId !== e.pointerId) return;
    ptrDragRef.current = null;
    try { document.body.style.userSelect = ''; } catch { /* ignore */ }
    if (!st.active) {
      // 没真正拖动 → 当作一次点击：段头按下就切换展开/折叠
      if (st.inHead && st.promptId) {
        ptrHandledClickRef.current = true; // 防止随后的 click 再切一次（不同浏览器 click 目标不一致）
        setTimeout(() => { ptrHandledClickRef.current = false; }, 300);
        togglePrompt(st.presetId, st.promptId);
      }
      return;
    }
    suppressClickRef.current = true; // 拖动过就别再触发点击
    setTimeout(() => { suppressClickRef.current = false; }, 300);
    const to = dropIndexAt(e.clientY, st.index);
    endDrag();
    if (to >= 0 && to !== st.index) reorderPrompt(st.presetId, st.index, to);
  };
  useEffect(() => () => { stopDragScroll(); }, []);
  const confirmDlg = useConfirm();
  const confirmDelete = (text) => confirmDlg({ title: '删除段落', text, danger: true, okText: '删除' });

  const importPresetFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (!obj || typeof obj !== 'object') throw new Error('根必须为对象');
        const name = obj.name || f.name.replace(/\.json$/i, '');
        const promptCount = Array.isArray(obj.prompts) ? obj.prompts.length : 0;
        if (promptCount === 0 && !obj.content) throw new Error('未找到 prompts 数组，可能不是 SillyTavern 风格预设');
        const preset = {
          id: 'sp_' + Date.now().toString(36),
          name,
          enabled: presets.length === 0,
          raw: obj,
          promptCount,
          importedAt: Date.now(),
        };
        setPresets([...presets, preset]);
        setOpenId(preset.id);
        toast?.('ok', `预设「${name}」已导入 · ${promptCount} 个段落`);
      } catch (err) {
        toast?.('err', '导入失败：' + err.message);
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  };

  const exportPreset = (preset) => {
    const blob = new Blob([JSON.stringify(preset.raw, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${preset.name || '正文预设'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const enablePreset = (id) => {
    setPresets(presets.map(p => ({ ...p, enabled: p.id === id ? !p.enabled : false })));
    toast('ok', presets.find(p => p.id === id)?.enabled ? `已停用「${presets.find(p => p.id === id).name}」` : `已启用「${presets.find(p => p.id === id).name}」`);
  };
  const removePreset = (id) => {
    const p = presets.find(x => x.id === id);
    setPresets(presets.filter(p => p.id !== id));
    if (openId === id) setOpenId(null);
    toast('ok', `已删除「${p?.name}」`);
  };

  const togglePrompt = (presetId, identifier) => {
    setOpenPrompts(prev => {
      const set = new Set(prev[presetId] || []);
      if (set.has(identifier)) set.delete(identifier); else set.add(identifier);
      return { ...prev, [presetId]: set };
    });
  };

  // ---- 段编辑 / 段启停 / 增删段 / 重命名（全部改完即存） ----
  const mutateRaw = (presetId, fn) => {
    setPresets(presets.map(p => {
      if (p.id !== presetId) return p;
      const raw = JSON.parse(JSON.stringify(p.raw || {}));
      fn(raw);
      return { ...p, raw, promptCount: Array.isArray(raw.prompts) ? raw.prompts.length : p.promptCount, updatedAt: Date.now() };
    }));
  };
  // 段启用/停用：优先维护 prompt_order[0].order，无 order 表时直接写段的 enabled
  const toggleSegment = (presetId, index) => {
    mutateRaw(presetId, (raw) => {
      const seg = raw.prompts[index];
      if (!seg) return;
      const identifier = seg.identifier || `idx_${index}`;
      const order = Array.isArray(raw.prompt_order?.[0]?.order) ? raw.prompt_order[0].order : null;
      if (order) {
        const hit = order.find(o => o.identifier === identifier);
        if (hit) hit.enabled = !hit.enabled;
        else order.push({ identifier, enabled: false });
      } else {
        seg.enabled = seg.enabled === false;
      }
    });
  };
  const saveSegment = (presetId, index, draft) => {
    mutateRaw(presetId, (raw) => {
      const seg = raw.prompts[index];
      if (!seg) return;
      if (draft.name?.trim()) seg.name = draft.name.trim();
      seg.role = draft.role || 'system';
      seg.content = draft.content;
    });
    setSegEdit(null);
    toast('ok', '段已保存');
  };
  const addSegment = (presetId) => {
    const identifier = 'custom_' + Date.now().toString(36);
    mutateRaw(presetId, (raw) => {
      if (!Array.isArray(raw.prompts)) raw.prompts = [];
      raw.prompts.push({ identifier, name: '新段落', role: 'system', content: '' });
      const order = Array.isArray(raw.prompt_order?.[0]?.order) ? raw.prompt_order[0].order : null;
      if (order) order.push({ identifier, enabled: true });
    });
    toast('ok', '已新增段落，请编辑内容');
  };
  const deleteSegment = async (presetId, index) => {
    const p = presets.find(x => x.id === presetId);
    const seg = p?.raw?.prompts?.[index];
    const ok = await confirmDelete(`确定删除段落「${seg?.name || seg?.identifier || index + 1}」？`);
    if (!ok) return;
    mutateRaw(presetId, (raw) => {
      const identifier = raw.prompts[index]?.identifier;
      raw.prompts.splice(index, 1);
      const order = Array.isArray(raw.prompt_order?.[0]?.order) ? raw.prompt_order[0].order : null;
      if (order && identifier) {
        const i = order.findIndex(o => o.identifier === identifier);
        if (i >= 0) order.splice(i, 1);
      }
    });
  };
  // 段顺序调整（拖动或 ↑↓）：prompts 与 prompt_order 一起重排，改完即落库
  const reorderPrompt = (presetId, from, to) => {
    const p0 = presets.find(x => x.id === presetId);
    const len = Array.isArray(p0?.raw?.prompts) ? p0.raw.prompts.length : 0;
    if (from === to || to < 0 || to >= len) return;
    setSegEdit(null); // 段序号已变，正在编辑的草稿作废
    setPresets(presets.map(p => p.id === presetId
      ? { ...p, raw: reorderPresetPrompts(p.raw, from, to), updatedAt: Date.now() }
      : p));
  };

  const renamePreset = (presetId, value) => {
    if (!value.trim()) return;
    setPresets(presets.map(p => p.id === presetId ? { ...p, name: value.trim(), updatedAt: Date.now() } : p));
    setNameEdit(null);
    toast('ok', '预设已重命名');
  };

  // 渲染 prompts 列表（折叠式，可编辑）
  const renderPrompts = (preset) => {
    const raw = preset.raw;
    const prompts = Array.isArray(raw?.prompts) ? raw.prompts : [];
    if (!prompts.length) return <div className="empty-tip">该预设无 prompts 数组</div>;
    let orderMap = new Map();
    const fo = Array.isArray(raw.prompt_order) ? raw.prompt_order[0] : null;
    if (fo && Array.isArray(fo.order)) for (const it of fo.order) orderMap.set(it.identifier, !!it.enabled);
    const openSet = openPrompts[preset.id] || new Set();
    return (
      <>
        {dragState?.presetId === preset.id && (
          // 提示条放在列表**外面**：放在列表里会在拖动开始的瞬间把后面所有行顶下去，
          // 指针下的行会突然换一个，落点跟着错一位。
          <div className="sp-drag-hint">
            拖动中 —— 拖到列表<b>上/下边缘</b>会自动滚动；松手落在哪一行，段就排到那一位
          </div>
        )}
        <div
          ref={dragListRef}
          className={`sp-prompt-list ${dragState?.presetId === preset.id ? 'dragging-list' : ''}`}
        >
          {prompts.map((p, i) => {
            const enabled = orderMap.has(p.identifier) ? orderMap.get(p.identifier) : (p.enabled !== false);
            const content = p.content || '';
            const isOpen = openSet.has(p.identifier);
            const id = p.identifier || ('idx_' + i);
            const editing = segEdit?.presetId === preset.id && segEdit.index === i;
            const dragging = dragState?.presetId === preset.id && dragState.index === i;
            const dropTarget = dragState?.presetId === preset.id && dropIdx === i && dragState.index !== i;
            return (
              <div
                key={id}
                data-idx={i}
                data-preset={preset.id}
                data-drag-row="1"
                className={`sp-prompt-row ${enabled ? '' : 'off'} ${isOpen ? 'open' : ''} ${dragging ? 'dragging' : ''} ${dropTarget ? 'drop-target' : ''}`}
                onPointerDown={beginPtrDrag(preset, i, id)}
                onPointerMove={movePtrDrag}
                onPointerUp={finishPtrDrag}
                onPointerCancel={finishPtrDrag}
              >
                <div
                  className="sp-prompt-head"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => {
                    if (suppressClickRef.current) return; // 刚拖动过，别顺手把段折叠了
                    if (ptrHandledClickRef.current) return; // 已经由 pointer 流程切换过
                    togglePrompt(preset.id, id);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePrompt(preset.id, id); }
                  }}
                >
                  <span className="sp-grip" title="按住拖动调整顺序" aria-hidden="true">⠿</span>
                  <span className="sp-toggle" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="sp-prompt-name">{p.name || p.identifier || `段 ${i + 1}`}</span>
                  <span className="tag">{p.role || 'system'}</span>
                  {enabled ? <span className="tag ok">启用</span> : <span className="tag">停用</span>}
                  {content && <span className="sp-prompt-preview">{content.slice(0, 80)}{content.length > 80 ? '…' : ''}</span>}
                </div>
                {isOpen && (
                <div className="sp-prompt-body">
                  {editing ? (
                    <div className="field">
                      <label>段名称</label>
                      <input type="text" value={segEdit.draft.name} onChange={e => setSegEdit({ ...segEdit, draft: { ...segEdit.draft, name: e.target.value } })} />
                      <label>角色 <span className="lbl-note">决定注入为哪种消息</span></label>
                      <select value={segEdit.draft.role} onChange={e => setSegEdit({ ...segEdit, draft: { ...segEdit.draft, role: e.target.value } })}>
                        {PRESET_ROLE_META.map(o => (
                          <option key={o.v} value={o.v}>{`${o.v} · ${o.zh}`}</option>
                        ))}
                      </select>
                      <div className="hint">
                        {PRESET_ROLE_META.find(o => o.v === segEdit.draft.role)?.hint || '未知角色，注入时按 system 处理'}
                      </div>
                      {/* 花括号必须包在字符串里：JSX 里裸写 {{xxx}} 会被当成对象字面量 { xxx: xxx }，直接 ReferenceError */}
                      <label>内容 <span className="lbl-note">{'支持占位符写法 {{xxx}} 与 ${xxx}'}</span></label>
                      <textarea style={{ minHeight: 200, fontFamily: 'monospace' }} value={segEdit.draft.content}
                        onChange={e => setSegEdit({ ...segEdit, draft: { ...segEdit.draft, content: e.target.value } })} />
                      <div className="btn-row">
                        <button className="primary small" onClick={() => saveSegment(preset.id, i, segEdit.draft)}>保存段</button>
                        <button className="ghost small" onClick={() => setSegEdit(null)}>取消</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {content ? <pre className="sp-prompt-content">{content}</pre> : <div className="hint">空段落</div>}
                      <div className="btn-row">
                        <button className="small" onClick={() => reorderPrompt(preset.id, i, i - 1)} disabled={i === 0} title="上移一段">↑</button>
                        <button className="small" onClick={() => reorderPrompt(preset.id, i, i + 1)} disabled={i === prompts.length - 1} title="下移一段">↓</button>
                        <button className="small" onClick={() => reorderPrompt(preset.id, i, 0)} disabled={i === 0} title="移到最前">⤒ 置顶</button>
                        <button className="small" onClick={() => reorderPrompt(preset.id, i, prompts.length - 1)} disabled={i === prompts.length - 1} title="移到最后">⤓ 置底</button>
                        <button className="small" onClick={() => setSegEdit({ presetId: preset.id, index: i, draft: { name: p.name || '', role: p.role || 'system', content } })}>编辑</button>
                        <button className="small" onClick={() => toggleSegment(preset.id, i)}>{enabled ? '停用此段' : '启用此段'}</button>
                        <button className="small danger" onClick={() => deleteSegment(preset.id, i)}>删除段</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
        </div>
      </>
    );
  };

  return (
    <div className="section sp-section">
      <div className="section-head-row">
        <h3>正文预设</h3>
        <span className="hint" style={{ margin: 0 }}>导入 SillyTavern 风格 JSON，AI 据此与用户交流</span>
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        启用的预设会覆盖「API 配置」里的温度与 max_tokens，并按预设提示词段顺序注入。
      </div>

      <div className="btn-row" style={{ marginBottom: 12 }}>
        <label className="small primary file-btn">＋ 导入预设 JSON<input type="file" accept=".json" onChange={importPresetFile} hidden /></label>
      </div>

      {presets.length === 0 ? (
        <div className="empty-tip" style={{ padding: '24px 0' }}>
          暂无正文预设<br />
          <span className="hint">导入类似「【凡人预设】青竹 - v2.0.json」的 SillyTavern 风格预设文件</span>
        </div>
      ) : (
        <div className="sp-list">
          {presets.map(p => {
            const isOpen = openId === p.id;
            return (
              <div className={`sp-accordion ${p.enabled ? 'active' : ''} ${isOpen ? 'open' : ''}`} key={p.id}>
                <button className="sp-accordion-head" onClick={() => setOpenId(isOpen ? null : p.id)} aria-expanded={isOpen}>
                  <span className="sp-toggle" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="sp-accordion-name">{p.name}</span>
                  {p.enabled && <span className="tag ok">已启用</span>}
                  <span className="tag">{p.promptCount || (Array.isArray(p.raw?.prompts) ? p.raw.prompts.length : 0)} 段</span>
                  {p.raw?.temperature != null && <span className="tag">temp {p.raw.temperature}</span>}
                  {p.raw?.openai_max_tokens != null && <span className="tag">max_tok {p.raw.openai_max_tokens}</span>}
                  <span className="spacer" />
                </button>
                <div className="sp-accordion-actions" onClick={e => e.stopPropagation()}>
                  <button className={`small ${p.enabled ? 'primary' : ''}`} onClick={() => enablePreset(p.id)}>{p.enabled ? '停用' : '启用'}</button>
                  <button className="small" onClick={() => exportPreset(p)}>导出</button>
                  <button className="small danger" onClick={() => removePreset(p.id)}>删除</button>
                </div>
                {isOpen && (
                  <div className="sp-accordion-body">
                    {/* 重命名 */}
                    {nameEdit?.presetId === p.id ? (
                      <div className="btn-row" style={{ marginBottom: 8 }}>
                        <input type="text" value={nameEdit.value} autoFocus style={{ flex: 1 }}
                          onChange={e => setNameEdit({ presetId: p.id, value: e.target.value })}
                          onKeyDown={e => e.key === 'Enter' && renamePreset(p.id, nameEdit.value)} />
                        <button className="primary small" onClick={() => renamePreset(p.id, nameEdit.value)}>保存名称</button>
                        <button className="ghost small" onClick={() => setNameEdit(null)}>取消</button>
                      </div>
                    ) : (
                      <div className="btn-row" style={{ marginBottom: 8 }}>
                        <button className="small ghost" onClick={() => setNameEdit({ presetId: p.id, value: p.name })}>✏️ 重命名预设</button>
                      </div>
                    )}
                    <div className="section-head-row" style={{ marginBottom: 8 }}>
                      <h4 style={{ margin: 0 }}>提示词段 <span className="tab-cnt">{p.promptCount || 0}</span></h4>
                      <span className="hint" style={{ margin: 0 }}>点击段标题展开内容；编辑后自动保存</span>
                      <span className="spacer" />
                      <button className="small" onClick={() => addSegment(p.id)}>＋ 新增段</button>
                      <button className="small ghost" onClick={() => setShowRaw(v => !v)}>{showRaw ? '解析视图' : '原始 JSON'}</button>
                    </div>
                    {showRaw ? (
                      <pre className="sp-raw-view">{JSON.stringify(p.raw, null, 2)}</pre>
                    ) : (
                      renderPrompts(p)
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="hint" style={{ marginTop: 12 }}>
        同一时间只能启用一个正文预设。未启用时回退到默认提示词段。
        <br />
        段的<b>角色</b>决定它注入成哪种消息：<b>system</b> 合进系统提示（位置由「注入顺序」控制）；
        <b>user</b> / <b>assistant</b> 各自独立成条，模拟玩家或 AI 的发言，可用于示范文风、承接上文；
        <b>model</b> 是 SillyTavern 的写法，注入时按 assistant 处理。
        <br />
        直接<b>拖动段落</b>（或点段内 ↑↓ / ⤒⤓）即可调整先后顺序，改完立即保存。
        <br />
        拖动时滚轮会被浏览器吞掉，所以把段落拖到列表<b>上/下边缘</b>即会自动滚动，可以一直拖到列表任意位置；
        跨很远的位置也可以直接用段内的 <b>⤒ 置顶</b> / <b>⤓ 置底</b>。
      </div>
    </div>
  );
}

/* ================= 快照编辑规则（重点演化阶段） ================= */
function SnapshotRulesTab({ form, set, toast, saveNow }) {
  // 导入的快照演化预设（类似 完整版-物品管理.json）
  const presets = form.evolutionPresets || [];
  const setPresets = (list) => {
    if (saveNow) saveNow('evolutionPresets', list);
    else set('evolutionPresets', list);
  };
  // JSON 编辑器状态：{ id, text }
  const [editJson, setEditJson] = useState(null);

  const importPresetFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (!obj || typeof obj !== 'object') throw new Error('根必须为对象');
        // 兼容两种预设结构：
        //  旧：完整版-物品管理.json（contentTemplates/entrySharedRules/stages）
        //  新：concurrent-evo-preset-full（sharedRules/itemSharedRules/prompts/outputFormat/bioCompressionTemplate）
        const isNewStruct = obj.sharedRules || obj.itemSharedRules || (obj.prompts && typeof obj.prompts === 'object' && !Array.isArray(obj.prompts));
        const preset = {
          id: 'preset_' + Date.now().toString(36),
          name: obj.name || f.name.replace(/\.json$/i, ''),
          description: obj.description || '',
          authorCredit: obj.authorCredit || '',
          version: obj.version,
          updatedAt: obj.updatedAt || '',
          // 旧结构字段
          contentTemplates: obj.contentTemplates || {},
          entrySharedRules: obj.entrySharedRules || [],
          stages: obj.stages || [],
          // 新结构字段
          outputFormat: obj.outputFormat || '',
          sharedRules: obj.sharedRules || [],
          itemSharedRules: obj.itemSharedRules || [],
          prompts: obj.prompts || {},
          bioCompressionTemplate: obj.bioCompressionTemplate || '',
          structType: isNewStruct ? 'concurrent' : 'staged',
          enabled: true,
          importedAt: Date.now(),
        };
        setPresets([...presets, preset]);
        toast?.('ok', `预设「${preset.name}」已导入 · ${isNewStruct ? 'concurrent 新结构' : 'staged 旧结构'}`);
      } catch (err) {
        toast?.('err', '导入失败：' + err.message);
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  };

  const exportPreset = (preset) => {
    const blob = new Blob([JSON.stringify(presetToExport(preset), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${preset.name || '快照演化预设'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // 预设 → 可编辑/导出的 JSON 结构（与导入兼容）
  const presetToExport = (preset) => {
    const out = {
      name: preset.name,
      description: preset.description,
      authorCredit: preset.authorCredit,
    };
    if (preset.structType === 'concurrent') {
      out.outputFormat = preset.outputFormat;
      out.entrySharedRules = preset.entrySharedRules;
      out.sharedRules = preset.sharedRules;
      out.itemSharedRules = preset.itemSharedRules;
      out.prompts = preset.prompts;
      out.bioCompressionTemplate = preset.bioCompressionTemplate;
    } else {
      out.contentTemplates = preset.contentTemplates;
      out.entrySharedRules = preset.entrySharedRules;
      out.stages = preset.stages;
    }
    return out;
  };

  // JSON 编辑：打开（载入当前预设内容）/ 保存（校验后写回，改完即存）
  const openJsonEditor = (preset) => {
    setEditJson({ id: preset.id, text: JSON.stringify(presetToExport(preset), null, 2) });
  };
  const saveJsonEditor = () => {
    if (!editJson) return;
    let obj;
    try {
      obj = JSON.parse(editJson.text);
    } catch (e) {
      return toast('err', 'JSON 解析失败：' + e.message);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return toast('err', '根必须为对象');
    const isNewStruct = obj.sharedRules || obj.itemSharedRules || (obj.prompts && typeof obj.prompts === 'object' && !Array.isArray(obj.prompts));
    setPresets(presets.map(p => p.id === editJson.id ? {
      ...p,
      name: obj.name || p.name,
      description: obj.description || '',
      authorCredit: obj.authorCredit || '',
      version: obj.version ?? p.version,
      updatedAt: obj.updatedAt || new Date().toISOString(),
      contentTemplates: obj.contentTemplates || {},
      entrySharedRules: obj.entrySharedRules || [],
      stages: obj.stages || [],
      outputFormat: obj.outputFormat || '',
      sharedRules: obj.sharedRules || [],
      itemSharedRules: obj.itemSharedRules || [],
      prompts: obj.prompts || {},
      bioCompressionTemplate: obj.bioCompressionTemplate || '',
      structType: isNewStruct ? 'concurrent' : 'staged',
    } : p));
    setEditJson(null);
    toast('ok', `预设「${obj.name || '未命名'}」已保存`);
  };

  const togglePreset = (id) => {
    setPresets(presets.map(p => p.id === id ? { ...p, enabled: !p.enabled } : p));
  };
  const removePreset = (id) => {
    setPresets(presets.filter(p => p.id !== id));
  };
  const movePreset = (id, dir) => {
    const i = presets.findIndex(p => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= presets.length) return;
    const list = [...presets];
    [list[i], list[j]] = [list[j], list[i]];
    setPresets(list);
  };

  return (
    <div className="section" style={{ maxWidth: 'none' }}>
      <div className="section-head-row">
        <h3>导入预设 · 推荐</h3>
        <span className="hint" style={{ margin: 0 }}>支持「完整版-物品管理.json」等预设文件</span>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>
        导入的预设会作为快照演化阶段的最高指导注入 AI；规则越完整，演化越稳定。
      </div>

      <div className="btn-row" style={{ marginBottom: 12 }}>
        <label className="small primary file-btn">＋ 导入预设 JSON<input type="file" accept=".json" onChange={importPresetFile} hidden /></label>
      </div>

      {presets.length === 0 ? (
        <div className="empty-tip" style={{ padding: '16px 0' }}>
          暂无导入预设<br />
          <span className="hint">点击上方按钮，选择类似「完整版-物品管理.json」的预设文件</span>
        </div>
      ) : (
        <div className="preset-import-list">
          {presets.map((p, i) => (
            <div className={`card rule-card preset-import-item ${p.enabled ? '' : 'off'}`} key={p.id}>
              <div className="rule-card-head">
                <span className="rule-name">{p.name}</span>
                {p.stages?.length ? <span className="tag">{p.stages.length} 阶段</span> : null}
                {p.entrySharedRules?.length ? <span className="tag">{p.entrySharedRules.length} 共用规则</span> : null}
                {Object.keys(p.contentTemplates || {}).length ? <span className="tag">{Object.keys(p.contentTemplates).length} 模板</span> : null}
                {p.sharedRules?.length ? <span className="tag">{p.sharedRules.length} 共享规则</span> : null}
                {p.itemSharedRules?.length ? <span className="tag">{p.itemSharedRules.length} 物品规则</span> : null}
                {p.prompts && typeof p.prompts === 'object' && Object.keys(p.prompts).length ? <span className="tag">{Object.keys(p.prompts).length} 角色组</span> : null}
                {p.structType === 'concurrent' && <span className="tag ok">新结构</span>}
                <span className="spacer" />
                <button className="small ghost" title="上移" onClick={() => movePreset(p.id, -1)} disabled={i === 0}>↑</button>
                <button className="small ghost" title="下移" onClick={() => movePreset(p.id, 1)} disabled={i === presets.length - 1}>↓</button>
                <button className="small" onClick={() => openJsonEditor(p)}>编辑 JSON</button>
                <button className="small" onClick={() => exportPreset(p)}>导出</button>
                <button className={`small ${p.enabled ? '' : 'primary'}`} onClick={() => togglePreset(p.id)}>{p.enabled ? '停用' : '启用'}</button>
                <button className="small danger" onClick={() => removePreset(p.id)}>删除</button>
              </div>
              {p.description && <div className="hint" style={{ margin: '4px 0' }}>{p.description}</div>}
              {p.authorCredit && <div className="hint" style={{ margin: 0 }}>{p.authorCredit}</div>}
              {/* JSON 编辑器（编辑即保存） */}
              {editJson?.id === p.id && (
                <div style={{ marginTop: 8 }}>
                  <textarea
                    style={{ width: '100%', minHeight: 360, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5 }}
                    value={editJson.text}
                    onChange={e => setEditJson({ ...editJson, text: e.target.value })}
                    spellCheck={false}
                  />
                  <div className="btn-row" style={{ marginTop: 6 }}>
                    <button className="primary small" onClick={saveJsonEditor}>保存修改</button>
                    <button className="ghost small" onClick={() => setEditJson(null)}>取消</button>
                    <span className="hint" style={{ margin: 0 }}>保存后立即生效</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="ghost small" onClick={() => { if (confirm('清空所有快照演化预设？此操作不可恢复。')) { set('evolutionPresets', []); toast?.('ok', '已清空'); } }}>清空全部预设</button>
      </div>
    </div>
  );
}

/* ================= 人物生平压缩（支持导入 default.json 预设，折叠式） ================= */
function BioTab({ form, set, toast }) {
  const bio = form.bio || {};
  const setBio = (patch) => set('bio', prev => ({ ...(prev || {}), ...patch }));
  const presets = form.bioPresets || [];
  const setPresets = (list) => set('bioPresets', list);
  const [openId, setOpenId] = useState(null);
  const [editingTemplate, setEditingTemplate] = useState(null); // 编辑中的模板字符串

  const importPresetFile = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const obj = JSON.parse(reader.result);
        if (!obj || typeof obj !== 'object') throw new Error('根必须为对象');
        // 兼容 default.json 格式：{ id, name, version, bioCompressionTemplate }
        if (!obj.bioCompressionTemplate && !obj.template) {
          throw new Error('未找到 bioCompressionTemplate 字段，可能不是生平压缩预设');
        }
        const preset = {
          id: 'bp_' + Date.now().toString(36),
          name: obj.name || f.name.replace(/\.json$/i, ''),
          version: obj.version || 1,
          updatedAt: obj.updatedAt || '',
          template: obj.bioCompressionTemplate || obj.template,
          enabled: presets.length === 0,
          importedAt: Date.now(),
        };
        setPresets([...presets, preset]);
        setOpenId(preset.id);
        // 第一个导入的默认写入 bio.template 作为当前使用模板
        if (presets.length === 0) setBio({ template: preset.template });
        toast?.('ok', `预设「${preset.name}」已导入`);
      } catch (err) {
        toast?.('err', '导入失败：' + err.message);
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  };

  const exportPreset = (preset) => {
    const out = {
      id: preset.id,
      name: preset.name,
      version: preset.version,
      updatedAt: preset.updatedAt || new Date().toISOString().slice(0, 10),
      bioCompressionTemplate: preset.template,
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${preset.name || '生平压缩预设'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const enablePreset = (preset) => {
    const next = presets.map(p => ({ ...p, enabled: p.id === preset.id ? !p.enabled : false }));
    setPresets(next);
    const active = next.find(p => p.enabled);
    if (active) {
      setBio({ template: active.template });
      toast('ok', `已启用「${active.name}」并加载其压缩模板`);
    } else {
      toast('ok', `已停用「${preset.name}」`);
    }
  };
  const removePreset = (id) => {
    const p = presets.find(x => x.id === id);
    setPresets(presets.filter(p => p.id !== id));
    if (openId === id) setOpenId(null);
    toast('ok', `已删除「${p?.name}」`);
  };

  return (
    <div className="section sp-section">
      <div className="section-head-row">
        <h3>人物生平压缩预设</h3>
        <span className="hint" style={{ margin: 0 }}>导入 default.json 等生平压缩预设</span>
      </div>
      <div className="hint" style={{ marginBottom: 12 }}>
        导入的预设自带压缩模板，AI 压缩角色生平与记忆时严格遵循该模板。启用的模板会写入下方编辑区。
      </div>

      <div className="btn-row" style={{ marginBottom: 12 }}>
        <label className="small primary file-btn">＋ 导入压缩预设 JSON<input type="file" accept=".json" onChange={importPresetFile} hidden /></label>
      </div>

      {presets.length === 0 ? (
        <div className="empty-tip" style={{ padding: '24px 0' }}>
          暂无压缩预设<br />
          <span className="hint">导入类似「default.json」的生平压缩预设文件</span>
        </div>
      ) : (
        <div className="sp-list">
          {presets.map(p => {
            const isOpen = openId === p.id;
            return (
              <div className={`sp-accordion ${p.enabled ? 'active' : ''} ${isOpen ? 'open' : ''}`} key={p.id}>
                <button className="sp-accordion-head" onClick={() => setOpenId(isOpen ? null : p.id)} aria-expanded={isOpen}>
                  <span className="sp-toggle" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="sp-accordion-name">{p.name}</span>
                  {p.enabled && <span className="tag ok">已启用</span>}
                  {p.version && <span className="tag">v{p.version}</span>}
                  {p.updatedAt && <span className="tag">{p.updatedAt}</span>}
                  <span className="spacer" />
                </button>
                <div className="sp-accordion-actions" onClick={e => e.stopPropagation()}>
                  <button className={`small ${p.enabled ? 'primary' : ''}`} onClick={() => enablePreset(p)}>{p.enabled ? '停用' : '启用并加载模板'}</button>
                  <button className="small" onClick={() => exportPreset(p)}>导出</button>
                  <button className="small danger" onClick={() => removePreset(p.id)}>删除</button>
                </div>
                {isOpen && (
                  <div className="sp-accordion-body">
                    <div className="section-head-row" style={{ marginBottom: 8 }}>
                      <h4 style={{ margin: 0 }}>压缩模板</h4>
                      <span className="hint" style={{ margin: 0 }}>占位符 ${'{characters_payload}'} = 待压缩的角色载荷</span>
                    </div>
                    <pre className="sp-raw-view">{p.template}</pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="section-head-row" style={{ marginTop: 20 }}>
        <h3>当前使用模板</h3>
        <span className="hint" style={{ margin: 0 }}>可直接编辑；失焦后自动保存并生效</span>
      </div>
      <textarea
        className="preset-content-input"
        style={{ minHeight: 220 }}
        value={editingTemplate ?? bio.template ?? DEFAULT_BIO_TEMPLATE}
        onChange={e => setEditingTemplate(e.target.value)}
        onBlur={() => { if (editingTemplate != null) { setBio({ template: editingTemplate }); setEditingTemplate(null); } }}
      />
      <div className="field" style={{ marginTop: 16 }}>
        <label>生平条目超过 N 条时触发压缩</label>
        <input type="number" min="5" max="200" value={bio.threshold ?? 30} onChange={e => setBio({ threshold: Number(e.target.value) || 30 })} style={{ width: 140 }} />
        <div className="hint">每回合记录一条主角生平；超过阈值后压缩为摘要。</div>
      </div>
    </div>
  );
}

/* ================= 故事记忆设置 ================= */
function MemoryTab({ form, set }) {
  const mem = form.memory || {};
  const setMem = (patch) => set('memory', prev => ({ ...(prev || {}), ...patch }));
  const num = (key, label, hint, min, max, ph) => (
    <div className="field">
      <label>{label}</label>
      <input type="number" min={min} max={max} value={mem[key] ?? ''} placeholder={ph}
        onChange={e => setMem({ [key]: Number(e.target.value) || undefined })} style={{ width: 140 }} />
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
  return (
    <div className="section" style={{ maxWidth: 'none' }}>
      <h3>叙事记忆 · 回合摘要 + 阶段总结</h3>
      <div className="hint" style={{ marginBottom: 12, lineHeight: 1.7 }}>
        本模块配置 AI 的长期剧情记忆：每回合正文结束后，AI 自动把当回合剧情压缩成一条<b>回合摘要</b>；
        每积累 N 条摘要，再自动浓缩成一条<b>阶段总结</b>，覆盖这 N 个回合的脉络。
        注入提示词时按「最近几条阶段总结（更早剧情脉络）+ 最近几条回合摘要（近期细节）」<b>近细远粗</b>地组织，
        让 AI 记得几十回合前的关键剧情。记忆生成不阻塞回合流程。
      </div>
      <div className="field">
        <label>启用叙事记忆</label>
        <div className="btn-row">
          <button className={mem.enabled !== false ? 'primary' : ''} onClick={() => setMem({ enabled: true })}>启用</button>
          <button className={mem.enabled === false ? 'primary' : ''} onClick={() => setMem({ enabled: false })}>停用</button>
        </div>
        <div className="hint">停用后不再生成任何记忆，正文阶段也不会注入历史剧情摘要。</div>
      </div>
      <h4 style={{ margin: '14px 0 4px' }}>① 回合摘要 · 每回合生成一条</h4>
      {num('summaryLen', '单条摘要字数上限', 'AI 压缩摘要时的目标字数 · 默认 60', 20, 300, '60')}
      {num('keepSummaries', '最多保留摘要条数', '超出后自动滚动淘汰最旧的 · 默认 40', 5, 200, '40')}
      {num('injectSummaries', '注入提示词的最近摘要条数', '每轮正文请求携带的近期剧情细节条数 · 默认 10', 1, 40, '10')}
      <h4 style={{ margin: '14px 0 4px' }}>② 阶段总结 · 每 N 条摘要自动浓缩一条</h4>
      <div className="field">
        <label>启用阶段总结</label>
        <div className="btn-row">
          <button className={mem.recapEnabled !== false ? 'primary' : ''} onClick={() => setMem({ recapEnabled: true })}>启用</button>
          <button className={mem.recapEnabled === false ? 'primary' : ''} onClick={() => setMem({ recapEnabled: false })}>停用</button>
        </div>
        <div className="hint">停用后只保留回合摘要——近期记忆精确，但几十回合前的剧情会逐渐「失忆」。</div>
      </div>
      {num('recapEvery', '每 N 条摘要生成一条总结', '默认 10，即每 10 回合左右沉淀一条全局脉络', 2, 50, '10')}
      {num('recapLen', '单条总结字数上限', '默认 150', 40, 500, '150')}
      {num('keepRecaps', '最多保留总结条数', '默认 10', 2, 50, '10')}
      {num('injectRecaps', '注入提示词的最近总结条数', '每轮正文请求携带的更早剧情脉络条数 · 默认 5，约覆盖 50 回合', 1, 20, '5')}
    </div>
  );
}

/* ================= 战斗模式 ================= */
// 这里只有两个开关：谁来决定战斗、以及「保底血量」这道安全线。
// 开启后：AI 不再自己推演战斗，只在正文里输出 <battle> 布置指令（谁打谁、在哪里打、什么地形）；
//         程序按角色快照建 15×15 战场，行动顺序与伤害全部由程序算，轮到主角时由玩家亲手操作。
function BattleTab({ form, set }) {
  const b = form.battle || {};
  const manual = b.mode === 'manual';
  const setB = (patch) => set('battle', prev => ({ ...(prev || {}), ...patch }));

  return (
    <div className="section" style={{ maxWidth: 'none' }}>
      <h3>战斗模式</h3>
      <div className="hint" style={{ marginBottom: 12, lineHeight: 1.75 }}>
        项目里关于战斗的一切都由这一个开关决定，两套流程互斥，不会同时生效。
      </div>

      <div className="field">
        <label>程序接管战斗</label>
        <div className="btn-row">
          <button className={manual ? 'primary' : ''} onClick={() => setB({ mode: 'manual' })}>开启</button>
          <button className={!manual ? 'primary' : ''} onClick={() => setB({ mode: 'auto' })}>关闭</button>
        </div>
        <div className="hint" style={{ lineHeight: 1.8 }}>
          <b>开启</b>：AI 只在正文里留一条战场布置（谁和谁打、地形如何），随后程序弹出 15×15 战棋界面接管整场战斗。
          行动顺序按<b>境界档位</b>算（凡人到道祖共 49 档，每档一个固定速度，境界越高出手越密），
          移动范围按脚力算，伤害＝「功法威力（由品阶定死，每高一品强两成）× 掷骰子掷出来的运气 × 双方攻防」，
          胜负由程序裁定；轮到主角时<b>由你亲手出招</b>，
          打完把战报交回 AI，由它写过程与结局。<br />
          <b>关闭</b>：维持原来的做法——AI 在思考里自行推演战斗，直接给结果，玩家不参与（当前默认）。
        </div>
      </div>

      <div className="field">
        <label>气血归零才退场</label>
        <div className="hint" style={{ lineHeight: 1.8 }}>
          已取消「保底血量」机制：无论寻常交手还是死斗，气血都可一路扣到 <b>0</b>，归零即退出战斗；
          角色是死是伤，由战后 AI 叙事描写（死斗则直接判死亡）。不再有「打到两成血线就停手」的安全线。
        </div>
      </div>

      <h3 style={{ marginTop: 24 }}>玩家在战斗里能做什么</h3>
      <div className="hint" style={{ lineHeight: 1.9 }}>
        · <b>移动</b>：每回合能走多远由脚力决定（6~12 格），泥地沼泽多花格数，耸峰过不去。<br />
        · <b>普攻</b>：贴身一格，伤害最低但永远可用、不耗法力。<br />
        · <b>技能</b>：与角色面板「技能」完全同一份数据，能不能打得看攻击距离，耗蓝按角色自己的法力池现算。<br />
        · <b>物品</b>：储物袋里能应急的丹药之类，用掉会真的从清单里扣。<br />
        · <b>动作</b>：防御、蓄力、以势压人、逃遁、认输——人人都会，不耗任何资源。
      </div>

      <h3 style={{ marginTop: 24 }}>对手由谁指挥</h3>
      <div className="hint" style={{ lineHeight: 1.9 }}>
        对手的每一步由程序枚举全部合法走法与招式，按真实公式估收益后取最优——快、免费、不会算错。
        AI 负责的是它在场上的性格与目标（写在其人物快照里），不负责逐个数字。这样同一场战斗打得快、结果可信，
        也不会因为网络卡住而停在半路。
      </div>
    </div>
  );
}
