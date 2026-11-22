'use strict';

// Outreach for LinkedIn — popup controller

const NOTE_LIMIT = 300;
const PROVIDER_META = {
  free:      { name: 'Free mode' },
  anthropic: { name: 'Claude',  keyUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  openai:    { name: 'OpenAI',  keyUrl: 'https://platform.openai.com/api-keys',        placeholder: 'sk-…' },
  gemini:    { name: 'Gemini',  keyUrl: 'https://aistudio.google.com/app/apikey',      placeholder: 'AIza…' },
  groq:      { name: 'Groq',    keyUrl: 'https://console.groq.com/keys',               placeholder: 'gsk_…' }
};

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  profile:     null,          // scraped + normalised profile (with .hooks)
  selected:    [],            // selected hook ids, in click order
  versions:    [],            // undo stack of previous message texts
  busy:        false,
  providers:   {},            // from background: defaults per provider
  modelLists:  {},            // provider -> [{id,label}] fetched from that provider's API
  draft:       { provider: 'free', apiKeys: {}, models: {} },
  pendingResume: undefined    // undefined = unchanged, null = remove, {base64,fileName} = new
};

const $  = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  wireTabs();
  wireCompose();
  wireSettings();
  $('clear-history').addEventListener('click', async () => { await Cache.clearContacts(); renderHistory(); });
  $('mode-pill').addEventListener('click', () => switchTab('settings'));

  state.providers = (await send({ action: 'getProviders' }).catch(() => ({}))).providers || {};
  await loadSettings();
  await checkPage();
  renderHistory();
});

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function wireTabs() {
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
}
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'history') renderHistory();
}

// ─── Page check ───────────────────────────────────────────────────────────────
async function checkPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onProfile = !!(tab && tab.url && /linkedin\.com\/in\/[^/?#]+/.test(tab.url));
  $('not-profile').classList.toggle('hidden', onProfile);
  $('compose-ui').classList.toggle('hidden', !onProfile);
  return onProfile;
}

// ─── Compose ──────────────────────────────────────────────────────────────────
function wireCompose() {
  wireSegmented('format', updateCounter);
  wireSegmented('tone');
  $('generate-btn').addEventListener('click', generate);
  $('regenerate-btn').addEventListener('click', generate);
  $('reread-btn').addEventListener('click', () => readProfile().catch(err => notice('status', err.message, 'err')));
  $('copy-btn').addEventListener('click', copyMessage);
  $('undo-btn').addEventListener('click', undo);
  $('message').addEventListener('input', () => { updateCounter(); autosize(); });
  $('first-name').addEventListener('input', () => {
    if (state.profile) state.profile.firstName = $('first-name').value.trim();
  });
  $$('#refine-chips button').forEach(b => b.addEventListener('click', () => refine({ preset: b.dataset.preset })));
  $('refine-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const instruction = $('refine-text').value.trim();
    if (instruction) refine({ instruction });
  });
}

function wireSegmented(id, onChange) {
  $$(`#${id} button`).forEach(b => b.addEventListener('click', () => {
    $$(`#${id} button`).forEach(x => x.classList.toggle('active', x === b));
    onChange && onChange();
  }));
}
const segValue = (id) => document.querySelector(`#${id} button.active`)?.dataset.value;

async function readProfile() {
  setBusy(true, 'Reading profile…');
  try {
    const res = await send({ action: 'scrapeProfile' });
    state.profile  = res.data;
    state.selected = (res.data.hooks || []).slice(0, 1).map(h => h.id);
    renderRecipient();
    hide('status');
  } finally {
    setBusy(false);
  }
}

async function generate() {
  if (state.busy) return;
  try {
    if (!state.profile) await readProfile();
    setBusy(true, 'Writing…');
    const prev = $('message').value;
    const res  = await send({ action: 'generateMessage', data: composePayload() });
    if (prev && prev !== res.message) pushVersion(prev);
    showMessage(res.message);
    await saveToHistory(res.message);
    hide('status');
  } catch (err) {
    notice('status', err.message, 'err');
  } finally {
    setBusy(false);
  }
}

