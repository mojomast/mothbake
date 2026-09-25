// Command line interface. Returns exit codes instead of calling process.exit,
// so tests can drive `main()` directly.

import fs from 'node:fs';
import path from 'node:path';
import { createApi, readKey, resolveBaseUrl } from './api.mjs';
import { formatIssue, loadConfig, validateConfig } from './config.mjs';
import { runConfig, selectJobs } from './runner.mjs';
import { buildExecutionPlan } from './execution-plan.mjs';
import { repairConfig } from './repair.mjs';
import { openRunJournal, readRunJournal } from './run-journal.mjs';
import { DEFAULT_MOTIF, DEFAULT_SOURCE_PATTERNS, writeSources } from './sources.mjs';
import { emitterTypes } from './emitters/index.mjs';
import { bakerTypes } from './bakers/index.mjs';
import { startWorkbenchServer } from './workbench-server.mjs';
import { resolveVariationPlan } from './variations.mjs';
import { createContractSnapshot, loadContractSnapshot, validateJobsAgainstContracts, writeContractSnapshot } from './engine-contracts.mjs';
import { exportApprovedCandidate } from './approved-export.mjs';
import { createApprovalStore } from './approvals.mjs';
import { createCandidateStore } from './candidates.mjs';
import { archiveResponse, readArchive } from './archive.mjs';
import { generationInstanceFingerprint, hashJson } from './identity.mjs';
import { generateValues, generators as builtinGenerators } from './values.mjs';
import { probeBackends } from './backends/index.mjs';
import { QUANTUMBLUR_ID, runQuantumBlur } from './backends/quantumblur.mjs';
import { buildGarbageReport } from './gc.mjs';

const PACKAGE = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = PACKAGE.version;

