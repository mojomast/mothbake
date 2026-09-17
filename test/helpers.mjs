// Shared test helpers: fixture paths, temp dirs, and a CLI spawner that strips
// API credentials from the environment so every test stays offline.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const CLI = path.join(ROOT, 'bin', 'mothbake.mjs');
const TMP_ROOT = path.join(ROOT, 'test', 'tmp');

export function fixture(name) {
  return path.join(FIXTURES, name);
}

export function readFixture(name) {
  return fs.readFileSync(fixture(name));
}

export function fixtureJson(name) {
  return JSON.parse(fs.readFileSync(fixture(name), 'utf8'));
}

/** Create a unique temp directory, cleaned up when the test finishes. */
export function makeTmpDir(t, label = 'case') {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `${label}-`));
  if (t?.after) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

/** Run the CLI in a child process with no API credentials by default. */
export function runCli(args, options = {}) {
  const env = { ...process.env };
  delete env.MOTH_API_KEY;
  delete env.MOTH_API_BASE;
  Object.assign(env, options.env || {});
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: options.cwd ?? ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
