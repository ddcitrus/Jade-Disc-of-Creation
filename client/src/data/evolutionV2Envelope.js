// ===== 演化输出 v2 信封解析（零依赖，服务端与前端共用） =====
// 信封形如：
//   <thinking>…</thinking>
//   <新增角色>{"C3":{完整快照}}</新增角色>
//   <修改>[B1] 字段 = 值 …</修改>
//   <世界时间>0032年08月06日 14:30</世界时间>
// 本模块只负责「拆信封」；字段级校验在 snapshotV2.js（parseEditBlock / validateV2Snapshot）。

const TAG_RE = (name) => new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');

function stripFences(s) {
  return String(s || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
}

/**
 * @returns {{ ok: boolean, parsed?: {format,thinking,init,editText,worldTime}, raw: string, error?: string }}
 */
export function parseEvolutionV2Text(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { ok: false, raw, error: '空回复' };
  const thinkingM = raw.match(TAG_RE('thinking'));
  const initM = raw.match(TAG_RE('新增角色')) || raw.match(TAG_RE('新增'));
  const editM = raw.match(TAG_RE('修改')) || raw.match(TAG_RE('edit'));
  const timeM = raw.match(TAG_RE('世界时间')) || raw.match(TAG_RE('time'));
  if (!thinkingM && !initM && !editM) {
    return { ok: false, raw, error: '没有找到 <thinking> / <新增角色> / <修改> 标签，输出信封不对。请按契约四段输出。' };
  }
  let init = {};
  if (initM) {
    const body = stripFences(initM[1]);
    if (body) {
      const a = body.indexOf('{');
      const b = body.lastIndexOf('}');
      if (a < 0 || b <= a) return { ok: false, raw, error: '<新增角色> 里不是合法的 JSON 对象' };
      try {
        const obj = JSON.parse(body.slice(a, b + 1));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) init = obj;
      } catch (e) {
        return { ok: false, raw, error: `<新增角色> JSON 解析失败：${e.message}` };
      }
    }
  }
  return {
    ok: true,
    raw,
    parsed: {
      format: 'v2',
      thinking: thinkingM ? thinkingM[1].trim() : '',
      init,
      editText: editM ? editM[1] : '',
      worldTime: timeM ? timeM[1].trim().split('\n')[0].trim() : '',
    },
  };
}

/** 打回重写用的反馈文本（v2） */
export function buildRewriteFeedbackV2(originalText, errors) {
  const flat = (errors || []).map(e => `- ${e.msg || e.code || String(e)}`);
  return [
    '你上一轮的四段信封不符合契约，已被打回。',
    '（修改语句逐行校验；<新增角色> 的完整快照校验必填字段、格式，以及战斗数值是否落在该角色境界的区间内）',
    '',
    '## 逐行校验结果',
    flat.join('\n') || '（未给出具体原因）',
    '',
    '## 你上一轮的原始输出（仅供参考，不要原样复述）',
    String(originalText || '').slice(0, 2000),
    '',
    '只修正上面被指出的行，其余行照抄，然后重新输出完整的四段信封：',
    '<thinking>…</thinking> <新增角色>…</新增角色> <修改>…</修改> <世界时间>…</世界时间>',
    '不要解释、不要复述正文。',
  ].join('\n');
}