export const HELP = `mothbake ${VERSION} — manifest-driven asset baking

Usage:
  mothbake <command> [options]

Commands:
  catalog            List the engines the API exposes and their credit cost
  validate           Validate the config and report every problem
  plan               Print the frozen execution/spending plan as JSON
  sources            Generate procedural source art (PNG/WAV/MIDI) locally
  run                Resolve jobs, bake records, and run the emitters
  resume             Resume known journal work (alias of safe run)
  repair             Rebuild local records from raw outputs, without the API
  rebuild            Alias of repair
  inspect            Print the local run journal as JSON
  explore            Resolve a bounded local variation request as JSON
  approve            Pin a candidate's exact content to a plan fingerprint
  export             Transactionally export the currently approved candidate
  backends           Probe explicit optional local backends
  local-blur         Run configured local QuantumBlur jobs, then rebuild
  gc                 Report references and unreferenced files (read-only)
  workbench          Start the loopback-only candidate review UI

Options:
  -c, --config <file>  Config file (default: mothbake.config.mjs / .js / mothbake.json)
  -o, --out <dir>      Output directory (default: mothbake-out; sources default: sources)
      --only <id>      Only this job (repeatable or comma-separated); with sources: pattern names
      --force          Ignore recorded fixtures and cached job ids; submit fresh jobs
      --dry            Print what would run without touching the API or writing files
      --strict         Stop at the first failed job instead of continuing
      --approve-spend <fingerprint>  Approve exactly one frozen plan
      --plan <fingerprint> Plan fingerprint to pin with a candidate approval
      --break-lock     Break only a confirmed stale same-host journal lock
      --json           Emit structured JSON where supported
      --host <address> Workbench loopback address (default 127.0.0.1)
      --port <number>  Workbench port (default: an available port)
      --request <file> Declarative JSON variation request for explore
      --snapshot <file> Save sanitized full engine contracts during catalog
      --workspace <dir> Candidate/approval workspace for export
      --candidate <id> Candidate id for approve
      --supersede      Deliberately replace an existing approval
      --python <file>  Absolute/relative Python interpreter for local backends
      --timeout <ms>   Local backend timeout (maximum 120000)
      --dry-run        Required safety flag for gc reporting
      --apply          Refused: GC deletion is intentionally not implemented
      --base <url>     Override the API base URL
  -h, --help           Show this help
  -v, --version        Show the version

Environment:
  MOTH_API_KEY             Required for catalog, and for run when any job is not recorded
  MOTH_API_BASE            Alternative to --base (default: https://api.mothquantum.com)
  MOTH_MIN_INTERVAL_MS     Minimum spacing between API request starts (default 300)
  MOTH_MAX_RETRIES         Retries per request after 429/transient failures (default 5)
  MOTH_RETRY_BASE_MS       First backoff delay when Retry-After is absent (default 1000)
  MOTH_RETRY_CAP_MS        Backoff ceiling (default 30000)
  MOTH_POLL_INTERVAL_MS    First job-status poll interval (default 1500)
  MOTH_POLL_MAX_INTERVAL_MS  Poll ceiling while a job makes no progress (default 5000)
  MOTH_REQUEST_TIMEOUT_MS    API request deadline (default 30000)
  MOTH_UPLOAD_TIMEOUT_MS     Presigned upload deadline (default 120000)
  MOTH_DOWNLOAD_TIMEOUT_MS   Signed download deadline (default 120000)
  MOTH_MAX_UPLOAD_BYTES      Local upload size cap (default 104857600)

Bakers: ${bakerTypes.join(', ')}
Emitters: ${emitterTypes.join(', ')}

Examples:
  mothbake validate
  mothbake sources --config examples/manifest.json
  mothbake run --config examples/manifest.json --out out/examples
  mothbake repair --config examples/manifest.json --out out/examples
  mothbake backends --json --python .venv-local/bin/python
  mothbake local-blur --config examples/local-backends/quantumblur.json --out out/qb --python .venv-local/bin/python
  mothbake gc --out out/examples --dry-run --json
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
  const args = { _: [], only: [], config: undefined, out: undefined, base: undefined, approveSpend: undefined, plan: undefined, host: undefined, port: undefined, request: undefined, snapshot: undefined, workspace: undefined, candidate: undefined, python: undefined, timeout: undefined, force: false, dry: false, dryRun: false, apply: false, strict: false, breakLock: false, supersede: false, json: false, help: false, version: false };
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
    else if (token === '--approve-spend') args.approveSpend = takeValue(token, i++);
    else if (token === '--plan') args.plan = takeValue(token, i++);
    else if (token === '--host') args.host = takeValue(token, i++);
    else if (token === '--port') args.port = takeValue(token, i++);
    else if (token === '--request') args.request = takeValue(token, i++);
    else if (token === '--snapshot') args.snapshot = takeValue(token, i++);
    else if (token === '--workspace') args.workspace = takeValue(token, i++);
    else if (token === '--candidate') args.candidate = takeValue(token, i++);
    else if (token === '--python') args.python = takeValue(token, i++);
    else if (token === '--timeout') args.timeout = takeValue(token, i++);
    else if (token === '--force') args.force = true;
    else if (token === '--dry') args.dry = true;
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--apply') args.apply = true;
    else if (token === '--strict') args.strict = true;
    else if (token === '--break-lock') args.breakLock = true;
    else if (token === '--supersede') args.supersede = true;
    else if (token === '--json') args.json = true;
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
  if (loaded.config.contractSnapshot) {
    const snapshot = loadContractSnapshot(path.resolve(loaded.dir, loaded.config.contractSnapshot));
    const contract = validateJobsAgainstContracts(loaded.config, snapshot, loaded.dir);
    for (const warning of contract.warnings) context.stderr(`warning: ${formatIssue(warning)}\n`);
    if (contract.errors.length) {
      const error = new Error(`config has ${contract.errors.length} contract problem(s)`);
      error.issues = contract.errors;
      error.file = loaded.file;
      throw error;
    }
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
  if (args.snapshot) {
    const full = [];
    for (const engine of engines) full.push(await api.getEngine(engine.engine_id ?? engine.id));
    const snapshot = createContractSnapshot(full, { verification: 'observed-read-only' });
    const target = path.resolve(context.cwd, args.snapshot);
    writeContractSnapshot(target, snapshot);
    write(stdout, `saved ${full.length} sanitized engine contract(s) to ${target}`);
    return 0;
  }
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
  if (!errors.length && loaded.config.contractSnapshot) {
    const snapshot = loadContractSnapshot(path.resolve(loaded.dir, loaded.config.contractSnapshot));
    const contract = validateJobsAgainstContracts(loaded.config, snapshot, loaded.dir);
    errors.push(...contract.errors);
    warnings.push(...contract.warnings);
  }
  for (const warning of warnings) stderr(`warning: ${formatIssue(warning)}\n`);
  if (errors.length) {
    if (args.json) {
      write(stdout, JSON.stringify({ ok: false, file: loaded.file, errors, warnings }, null, 2));
      return 1;
    }
    for (const issue of errors) stderr(`error: ${formatIssue(issue)}\n`);
    stderr(`\n${errors.length} error(s) in ${loaded.file}\n`);
    return 1;
  }
  const jobs = loaded.config.jobs?.length ?? 0;
  if (args.json) {
    write(stdout, JSON.stringify({ ok: true, file: loaded.file, jobs, errors: [], warnings }, null, 2));
    return 0;
  }
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
  const chunks = sources.chunks === false ? null : sources.chunks;
  const written = writeSources({
    dir,
    patterns,
    audio: sources.audio || {},
    chunks,
    only,
    wanted,
    motif,
    log: (message) => stderr(`${message}\n`),
  });
  write(stdout, `wrote ${written.length} source file(s) to ${dir}`);
  return 0;
}

async function commandPlan(args, context) {
  const loaded = await loadValidatedConfig(args, context);
  const outDir = path.resolve(context.cwd, args.out ?? 'mothbake-out');
  const baseUrl = resolveBaseUrl({ base: args.base, configBaseUrl: loaded.config.baseUrl, env: context.env });
  const plan = buildExecutionPlan({
    config: loaded.config,
    configDir: loaded.dir,
    outDir,
    only: args.only,
    force: args.force,
    baseUrl,
    journalSnapshot: readRunJournal(outDir),
  });
  write(context.stdout, JSON.stringify(plan, null, 2));
  return plan.jobs.some((entry) => entry.action === 'blocked-unknown-submission') ? 2 : 0;
}

async function commandRun(args, context) {
  const { env, stdout, stderr } = context;
  const loaded = await loadValidatedConfig(args, context);
  const { config, dir, file } = loaded;
  const outDir = path.resolve(context.cwd, args.out ?? 'mothbake-out');
  const baseUrl = resolveBaseUrl({ base: args.base, configBaseUrl: config.baseUrl, env });
  const preview = buildExecutionPlan({ config, configDir: dir, outDir, only: args.only, force: args.force, baseUrl, journalSnapshot: readRunJournal(outDir) });
  const needsApi = !args.dry && preview.jobs.some((entry) => ['submit', 'resume', 'legacy-reuse'].includes(entry.action));
  const key = needsApi ? readKey(env) : null;
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
    approveSpend: args.approveSpend,
    breakLock: args.breakLock,
    log: (message) => stderr(`${message}\n`),
  });
  if (args.dry) {
    const actions = result.plan.reduce((counts, entry) => ({ ...counts, [entry.action]: (counts[entry.action] || 0) + 1 }), {});
    write(stdout, `dry run — ${result.plan.length} job(s): ${JSON.stringify(actions)} (no API calls, nothing written)`);
    return 0;
  }
  if (args.json) {
    write(stdout, JSON.stringify({ plan: result.executionPlan, failures: result.failures, written: result.written, buckets: result.buckets }, null, 2));
    return result.failures.length ? 1 : 0;
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

async function commandRepair(args, context) {
  const { stdout, stderr } = context;
  const loaded = await loadValidatedConfig(args, context);
  const { config, dir } = loaded;
  const outDir = path.resolve(context.cwd, args.out ?? 'mothbake-out');
  const result = await repairConfig({
    config,
    configDir: dir,
    outDir,
    only: args.only,
    breakLock: args.breakLock,
    log: (message) => stderr(`${message}\n`),
  });
  write(
    stdout,
    `repaired ${result.records.length} record(s) into ${outDir} · ${JSON.stringify(result.buckets)} · failed: ${result.failures.length}`,
  );
  if (result.failures.length) {
    for (const failure of result.failures) stderr(`failed: ${failure.id} — ${failure.message}\n`);
    return 1;
  }
  return 0;
}

async function commandInspect(args, context) {
  const outDir = path.resolve(context.cwd, args.out ?? 'mothbake-out');
  const journal = readRunJournal(outDir);
  write(context.stdout, JSON.stringify(journal ?? { version: 1, jobs: {} }, null, 2));
  return 0;
}

async function commandWorkbench(args, context) {
  const workspaceRoot = path.resolve(context.cwd, args.out ?? 'mothbake-out');
  const port = args.port === undefined ? 0 : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  const app = await startWorkbenchServer({ workspaceRoot, host: args.host ?? '127.0.0.1', port });
  write(context.stdout, `Local workbench: ${app.url}`);
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await app.close();
  return 0;
}

async function commandExplore(args, context) {
  if (!args.request) throw new Error('explore requires --request <file>');
  const file = path.resolve(context.cwd, args.request);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('variation request must be a JSON file no larger than 1 MiB');
  let request;
  try { request = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid variation request JSON: ${error.message}`); }
  write(context.stdout, JSON.stringify(resolveVariationPlan(request), null, 2));
  return 0;
}

