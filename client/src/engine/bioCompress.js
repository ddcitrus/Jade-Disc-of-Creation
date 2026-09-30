// ===== 生平自动压缩（2026-09-29）=====
// 用户拍板的口径：快照 bio.lifeStory 的非空条目超过 20 条时，后台自动压成
// 150 字以内的摘要，**压完替换原文**（不留原文——回退到旧回合仍可从 story[].payload 找回）。
// 本文件只放纯函数与消息构造：判谁要压、拼请求、把结果写回；
// 网络调用与落盘（读改写 + 本地状态同步）由 GameDashboard 回合尾部的后台块执行，
// 与「叙事记忆压缩」同一款式：异步不阻塞、失败静默。
//
// 为什么必须读改写整份存档：POST /api/saves 是全量覆盖（除 memories 外），
// 若只写 char_snaps 副本、不动存档文档，下一回合全量落盘会把长文原样带回，
// 于是每回合都重新触发压缩、每次都白压。

import { DEFAULT_BIO_TEMPLATE } from '../prompts/assistant.js';

/** 触发阈值：非空生平条目超过这个条数才压。 */
export const BIO_COMPRESS_MAX_LINES = 20;

/** 摘要写回时的长度保险丝（模板要求 150 字，这里只防 AI 失控长篇）。 */
const BIO_SUMMARY_MAX_CHARS = 300;

/** 非空生平条目行（空行、纯空白不算条目）。 */
export function bioLines(snap) {
  return String(snap?.bio?.lifeStory || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 该快照是否需要压缩。 */
export function needsBioCompress(snap, max = BIO_COMPRESS_MAX_LINES) {
  return bioLines(snap).length > max;
}

/** 扫出需要压缩的快照 id（主角 B1 与 NPC 同一口径）。 */
export function findBioCompressTargets(save, max = BIO_COMPRESS_MAX_LINES) {
  const snaps = save?.charSnapshots;
  if (!snaps || typeof snaps !== 'object') return [];
  return Object.entries(snaps)
    .filter(([, s]) => needsBioCompress(s, max))
    .map(([id]) => id);
}

/** 压缩请求消息（走 /api/ai/generate 快照通道，同叙事记忆压缩）。 */
export function bioCompressMessages(snap) {
  const entries = bioLines(snap).map((l, i) => `${i + 1}. ${l}`).join('\n');
  const name = snap?.identity?.name || '角色';
  return [
    { role: 'system', content: '你是修仙故事的生平编纂者。只输出压缩后的生平正文本身：纯文本、无标题、无解释、无列表符号、不带引号。' },
    { role: 'user', content: `${DEFAULT_BIO_TEMPLATE.replace('{{bioEntries}}', entries)}\n\n【角色】${name}` },
  ];
}

/**
 * 把 AI 摘要套进该快照的 bio：**替换** lifeStory，其余 bio 字段原样保留。
 * @returns 新 bio 对象；摘要为空返回 null（调用方据此放弃）。
 */
export function compressedBio(snap, summary) {
  const text = String(summary || '').trim().replace(/^["'「『]+|["'」』]+$/g, '');
  if (!text) return null;
  return { ...(snap?.bio || {}), lifeStory: text.slice(0, BIO_SUMMARY_MAX_CHARS) };
}
