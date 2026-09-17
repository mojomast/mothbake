// Command line interface. Returns exit codes instead of calling process.exit,
// so tests can drive `main()` directly.

import fs from 'node:fs';
import path from 'node:path';
import { createApi, readKey, resolveBaseUrl } from './api.mjs';
import { formatIssue, loadConfig, validateConfig } from './config.mjs';
import { jobsRequiringApi, runConfig } from './runner.mjs';
import { DEFAULT_MOTIF, DEFAULT_SOURCE_PATTERNS, writeSources } from './sources.mjs';
import { emitterTypes } from './emitters/index.mjs';
import { bakerTypes } from './bakers/index.mjs';

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = PACKAGE.version;

export const HELP = `mothbake ${VERSION} — manifest-driven asset baking

Usage:
  mothbake <command> [options]

Commands:
  catalog            List the engines the API exposes and their credit cost
  validate           Validate the config and report every problem
  sources            Generate procedural source art (PNG/MIDI) locally
  run                Resolve jobs, bake records, and run the emitters

Options:
  -c, --config <file>  Config file (default: mothbake.config.mjs / .js / mothbake.json)
  -o, --out <dir>      Output directory (default: mothbake-out; sources default: sources)
      --only <id>      Only this job (repeatable or comma-separated); with sources: pattern names
      --force          Ignore recorded fixtures and cached job ids; submit fresh jobs
      --dry            Print what would run without touching the API or writing files
      --strict         Stop at the first failed job instead of continuing
      --base <url>     Override the API base URL
  -h, --help           Show this help
  -v, --version        Show the version

Environment:
  MOTH_API_KEY         Required for catalog, and for run when any job is not recorded
  MOTH_API_BASE        Alternative to --base (default: https://api.mothquantum.com)

Bakers: ${bakerTypes.join(', ')}
Emitters: ${emitterTypes.join(', ')}

Examples:
  mothbake validate
  mothbake sources --config examples/manifest.json
  mothbake run --config examples/manifest.json --out out/examples
  mothbake run --only rock-tile --force
`;

export function parseArgs(argv) {
  const flat = [];
  for (const token of argv) {
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=');
      flat.push(token.slice(0, eq), token.slice(eq + 1));
    } else {
      flat.push(token);
    }
  }
  const args = { _: [], only: [], config: undefined, out: undefined, base: undefined, force: false, dry: false, strict: false, help: false, version: false };
  const takeValue = (token, index) => {
    if (index + 1 >= flat.length) throw new Error(`${token} needs a value`);
    return flat[index + 1];
  };
  for (let i = 0; i < flat.length; i++) {
    const token = flat[i];
    if (token === '-h' || token === '--help') args.help = true;
    else if (token === '-v' || token === '--version') args.version = true;
    else if (token === '-c' || token === '--config') args.config = takeValue(token, i++);
    else if (token === '-o' || token === '--out') args.out = takeValue(token, i++);
    else if (token === '--only') args.only.push(takeValue(token, i++));
    else if (token === '--base') args.base = takeValue(token, i++);
    else if (token === '--force') args.force = true;
    else if (token === '--dry') args.dry = true;
    else if (token === '--strict') args.strict = true;
    else if (token.startsWith('-') && token !== '-') throw new Error(`unknown option: ${token}`);
    else args._.push(token);
  }
  return args;
}

function write(stdout, message) {
  stdout(`${message}\n`);
}

async function loadValidatedConfig(args, context) {
  const loaded = await loadConfig({ file: args.config, cwd: context.cwd });
  const { errors, warnings } = validateConfig(loaded.config, { file: loaded.file });
  for (const warning of warnings) context.stderr(`warning: ${formatIssue(warning)}\n`);
  if (errors.length) {
    const error = new Error(`config has ${errors.length} problem(s)`);
    error.issues = errors;
    error.file = loaded.file;
    throw error;
  }
  return loaded;
}

async function commandCatalog(args, context) {
  const { env, stdout } = context;
  let configBaseUrl;
  if (args.config) {
    const loaded = await loadConfig({ file: args.config, cwd: context.cwd });
    configBaseUrl = loaded.config.baseUrl;
  }
  const key = readKey(env);
  const api = createApi({ baseUrl: resolveBaseUrl({ base: args.base, configBaseUrl, env }), key });
  const engines = await api.listEngines();
  if (!Array.isArray(engines)) throw new Error('catalog: unexpected response shape (expected a list of engines)');
  const rows = engines
    .map((engine) => ({ ...engine, engine_id: engine.engine_id ?? engine.id ?? '?' }))
    .sort((a, b) => String(a.engine_id).localeCompare(String(b.engine_id)));
  const short = (type) => String(type ?? '').split('/').pop() || '?';
  for (const engine of rows) {
    const credits = String(engine.credits_per_run ?? '?').padStart(2);
    stdout(`${credits}cr  ${String(engine.engine_id).padEnd(26)} ${short(engine.input_type)} -> ${short(engine.output_type).padEnd(8)} ${engine.name ?? ''}\n`);
  }
  return 0;
}