async function commandExport(args, context) {
  const workspaceRoot = path.resolve(context.cwd, args.workspace ?? 'mothbake-out');
  const exportRoot = path.resolve(context.cwd, args.out ?? path.join(workspaceRoot, 'delivery'));
  const result = await exportApprovedCandidate({ workspaceRoot, exportRoot });
  write(context.stdout, JSON.stringify({ version: result.pointer.currentVersion, directory: result.directory, pointer: path.join(result.root, 'current.json') }, null, 2));
  return 0;
}

async function commandApprove(args, context) {
  const planFingerprint = args.plan ?? args.approveSpend;
  if (!args.candidate || !planFingerprint) throw new Error('approve requires --candidate <id> and --plan <fingerprint>');
  const workspaceRoot = path.resolve(context.cwd, args.workspace ?? 'mothbake-out');
  const candidate = await createCandidateStore({ workspaceRoot }).get(args.candidate);
  if (!candidate) throw new Error(`candidate not found: ${args.candidate}`);
  const store = createApprovalStore({ workspaceRoot });
  const approval = args.supersede
    ? await store.supersede(candidate, planFingerprint)
    : await store.approve(candidate, planFingerprint);
  write(context.stdout, JSON.stringify({ approval, superseded: args.supersede }, null, 2));
  return 0;
}