async function refine({ preset, instruction }) {
  const current = $('message').value.trim();
  if (!current || state.busy) return;
  setBusy(true, instruction ? 'Applying your edit…' : 'Refining…');
  try {
    const res = await send({ action: 'refineMessage', data: { ...composePayload(), message: current, preset, instruction } });
    if (res.message && res.message !== current) {
      pushVersion(current);
      showMessage(res.message);
      await saveToHistory(res.message);
      $('refine-text').value = '';
      hide('status');
    } else {
      notice('status', 'Already as short as it can get without losing the point.', 'warn');
    }
  } catch (err) {
    notice('status', err.message, err.message.includes('need an AI provider') ? 'warn' : 'err');
  } finally {
    setBusy(false);
  }
}

function composePayload() {
  const hooks = (state.profile?.hooks || []);
  return {
    profile:     state.profile,
    hooks:       state.selected.map(id => hooks.find(h => h.id === id)).filter(Boolean),
    messageType: $('message-type').value,
    tone:        segValue('tone'),
    format:      segValue('format')
  };
}

function pushVersion(text) {
  state.versions.push(text);
  if (state.versions.length > 20) state.versions.shift();
  $('undo-btn').disabled = false;
}
function undo() {
  const prev = state.versions.pop();
  if (prev !== undefined) showMessage(prev);
  $('undo-btn').disabled = state.versions.length === 0;
}

function showMessage(text) {
  const firstTime = $('output').classList.contains('hidden');
  $('message').value = text;
  show('output');
  autosize();
  updateCounter();
  $('generate-label').textContent = 'Write again';
  if (firstTime) requestAnimationFrame(() => $('output').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function autosize() {
  const ta = $('message');
  ta.style.height = 'auto';
  ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 150), 320) + 'px';
}

function updateCounter() {
  const len   = $('message').value.length;
  const note  = segValue('format') === 'note';
  const over  = note && len > NOTE_LIMIT;
  $('counter').textContent = note ? `${len} / ${NOTE_LIMIT}` : `${len} characters`;
  $('counter').classList.toggle('over', over);
  $('counter').title = over ? 'LinkedIn connection notes are limited to 300 characters. Try "Fit 300".' : '';
  $('meter-fill').style.width = note ? `${Math.min(100, (len / NOTE_LIMIT) * 100)}%` : '0';
  $('meter-fill').classList.toggle('over', over);
}

async function copyMessage() {
  const text = $('message').value;
  if (!text) return;
  try { await navigator.clipboard.writeText(text); }
  catch (_) { $('message').select(); document.execCommand('copy'); }
  await saveToHistory(text);  // keep the version the user actually sent
  const b = $('copy-btn');
  b.textContent = 'Copied'; b.classList.add('done');
  setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1600);
}

function setBusy(busy, label) {
  state.busy = busy;
  $('generate-btn').disabled = busy;
  $('generate-spinner').classList.toggle('hidden', !busy);
  $('generate-label').textContent = busy ? label : (state.profile && $('message').value ? 'Write again' : state.profile ? 'Write message' : 'Read profile & write');
  $('output').classList.toggle('busy', busy);
  $$('#refine-chips button, #refine-btn, #regenerate-btn, #copy-btn, #reread-btn').forEach(b => b.disabled = busy);
}

function renderRecipient() {
  const p = state.profile;
  show('recipient'); show('addressed-row');
  const name = p.name || 'Unknown name';
  $('avatar').textContent = initials(name);
  $('recipient-name').textContent = name;
  $('recipient-sub').textContent = p.headline || [p.currentTitle, p.currentCompany].filter(Boolean).join(' at ');
  $('first-name').value = p.firstName || '';
  $('first-name').placeholder = 'First name';

  const list = $('hooks');
  list.innerHTML = '';
  (p.hooks || []).forEach(h => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.selected.includes(h.id) ? ' on' : '');
    chip.textContent = h.label;
    chip.addEventListener('click', () => {
      const i = state.selected.indexOf(h.id);
      if (i >= 0) state.selected.splice(i, 1);
      else { state.selected.push(h.id); if (state.selected.length > 2) state.selected.shift(); }
      $$('.chip', list).forEach((c, idx) => c.classList.toggle('on', state.selected.includes(p.hooks[idx].id)));
    });
    list.appendChild(chip);
  });
  $('hooks-field').classList.toggle('hidden', !(p.hooks || []).length);
  if (!$('message').value) $('generate-label').textContent = 'Write message';
}

