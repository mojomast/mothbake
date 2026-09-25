const token = document.querySelector('meta[name="workbench-token"]').content;
const list = document.querySelector('#list');
const detail = document.querySelector('#detail');
let selected;
const element = (tag, text, parent, attrs = {}) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); parent.append(node); return node; };
const mediaUrl = (id, role) => `/api/candidates/${encodeURIComponent(id)}/${role}`;
async function request(path, options) { const response = await fetch(path, options); const result = await response.json(); if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`); return result; }
function error(place, message) { place.replaceChildren(); element('p', message, place, { class: 'error', role: 'alert' }); }
async function refresh() {
  try {
    const { candidates } = await request('/api/candidates');
    list.replaceChildren();
    if (!candidates.length) { element('p', 'No candidates yet. Prepare candidates in your local workspace, then refresh.', list); return; }
    for (const candidate of candidates) {
      const button = element('button', `${candidate.id} · ${candidate.kind}${candidate.favorite ? ' ★' : ''}${candidate.rejected ? ' · rejected' : ''}`, list, { class: `card${candidate.id === selected ? ' selected' : ''}`, type: 'button' });
      button.addEventListener('click', () => show(candidate.id));
    }
    if (!selected) await show(candidates[0].id);
  } catch (cause) { error(list, `Could not load candidates: ${cause.message}`); }
}
function action(label, handler, parent) { const button = element('button', label, parent, { type: 'button' }); button.addEventListener('click', async () => { try { button.disabled = true; await handler(); await refresh(); await show(selected); } catch (cause) { error(document.querySelector('#feedback'), cause.message); } finally { button.disabled = false; } }); }
async function mutation(id, name, data) { return request(`/api/candidates/${encodeURIComponent(id)}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workbench-Token': token }, body: JSON.stringify(data) }); }
async function show(id) {
  selected = id;
  try {
    const { candidate: c } = await request(`/api/candidates/${encodeURIComponent(id)}`);
    detail.replaceChildren();
    element('h2', c.id, detail);
    const state = element('p', '', detail, { class: 'badge' });
    state.textContent = `${c.kind} · ${c.favorite ? '★ favorite' : 'not favorite'} · ${c.rejected ? 'rejected' : 'active'}`;
    const media = element('div', undefined, detail, { class: 'media' });
    for (const role of ['source', 'result']) {
      const pane = element('div', undefined, media);
      element('h3', role === 'source' ? 'Original' : 'Result', pane);
      const path = c[role]?.path || '';
      const url = mediaUrl(c.id, role);
      if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
        element('img', undefined, pane, { src: url, alt: `${role} image for ${c.id}` });
        if (role === 'result') { element('h4', '3 × 3 tiled preview', pane); element('div', undefined, pane, { class: 'tile', role: 'img', 'aria-label': 'Result tiled three by three', style: `background-image:url("${url}")` }); }
      } else if (/\.(wav|mp3|ogg)$/i.test(path)) {
        element('audio', undefined, pane, { src: url, controls: '', 'aria-label': `${role} audio for ${c.id}` });
      } else element('p', 'Media preview unavailable for this format.', pane);
    }
    if (c.kind === 'audio') { const canvas = element('canvas', undefined, detail, { width: '640', height: '96', 'aria-label': 'Audio waveform overview', role: 'img' }); waveform(canvas, mediaUrl(c.id, 'result')); }
    const report = element('div', undefined, detail, { class: 'panel' });
    element('h3', 'Quality and diagnostics', report);
    element('pre', JSON.stringify(c.qualityReport ?? {}, null, 2), report);
    const provenance = element('div', undefined, detail, { class: 'panel' });
    element('h3', 'Parameters and provenance', provenance);
    for (const key of ['backend', 'provenance', 'params', 'parameterDelta']) { element('h4', key, provenance); element('pre', JSON.stringify(c[key] ?? {}, null, 2), provenance); }
    const controls = element('div', undefined, detail, { class: 'panel' });
    element('h3', 'Review', controls);
    action(c.favorite ? 'Remove favorite' : 'Favorite', () => mutation(id, 'favorite', { value: !c.favorite }), controls);
    action(c.rejected ? 'Undo reject' : 'Reject', () => mutation(id, 'reject', { value: !c.rejected }), controls);
    const notes = element('textarea', undefined, controls, { 'aria-label': 'Candidate notes', maxlength: '4096' }); notes.value = c.notes || '';
    action('Save note', () => mutation(id, 'note', { notes: notes.value }), controls);
    const fingerprint = element('input', undefined, controls, { 'aria-label': 'Plan fingerprint', placeholder: 'Plan fingerprint', required: '' });
    action('Approve', () => mutation(id, 'approve', { planFingerprint: fingerprint.value }), controls);
    action('Supersede approval', () => mutation(id, 'supersede', { planFingerprint: fingerprint.value }), controls);
    element('div', '', controls, { id: 'feedback', role: 'status', 'aria-live': 'polite' });
  } catch (cause) { error(detail, `Could not display candidate: ${cause.message}`); }
}
async function waveform(canvas, url) {
  try {
    const response = await fetch(url); if (!response.ok) return;
    const bytes = await response.arrayBuffer();
    const audio = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const decoded = await audio.decodeAudioData(bytes);
      const samples = decoded.getChannelData(0), context = canvas.getContext('2d');
      context.strokeStyle = '#ffdb79'; context.beginPath();
      for (let x = 0; x < canvas.width; x++) { const index = Math.floor(x * samples.length / canvas.width); const y = (1 - samples[index]) * canvas.height / 2; x ? context.lineTo(x, y) : context.moveTo(x, y); }
      context.stroke();
    } finally { await audio.close(); }
  } catch { /* Unsupported formats still have a native audio player. */ }
}
refresh();