function localTimeout(args) {
  if (args.timeout === undefined) return undefined;
  const value = Number(args.timeout);
  if (!Number.isInteger(value) || value < 1 || value > 120_000) throw new Error('--timeout must be an integer from 1 to 120000');
  return value;
}

async function commandBackends(args, context) {
  const python = args.python ? path.resolve(context.cwd, args.python) : undefined;
  const report = await probeBackends({ python, timeoutMs: localTimeout(args) });
  if (args.json) write(context.stdout, JSON.stringify(report, null, 2));
  else for (const backend of report.backends) {
    write(context.stdout, `${backend.available ? 'available' : 'unavailable'}  ${backend.id}  ${backend.reason ?? backend.kind}`);
  }
  return 0;
}

async function commandLocalBlur(args, context) {
  const loaded = await loadValidatedConfig(args, context);
  const { config, dir } = loaded;
  const outDir = path.resolve(context.cwd, args.out ?? 'mothbake-out');
  const python = args.python ? path.resolve(context.cwd, args.python) : null;
  if (!python || !path.isAbsolute(python)) throw new Error('local-blur requires --python <interpreter>');
  const selected = selectJobs(config, args.only).filter((job) => job.enabled !== false);
  if (!selected.length) throw new Error('local-blur selected no enabled jobs');
  for (const job of selected) if (!['local:quantumblur', QUANTUMBLUR_ID].includes(job.engine)) {
    throw new Error(`local-blur only accepts engine "local:quantumblur" (selected ${job.id}: ${job.engine})`);
  }
  const snapshot = readRunJournal(outDir);
  const plan = buildExecutionPlan({ config, configDir: dir, outDir, only: args.only, baseUrl: QUANTUMBLUR_ID, journalSnapshot: snapshot });
  const planById = new Map(plan.jobs.map((entry) => [entry.id, entry]));
  if (args.dry) {
    write(context.stdout, JSON.stringify(plan, null, 2));
    return 0;
  }
  const journal = openRunJournal(outDir, { breakLock: args.breakLock });
  const results = [];
  try {
    for (const job of selected) {
      const entry = planById.get(job.id);
      const rawName = job.raw || job.id;
      journal.transition(job.id, 'prepared', { metadata: { recipeFingerprint: entry.recipeFingerprint, verification: 'local-backend' } });
      try {
        let archived;
        const rawDir = path.join(outDir, 'raw', rawName);
        const reused = fs.existsSync(rawDir);
        if (reused) {
          archived = readArchive({ outDir, rawName, job, requireVerified: true });
          if (archived.manifest.recipeFingerprint !== entry.recipeFingerprint || archived.manifest.engine !== QUANTUMBLUR_ID) {
            throw new Error(`raw/${rawName} belongs to a different local recipe; choose a new raw name`);
          }
        } else {
          const params = entry.executable.params;
          const grid = params.values;
          if (!Array.isArray(grid)) throw new Error(`local QuantumBlur job "${job.id}" needs generateValues or params.values`);
          const result = await runQuantumBlur({ grid, xi: params.xi, locality: params.locality ?? 1, axis: params.axis ?? 'x' }, {
            python, timeoutMs: localTimeout(args),
          });
          const localId = `local-${hashJson({ backend: QUANTUMBLUR_ID, recipe: entry.recipeFingerprint, result })}`;
          const generationFingerprint = generationInstanceFingerprint({ recipe: entry.recipeFingerprint, jobId: localId });
          archived = await archiveResponse({
            response: { files: new Map(), result }, outDir, rawName,
            recipeFingerprint: entry.recipeFingerprint, generationFingerprint,
            jobId: localId, engine: QUANTUMBLUR_ID, verification: 'local-backend',
          });
        }
        job.jobId = archived.manifest.jobId;
        // The authored alias is convenient, but emitted provenance carries the
        // exact pinned local backend identity.
        job.engine = QUANTUMBLUR_ID;
        journal.transition(job.id, 'downloaded', { jobId: job.jobId, metadata: {
          recipeFingerprint: entry.recipeFingerprint,
          generationFingerprint: archived.manifest.generationFingerprint,
          rawFingerprint: archived.rawFingerprint,
          verification: 'local-backend',
        } });
        results.push({ id: job.id, raw: rawName, jobId: job.jobId, rawFingerprint: archived.rawFingerprint, reused });
      } catch (error) {
        journal.transition(job.id, 'local-failed', { detail: 'local QuantumBlur execution failed' });
        throw error;
      }
    }
  } finally { journal.close(); }
  const repaired = await repairConfig({ config, configDir: dir, outDir, only: selected.map((job) => job.id), breakLock: args.breakLock, log: (message) => context.stderr(`${message}\n`) });
  const report = { backend: QUANTUMBLUR_ID, jobs: results, repaired: repaired.records.length, failures: repaired.failures };
  if (args.json) write(context.stdout, JSON.stringify(report, null, 2));
  else write(context.stdout, `local QuantumBlur: ${results.length} job(s), ${repaired.records.length} record(s), failures: ${repaired.failures.length}`);
  return repaired.failures.length ? 1 : 0;
}

