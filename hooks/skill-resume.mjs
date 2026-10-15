#!/usr/bin/env node
// SessionStart(resume/compact) 钩子：会话里调用过 /team-dev 的，恢复后提醒组长 skill 仍在启用。
// Claude Code 恢复会话不会重新加载已调用的 skill；这里查原会话记录，有调用就注入一段上下文。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch {}
const file = input.transcript_path;
if (!file || !fs.existsSync(file)) process.exit(0);
// 只认真实调用：用户消息里的斜杠命令，或助手的 Skill 工具调用；聊天/命令里提到 team-dev 不算。
const used = fs.readFileSync(file, 'utf8').split('\n').some(line => {
  let e; try { e = JSON.parse(line); } catch { return false; }
  const c = e.message?.content;
  if (e.type === 'user') return (typeof c === 'string' ? c : JSON.stringify(c ?? '')).includes('<command-name>/team-dev</command-name>') && !Array.isArray(c);
  if (e.type === 'assistant' && Array.isArray(c)) return c.some(b => b.type === 'tool_use' && b.name === 'Skill' && b.input?.skill === 'team-dev');
  return false;
});
if (!used) process.exit(0);
const skill = path.join(os.homedir(), 'agent-hub/skills/team-dev/SKILL.md');
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext:
  `本会话之前用户调用过 /team-dev（恢复/压缩后 skill 正文不会自动带回）。按 SKILL.md 门禁，视为本会话仍在启用，除非用户已撤回。继续派活前先重读 ${skill}。` } }));