async function saveToHistory(message) {
  const p = state.profile;
  if (!p) return;
  await Cache.addContact({
    profileUrl: p.profileUrl || '',
    name:       p.name || 'Unknown',
    headline:   p.headline || p.currentCompany || '',
    type:       $('message-type').selectedOptions[0].textContent,
    format:     segValue('format'),
    message,
    timestamp:  Date.now()
  });
}

// ─── History ──────────────────────────────────────────────────────────────────
async function renderHistory() {
  const items = await Cache.getContacts();
  const list  = $('history-list');
  list.innerHTML = '';
  $('history-empty').classList.toggle('hidden', items.length > 0);
  $('history-head').classList.toggle('hidden', items.length === 0);
  $('history-count').textContent = `${items.length} recent ${items.length === 1 ? 'person' : 'people'}`;

  items.forEach(c => {
    const card = document.createElement('div');
    card.className = 'card h-card';
    const date = new Date(c.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    card.innerHTML = `
      <div class="h-top"><div class="h-name"></div><div class="h-meta"></div></div>
      <div class="h-sub"></div>
      <div class="h-msg"></div>
      <div class="h-actions">
        <div><span class="tag t-type"></span><button class="link more">Show all</button></div>
        <button class="btn btn-secondary copy" style="height:28px;padding:0 10px;font-size:12px">Copy</button>
      </div>`;
    card.querySelector('.h-name').textContent = cleanDisplayName(c.name);
    card.querySelector('.h-meta').textContent = date;
    card.querySelector('.h-sub').textContent  = c.headline || '';
    const preview = (c.message || '').replace(/\s*\n+\s*/g, ' ');
    card.querySelector('.h-msg').textContent  = preview;
    const tag = card.querySelector('.t-type');
    if (c.type) tag.textContent = c.type; else tag.remove();
    card.querySelector('.more').addEventListener('click', (e) => {
      const open = card.classList.toggle('open');
      card.querySelector('.h-msg').textContent = open ? (c.message || '') : preview;
      e.target.textContent = open ? 'Show less' : 'Show all';
    });
    card.querySelector('.copy').addEventListener('click', async (e) => {
      await navigator.clipboard.writeText(c.message || '').catch(() => {});
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
    });
    list.appendChild(card);
  });
}

// ─── Settings ─────────────────────────────────────────────────────────────────
function wireSettings() {
  $$('input[name="provider"]').forEach(r => r.addEventListener('change', () => {
    stashKeyInputs();
    state.draft.provider = r.value;
    renderProviderBox();
  }));
  $('test-btn').addEventListener('click', testKey);
  $('refresh-models').addEventListener('click', () => { stashKeyInputs(); fetchModels(state.draft.provider); });
  $('model-select').addEventListener('change', () => {
    const custom = $('model-select').value === CUSTOM_MODEL;
    $('model').classList.toggle('hidden', !custom);
    if (custom) { $('model').value = ''; $('model').focus(); }
    stashKeyInputs();
  });
  $('model').addEventListener('input', stashKeyInputs);
  $('api-key').addEventListener('keydown', e => { if (e.key === 'Enter') testKey(); });
  $('save-btn').addEventListener('click', saveSettings);

  const drop = $('drop');
  drop.addEventListener('click', (e) => { if (e.target.id !== 'remove-resume') $('resume-input').click(); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readResume(e.dataTransfer.files[0]); });
  $('resume-input').addEventListener('change', (e) => { if (e.target.files[0]) readResume(e.target.files[0]); });
  $('remove-resume').addEventListener('click', (e) => {
    e.stopPropagation();
    state.pendingResume = null;
    renderResume(null);
  });
}

async function loadSettings() {
  const s = await storageGet(['provider', 'apiKeys', 'models', 'modelLists', 'userApiKey', 'userName', 'userBio', 'resumeFileName']);
  state.modelLists = s.modelLists || {};
  const apiKeys = { ...(s.apiKeys || {}) };
  if (!apiKeys.anthropic && s.userApiKey) apiKeys.anthropic = s.userApiKey;   // migrate legacy single-key setting
  state.draft = {
    provider: s.provider || (apiKeys.anthropic ? 'anthropic' : 'free'),
    apiKeys,
    models: { ...(s.models || {}) }
  };
  const radio = document.querySelector(`input[name="provider"][value="${state.draft.provider}"]`);
  if (radio) radio.checked = true;
  renderProviderBox();
  $('user-name').value = s.userName || '';
  $('user-bio').value  = s.userBio || '';
  renderResume(s.resumeFileName || null);
  renderModePill(state.draft);
}

function renderProviderBox() {
  const p = state.draft.provider;
  const meta = PROVIDER_META[p];
  $('key-box').classList.toggle('hidden', p === 'free');
  hide('key-status');
  if (p === 'free') return;
  $('api-key-label').textContent = `${meta.name} API key`;
  $('api-key').placeholder = meta.placeholder;
  $('api-key').value = state.draft.apiKeys[p] || '';
  $('get-key-link').href = meta.keyUrl;
  renderModelSelect(p);
  // First time we see a saved key for this provider, pull its model list automatically.
  if (state.draft.apiKeys[p] && !state.modelLists[p]) fetchModels(p, { quiet: true });
}

// ─── Model dropdown ───────────────────────────────────────────────────────────
const CUSTOM_MODEL = '__custom__';

function renderModelSelect(p) {
  const sel      = $('model-select');
  const fallback = state.providers[p]?.defaultModel || '';
  const list     = state.modelLists[p] || (fallback ? [{ id: fallback, label: fallback }] : []);
  const ids      = list.map(m => m.id);
  let current    = state.draft.models[p] || '';
  if (!current) current = ids.includes(fallback) ? fallback : (ids[0] || fallback);

  sel.innerHTML = '';
  const add = (value, text, title) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text; if (title) o.title = title;
    sel.appendChild(o);
  };
  list.forEach(m => add(m.id, m.id === fallback ? `${m.label}  (recommended)` : m.label, m.id));
  if (current && !ids.includes(current)) add(current, `${current}  (saved)`, current);   // keep a hand-typed model
  add(CUSTOM_MODEL, 'Other… type a model ID');
  sel.value = current || CUSTOM_MODEL;

  $('model').classList.toggle('hidden', sel.value !== CUSTOM_MODEL);
  $('model-hint').textContent = state.modelLists[p]
    ? `${state.modelLists[p].length} models available for your key.`
    : 'Test your key to load every model it can use.';
}

