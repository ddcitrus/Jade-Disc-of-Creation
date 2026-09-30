import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 快照 v2 的校验口径与前端共用同一份实现（服务端与客户端不允许漂移）
// ⚠ 下面这几行跨目录 import 会把「整条前端数据模块图」拖进 node 直跑路径，两条硬约束：
//   ① 链上任何模块都不得**裸 import JSON** —— 必须写成 `with { type: 'json' }`
//      （client/src/data/numericTuning.js 的数值表已按此写法）。少了 attribute，node 会在
//      listen 之前抛 ERR_IMPORT_ATTRIBUTE_MISSING，后端在写任何日志之前就退出；用户看到的是
//      「双击启动脚本，窗口刷一堆 assert 栈后自动关闭」。2026-09-26 踩过一次，别再犯。
//   ② 不要在这里新增依赖浏览器 API / .jsx / .css 的模块。
//   自检：用系统 node（v24）动态 import 一次 snapshotV2.js，能加载成功即整链可加载。
import { parseEditBlock, validateV2Snapshot } from '../client/src/data/snapshotV2.js';
import { sanitizeSaveInPlace, stripPlayerBlockInPlace } from '../client/src/data/saveSanitize.js';
import { parseEvolutionV2Text, buildRewriteFeedbackV2 } from '../client/src/data/evolutionV2Envelope.js';
// 新增角色的属性区间校验（零依赖模块，与客户端校界 attrClamp 同一口径）
import { checkV2RealmBounds, realmBoundsHintFor } from '../client/src/data/realmBounds.js';
// 前缀缓存用量统计与上游请求封装（零依赖模块，探针可直接 import 验证）
import { createUsageStats, createChatPoster } from './aiUsage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.FANREN_DATA_DIR || path.join(__dirname, 'data'); // 桌面版可通过环境变量重定向数据目录
const SAVES_DIR = path.join(DATA_DIR, 'saves');
const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
const CHAR_SNAPS_DIR = path.join(DATA_DIR, 'char_snaps'); // 各角色独立快照存储
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const FACTOR_LIBRARY_FILE = path.join(DATA_DIR, 'factor-library.json'); // 世界因子库（跨存档：自定义因子 + 组合）
const WORLD_BOOK_FILE = path.join(DATA_DIR, 'worldbook.json'); // 世界书（跨存档共用，不放在各存档里）

fs.mkdirSync(SAVES_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
fs.mkdirSync(CHAR_SNAPS_DIR, { recursive: true });

const DEFAULT_SETTINGS = {
  // 正文与快照一律走 OpenAI 兼容接口（mode 恒为 ai）
  mode: 'ai',
  // 接口库：[{ id, name, baseUrl, apiKey, model, temperature }]，正文 / 快照两个通道各自选用
  // 落盘在 settings.json，跨存档共用；空库且未迁移过时从 ai / aiSnapshot 自动迁移一条
  apiEndpoints: [],
  apiMigrated: false,
  storyEndpointId: '',     // 正文通道使用的接口 id（'' = 库里第一条已填地址的）
  snapshotEndpointId: '',  // 快照通道使用的接口 id（'' = 与正文相同）
  // 以下两个字段是单通道时期的配置，仅作为迁移来源保留，界面不读写
  ai: { baseUrl: '', apiKey: '', model: '', temperature: 0.9 },
  aiSnapshot: { enabled: false, baseUrl: '', apiKey: '', model: '', temperature: 0.4 },
  // 正文输出预算硬顶（max_tokens）。推理模型的思考 token 也计入——若正文总被截断请调大；0 = 不设顶
  storyMaxTokens: 32768,
  fontSize: 16,
  lineHeight: 1.95, // 正文行距倍数（设置页「显示与字体」可调）
  // 数值规则表（Mortal 数值体系）：null = 使用前端内置 mortal-numeric-tuning 表；
  // 结构 { enabled, enforce, applyTo:{playerB1,npcs}, disabledTables:[], tables:{ 表名: 整张表 } }
  //   enabled=false 不注入；enforce=false 关闭「属性越界强制写回边界」；
  //   tables 为「用户覆盖层」——只存被编辑过的表，未覆盖的表走内置默认（见 numericTuning.getEffectiveTables）
  numericTuning: null,
  // 正文规则与文风
  // colorPalette：正文着色词表 { mode:'off'|'strict', list:[{name,value,desc}] }；null = 使用前端内置默认
  textRules: { minWords: 200, maxWords: 400, style: 'fanren', customStyle: '', colorPalette: null },
  // 提示词注入顺序（设置 → 注入顺序）；null = 用内置默认排布
  promptLayout: null,
  // 故事设定
  story: {
    narrativePerson: 'second',     // first | second | third
    autoSnapshotEvery: 10,         // 每 N 回合自动快照（0 = 关闭）
  },
  // 正文预设（提示词段落，支持占位符）—— 注：这是占位符/注入段编辑，非真正预设
  prompts: null, // null = 使用前端默认预设
  // 真正的正文预设：导入的 SillyTavern 风格预设 JSON
  // 结构：[{ id, name, enabled, raw: { prompts:[], prompt_order:[], temperature, openai_max_tokens, ... }, importedAt }]
  storyPresets: [],
  // 快照编辑规则（重点演化各阶段）：保留兼容旧字段
  evolutionRules: null,
  // 新增：导入的快照演化预设
  // 结构：{ name, description, contentTemplates, entrySharedRules, stages }[]
  evolutionPresets: [],
  // 故事记忆（叙事记忆）
  memory: { enabled: true, summaryLen: 60, keepSummaries: 40, injectSummaries: 10, recapEnabled: true, recapEvery: 10, recapLen: 150, injectRecaps: 5, keepRecaps: 10 },
  // 演化自动重写次数上限（格式不合规时打回）
  evolutionMaxRetries: 3,
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

function readSettings() {
  let out;
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    out = deepMerge(structuredClone(DEFAULT_SETTINGS), saved);
  } catch {
    out = structuredClone(DEFAULT_SETTINGS);
  }
  return applyApiConfig(out);
}

// 深度合并（数组与 null 直接覆盖）
function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch;
  const out = (typeof base === 'object' && base !== null && !Array.isArray(base)) ? base : {};
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v))
      ? deepMerge(out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? out[k] : {}, v)
      : v;
  }
  return out;
}

function saveFile(id) {
  return path.join(SAVES_DIR, `${id}.json`);
}

// ---------- 接口库：多接口保存，正文 / 快照各自选用 ----------
// 与 client/src/data/apiEndpoints.js 的 storyEndpointOf / snapshotEndpointOf 是同一套规则，
// 改一边务必同步另一边（服务端不 import 前端源码，前端也不 import 服务端）。
function normalizeEndpoint(ep, i = 0) {
  const e = ep && typeof ep === 'object' ? ep : {};
  const t = Number(e.temperature);
  return {
    id: String(e.id || 'ep-' + (i + 1)),
    name: String(e.name || '接口 ' + (i + 1)),
    baseUrl: String(e.baseUrl || ''),
    apiKey: String(e.apiKey || ''),
    model: String(e.model || ''),
    temperature: Number.isFinite(t) ? Math.min(1.5, Math.max(0, t)) : 0.9,
  };
}

function normalizeEndpointList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  raw.forEach((ep, i) => {
    const n = normalizeEndpoint(ep, i);
    let id = n.id;
    let k = 2;
    while (seen.has(id)) { id = n.id + '-' + k; k += 1; }
    seen.add(id);
    out.push({ ...n, id });
  });
  return out;
}

function storyEndpoint(s) {
  const list = normalizeEndpointList(s.apiEndpoints);
  const want = list.find(e => e.id && e.id === String(s.storyEndpointId || '')) || null;
  if (want && want.baseUrl.trim()) return want;
  return list.find(e => e.baseUrl.trim()) || want || list[0] || null;
}

function snapshotEndpoint(s) {
  const list = normalizeEndpointList(s.apiEndpoints);
  const want = list.find(e => e.id && e.id === String(s.snapshotEndpointId || '')) || null;
  if (want && want.baseUrl.trim()) return want;
  return storyEndpoint(s);
}