async function commandValidate(args, context) {
  const { stdout, stderr } = context;
  const loaded = await loadConfig({ file: args.config, cwd: context.cwd });
  const { errors, warnings } = validateConfig(loaded.config, { file: loaded.file });
  for (const warning of warnings) stderr(`warning: ${formatIssue(warning)}\n`);
  if (errors.length) {
    for (const issue of errors) stderr(`error: ${formatIssue(issue)}\n`);
    stderr(`\n${errors.length} error(s) in ${loaded.file}\n`);
    return 1;
  }
  const jobs = loaded.config.jobs?.length ?? 0;
  write(stdout, `OK — ${jobs} job(s) in ${loaded.file}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  return 0;
}

async function commandSources(args, context) {
  const { stdout, stderr } = context;
  const loaded = await loadValidatedConfig(args, context);
  const config = loaded.config;
  if (config.sources === false) throw new Error('sources are disabled in the config (set sources to an object or remove the flag)');
  const sources = config.sources && typeof config.sources === 'object' ? config.sources : {};
  const patterns = { ...DEFAULT_SOURCE_PATTERNS, ...(sources.patterns || {}) };
  const dir = args.out ? path.resolve(context.cwd, args.out) : path.resolve(loaded.dir, sources.dir ?? 'sources');
  const wanted = new Set();
  for (const job of config.jobs ?? []) {
    for (const relative of Object.values(job.inputs ?? job.input ?? {})) wanted.add(path.basename(relative));
  }
  const only = args.only.length ? args.only : sources.only;
  const motif = sources.motif === false ? false : { notes: DEFAULT_MOTIF, ppq: 480, bpm: 60, ...(sources.motif || {}) };
  const written = writeSources({ dir, patterns, only, wanted, motif, log: (message) => stderr(`${message}\n`) });
  write(stdout, `wrote ${written.length} source file(s) to ${dir}`);
  return 0;
}

async function commandRun(args, context) {
  const { env, stdout, stderr } = context;
  const loaded = await loadValidatedConfig(args, context);
  const { config, dir, file } = loaded;
  let needsApi = [];
  if (!args.dry) {
    needsApi = jobsRequiringApi(config, { only: args.only, force: args.force });
  }
  const key = needsApi.length ? readKey(env) : null;
  const outDir = path.resolve(context.cwd, args.out ?? 'mothbake-out');
  const result = await runConfig({
    config,
    configFile: file,
    configDir: dir,
    outDir,
    key,
    env,
    base: args.base,
    only: args.only,
    force: args.force,
    dry: args.dry,
    strict: args.strict,
    log: (message) => stderr(`${message}\n`),
  });
  if (args.dry) {
    const actions = result.plan.reduce((counts, entry) => ({ ...counts, [entry.action]: (counts[entry.action] || 0) + 1 }), {});
    write(stdout, `dry run — ${result.plan.length} job(s): ${JSON.stringify(actions)} (no API calls, nothing written)`);
    return 0;
  }
  write(
    stdout,
    `baked ${result.records.length} record(s) from ${Object.keys(result.provenance).length} job(s) into ${outDir} · ${JSON.stringify(result.buckets)} · failed: ${result.failures.length}`,
  );
  if (result.failures.length) {
    for (const failure of result.failures) stderr(`failed: ${failure.id} — ${failure.message}\n`);
    return 1;
  }
  return 0;
}

const COMMANDS = {
  catalog: commandCatalog,
  validate: commandValidate,
  sources: commandSources,
  run: commandRun,
};

/**
 * Run the CLI.
 *
 * @param {string[]} argv Arguments after the node script.
 * @param {{ env?: object, cwd?: string, stdout?: (s: string) => void, stderr?: (s: string) => void }} [context]
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv = process.argv.slice(2), context = {}) {
  const resolved = {
    env: context.env ?? process.env,
    cwd: context.cwd ?? process.cwd(),
    stdout: context.stdout ?? ((message) => process.stdout.write(message)),
    stderr: context.stderr ?? ((message) => process.stderr.write(message)),
  };
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    resolved.stderr(`mothbake: ${error.message}\nRun "mothbake --help" for usage.\n`);
    return 1;
  }
  if (args.help) {
    resolved.stdout(HELP);
    return 0;
  }
  if (args.version) {
    write(resolved.stdout, VERSION);
    return 0;
  }
  const command = args._[0] ?? 'run';
  if (args._.length > 1) {
    resolved.stderr(`mothbake: unexpected argument "${args._[1]}" (one command at a time)\n`);
    return 1;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    resolved.stderr(`mothbake: unknown command "${command}" (expected: ${Object.keys(COMMANDS).join(', ')})\n`);
    return 1;
  }
  try {
    return await handler(args, resolved);
  } catch (error) {
    if (error.issues) {
      for (const issue of error.issues) resolved.stderr(`error: ${formatIssue(issue)}\n`);
      resolved.stderr(`mothbake: ${error.file ? `${error.file}: ` : ''}${error.issues.length} problem(s)\n`);
      return 1;
    }
    resolved.stderr(`mothbake: ${error.message}\n`);
    return 1;
  }
}