async function commandGc(args, context) {
  if (args.apply) throw new Error('gc deletion is not implemented; dry-run only');
  if (!args.dryRun) throw new Error('gc is report-only and requires --dry-run');
  const workspaceRoot = path.resolve(context.cwd, args.workspace ?? args.out ?? 'mothbake-out');
  const report = buildGarbageReport({ workspaceRoot });
  if (args.json) write(context.stdout, JSON.stringify(report, null, 2));
  else {
    write(context.stdout, `GC report only — ${report.totals.files} file(s), ${report.totals.referenced} referenced, ${report.totals.unreferenced} unreferenced, ${report.totals.unknown} unknown; nothing deleted`);
    for (const warning of report.warnings) context.stderr(`warning: ${warning}\n`);
  }
  return 0;
}

const COMMANDS = {
  catalog: commandCatalog,
  validate: commandValidate,
  plan: commandPlan,
  sources: commandSources,
  run: commandRun,
  resume: commandRun,
  repair: commandRepair,
  rebuild: commandRepair,
  inspect: commandInspect,
  explore: commandExplore,
  approve: commandApprove,
  export: commandExport,
  backends: commandBackends,
  'local-blur': commandLocalBlur,
  gc: commandGc,
  workbench: commandWorkbench,
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
    if (argv.includes('--json')) {
      const message = String(error.message ?? error);
      const category = error.issues ? 'configuration'
        : /approve|budget|spend/i.test(message) ? 'spending_approval'
          : /lock/i.test(message) ? 'lock'
            : /unknown submission|reconcil/i.test(message) ? 'reconciliation_required'
              : 'operation_failed';
      resolved.stderr(`${JSON.stringify({ ok: false, error: { category, message, issues: error.issues ?? [] } })}\n`);
      return 1;
    }
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
    if (args.json) {
      const message = String(error.message ?? error);
      const category = error.issues ? 'configuration'
        : /approve|budget|spend/i.test(message) ? 'spending_approval'
          : /lock/i.test(message) ? 'lock'
            : /unknown submission|reconcil/i.test(message) ? 'reconciliation_required'
              : 'operation_failed';
      resolved.stderr(`${JSON.stringify({ ok: false, error: { category, message, issues: error.issues ?? [] } })}\n`);
      return 1;
    }
    if (error.issues) {
      for (const issue of error.issues) resolved.stderr(`error: ${formatIssue(issue)}\n`);
      resolved.stderr(`mothbake: ${error.file ? `${error.file}: ` : ''}${error.issues.length} problem(s)\n`);
      return 1;
    }
    resolved.stderr(`mothbake: ${error.message}\n`);
    return 1;
  }
}
