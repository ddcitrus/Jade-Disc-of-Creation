// ===== 世界地图 页面 =====
// 2026-09-24：本文件原先还挂着「人生快照」与「天道助手」两个页面（SnapshotsPage /
// AssistantPage），以及只服务它们的一串内部函数（FoldCard / SnapPayloadView /
// buildManualOp / opSummary / localQuery）。这七个函数全项目零引用——GameDashboard
// 只 import 了 MapPage——整链删除，连带清掉随之作废的 import。
import React, { useState, useRef } from 'react';
import { WORLD_MAP, MAP_POIS, findPoi } from '../data/gameData.js';
import { GamePage } from './GamePages.jsx';
import { useToast } from '../ui.jsx';

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
