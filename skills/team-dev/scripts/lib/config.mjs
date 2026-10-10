import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { absolute, fail, readJSON } from './core.mjs';

export const defaultStateRoot = () => path.join(os.homedir(), 'agent-hub/state/team-dev');
export const webConfigPath = options => options['web-config'] || process.env.TEAM_DEV_WEB_CONFIG || path.join(options['state-root'] || process.env.TEAM_DEV_STATE || defaultStateRoot(), 'web-config.json');

// Runtime configuration never contains credential contents.
export function resolveOptions(input = {}) {
  const options = { ...input };
  const explicit = input.config || process.env.TEAM_DEV_CONFIG;
  const file = absolute(explicit || path.join(defaultStateRoot(), 'config.json'), 'config');
  const config = fs.existsSync(file) ? readJSON(file) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('INVALID_CONFIG', 'config 必须为对象');
  for (const [option, env, field] of [
    ['dsh-bin', 'DSH_BIN', 'dsh_bin'], ['dsh-home', 'DSH_HOME', 'dsh_home'],
    ['credential-file', 'TEAM_DEV_CREDENTIAL_FILE', 'credential_file'], ['web-mode', 'TEAM_DEV_WEB_MODE', 'web_mode'],
  ]) options[option] = input[option] ?? process.env[env] ?? config[field];
  for (const option of ['dsh-bin', 'dsh-home', 'credential-file']) {
    if (options[option] !== undefined) options[option] = absolute(options[option], option);
  }
  let expected = input['expected-model'] ?? process.env.TEAM_DEV_EXPECTED_MODEL ?? config.expected_model;
  if (typeof expected === 'string') {
    try { expected = JSON.parse(expected); } catch { fail('INVALID_CONFIG', 'expected-model 必须为 JSON 对象'); }
  }
  if (expected !== undefined && (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
      Object.keys(expected).length !== 3 || ['provider', 'model', 'reasoningEffort'].some(k => typeof expected[k] !== 'string' || !expected[k].trim()))) {
    fail('INVALID_CONFIG', 'expected_model 必须包含非空 provider/model/reasoningEffort');
  }
  options['expected-model'] = expected;
  options['state-root'] = input['state-root'] || process.env.TEAM_DEV_STATE || defaultStateRoot();
  options['web-config'] = webConfigPath(options);
  options['web-mode'] ??= fs.existsSync(options['web-config']) ? 'required' : 'off';
  if (!['off', 'required'].includes(options['web-mode'])) fail('INVALID_CONFIG', 'web_mode 必须为 off 或 required');
  if (input['headless-only']) options['web-mode'] = 'off';
  return options;
}