async function fetchModels(p, { quiet } = {}) {
  const apiKey = state.draft.apiKeys[p];
  if (!apiKey) { if (!quiet) notice('key-status', 'Paste a key first.', 'warn'); return false; }
  const btn = $('refresh-models');
  btn.disabled = true; btn.textContent = 'Loading…';
  try {
    const res = await send({ action: 'listModels', data: { provider: p, apiKey } });
    state.modelLists[p] = res.models;
    await new Promise(r => chrome.storage.local.set({ modelLists: state.modelLists }, r));
    if (state.draft.provider === p) renderModelSelect(p);
    return true;
  } catch (err) {
    if (!quiet && state.draft.provider === p) notice('key-status', `Couldn't load models: ${err.message}`, 'err');
    return false;
  } finally {
    btn.disabled = false; btn.textContent = 'Refresh list';
  }
}

function stashKeyInputs() {
  const p = state.draft.provider;
  if (p === 'free') return;
  state.draft.apiKeys[p] = $('api-key').value.trim();
  const v = $('model-select').value;
  state.draft.models[p] = v === CUSTOM_MODEL ? $('model').value.trim() : v;
}

async function testKey() {
  stashKeyInputs();
  const provider = state.draft.provider;
  const apiKey   = state.draft.apiKeys[provider];
  if (!apiKey) { notice('key-status', 'Paste a key first.', 'warn'); return; }
  $('test-btn').disabled = true; $('test-btn').textContent = 'Testing…';
  try {
    // Loading the model list also proves the key works; then confirm the chosen model answers.
    await fetchModels(provider, { quiet: true });
    stashKeyInputs();
    await send({ action: 'testApiKey', data: { provider, apiKey, model: state.draft.models[provider] } });
    notice('key-status', `Connected. ${PROVIDER_META[provider].name} will write your messages.`, 'ok');
    await persistDraft();
  } catch (err) {
    notice('key-status', err.message, 'err');
  } finally {
    $('test-btn').disabled = false; $('test-btn').textContent = 'Test';
  }
}