// 解析后的 settings：settings.ai 恒等于「正文通道当前接口」，
// 于是所有读 settings.ai 的老代码（正文路由 / 宏 {{model}} / 测试连接）自动跟随通道选择。
function applyApiConfig(s) {
  s.mode = 'ai';
  s.apiEndpoints = normalizeEndpointList(s.apiEndpoints);
  // 单通道配置 → 迁移进接口库。只在「库为空 且 从未迁移过」时执行，
  // 否则用户把接口全删光后，残留的旧字段会把它变回来。
  if (!s.apiEndpoints.length && !s.apiMigrated) {
    const legacy = s.ai || {};
    if (typeof legacy.baseUrl === 'string' && legacy.baseUrl.trim()) {
      s.apiEndpoints.push(normalizeEndpoint({
        id: 'ep-legacy-story', name: '默认接口',
        baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, model: legacy.model, temperature: legacy.temperature,
      }));
    }
    const sn = s.aiSnapshot || {};
    if (sn.enabled && typeof sn.baseUrl === 'string' && sn.baseUrl.trim()) {
      s.apiEndpoints.push(normalizeEndpoint({
        id: 'ep-legacy-snapshot', name: '快照接口',
        baseUrl: sn.baseUrl, apiKey: sn.apiKey, model: sn.model,
        temperature: Number.isFinite(Number(sn.temperature)) ? Number(sn.temperature) : 0.4,
      }));
    }
    s.apiMigrated = true;
  }
  const st = storyEndpoint(s);
  s.storyEndpointId = st ? st.id : String(s.storyEndpointId || '');
  const snapId = String(s.snapshotEndpointId || '');
  if (snapId && !s.apiEndpoints.some(e => e.id === snapId && e.baseUrl.trim())) s.snapshotEndpointId = '';
  // 没有可用接口时清空 ai，避免残留的旧地址被当成有效配置
  s.ai = st ? { ...st } : { baseUrl: '', apiKey: '', model: '', temperature: 0.9 };
  return s;
}

// 快照通道生效配置（快照演化 / 初始快照 / 助手·导演·记忆压缩等结构化任务）
function snapshotAISettings(settings) {
  const ep = snapshotEndpoint(settings);
  return { ...settings, ai: ep ? { ...ep } : { ...(settings.ai || {}) } };
}

// ---------- 存档 API ----------
app.get('/api/saves', (req, res) => {
  const list = fs.readdirSync(SAVES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SAVES_DIR, f), 'utf-8'));
        return {
          id: s.id, name: s.name, updatedAt: s.updatedAt, createdAt: s.createdAt,
          summary: {
            charName: s.character?.name,
            gender: s.character?.gender,
            race: s.character?.race?.name,
            realm: s.character?.realm?.name,
            root: s.character?.root?.name,
            turnCount: s.turnCount,
            timeLabel: s.world?.timeLabel
          }
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json(list);
});

app.post('/api/saves', (req, res) => {
  const save = req.body;
  if (!save || !save.id) return res.status(400).json({ error: 'invalid save' });
  // 记忆（memories / memoryRecaps）只由下方 /api/saves/:id/memories 维护，这里默认不认客户端带上来的那一份。
  // 原因：记忆是回合结束后**异步**追加的，客户端手里的副本常停在追加之前；每回合开场这次整份覆盖
  // 会把刚追加的那条冲掉（逐回合实测 story[].payload.memories 恒为 0/1 条，条数从不增长，
  // 阶段总结因此永远不满足「满 10 条」的触发条件）。
  // 例外：回退到某回合 / 重新生成 / 重新发送 —— 它们本就要把记忆退回到那一刻，客户端会显式声明 rollbackMemories。
  const rollbackMemories = !!save.rollbackMemories;
  delete save.rollbackMemories;   // 标记不进存档文件
  if (!rollbackMemories) {
    try {
      const prev = JSON.parse(fs.readFileSync(saveFile(save.id), 'utf-8'));
      save.memories = Array.isArray(prev.memories) ? prev.memories : [];
      save.memoryRecaps = Array.isArray(prev.memoryRecaps) ? prev.memoryRecaps : [];
    } catch { /* 首次落盘：文件还不存在，沿用客户端交上来的 */ }
  }
  // 兜底自愈：老版本客户端内存里可能是「姓名 = B1 / 长期目标 = 性格底色」的坏数据，
  // 它会整份覆盖上来。在这里过一遍同一份修复规则，保证磁盘永远不会被写脏。
  const healed = sanitizeSaveInPlace(save);
  if (healed.length) console.log('[save] 已自愈脏字段:', save.id, healed.join('；'));
  save.updatedAt = Date.now();
  fs.writeFileSync(saveFile(save.id), JSON.stringify(save, null, 2), 'utf-8');
  res.json({ ok: true, updatedAt: save.updatedAt, healed });
});

app.get('/api/saves/:id', (req, res) => {
  const f = saveFile(req.params.id);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'not found' });
  const save = JSON.parse(fs.readFileSync(f, 'utf-8'));
  // 读的时候也自愈：这样即使前端跑的是旧 bundle，拿到的也是干净数据，
  // 它下一次保存就不会再把坏数据带回来。
  const healed = sanitizeSaveInPlace(save);
  if (healed.length) {
    srvLog('[save] 读取时自愈:', req.params.id, healed.join('；'));
    try { fs.writeFileSync(f, JSON.stringify(save, null, 2), 'utf-8'); } catch {}
  }
  res.json(save);
});

