// ===== SillyTavern 宏指令引擎 =====
// 支持 {{setvar::name::value}} / {{getvar::name}} / {{user}} / {{char}} 等 ST 宏
// 核心特性：顺序求值——按 prompt 段顺序执行，setvar 设置的变量可被后续段 getvar 读取
// 保留所有功能：禁止词表、多样性提示、写作风格等通过 setvar 存储、getvar 注入

/**
 * 执行 ST 宏指令，返回处理后的文本 + 更新后的变量表
 * @param {string} content - 单个 prompt 段的原始内容
 * @param {object} vars - 当前变量表（会被原地修改）
 * @param {object} ctx - { userName, charName }
 * @returns {string} 处理后的文本
 */
export function evalSTMacros(content, vars, ctx = {}) {
  if (!content) return '';
  let text = content;

  // 1. {{setvar::name::value}} —— 设置变量并替换为空字符串（ST 行为：setvar 不输出）
  //    value 可以为空（用于初始化）或跨多行（禁止词表等）
  text = text.replace(/\{\{setvar::([^:}]+)::([\s\S]*?)\}\}/g, (m, name, value) => {
    vars[name] = value;
    return ''; // setvar 不输出内容
  });

  // 2. {{getvar::name}} —— 读取变量并内联（若不存在返回空）
  text = text.replace(/\{\{getvar::([^}]+)\}\}/g, (m, name) => {
    return vars[name] != null ? String(vars[name]) : '';
  });

  // 3. {{addvar::name::value}} —— 追加到变量末尾
  text = text.replace(/\{\{addvar::([^:}]+)::([\s\S]*?)\}\}/g, (m, name, value) => {
    vars[name] = (vars[name] || '') + value;
    return '';
  });

  // 4. {{incvar::name}} / {{decvar::name}} —— 数值自增/自减
  text = text.replace(/\{\{incvar::([^}]+)\}\}/g, (m, name) => {
    vars[name] = (Number(vars[name]) || 0) + 1;
    return '';
  });
  text = text.replace(/\{\{decvar::([^}]+)\}\}/g, (m, name) => {
    vars[name] = (Number(vars[name]) || 0) - 1;
    return '';
  });

  // 5. {{user}} —— 玩家名
  text = text.replace(/\{\{user\}\}/g, ctx.userName || '主角');

  // 6. {{char}} —— 角色/引擎名
  text = text.replace(/\{\{char\}\}/g, ctx.charName || 'Tomoyo');

  // 7. <user> / <bot> 标签（部分预设用这种形式）
  text = text.replace(/<user>/g, ctx.userName || '主角');
  text = text.replace(/<bot>/g, ctx.charName || 'Tomoyo');

  // 8. {{roll:NdM}} / {{roll:N}} —— 骰子（保留功能，实际掷骰）
  text = text.replace(/\{\{roll:(\d+)d(\d+)\}\}/g, (m, n, sides) => {
    let total = 0;
    for (let i = 0; i < Number(n); i++) total += Math.floor(Math.random() * Number(sides)) + 1;
    return String(total);
  });
  text = text.replace(/\{\{roll:(\d+)\}\}/g, (m, max) => {
    return String(Math.floor(Math.random() * Number(max)) + 1);
  });

  // 9. {{time}} / {{date}} —— 当前时间
  const now = new Date();
  text = text.replace(/\{\{time\}\}/g, now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
  text = text.replace(/\{\{date\}\}/g, now.toLocaleDateString('zh-CN'));

  // 10. {{idle_duration}} —— 空闲时长（简化为固定值）
  text = text.replace(/\{\{idle_duration\}\}/g, '0');

  // 11. {{model}} —— 模型名（从 ctx 读取）
  text = text.replace(/\{\{model\}\}/g, ctx.model || 'AI');

  // 12. {{random:a,b,c}} —— 随机选一个
  text = text.replace(/\{\{random:([^}]+)\}\}/g, (m, list) => {
    const items = list.split(',').map(s => s.trim());
    return items[Math.floor(Math.random() * items.length)] || '';
  });

  // 13. {{pick::name}} —— 从数组变量中随机取一个（简化实现）
  // 14. {{wvar::name::word}} —— 词库变量（简化为空）

  return text;
}

/**
 * 对一组 prompt 段批量执行 ST 宏处理
 * 关键：按顺序处理，前一段 setvar 的变量后一段可 getvar
 * @param {Array} segments - [{ role, content, name }] 已按启用顺序排好
 * @param {object} ctx - { userName, charName, model }
 * @returns {Array} 处理后的 segments（content 已替换宏，变量已消化）
 */
export function processPromptsWithMacros(segments, ctx = {}) {
  const vars = {}; // 跨段共享的变量表
  return segments.map(seg => {
    const processed = evalSTMacros(seg.content || '', vars, ctx);
    return { ...seg, content: processed };
  });
}
