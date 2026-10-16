#!/usr/bin/env node
// UserPromptSubmit 钩子：每条用户消息前告诉组长本会话（上次压缩后）已调用工具几次、上下文多大。
// 用途：一行交代里写实际调用次数（不靠自估）；超过长会话门槛时提醒派活或建议开新会话。
// 只数主会话（不含子任务），压缩后从零算——费用跟着当前上下文走。
import fs from 'node:fs';

const LONG = 80, STEP = 40, BIG = 150_000;
let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
const file = input.transcript_path;
if (!file || !fs.existsSync(file)) process.exit(0);

let calls = 0, atLastUser = 0, ctx = 0, ctxAtLastUser = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.isSidechain) continue;
  if (e.type === 'system' && e.subtype === 'compact_boundary') { calls = atLastUser = ctx = ctxAtLastUser = 0; continue; }
  const c = e.message?.content;
  const typed = typeof c === 'string' ? !c.startsWith('<') : Array.isArray(c) && c.some(b => b.type === 'text' && !b.text.startsWith('<')) && !c.some(b => b.type === 'tool_result');
  if (e.type === 'user' && typed) { atLastUser = calls; ctxAtLastUser = ctx; }  // 真实用户消息（非工具结果、非命令）
  if (e.type === 'assistant' && Array.isArray(c)) {
    calls += c.filter(b => b.type === 'tool_use').length;
    const u = e.message.usage;
    if (u) ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
}
let text = `【会话计数】本会话（上次压缩后）已调用工具 ${calls} 次，上一条用户消息以来 ${calls - atLastUser} 次，上下文约 ${Math.round(ctx / 1000)}k token。一行交代里的调用次数按这个数差值写，不要估。`;
const crossed = (calls >= LONG && Math.floor(calls / STEP) > Math.floor(atLastUser / STEP)) || (ctx >= BIG && ctxAtLastUser < BIG);
if (crossed)
  text += `\n【长会话】已超过门槛（${LONG} 次调用或 ${BIG / 1000}k 上下文）：后续实现活优先派出去；若当前话题告一段落，在回复末尾建议用户开新会话（只提一次，用户拒绝就不再提）。`;
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