// 叙事记忆追加（服务端读改写单文件，避免客户端拿旧存档全量覆盖、冲掉用户并发修改的世界书等状态）
// body: { entry?: {turn,timeLabel,summary}, recap?: {fromTurn,toTurn,turn,summary} }
app.post('/api/saves/:id/memories', (req, res) => {
  const body = req.body || {};
  if (!body.entry && !body.recap) return res.status(400).json({ error: 'entry or recap required' });
  const f = saveFile(req.params.id);
  let save;
  try { save = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { return res.status(404).json({ error: '存档不存在' }); }
  if (body.entry && body.entry.summary) {
    const t = body.entry.turn;
    save.memories = save.memories || [];
    // 同回合去重：重新生成时替换而非重复追加
    const idx = save.memories.findIndex(m => m.turn === t);
    if (idx >= 0) save.memories[idx] = body.entry;
    else save.memories.push(body.entry);
    save.memories = save.memories.slice(-(Number(body.keep?.summaries) || 40));
  }
  if (body.recap && body.recap.summary) {
    save.memoryRecaps = save.memoryRecaps || [];
    const idx = save.memoryRecaps.findIndex(r => r.toTurn === body.recap.toTurn);
    if (idx >= 0) save.memoryRecaps[idx] = body.recap;
    else save.memoryRecaps.push(body.recap);
    save.memoryRecaps = save.memoryRecaps.slice(-(Number(body.keep?.recaps) || 10));
  }
  save.updatedAt = Date.now();
  fs.writeFileSync(f, JSON.stringify(save, null, 2), 'utf-8');
  res.json({ ok: true, memories: (save.memories || []).length, memoryRecaps: (save.memoryRecaps || []).length });
});


app.delete('/api/saves/:id', (req, res) => {
  const f = saveFile(req.params.id);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  res.json({ ok: true });
});

// ---------- 设置 API ----------
// 世界书是跨存档共用的独立文件，附带在设置里一并返回，前端读起来跟预设一样；
// 但**写入只走 PUT /api/worldbook** —— 设置页保存的是「打开设置页那一刻」的整份快照，
// 若允许它覆盖世界书，玩家在设置页停留期间对世界书的增删会被这次保存回滚掉。
app.get('/api/settings', (req, res) => res.json({ ...readSettings(), worldbook: readWorldbook() }));
app.put('/api/settings', (req, res) => {
  const cur = readSettings();
  // 合并后重新解析：接口库归一化、通道 id 校正、settings.ai 与正文通道保持一致
  const body = { ...(req.body || {}) };
  delete body.worldbook; // 世界书不进设置文件，改它走 PUT /api/worldbook
  const next = applyApiConfig(deepMerge(cur, body));
  next._savedAt = Date.now(); // 版本戳：客户端据此判断新旧，避免竞态读到旧设置
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8');
  // 返回值与 GET 同形态：带上世界书。否则调用方把返回值存回内存设置后，
  // 世界书会变成 undefined —— 界面显示空、提示词里那段也随之消失。
  res.json({ ...next, worldbook: readWorldbook() });
});

// ---------- 世界因子库（跨存档共享） ----------
// 存在独立文件里，不跟 settings 抢字段：
//   custom → 用户自定义因子定义（任何存档都能选用）
//   sets   → 因子组合（一套启用的因子，可一键套用到其它存档）
function normalizeFactor(f) {
  if (!f || typeof f !== 'object') return null;
  const name = String(f.name || '').trim();
  if (!name) return null;
  return { name, desc: String(f.desc || ''), effect: String(f.effect || '自定义世界规则。') };
}
function uniqueFactors(list) {
  const map = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const factor = normalizeFactor(item);
    if (factor) map.set(factor.name, factor); // 同名以最后一条为准
  }
  return [...map.values()];
}
function normalizeFactorLibrary(body) {
  const src = body && typeof body === 'object' ? body : {};
  const sets = [];
  const seen = new Set();
  for (const item of Array.isArray(src.sets) ? src.sets : []) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name || seen.has(name)) continue;
    const factors = uniqueFactors(item.factors);
    if (factors.length === 0) continue;
    seen.add(name);
    const createdAt = Number(item.createdAt) || Date.now();
    sets.push({
      id: String(item.id || '') || `fset_${createdAt.toString(36)}_${sets.length}`,
      name,
      note: String(item.note || ''),
      factors,
      createdAt,
      updatedAt: Number(item.updatedAt) || createdAt,
    });
  }
  return { custom: uniqueFactors(src.custom), sets };
}
function readFactorLibrary() {
  try {
    return normalizeFactorLibrary(JSON.parse(fs.readFileSync(FACTOR_LIBRARY_FILE, 'utf-8')));
  } catch { return { custom: [], sets: [] }; }
}
// ---------- 世界书（跨存档共用，与因子库同级） ----------
// 所有存档共用 server/data/worldbook.json 这一个文件，不再各存一套。
// 前端从 GET /api/settings 拿到（见下方 settings 接口），写入只走 PUT /api/worldbook。
function normalizeWorldbook(src) {
  const list = Array.isArray(src) ? src : (Array.isArray(src?.entries) ? src.entries : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim();
    if (!name) continue;
    const id = String(item.id || '') || `wb_${Date.now().toString(36)}_${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      keywords: (Array.isArray(item.keywords) ? item.keywords : []).map(k => String(k)).filter(Boolean),
      content: String(item.content || ''),
      enabled: item.enabled !== false,
      always: !!item.always,
      source: String(item.source || ''),
    });
  }
  return out;
}
function readWorldbook() {
  try {
    return normalizeWorldbook(JSON.parse(fs.readFileSync(WORLD_BOOK_FILE, 'utf-8')));
  } catch { return []; }
}
app.get('/api/worldbook', (req, res) => res.json(readWorldbook()));
app.put('/api/worldbook', (req, res) => {
  const next = normalizeWorldbook(req.body);
  fs.writeFileSync(WORLD_BOOK_FILE, JSON.stringify(next, null, 2), 'utf-8');
  res.json(next);
});

app.get('/api/factor-library', (req, res) => res.json(readFactorLibrary()));
app.put('/api/factor-library', (req, res) => {
  const next = normalizeFactorLibrary(req.body);
  fs.writeFileSync(FACTOR_LIBRARY_FILE, JSON.stringify(next, null, 2), 'utf-8');
  res.json(next);
});

// ---------- 人生快照 API ----------
// 快照 = 某一时刻的角色/世界/剧情状态存档，可手动或自动创建，可编辑与恢复
function snapDir(saveId) {
  return path.join(SNAPSHOTS_DIR, String(saveId).replace(/[^\w-]/g, '_'));
}
function snapFile(saveId, snapId) {
  return path.join(snapDir(saveId), `${snapId}.json`);
}
function safeId(id) {
  return String(id).replace(/[^\w-]/g, '_');
}

// 快照列表（仅元信息）
app.get('/api/saves/:id/snapshots', (req, res) => {
  const dir = snapDir(req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return { id: s.id, saveId: s.saveId, label: s.label, source: s.source, summary: s.summary, createdAt: s.createdAt, turnCount: s.turnCount, timeLabel: s.timeLabel };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json(list);
});

// 创建快照（body: { label, source, summary, payload }）
app.post('/api/saves/:id/snapshots', (req, res) => {
  const saveId = req.params.id;
  const body = req.body || {};
  if (!body.payload) return res.status(400).json({ error: 'payload required' });
  const snap = {
    id: 'snap_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    saveId,
    label: (body.label || '').trim() || `人生快照 ${new Date().toLocaleString('zh-CN')}`,
    source: body.source || 'manual', // manual | turn（回合自动）| assistant（天道助手前备份）
    summary: body.summary || '',
    turnCount: body.turnCount ?? null,
    timeLabel: body.timeLabel || '',
    createdAt: Date.now(),
    payload: body.payload,
  };
  fs.mkdirSync(snapDir(saveId), { recursive: true });
  fs.writeFileSync(snapFile(saveId, snap.id), JSON.stringify(snap, null, 2), 'utf-8');
  const { payload, ...meta } = snap;
  res.json(meta);
});

// 快照详情（含 payload）
app.get('/api/snapshots/:sid', (req, res) => {
  // sid 形如 snap_xxx，可能分布在任意存档目录；遍历查找
  const sid = safeId(req.params.sid);
  if (!fs.existsSync(SNAPSHOTS_DIR)) return res.status(404).json({ error: 'not found' });
  for (const dir of fs.readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = path.join(SNAPSHOTS_DIR, dir.name, `${sid}.json`);
    if (fs.existsSync(f)) return res.json(JSON.parse(fs.readFileSync(f, 'utf-8')));
  }
  res.status(404).json({ error: 'not found' });
});

// 编辑快照（label / payload）
app.put('/api/snapshots/:sid', (req, res) => {
  const sid = safeId(req.params.sid);
  for (const dir of fs.readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = path.join(SNAPSHOTS_DIR, dir.name, `${sid}.json`);
    if (!fs.existsSync(f)) continue;
    const snap = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const body = req.body || {};
    if (typeof body.label === 'string' && body.label.trim()) snap.label = body.label.trim();
    if (body.payload) snap.payload = body.payload;
    if (typeof body.summary === 'string') snap.summary = body.summary;
    snap.updatedAt = Date.now();
    fs.writeFileSync(f, JSON.stringify(snap, null, 2), 'utf-8');
    return res.json({ ok: true, updatedAt: snap.updatedAt });
  }
  res.status(404).json({ error: 'not found' });
});

// 删除快照
app.delete('/api/snapshots/:sid', (req, res) => {
  const sid = safeId(req.params.sid);
  for (const dir of fs.readdirSync(SNAPSHOTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const f = path.join(SNAPSHOTS_DIR, dir.name, `${sid}.json`);
    if (fs.existsSync(f)) { fs.unlinkSync(f); return res.json({ ok: true }); }
  }
  res.status(404).json({ error: 'not found' });
});

// ---------- AI 代理（转发到本地 OpenAI 兼容接口，避免浏览器跨域） ----------
// presetOverride: 可选，来自启用的正文预设，覆盖 temperature/max_tokens
// 清洗上游错误：HTML 错误页（如 Cloudflare 524）提取为简洁信息，不透传整页 HTML
function cleanUpstreamError(status, text) {
  const raw = String(text || '').trim();
  if (status === 524) {
    return `AI 接口返回 524：上游代理超时（Cloudflare 网关约 100 秒内未收到响应，多为生成长度/代理负载导致，通常可重试）`;
  }
  if (/<html|<!DOCTYPE/i.test(raw)) {
    const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const detail = t ? t[1].trim() : '上游返回 HTML 错误页';
    return `AI 接口返回 ${status}：${detail}`;
  }
  return `AI 接口返回 ${status}${raw ? '：' + raw.slice(0, 300) : ''}`;
}

// ---------- AI 调试日志（持久化到 data/ai-debug.log，排查「AI 未返回内容」类问题） ----------
// ⚠️ 后台运行时 stdout 常常是一条管道，读端（启动它的终端/任务）一旦消失，管道写满即阻塞。
// 同步写满管道的调用会把**整个事件循环**冻住：所有请求（连 GET /）全部超时、CPU 归零、
// 日志停在最后一行之前——2026-09-16 的服务端假死就是这么来的。
// 因此：日志一律先落文件；控制台只在**交互终端**下回显，后台/重定向时一个字都不往 stdout 写。
process.stdout.on('error', () => { /* 吞掉 EPIPE，别让它抛崩进程 */ });
process.stderr.on('error', () => { /* 同上 */ });
const AI_DEBUG_LOG = path.join(DATA_DIR, 'ai-debug.log');
function writeLog(line) {
  try { fs.appendFileSync(AI_DEBUG_LOG, line + '\n'); } catch { /* 磁盘异常不影响主流程 */ }
}
function consoleEcho(tag, args) {
  if (!process.stdout.isTTY) return;
  try { console.log(tag, ...args); } catch { /* 忽略 */ }
}
function aiLog(...args) {
  writeLog(`[${new Date().toISOString()}] ${args.join(' ')}`);
  consoleEcho('[ai]', args);
}
// 服务端通用日志（启动横幅、存档自愈等）：进文件，控制台仅在 TTY 下回显
function srvLog(...args) {
  writeLog(`[${new Date().toISOString()}] ${args.join(' ')}`);
  consoleEcho('[造化玉碟]', args);
}

// ---------- 前缀缓存命中统计 + 上游请求封装 ----------
// 实现抽在 server/aiUsage.js（零依赖，带探针），这里只做接线。
const usageStats = createUsageStats({ filePath: path.join(DATA_DIR, 'ai-stats.json'), log: aiLog });
const chatPoster = createChatPoster({ log: aiLog });
const recordUsage = (kind, usageObj) => usageStats.record(kind, usageObj);
// 附 stream_options.include_usage 请求用量；上游 400 拒绝时自动降级重试（见 aiUsage.js）
const postChat = (url, headers, body, signal) => chatPoster.post(url, headers, body, signal);

async function callAI(settings, messages, maxTokens = 2000, presetOverride = null) {
  const { baseUrl, apiKey, model } = settings.ai;
  if (!String(baseUrl || '').trim()) {
    throw new Error('未配置接口地址：请在「设置 → API 配置」里添加接口，并为该通道选择接口');
  }
  // 预设可覆盖温度与 max_tokens
  let temperature = Number(presetOverride?.temperature ?? settings.ai.temperature);
  if (!Number.isFinite(temperature)) temperature = 0.9;
  // max_tokens：若预设指定了 openai_max_tokens，优先用预设值（青竹预设 52000）
  // 预设值直接覆盖请求值，不做 min() 截断——预设值是作者按模型能力设定的上限
  if (presetOverride?.openai_max_tokens && Number(presetOverride.openai_max_tokens) > 0) {
    maxTokens = Number(presetOverride.openai_max_tokens);
  }
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300000); // 5 分钟总超时
  // 停滞看门狗：90 秒收不到任何数据（上游卡死/代理挂起）→ 中止，由调用方重试
  let stalledFlag = false;
  let stallTimer = setTimeout(() => { stalledFlag = true; ctrl.abort(); }, 90000);
  const resetStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => { stalledFlag = true; ctrl.abort(); }, 90000); };
  const t0 = Date.now();
  try {
    // stream:true —— 让上游尽早返回首字节并持续吐流，
    // 规避代理 Cloudflare「~100 秒无响应即 524」的问题（此前非流式要等全部生成完才回包）
    const { resp, errText } = await postChat(url, headers, {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    }, ctrl.signal);
    resetStall();
    if (!resp.ok) {
      aiLog(`callAI: HTTP ${resp.status} 耗时${((Date.now()-t0)/1000).toFixed(1)}s maxTokens=${maxTokens} 错误=${cleanUpstreamError(resp.status, errText).slice(0, 150)}`);
      throw new Error(cleanUpstreamError(resp.status, errText));
    }
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/event-stream')) {
      // 代理未按流式返回（直接给了完整 JSON）——按原方式解析
      const data = await resp.json();
      const content = data.choices?.[0]?.message?.content || '';
      recordUsage('callAI', data.usage);
      aiLog(`callAI: 非流式返回 字符=${content.length} 耗时=${((Date.now()-t0)/1000).toFixed(1)}s`);
      return content;
    }
    // 累积 SSE 流为完整文本
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    let usageObj = null; // 上游在末包回传的 token 用量（含缓存命中数）
    let firstDeltaSec = null; // 首字延迟（秒）
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStall();
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          recordUsage('callAI', usageObj, { firstTokenSec: firstDeltaSec });
          aiLog(`callAI: 完成 字符=${full.length} 耗时=${((Date.now()-t0)/1000).toFixed(1)}s maxTokens=${maxTokens}${full.length === 0 ? ' ⚠️空回复' : ''}`);
          return full;
        }
        try {
          const obj = JSON.parse(data);
          if (obj.usage) usageObj = obj.usage;
          const delta = obj.choices?.[0]?.delta?.content || '';
          if (delta) {
            if (firstDeltaSec === null) firstDeltaSec = Number(((Date.now()-t0)/1000).toFixed(1));
            full += delta;
          }
        } catch { /* 跳过非 JSON 行（如 SSE 注释/keepalive） */ }
      }
    }
    recordUsage('callAI', usageObj, { firstTokenSec: firstDeltaSec });
    aiLog(`callAI: 流结束(无[DONE]) 字符=${full.length} 耗时=${((Date.now()-t0)/1000).toFixed(1)}s${full.length === 0 ? ' ⚠️空回复' : ''}`);
    return full;
  } catch (e) {
    if (stalledFlag) {
      aiLog(`callAI: 停滞中止(90s无数据) 耗时=${((Date.now()-t0)/1000).toFixed(1)}s maxTokens=${maxTokens}`);
      // 转成可读中文（evolve 等调用方直接展示给用户）
      throw new Error('上游停滞：90 秒无任何数据（中转站拥堵或上游卡死），请稍后重试');
    }
    if (e.name === 'AbortError') {
      aiLog(`callAI: 总超时(5分钟) maxTokens=${maxTokens}`);
      throw new Error('生成超过 5 分钟仍未完成，已中止（可调小输出预算或字数后重试）');
    }
    aiLog(`callAI: 异常 ${e.name || ''} ${String(e.message || e).slice(0, 200)} 耗时=${((Date.now()-t0)/1000).toFixed(1)}s`);
    throw e;
  } finally {
    clearTimeout(timer);
    clearTimeout(stallTimer);
  }
}

// 取启用中的正文预设（用于 story 调用覆盖参数）
function getActiveStoryPreset(settings) {
  const list = Array.isArray(settings.storyPresets) ? settings.storyPresets : [];
  const active = list.find(p => p && p.enabled);
  return active?.raw || null;
}

// 获取模型列表（代理任意 OpenAI 兼容站点，如公益站）
app.post('/api/ai/models', async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl required' });
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/models';
    const headers = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`接口返回 ${resp.status}（请检查地址与 Key 是否正确）`);
    const data = await resp.json();
    const models = (data.data || data.models || [])
      .map(m => m.id || m.name || m.model)
      .filter(Boolean);
    res.json({ models });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post('/api/ai/generate', async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });
  const settings = readSettings();
  try {
    // 助手/导演/记忆压缩等结构化任务 → 快照通道（可独立配置）
    const text = await callAI(snapshotAISettings(settings), messages);
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

app.post('/api/ai/test', async (req, res) => {
  // 直接接受临时接口字段（不必先保存设置）：测的就是界面上正在编辑的那条接口
  const b = req.body || {};
  const base = readSettings();
  const cur = base.ai || {};
  const ai = {
    baseUrl: String(b.baseUrl ?? cur.baseUrl ?? ''),
    apiKey: String(b.apiKey ?? cur.apiKey ?? ''),
    model: String(b.model ?? cur.model ?? ''),
    temperature: Number.isFinite(Number(b.temperature)) ? Number(b.temperature) : (Number(cur.temperature) || 0.9),
  };
  try {
    const text = await callAI({ ...base, ai }, [
      { role: 'user', content: '请回复"接口正常"四个字。' }
    ]);
    res.json({ ok: true, text });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- Stage 1：正文生成（SSE 流式） ----------
// body: { messages } 或 { prompt }
// ---------- 缓存命中统计：设置页「缓存命中」面板读取 ----------
app.get('/api/ai/stats', (req, res) => {
  // streamOptionsBlocked：上游是否拒绝过用量请求字段（界面据此提示「可能拿不到数据」）
  res.json(usageStats.snapshot({ streamOptionsBlocked: chatPoster.isBlocked() }));
});
app.post('/api/ai/stats/reset', (req, res) => {
  usageStats.reset();
  srvLog('缓存命中统计已清零');
  res.json({ ok: true, ...usageStats.snapshot({ streamOptionsBlocked: chatPoster.isBlocked() }) });
});

app.post('/api/ai/story', async (req, res) => {
  const body = req.body || {};
  const settings = readSettings();
  let messages;
  if (Array.isArray(body.messages) && body.messages.length) {
    messages = body.messages;
  } else if (typeof body.prompt === 'string' && body.prompt.trim()) {
    messages = [{ role: 'user', content: body.prompt }];
  } else {
    return res.status(400).json({ error: 'messages 或 prompt 必填' });
  }
  if (!String(settings.ai.baseUrl || '').trim()) {
    return res.status(400).json({ error: '未配置正文接口：请到「设置 → API 配置」添加接口并选为正文接口' });
  }
  const preset = getActiveStoryPreset(settings);
  const temperature = Number(preset?.temperature ?? settings.ai.temperature);
  // 正文输出预算（max_tokens）：
  // - 预设的 openai_max_tokens（如 32000）是作者按模型能力设定的上限，优先采用
  // - settings.storyMaxTokens（默认 32768）是全局硬顶，可在设置页调整（0 = 不设顶）
  // 注意：推理模型（如 gemini-3-flash）的思考 token 也计入 max_tokens——
  // 实测思考可吃掉 11000+ token，旧硬顶 12288 会把正文腰斩在几百字（finish_reason=length）。
  // 524 风险已有瞬态重试 + 停滞看门狗兜底。
  const presetMax = (preset?.openai_max_tokens && Number(preset.openai_max_tokens) > 0) ? Number(preset.openai_max_tokens) : 8000;
  const capSetting = Number(settings.storyMaxTokens);
  const hardCap = (Number.isFinite(capSetting) && capSetting > 0) ? capSetting : 65536;
  let attemptMaxTokens = Math.min(presetMax, hardCap);
  const { baseUrl, apiKey, model } = settings.ai;
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  // SSE 头
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: 'start' });

  // 整体超时 5 分钟；浏览器中途断开时中止上游请求
  // （注意：必须用 res 的 close 且排除正常结束——req 的 close 在请求体读完后就会触发，不能用作断开信号）
  const overallCtrl = new AbortController();
  const overallTimer = setTimeout(() => overallCtrl.abort(), 300000);
  // 区分"客户端主动断开"与"整体超时"：两者都触发 abort，但报错文案不同
  let clientGone = false;
  res.on('close', () => { if (!res.writableEnded) { clientGone = true; overallCtrl.abort(); } });
  const totalChars = messages.reduce((n, m) => n + String(m.content || '').length, 0);
  aiLog(`story 开始: messages=${messages.length} 总字符=${totalChars} maxTokens=${attemptMaxTokens} hardCap=${hardCap} model=${model}`);
  // 524/502/503/504 等瞬态错误 + 空流/退化流（200 但零或极少 delta）+ 停滞（90s 无数据）自动重试
  const TRANSIENT = new Set([429, 500, 502, 503, 504, 524]);
  const STALL_MS = 90000;      // 单次尝试内 90 秒收不到任何数据 → 中止该次尝试
  const MIN_CONTENT = 30;      // 正文少于 30 字符视为退化响应（正常正文至少数百字）
  const maxAttempts = 3;
  let lastErr = '';
  let usageObj = null; // 上游在末包回传的 token 用量（含缓存命中数），每次尝试开始时重置
  let firstDeltaSec = null; // 本轮首字延迟（秒）：接口不回传缓存字段时，用它间接判断前缀有没有命中
  // 把本轮用量记进统计（落盘 + 日志）并推给前端：设置页「缓存命中」面板据此显示
  const pushUsage = () => {
    const entry = recordUsage('story', usageObj, { firstTokenSec: firstDeltaSec });
    if (entry) send({ type: 'usage', usage: entry });
  };
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const t0 = Date.now();
      usageObj = null;
      firstDeltaSec = null;
      // 每次尝试独立的中止器 + 停滞看门狗；整体超时/客户端断开时联动中止当前尝试
      const attemptCtrl = new AbortController();
      let stalledFlag = false;
      let stallTimer = setTimeout(() => { stalledFlag = true; attemptCtrl.abort(); }, STALL_MS);
      const resetStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => { stalledFlag = true; attemptCtrl.abort(); }, STALL_MS); };
      const onOverallAbort = () => attemptCtrl.abort();
      overallCtrl.signal.addEventListener('abort', onOverallAbort);
      try {
        const { resp, errText } = await postChat(url, headers, {
          model, messages, temperature: Number.isFinite(temperature) ? temperature : 0.9, max_tokens: attemptMaxTokens, stream: true,
        }, attemptCtrl.signal);
        resetStall();
        if (!resp.ok) {
          lastErr = cleanUpstreamError(resp.status, errText);
          aiLog(`story 尝试${attempt}: HTTP ${resp.status} 耗时${((Date.now()-t0)/1000).toFixed(1)}s 错误=${lastErr.slice(0, 200)}`);
          // 代理端「读请求体失败/invalid_json」属传输层瞬时故障（请求体由 JSON.stringify 生成必然合法，
          // 且实测 40s 才返回 400——真解析错误会秒回；同尺寸请求前后均成功）。按可重试处理。
          const bodyReadFailure = resp.status === 400 && /invalid_json|failed to read request body/i.test(errText);
          if ((!TRANSIENT.has(resp.status) && !bodyReadFailure) || attempt === maxAttempts) {
            send({ type: 'error', error: lastErr });
            return;
          }
          send({ type: 'info', text: `上游错误（${resp.status}），自动重试 ${attempt}/${maxAttempts - 1}…` });
        } else {
          // 读取 SSE 流
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          let gotDelta = false;
          let streamEnded = false;
          let deltaCount = 0;
          let contentChars = 0;
          let firstDeltaAt = null;
          let finishReason = null; // length = 输出因 max_tokens 被截断
          const oddEvents = []; // 非 content 增量的事件样本（诊断空流用）
          let rawSample = [];  // 原始 data 行样本
          while (!streamEnded) {
            const { done, value } = await reader.read();
            if (done) break;
            resetStall();
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const data = trimmed.slice(5).trim();
              if (data === '[DONE]') { streamEnded = true; break; }
              try {
                const obj = JSON.parse(data);
                // 用量包（stream_options.include_usage 会让它在末包出现）：自带 usage、没有 choices，
                // 必须在这里摘出来，否则会被下方当成「无 content 的异常事件」污染空流诊断样本。
                if (obj.usage) usageObj = obj.usage;
                const fr = obj.choices?.[0]?.finish_reason;
                if (fr) finishReason = fr;
                const delta = obj.choices?.[0]?.delta?.content || '';
                // 思维链走独立字段的模型（DeepSeek-R1 风格 reasoning_content / 部分代理用 reasoning）：
                // 不并入正文，单独发 reason 事件，前端写进思考栏
                const reason = obj.choices?.[0]?.delta?.reasoning_content
                  ?? obj.choices?.[0]?.delta?.reasoning ?? '';
                if (reason) send({ type: 'reason', text: reason });
                if (delta) {
                  gotDelta = true; deltaCount++; contentChars += delta.length;
                  if (!firstDeltaAt) {
                    firstDeltaAt = ((Date.now()-t0)/1000).toFixed(1);
                    firstDeltaSec = Number(firstDeltaAt);
                  }
                  send({ type: 'delta', text: delta });
                } else if (!obj.usage && oddEvents.length < 5) {
                  // 记录无 content 的事件：finish_reason / error / reasoning 等字段
                  oddEvents.push(JSON.stringify(obj).slice(0, 300));
                }
                if (rawSample.length < 3) rawSample.push(data.slice(0, 200));
              } catch { /* 跳过非 JSON 行 */ }
            }
          }
          if (gotDelta && contentChars >= MIN_CONTENT) {
            // 截断检测：finish_reason=length 说明 max_tokens 耗尽（推理模型思考吃预算的典型症状）
            if (finishReason === 'length') {
              const canRaise = attemptMaxTokens < hardCap;
              aiLog(`story 尝试${attempt}: 被截断! finish=length 字符=${contentChars} maxTokens=${attemptMaxTokens}${canRaise ? ' 将提升预算重试' : ' 已达上限'}`);
              if (attempt < maxAttempts && canRaise) {
                // 提升预算重试：通知前端丢弃半截正文，从零开始接收新输出
                const raised = Math.min(attemptMaxTokens * 2, hardCap);
                send({ type: 'reset' });
                send({ type: 'info', text: `正文因长度上限被截断，已提高输出预算（${attemptMaxTokens} → ${raised}）重新生成…` });
                attemptMaxTokens = raised;
              } else {
                // 保住已有内容，但明确告知可能不完整
                send({ type: 'info', text: `⚠️ 正文疑似被截断（已达输出上限 ${attemptMaxTokens}）——如需完整正文，可在设置 → API 配置中调大「正文输出上限」或精简正文规则字数` });
                pushUsage();
                send({ type: 'done' }); return;
              }
            } else if (finishReason === 'content_filter') {
              // 上游安全过滤把正文从句中掐断（实测 882 字符断在"顺着你的胸"）：
              // temperature 0.9 下重试通常能走出过滤分支，按截断类失败重试而非当成功
              aiLog(`story 尝试${attempt}: 被安全过滤截断! finish=content_filter 字符=${contentChars}`);
              if (attempt < maxAttempts) {
                send({ type: 'reset' });
                send({ type: 'info', text: '正文被上游安全过滤从句中截断，自动重新生成…' });
              } else {
                // 最后一次尝试：保住已有内容，但明确告知不完整
                send({ type: 'info', text: '⚠️ 正文多次被上游安全过滤截断，本段可能不完整。建议适当调整剧情走向后重试' });
                pushUsage();
                send({ type: 'done' }); return;
              }
            } else {
              aiLog(`story 尝试${attempt}: 成功 deltas=${deltaCount} 字符=${contentChars} 首字=${firstDeltaAt}s finish=${finishReason || 'stop'} 总耗时=${((Date.now()-t0)/1000).toFixed(1)}s`);
              pushUsage();
              send({ type: 'done' }); return;
            }
          } else if (finishReason === 'length') {
            // 思考吃光预算、正文几乎为零：同样按截断处理（提升预算重试）
            aiLog(`story 尝试${attempt}: 被截断且内容极少! finish=length 字符=${contentChars} maxTokens=${attemptMaxTokens}`);
            if (attempt < maxAttempts && attemptMaxTokens < hardCap) {
              send({ type: 'reset' });
              send({ type: 'info', text: `模型思考耗尽输出预算，已提高上限（${attemptMaxTokens} → ${Math.min(attemptMaxTokens * 2, hardCap)}）重新生成…` });
              attemptMaxTokens = Math.min(attemptMaxTokens * 2, hardCap);
            } else {
              // 无法再提升：明确报错而非静默成功
              send({ type: 'error', error: `模型思考耗尽输出预算（max_tokens=${attemptMaxTokens}），正文仅 ${contentChars} 字符。请在设置 → API 配置中调大「正文输出上限」` });
              return;
            }
          } else {
          // 200 OK 但内容为空或退化（实测上游会返回"等 75 秒只吐 1 个字符"的垃圾流）：
          // 视为瞬态失败重试，否则前端会显示「AI 未返回内容」
          lastErr = gotDelta
            ? `上游返回退化响应（仅 ${contentChars} 字符，疑似代理故障）`
            : '上游返回空内容（连接正常但无正文增量）';
          aiLog(`story 尝试${attempt}: ${gotDelta ? '退化流' : '空流'}! deltas=${deltaCount} 字符=${contentChars} 耗时=${((Date.now()-t0)/1000).toFixed(1)}s 原始样本=${JSON.stringify(rawSample)} 无content事件=${JSON.stringify(oddEvents)}`);
          if (attempt === maxAttempts) {
            send({ type: 'error', error: `${lastErr}，已重试 ${maxAttempts} 次。建议稍后再试或更换 AI 中转地址` });
            return;
          }
          send({ type: 'info', text: `上游返回内容异常，自动重试 ${attempt}/${maxAttempts - 1}…` });
          }
        }
      } catch (e) {
        lastErr = String(e.message || e);
        if (overallCtrl.signal.aborted) throw e; // 整体超时/客户端断开：致命，立即结束
        aiLog(`story 尝试${attempt}: ${stalledFlag ? '停滞中止(90s无数据)' : '异常'} ${e.name || ''} ${lastErr.slice(0, 200)} 耗时=${((Date.now()-t0)/1000).toFixed(1)}s`);
        if (!stalledFlag || attempt === maxAttempts) throw e;
        send({ type: 'info', text: `上游长时间无响应，自动重试 ${attempt}/${maxAttempts - 1}…` });
      } finally {
        clearTimeout(stallTimer);
        overallCtrl.signal.removeEventListener('abort', onOverallAbort);
      }
      await new Promise(r => setTimeout(r, 1500 * attempt)); // 递增退避
    }
    pushUsage();
    send({ type: 'done' });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (clientGone) {
        // 用户点停止/关闭页面：连接已断，send 写不进去，只记日志
        aiLog(`story 失败: 客户端已断开（用户停止或页面关闭）`);
      } else if (overallCtrl.signal.aborted) {
        aiLog(`story 失败: 整体超时（5 分钟）`);
        send({ type: 'error', error: '请求超时（5 分钟）。生成耗时过长或上游拥堵，可重试一次；频繁出现请在设置中调小「正文输出上限」或正文字数' });
      } else {
        // 尝试循环抛出的 AbortError：多次尝试全部失败（停滞/空流等）
        const reason = lastErr || '上游连续无响应';
        aiLog(`story 失败: 重试耗尽（${maxAttempts} 次） ${reason.slice(0, 200)}`);
        send({ type: 'error', error: `已尝试 ${maxAttempts} 次均失败：${reason}。中转站/上游疑似拥堵，请稍后重试（点重试或右键重新生成）` });
      }
    }
    else { aiLog(`story 失败: ${String(e.message || e).slice(0, 300)}`); send({ type: 'error', error: String(e.message || e) }); }
  } finally {
    clearTimeout(overallTimer);
    res.end();
  }
});

// ---------- Stage 2：快照演化（读取正文+快照+规则，输出 v2 修改语句信封） ----------
// body: { messages, knownIds, ownedItems } —— 由前端用 evolutionPrompt.assembleEvolutionPromptV2 组装
// 服务端做：调用 AI → 解析 v2 四段信封 → 逐行校验修改语句与新增角色快照 → 失败自动打回重写（最多 N 次）
app.post('/api/ai/evolve', async (req, res) => {
  const body = req.body || {};
  const settings = readSettings();
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: 'messages 必填' });
  }
  const maxRetries = Number(settings.evolutionMaxRetries) || 3;
  // v2 输出为「修改语句 + 新增角色」，几千 token 足够；再高只会加剧代理输出预算预留 → 空回复/524 风险
  const evolveMaxTokens = 8000;
  let lastRaw = '';
  let lastErrors = [];
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let messages = body.messages;
    if (attempt > 1) {
      // 注入打回反馈
      const feedback = buildRewriteFeedbackV2(lastRaw, lastErrors);
      messages = [...body.messages, { role: 'assistant', content: lastRaw }, { role: 'user', content: feedback }];
    }
    try {
      // 快照演化 → 快照通道（可独立配置）
      const raw = await callAI(snapshotAISettings(settings), messages, evolveMaxTokens);
      lastRaw = raw;
      // 逐行校验「修改语句」，并校验新增角色的完整快照
      const pv = parseEvolutionV2Text(raw);
      if (!pv.ok) { lastErrors = [{ code: 'parse', msg: pv.error }]; continue; }
      const knownIds = Array.isArray(body.knownIds) ? body.knownIds.map(String) : null;
      // ownedItems：各角色储物袋现状（客户端带上来的）—— 校验「装备的物品必须先登记进储物袋」
      const ownedItems = body.ownedItems && typeof body.ownedItems === 'object' ? body.ownedItems : null;
      const { edits, errors: editErrors } = parseEditBlock(pv.parsed.editText, { knownIds, ownedItems });
      if (editErrors.length) {
        lastErrors = editErrors.map(e => ({ code: 'edit', msg: e.msg }));
        continue;
      }
      const initErrors = [];
      const initFixed = {};
      for (const [id, snap] of Object.entries(pv.parsed.init || {})) {
        const r = validateV2Snapshot(id, snap);
        if (r.errors.length) initErrors.push(...r.errors.map(m => ({ code: 'init', msg: m })));
        else {
          initFixed[id] = r.fixed;
          // 新角色的战斗数值必须落在该境界的区间内（打回时带区间与表路径）
          initErrors.push(...realmBoundErrors(settings, id, r.fixed));
        }
      }
      if (initErrors.length) { lastErrors = initErrors; continue; }
      return res.json({
        ok: true,
        attempts: attempt,
        raw,
        result: {
          format: 'v2',
          thinking: pv.parsed.thinking,
          init: initFixed,
          edits,
          editText: pv.parsed.editText,
          worldTime: pv.parsed.worldTime,
        },
      });
    } catch (e) {
      lastErrors = [{ code: 'call', msg: String(e.message || e) }];
      continue;
    }
  }
  // 区分失败原因：网络/接口错误 ≠ 格式不合规，避免误导排查方向
  const callErr = lastErrors.find(e => e.code === 'call');
  if (callErr) {
    return res.status(502).json({
      ok: false,
      error: `AI 接口调用失败（网络/供应商问题，非输出格式问题）：${callErr.msg}`,
      lastRaw: String(lastRaw).slice(0, 4000),
      lastErrors,
    });
  }
  res.status(502).json({
    ok: false,
    error: `演化失败，已重写 ${maxRetries} 次仍不合规`,
    lastRaw: String(lastRaw).slice(0, 4000),
    lastErrors,
  });
});

// ---------- v2 新增角色的「数值对表」校验 ----------
// AI 首次生成角色（<新增角色> 的完整快照）时，属性必须落在该角色境界的区间内。
// 只校验字段格式是不够的：AI 会按内置宽表（炼气四层物攻可到 290）写值，
// 客户端再用玩家生效的窄表（68~72）校界，属性就凭空超上限、只能被强行压回。
// 所以在服务端就打回，让 AI 按真正的表重写一次，落库前就已经合法。
// （实现见 client/src/data/realmBounds.js，已在文件顶部导入）

// 生效数值表：优先玩家设置里的覆盖层，缺则回落到内置表文件（缺表 → 返回 null，校验直接跳过）
function effectiveRealmProfiles(settings) {
  const rp = settings?.numericTuning?.tables?.realmProfiles;
  if (rp && typeof rp === 'object' && Object.keys(rp).length) return rp;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../client/src/data/mortal-numeric-tuning.json'), 'utf8'));
    return raw?.tables?.realmProfiles || null;
  } catch { return null; }
}

// 该角色是否受数值表约束（与客户端 isCharClamped / tuning.applyTo 同口径）
function numericCheckScope(settings, id, kind) {
  const t = settings?.numericTuning;
  if (t && t.enforce === false) return false;
  const applyTo = (t && t.applyTo) || {};
  return (id === 'B1' || kind === 'player') ? applyTo.playerB1 !== false : applyTo.npcs !== false;
}

// 一份已通过格式校验的 v2 快照 → 数值越界错误列表（空数组 = 合规 / 境界不在表内）
function realmBoundErrors(settings, id, snap) {
  if (!numericCheckScope(settings, id, snap?.kind)) return [];
  const rp = effectiveRealmProfiles(settings);
  if (!rp) return [];
  // 特质与装备加成都**不计入**合法区间：stats 语义是「自身值」＝境界基准 + 出身 + 种族 + 加点，
  // 特质与装备由系统另行实时叠加、不写进自身（见 snapshotSchema.js 的 attrRows 三段口径）。
  // 服务端只拿得到 v2 快照、读不到主角档案里的出身/种族/加点，所以这里不为任何加成上移区间；
  // 客户端落档时仍按 characterClampBonus（出身/种族/加点）校界兜底。
  const r = checkV2RealmBounds({ ...snap, id }, rp);
  if (r.skipped) return [];   // 境界不在表内（妖兽、散修等）→ 不阻断，交给客户端校界兜底
  if (!r.errors.length) return [];
  const hint = realmBoundsHintFor({ ...snap, id }, rp);
  return [
    ...(hint ? [{ code: 'init-numeric-hint', msg: hint }] : []),
    ...r.errors.map(m => ({ code: 'init-numeric', msg: m })),
  ];
}

// ---------- 各角色独立快照存储（角色名册每人一份） ----------
function charSnapDir(saveId) {
  return path.join(CHAR_SNAPS_DIR, String(saveId).replace(/[^\w-]/g, '_'));
}
function charSnapFile(saveId, charId) {
  return path.join(charSnapDir(saveId), `${safeId(charId)}.json`);
}

// 批量保存各角色快照
app.post('/api/saves/:id/characters/snapshots', async (req, res) => {
  const saveId = req.params.id;
  const body = req.body || {};
  const snaps = body.snapshots; // { B1: {...}, C1: {...} }
  if (!snaps || typeof snaps !== 'object' || Array.isArray(snaps)) {
    return res.status(400).json({ error: 'snapshots 必填且为对象' });
  }
  fs.mkdirSync(charSnapDir(saveId), { recursive: true });
  const saved = [];
  for (const [charId, snap] of Object.entries(snaps)) {
    const file = charSnapFile(saveId, charId);
    stripPlayerBlockInPlace(snap);   // 主角专有块：镜像副本也不留
    const record = {
      saveId, charId,
      snapshot: snap,
      updatedAt: Date.now(),
    };
    try {
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
      record.createdAt = existing.createdAt || Date.now();
      fs.writeFileSync(file, JSON.stringify({ ...existing, ...record }, null, 2), 'utf-8');
      saved.push(charId);
    } catch (e) {
      // 单个失败不影响其余
    }
  }
  res.json({ ok: true, saved });
});

// 按集合对齐各角色快照：以传入的 snapshots 为「全集」
// 先删掉服务端多出来的角色文件（回滚的孤儿），再把全集写一遍。
// 为什么需要：批量保存只增不删，而「回退 / 重新生成 / 恢复人生快照」会把存档里的角色集合
// 缩回后 —— 回滚时进化出来、回滚后已不存在的角色，其服务端副本会永久残留。
app.put('/api/saves/:id/characters/snapshots', (req, res) => {
  const saveId = req.params.id;
  const body = req.body || {};
  const snaps = body.snapshots;
  if (!snaps || typeof snaps !== 'object' || Array.isArray(snaps)) {
    return res.status(400).json({ error: 'snapshots 必填且为对象' });
  }
  // 空集合一律拒绝：本接口会删除服务端多余副本，空对象意味着「一个角色都不留」，
  // 正常存档至少有主角 B1 —— 误传空对象会清空整份角色快照，得不偿失。要清空请用删除接口逐个删。
  if (!Object.keys(snaps).length) {
    return res.status(400).json({ error: 'snapshots 不能为空（避免误删全部角色快照）' });
  }
  const dir = charSnapDir(saveId);
  fs.mkdirSync(dir, { recursive: true });
  // 文件名用 safeId 转写，keep 也用同一套规则，避免角色 id 含特殊字符时误删
  const keep = new Set(Object.keys(snaps).map(id => safeId(id)));
  const removed = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const charId = f.slice(0, -5);
    if (keep.has(charId)) continue;
    try { fs.unlinkSync(path.join(dir, f)); removed.push(charId); } catch { /* 单个失败不影响其余 */ }
  }
  const saved = [];
  for (const [charId, snap] of Object.entries(snaps)) {
    const file = charSnapFile(saveId, charId);
    stripPlayerBlockInPlace(snap);   // 主角专有块：镜像副本也不留
    const record = { saveId, charId, snapshot: snap, updatedAt: Date.now() };
    try {
      const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
      record.createdAt = existing.createdAt || Date.now();
      fs.writeFileSync(file, JSON.stringify({ ...existing, ...record }, null, 2), 'utf-8');
      saved.push(charId);
    } catch { /* 单个失败不影响其余 */ }
  }
  res.json({ ok: true, saved, removed });
});

// 单角色快照读取
app.get('/api/saves/:id/characters/:charId/snapshot', (req, res) => {
  const file = charSnapFile(req.params.id, req.params.charId);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // 主角专有块：镜像副本读取时顺手清掉并回写，别让它再流回客户端内存
    if (rec.snapshot && stripPlayerBlockInPlace(rec.snapshot)) {
      try { fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf-8'); } catch {}
    }
    res.json(rec);
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

// 单角色快照写入/更新
app.put('/api/saves/:id/characters/:charId/snapshot', (req, res) => {
  const saveId = req.params.id;
  const charId = req.params.charId;
  const file = charSnapFile(saveId, charId);
  fs.mkdirSync(charSnapDir(saveId), { recursive: true });
  let existing = {};
  if (fs.existsSync(file)) {
    try { existing = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
  }
  const snap = req.body?.snapshot;
  if (!snap || typeof snap !== 'object') return res.status(400).json({ error: 'snapshot 必填' });
  stripPlayerBlockInPlace(snap);   // 主角专有块：镜像副本也不留
  const record = {
    ...existing,
    saveId, charId,
    snapshot: snap,
    createdAt: existing.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
  res.json({ ok: true, updatedAt: record.updatedAt });
});

// 单角色快照删除
app.delete('/api/saves/:id/characters/:charId/snapshot', (req, res) => {
  const file = charSnapFile(req.params.id, req.params.charId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

// 列出某存档下所有角色快照
app.get('/api/saves/:id/characters/snapshots', (req, res) => {
  const dir = charSnapDir(req.params.id);
  if (!fs.existsSync(dir)) return res.json([]);
  const list = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return {
          charId: rec.charId,
          name: rec.snapshot?.identity?.name || rec.charId,
          realm: rec.snapshot?.identity?.realm || '',
          updatedAt: rec.updatedAt,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json(list);
});

// ---------- 静态托管（生产模式） ----------
const distDir = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(distDir)) {
  // ===== /models 直接挂源码里的 client/public/models，**不走 dist** =====
  // 为什么（2026-09-24 用户报「没有 3D 棋盘，模型文件 404」）：
  //   `vite build` 会先把 dist 整个清空，再把 public 全量拷进去；本仓库 public 里有 450MB 模型，
  //   拷贝要几十秒。这几十秒里 dist/models 是不存在的 ⇒ 正玩着的页面请求 /models/* 全是 404。
  //   而三维场景那边会把「一个模型都没下到」缓存成整个会话的结果，于是那一页**不刷新就一直**是兜底格盘
  //   （哪怕文件早已恢复）。public 不被构建动到，让 /models 直接读它，这个窗口就填平了。
  // 只改 /models：它是唯一体量大到能开出窗口的目录，其余小目录的拷贝是毫秒级。
  const publicModels = path.join(__dirname, '..', 'client', 'public', 'models');
  if (fs.existsSync(publicModels)) app.use('/models', express.static(publicModels));

  // index.html 禁止强缓存：确保前端发版后浏览器总是拿到最新 JS 引用（否则会加载旧 JS 导致白屏/旧 bug）
  // 带 hash 的 assets 资源可长缓存
  //
  // ⚠⚠ 2026-09-23 补：`/splash/` 下的文件**没有 hash**（封面图 cover.jpg、自备字体
  //   feibo-title.woff2/.ttf）。它们原来走 express 的默认缓存策略，而我们替换文件时
  //   文件名不变 ⇒ 老浏览器会一直用旧的那份，出现「源码/构建都改了，玩家看到的还是旧样子」
  //   —— 这正是「字体没生效」那次排查里最难缠的一环（我重建了 dist，玩家的页面还是旧的）。
  //   所以：凡**未带 hash** 的静态资源，一律 no-cache（允许缓存，但每次都要回源校验）。
  //   assets/ 下的文件名带内容 hash，内容一变名字就变，保持长缓存反而更快。
  const NO_CACHE_DIRS = ['/splash/'];
  app.use(express.static(distDir, {
    setHeaders: (res, filePath) => {
      const p = filePath.replace(/\\/g, '/');
      const isHashed = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\./.test(p);
      if (p.endsWith('index.html') || NO_CACHE_DIRS.some(d => p.includes(d))) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (!isHashed && /\.(?:woff2?|ttf|otf|jpg|jpeg|png|webp|gif|svg|mp3|ogg|wav)$/i.test(p)) {
        // 其它未带 hash 的媒体/字体也一并 no-cache：它们同样会在原地被替换
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const PORT = process.env.PORT || 8346;
const HOST = process.env.HOST || '127.0.0.1';
const server = app.listen(PORT, HOST, () => {
  srvLog(`后端已启动: http://${HOST}:${PORT}`);
  if (fs.existsSync(distDir)) srvLog('正在托管前端构建产物（生产模式）');
  else srvLog('未检测到 client/dist，仅提供 API（开发模式请另起 vite）');
});

