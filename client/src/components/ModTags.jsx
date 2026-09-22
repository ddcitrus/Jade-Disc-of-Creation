import React from 'react';

// 属性加成标签组
export default function ModTags({ mods }) {
  if (!mods) return null;
  return (
    <div className="mods">
      {Object.entries(mods).map(([k, v]) => (
        <span key={k} className={`mod-tag ${v > 0 ? 'pos' : 'neg'}`}>{k} {v > 0 ? `+${v}` : v}</span>
      ))}
    </div>
  );
}
