// Dependency planning only: the runner executes returned jobs sequentially.
// Integration: buildJobGraph(config, { only: 'target' }) returns { jobs,
// dependencies, explain }. `jobs` are original job objects in topological
// order; dependencies is a Map keyed by job id whose values contain
// { inputSlot, job, slot }. explain(id) describes why that job is included.

/** Normalize an inputFrom reference; an object without slot uses its input slot. */
export function normalizeInputRef(ref, inputSlot) {
  if (typeof ref === 'string') {
    const match = /^([^/:]+)\/([^/]+)$/.exec(ref);
    if (!match) throw new Error(`inputFrom "${inputSlot}": expected "job/slot"`);
    return { job: match[1], slot: match[2] };
  }
  if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.job !== 'string' || !ref.job ||
      (ref.slot !== undefined && (typeof ref.slot !== 'string' || !ref.slot))) {
    throw new Error(`inputFrom "${inputSlot}": expected { job, slot? } or "job/slot"`);
  }
  return { job: ref.job, slot: ref.slot ?? inputSlot };
}

function onlyIds(only) {
  if (only == null) return null;
  const values = only instanceof Set ? [...only] : Array.isArray(only) ? only : [only];
  const ids = new Set();
  for (const value of values) {
    if (typeof value !== 'string') throw new TypeError('--only must contain job ids');
    for (const id of value.split(',')) if (id.trim()) ids.add(id.trim());
  }
  return ids.size ? ids : null;
}

/** Plan a graph from a config or job array; validate all edges before selecting. */
export function buildJobGraph(config, { only = null } = {}) {
  const jobs = Array.isArray(config) ? config : config?.jobs;
  if (!Array.isArray(jobs)) throw new TypeError('job graph requires a jobs array');
  const byId = new Map();
  for (const job of jobs) {
    if (!job || typeof job.id !== 'string' || !job.id) throw new Error('job graph requires non-empty job ids');
    if (byId.has(job.id)) throw new Error(`duplicate job id "${job.id}"`);
    byId.set(job.id, job);
  }
  const dependencies = new Map();
  for (const job of jobs) {
    if (job.inputFrom != null && (typeof job.inputFrom !== 'object' || Array.isArray(job.inputFrom))) {
      throw new Error(`job "${job.id}": inputFrom must map slots to references`);
    }
    const refs = Object.entries(job.inputFrom ?? {}).map(([inputSlot, raw]) => {
      const ref = normalizeInputRef(raw, inputSlot);
      if (!byId.has(ref.job)) throw new Error(`job "${job.id}" inputFrom "${inputSlot}": missing job "${ref.job}"`);
      return { inputSlot, ...ref };
    });
    refs.sort((a, b) => a.job.localeCompare(b.job) || a.inputSlot.localeCompare(b.inputSlot));
    dependencies.set(job.id, refs);
  }

  const state = new Map();
  const ordered = [];
  const stack = [];
  function visit(id) {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`job dependency cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`);
    state.set(id, 1);
    stack.push(id);
    for (const ref of dependencies.get(id)) visit(ref.job);
    stack.pop();
    state.set(id, 2);
    ordered.push(id);
  }
  // Keep authored order for independent jobs. Dependency edges still move an
  // ancestor before its consumer, but an unrelated job should not change
  // record/emitter order merely because its id sorts differently.
  for (const id of byId.keys()) visit(id);

  const requested = onlyIds(only);
  if (requested) for (const id of requested) {
    if (!byId.has(id)) throw new Error(`--only did not match any job: ${id} (known ids: ${[...byId.keys()].sort().join(', ')})`);
    if (byId.get(id).enabled === false) throw new Error(`--only job "${id}" is disabled`);
  }
  const included = new Set();
  const reasons = new Map();
  function include(id, via = null) {
    if (byId.get(id).enabled === false) {
      throw new Error(`job "${via?.job ?? id}" requires disabled ancestor "${id}"${via ? ` via inputFrom "${via.inputSlot}"` : ''}`);
    }
    if (via && !reasons.has(id)) reasons.set(id, via);
    if (included.has(id)) return;
    included.add(id);
    for (const ref of dependencies.get(id)) include(ref.job, { job: id, inputSlot: ref.inputSlot, slot: ref.slot });
  }
  for (const id of requested ?? byId.keys()) {
    if (byId.get(id).enabled !== false) include(id);
  }
  return {
    jobs: ordered.filter((id) => included.has(id)).map((id) => byId.get(id)),
    dependencies,
    explain(id) {
      if (!included.has(id)) throw new Error(`job "${id}" is not selected`);
      const via = reasons.get(id);
      return via
        ? `job "${id}" is required by "${via.job}" inputFrom "${via.inputSlot}" <- "${id}/${via.slot}"`
        : `job "${id}" is ${requested ? 'selected by --only' : 'enabled'}`;
    },
  };
}