// ---------- 端口被占时别静默崩掉 ----------
// 为什么（2026-09-24 用户报「双击启动脚本，窗口打开之后自己就关了」）：
//   node 的 http server 在没有 'error' 监听者时，端口冲突会抛出未捕获异常 ⇒ 进程直接退出（实测 EADDRINUSE、退出码 1）。
//   而启动脚本的最后一行是 `node index.js`（前台阻塞）——node 一退，脚本就走完，cmd 窗口随之自动关闭，
//   报错信息只在那不到一秒的窗口里闪一下，用户根本看不到，日志里也**一条痕迹都没有**。
//   这里把它变成：① 写进 ai-debug.log（以后能查）；② 在窗口里用人话说明原因和怎么查占用者；
//   ③ 以非 0 码退出，交给启动脚本决定要不要 pause 把窗口留住。
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    srvLog(`启动失败：端口 ${HOST}:${PORT} 已被占用（多半是上一次的后端还没退干净）`);
    srvLog(`  查占用者：netstat -ano | findstr ":${PORT}" | findstr LISTENING  ← 最后一列就是 PID`);
    srvLog(`  也可换端口启动：先设环境变量 PORT（例如 PORT=8347）再启动`);
    console.error('');
    console.error(`[造化玉碟] 启动失败：端口 ${PORT} 已被占用，本次没有起来。`);
    console.error(`  占用者多半是上一次留下的后端进程。查它：netstat -ano | findstr ":${PORT}" | findstr LISTENING`);
    console.error(`  结束它：taskkill /PID <上面查到的数字> /T /F    或换端口：set PORT=8347 后再启动`);
    console.error('');
  } else {
    srvLog(`启动失败：${err && err.message}`);
    console.error('[造化玉碟] 启动失败：', err);
  }
  process.exit(1);
});