async function saveSettings() {
  stashKeyInputs();
  const p = state.draft.provider;
  if (p !== 'free' && !state.draft.apiKeys[p]) {
    notice('save-status', `Add a ${PROVIDER_META[p].name} key, or switch back to Free.`, 'warn');
    return;
  }
  const extra = { userName: $('user-name').value.trim(), userBio: $('user-bio').value.trim() };
  if (state.pendingResume === null) {
    await new Promise(r => chrome.storage.local.remove(['resumeBase64', 'resumeFileName'], r));
  } else if (state.pendingResume) {
    extra.resumeBase64 = state.pendingResume.base64;
    extra.resumeFileName = state.pendingResume.fileName;
  }
  state.pendingResume = undefined;
  await persistDraft(extra);
  notice('save-status', 'Saved.', 'ok', 1800);
}

async function persistDraft(extra = {}) {
  await new Promise(r => chrome.storage.local.set({
    provider: state.draft.provider, apiKeys: state.draft.apiKeys, models: state.draft.models, ...extra
  }, r));
  await new Promise(r => chrome.storage.local.remove(['userApiKey'], r)); // legacy key now lives in apiKeys
  renderModePill(state.draft);
}

function renderModePill(d) {
  const ai = d.provider !== 'free' && (d.apiKeys || {})[d.provider];
  $('mode-pill').textContent = ai ? `${PROVIDER_META[d.provider].name} connected` : 'Free mode';
  $('mode-pill').classList.toggle('ai', !!ai);
}

function readResume(file) {
  if (file.type !== 'application/pdf') { notice('save-status', 'Resume must be a PDF.', 'err'); return; }
  if (file.size > 4 * 1024 * 1024)    { notice('save-status', 'Resume is over 4 MB.', 'err'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    state.pendingResume = { base64: e.target.result.split(',')[1], fileName: file.name };
    renderResume(file.name, true);
  };
  reader.readAsDataURL(file);
}

function renderResume(name, pending) {
  $('drop').classList.toggle('has-file', !!name);
  $('drop-label').textContent = name ? `${name}${pending ? ' (save to keep)' : ''}` : 'Upload or drop a PDF';
  $('remove-resume').classList.toggle('hidden', !name);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res) return reject(new Error('No response from the extension. Try reopening the popup.'));
      if (!res.success) return reject(new Error(res.error || 'Something went wrong.'));
      resolve(res);
    });
  });
}

function storageGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function notice(id, text, kind = '', autoHide) {
  const el = $(id);
  el.textContent = text;
  el.className = `notice ${kind}`;
  if (autoHide) setTimeout(() => el.classList.add('hidden'), autoHide);
}
function cleanDisplayName(n) { return String(n || 'Unknown').replace(/^\(\d+\+?\)\s*/, ''); }
function initials(name) {
  const parts = cleanDisplayName(name).replace(/[^\p{L}\s]/gu, '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
