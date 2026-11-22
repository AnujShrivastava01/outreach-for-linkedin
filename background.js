'use strict';

// background.js — Outreach for LinkedIn
// • Free Mode: messages are written locally from templates (no key, no network).
// • AI Mode: the user picks a provider (Anthropic, OpenAI, Google Gemini, Groq)
//   and pastes THEIR OWN key. Calls go straight from the browser to that provider.
// • Refine: any message can be rewritten with a quick action or a custom instruction.

// ─── Providers ────────────────────────────────────────────────────────────────
const PROVIDERS = {
  anthropic: { label: 'Anthropic Claude', defaultModel: 'claude-haiku-5-5',        supportsPdf: true  },
  openai:    { label: 'OpenAI',           defaultModel: 'gpt-4o-mini',             supportsPdf: true  },
  gemini:    { label: 'Google Gemini',    defaultModel: 'gemini-2.5-flash',        supportsPdf: true  },
  groq:      { label: 'Groq',             defaultModel: 'llama-3.3-70b-versatile', supportsPdf: false }
};

const NOTE_LIMIT = 300; // LinkedIn connection-request note limit

// ─── Router ───────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const routes = {
    scrapeProfile:   () => handleScrapeProfile(),
    generateMessage: () => handleGenerate(message.data),
    refineMessage:   () => handleRefine(message.data),
    testApiKey:      () => handleTestKey(message.data),
    listModels:      () => handleListModels(message.data),
    getProviders:   async () => ({ providers: PROVIDERS })
  };
  const route = routes[message.action];
  if (!route) return false;
  route()
    .then(res => sendResponse({ success: true, ...res }))
    .catch(err => sendResponse({ success: false, error: friendlyError(err) }));
  return true;
});

// ─── Scrape profile from active tab ───────────────────────────────────────────
async function handleScrapeProfile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab found.');
  if (!tab.url || !/linkedin\.com\/in\//.test(tab.url)) {
    throw new Error('Open a LinkedIn profile (linkedin.com/in/…) first.');
  }

  let result;
  try {
    result = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
  } catch (_) {
    // Content script not injected yet (e.g. tab opened before install) — inject and retry.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content_script.js'] });
    await delay(400);
    result = await chrome.tabs.sendMessage(tab.id, { action: 'scrapeProfile' });
  }
  if (!result?.success) throw new Error(result?.error || 'Could not read this profile.');

  const profile = normalizeProfile(result.data);
  return { data: { ...profile, hooks: buildHooks(profile) } };
}

// ─── Generate ─────────────────────────────────────────────────────────────────
async function handleGenerate({ profile, messageType, tone, format, hooks }) {
  const p        = normalizeProfile(profile);
  const settings = await getSettings();
  const chosen   = (hooks && hooks.length ? hooks : buildHooks(p)).slice(0, 2);
  const ai       = activeProvider(settings);

  if (!ai) {
    return { message: localMessage(p, chosen, messageType, tone, format, settings), mode: 'free' };
  }

  const prompt = buildGeneratePrompt(p, chosen, messageType, tone, format, settings);
  let text;
  try {
    text = await callModel(ai, prompt, { resume: settings.resumeBase64 });
  } catch (err) {
    // If attaching the resume was the problem, try again without it rather than failing.
    if (!settings.resumeBase64) throw err;
    text = await callModel(ai, prompt, {});
  }
  return { message: ensureGreeting(cleanOutput(text), greetingFor(tone, p.firstName), p.firstName), mode: ai.provider };
}

// ─── Refine ───────────────────────────────────────────────────────────────────
async function handleRefine({ message, instruction, preset, profile, tone, format }) {
  if (!message) throw new Error('Nothing to refine yet.');
  const settings = await getSettings();
  const ai       = activeProvider(settings);
  const p        = normalizeProfile(profile);

  if (!ai) {
    if (preset) return { message: localRefine(message, preset, p, tone, format), mode: 'free' };
    throw new Error('Custom instructions need an AI provider. Add a key in Settings (Gemini and Groq have free tiers), or use a quick action.');
  }

  const ask = instruction || PRESET_INSTRUCTIONS[preset] || 'Improve it.';
  const limit = format === 'note' ? `It is a LinkedIn connection note, so it MUST stay under ${NOTE_LIMIT} characters.` : '';
  const prompt =
`Here is a LinkedIn outreach message to ${p.firstName || 'someone'}:

"""
${message}
"""

Rewrite it following this instruction: ${ask}
${limit}
Keep every fact accurate. Do not invent details about either person. Keep the recipient's first name exactly as "${p.firstName}".
Keep a greeting line at the top (like "Hi ${p.firstName || 'there'},"); only change its wording if the instruction is about tone.
Return only the rewritten message, with no preamble or quotes.`;
  // If the model drops the greeting, put back the one the message had (or the tone's default).
  const firstLine = message.split('\n')[0].trim();
  const fallback  = GREETING_RE.test(firstLine) ? firstLine : greetingFor(tone, p.firstName);
  const out = cleanOutput(await callModel(ai, prompt, { system: WRITING_RULES }));
  return { message: ensureGreeting(out, fallback, p.firstName), mode: ai.provider };
}

const PRESET_INSTRUCTIONS = {
  shorter:  'Make it noticeably shorter and tighter. Cut filler, keep the hook and the ask.',
  formal:   'Make it more formal and polished, suitable for a senior professional.',
  friendly: 'Make it warmer and more conversational, like a message to a peer.',
  question: 'End with one easy, specific question the recipient can answer in a line.',
  fit:      `Fit it under ${NOTE_LIMIT} characters for a LinkedIn connection note.`
};

// ─── Test key ─────────────────────────────────────────────────────────────────
async function handleTestKey({ provider, apiKey, model }) {
  if (!PROVIDERS[provider]) throw new Error('Pick a provider first.');
  if (!apiKey) throw new Error('Paste a key first.');
  await callModel({ provider, apiKey, model: model || PROVIDERS[provider].defaultModel }, 'Reply with the single word: OK', { maxTokens: 20 });
  return { valid: true };
}

// ─── List models (from the provider's own API, using the user's key) ─────────
// Returns [{ id, label }] filtered to text/chat models that can write a message.
async function handleListModels({ provider, apiKey }) {
  if (!PROVIDERS[provider]) throw new Error('Pick a provider first.');
  if (!apiKey) throw new Error('Paste a key first.');
  let models = [];

  if (provider === 'anthropic') {
    const data = await getJSON('https://api.anthropic.com/v1/models?limit=100', {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    });
    models = (data.data || []).map(m => ({ id: m.id, label: m.display_name || m.id }));   // newest first
  }

  if (provider === 'openai' || provider === 'groq') {
    const url = provider === 'openai' ? 'https://api.openai.com/v1/models' : 'https://api.groq.com/openai/v1/models';
    const data = await getJSON(url, { Authorization: `Bearer ${apiKey}` });
    const notChat = /embed|whisper|tts|audio|realtime|transcribe|image|dall-e|moderation|search|guard|instruct|babbage|davinci|computer-use|codex|prompt/i;
    models = (data.data || [])
      .filter(m => m.active !== false && !notChat.test(m.id))
      .filter(m => provider === 'groq' || /^(gpt|o\d|chatgpt)/i.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id))
      .map(m => ({ id: m.id, label: m.id }));
  }

  if (provider === 'gemini') {
    const data = await getJSON('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': apiKey });
    models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .filter(m => !/embed|tts|image|aqa|vision|learnlm|native-audio|live/i.test(m.name))
      .map(m => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, '') }));
  }

  if (!models.length) throw new Error('The provider returned no usable models for this key.');
  return { models };
}

async function getJSON(url, headers) {
  const res  = await fetch(url, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data?.error?.message || `HTTP ${res.status}`); e.status = res.status; throw e;
  }
  return data;
}

// ─── Prompting ────────────────────────────────────────────────────────────────
const WRITING_RULES =
`You write LinkedIn outreach messages that sound like a thoughtful human, not a template.
Rules:
- Start with the exact greeting line you are given (for example "Hi Priya,"), on its own line. Never start with the bare name.
- Reference ONE specific, true detail from their profile. Use only facts present in the profile JSON.
- Only mention a post if "recentPosts" contains one. Do not congratulate them on a new role, promotion or anniversary unless the profile explicitly says it is recent.
- One clear, low-pressure ask. No more than one question.
- Plain words. No buzzwords, no flattery stacks, no "I hope this message finds you well", no "I came across your profile and was impressed".
- No emojis, hashtags, subject lines, markdown or placeholders like [Company].
- Sign off with the sender's first name if one is given.`;

function buildGeneratePrompt(p, hooks, messageType, tone, format, settings) {
  const purpose = {
    Networking:    'start a genuine professional connection',
    Job:           'ask about job opportunities on their team or company',
    Referral:      'politely ask whether they would consider referring the sender for a relevant role',
    Collaboration: 'propose exploring a collaboration'
  }[messageType] || 'connect';

  const length = format === 'note'
    ? `This is a connection-request note: HARD LIMIT ${NOTE_LIMIT} characters including spaces. Aim for 200-280.`
    : 'This is a direct message: 60-110 words, 2-3 short paragraphs.';

  // Only send fields we actually have, so the model has nothing empty to "fill in".
  const recipient = pruneEmpty({
    firstName: p.firstName, fullName: p.name, headline: p.headline,
    title: p.currentTitle, company: p.currentCompany, location: p.location,
    about: truncate(p.about, 400), recentPosts: p.recentPosts.map(x => truncate(x, 200)),
    skills: p.skills.slice(0, 6), pastCompanies: p.pastCompanies, education: p.educationEntries.slice(0, 1)
  });
  const me = firstNameOf(settings.userName);

  return {
    system: WRITING_RULES,
    user:
`Goal: ${purpose}.
Tone: ${tone}.
${length}

Recipient profile (JSON):
${JSON.stringify(recipient, null, 1)}
${p.recentPosts.length ? '' : '\nWe could not read any posts from this person, so do NOT mention or imply a post.\n'}
Lead with this talking point: ${hooks.map(h => h.label).join(' / ') || 'their current role'}

Start the message with exactly this line: "${greetingFor(tone, p.firstName)}"
End with "${signoffFor(tone)}"${me ? ` followed by "${me}" on the next line` : ''}.

Sender: ${settings.userName || '(no name given — sign off without a name)'}
Sender background: ${settings.userBio || '(not given)'}${settings.resumeBase64 ? '\nThe sender\'s resume is attached; use at most one relevant credential from it.' : ''}

Write the message now. Return only the message text.`
  };
}

// ─── Model calls ──────────────────────────────────────────────────────────────
async function callModel(ai, prompt, opts = {}) {
  const system    = typeof prompt === 'string' ? (opts.system || '') : prompt.system;
  const user      = typeof prompt === 'string' ? prompt : prompt.user;
  const maxTokens = opts.maxTokens || 600;
  const resume    = PROVIDERS[ai.provider].supportsPdf ? opts.resume : null;

  switch (ai.provider) {
    case 'anthropic': return callAnthropic(ai, system, user, maxTokens, resume);
    case 'openai':    return callOpenAICompatible('https://api.openai.com/v1/chat/completions', ai, system, user, maxTokens, resume, 'max_completion_tokens');
    case 'groq':      return callOpenAICompatible('https://api.groq.com/openai/v1/chat/completions', ai, system, user, maxTokens, null, 'max_tokens');
    case 'gemini':    return callGemini(ai, system, user, maxTokens, resume);
    default: throw new Error('Unknown provider.');
  }
}

async function callAnthropic({ apiKey, model }, system, user, maxTokens, resume) {
  const content = [{ type: 'text', text: user }];
  if (resume) content.unshift({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: resume } });
  const body = { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] };
  if (system) body.system = system;
  const data = await postJSON('https://api.anthropic.com/v1/messages', body, {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  });
  return (data.content || []).map(c => c.text || '').join('');
}

async function callOpenAICompatible(url, { apiKey, model }, system, user, maxTokens, resume, tokenParam) {
  const userContent = resume
    ? [{ type: 'file', file: { filename: 'resume.pdf', file_data: `data:application/pdf;base64,${resume}` } }, { type: 'text', text: user }]
    : user;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });
  const data = await postJSON(url, { model, messages, [tokenParam]: maxTokens }, { Authorization: `Bearer ${apiKey}` });
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini({ apiKey, model }, system, user, maxTokens, resume) {
  const parts = [{ text: user }];
  if (resume) parts.unshift({ inline_data: { mime_type: 'application/pdf', data: resume } });
  const body = {
    contents: [{ role: 'user', parts }],
    // Thinking models spend output tokens on reasoning, so leave generous headroom.
    generationConfig: { maxOutputTokens: Math.max(maxTokens, 1500), temperature: 0.8 }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await postJSON(url, body, { 'x-goog-api-key': apiKey });
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason || 'unknown reason'}).`);
  return text;
}

async function postJSON(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || (typeof data?.error === 'string' ? data.error : '') || `HTTP ${res.status}`;
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return data;
}

function friendlyError(err) {
  const m = String(err?.message || err);
  if (err?.status === 401 || err?.status === 403 || /invalid.*key|api key not valid|incorrect api key|authentication/i.test(m)) return 'That API key was rejected. Check it in Settings.';
  if (err?.status === 429 || /quota|rate limit/i.test(m)) return 'The provider is rate-limiting this key. Wait a moment and try again.';
  if (err?.status === 404 || /model.*not.*found|does not exist/i.test(m)) return `Model not found: ${m}. Check the model name in Settings.`;
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Network error. Check your connection.';
  return m;
}

// ─── Profile helpers ──────────────────────────────────────────────────────────
function normalizeProfile(raw = {}) {
  const name = String(raw.name || '').replace(/^\(\d+\+?\)\s*/, '').trim();
  const first = raw.firstName || name.split(/\s+/)[0] || '';
  return {
    name,
    firstName:         properCase(first),
    headline:          raw.headline || '',
    currentTitle:      raw.currentTitle || '',
    currentCompany:    raw.currentCompany || '',
    location:          raw.location || '',
    about:             raw.about || '',
    recentPosts:       raw.recentPosts || [],
    experienceEntries: raw.experienceEntries || [],
    pastCompanies:     raw.pastCompanies || [],
    educationEntries:  raw.educationEntries || [],
    skills:            raw.skills || [],
    profileUrl:        raw.profileUrl || ''
  };
}

// Talking points the user can choose from. Each has a short label for the UI and a
// ready-made sentence for Free Mode.
function buildHooks(p) {
  const hooks = [];
  const co = prettyCompany(p.currentCompany);
  if (p.recentPosts.length) {
    const post = truncate(p.recentPosts[0], 70);
    hooks.push({ id: 'post', label: `Their recent post: "${post}"`, sentence: `Your recent post on "${truncate(p.recentPosts[0], 60)}" got me thinking.` });
  }
  if (p.currentTitle && co) {
    hooks.push({ id: 'role', label: `${p.currentTitle} at ${co}`, sentence: `Your work as ${p.currentTitle} at ${co} caught my eye.` });
  } else if (co) {
    hooks.push({ id: 'role', label: `Works at ${co}`, sentence: `I noticed you're at ${co}.` });
  } else if (p.headline) {
    hooks.push({ id: 'role', label: truncate(p.headline, 60), sentence: `Your work in ${truncate(p.headline, 60)} caught my eye.` });
  }
  if (p.skills.length) {
    const s = p.skills.slice(0, 2).join(' and ');
    hooks.push({ id: 'skills', label: `Skills: ${p.skills.slice(0, 3).join(', ')}`, sentence: `Your background in ${s} is close to what I work on.` });
  }
  if (p.pastCompanies.length) {
    hooks.push({ id: 'past', label: `Previously at ${p.pastCompanies.slice(0, 2).join(', ')}`, sentence: `I saw you were previously at ${prettyCompany(p.pastCompanies[0])}.` });
  }
  if (p.educationEntries.length) {
    const school = stringify(p.educationEntries[0]).split(' — ')[0];
    hooks.push({ id: 'edu', label: `Studied at ${truncate(school, 50)}`, sentence: `I noticed you studied at ${school}.` });
  }
  return hooks.slice(0, 5);
}

// ─── Free Mode writer ─────────────────────────────────────────────────────────
function localMessage(p, hooks, messageType, tone, format, settings = {}) {
  const me    = firstNameOf(settings.userName);
  const first = p.firstName;
  const co    = prettyCompany(p.currentCompany);

  const greet = first
    ? ({ Formal: `Dear ${first},`, Neutral: `Hi ${first},`, Casual: `Hey ${first},` }[tone] || `Hi ${first},`)
    : ({ Formal: 'Hello,', Neutral: 'Hi there,', Casual: 'Hey,' }[tone] || 'Hi there,');
  const close = { Formal: 'Kind regards,', Neutral: 'Best,', Casual: 'Cheers,' }[tone] || 'Best,';

  const hookLine = hooks[0]?.sentence || (co ? `I noticed your work at ${co}.` : 'I came across your profile and liked your background.');
  const bio      = (settings.userBio || '').trim();
  const intro    = bio ? `A bit about me: ${truncate(firstSentence(bio), 110)}` : '';

  const ask = {
    Networking:    `Would be great to connect and swap notes.`,
    Job:           `I'm exploring roles${co ? ` at ${co}` : ''} and would value a quick chat about what the team is working on.`,
    Referral:      `If there's a role${co ? ` at ${co}` : ''} that fits my background, would you be open to referring me? Happy to send details.`,
    Collaboration: `I think there's room for us to work on something together. Open to a short call?`
  }[messageType] || `Would be great to connect.`;

  const signoff = me ? `${close}\n${me}` : close;
  let body = [hookLine, intro ? ensurePeriod(intro) : ''].filter(Boolean).join(' ');
  let msg = `${greet}\n\n${body}\n\n${ask}\n\n${signoff}`;

  if (format === 'note' && msg.length > NOTE_LIMIT) {
    msg = `${greet}\n\n${hookLine}\n\n${ask}\n\n${signoff}`;          // drop the intro first
    if (msg.length > NOTE_LIMIT) msg = `${greet} ${hookLine} ${ask}\n${signoff}`;
  }
  return msg;
}

function localRefine(message, preset, p, tone, format) {
  let m = message.trim();
  const lines = m.split('\n');
  switch (preset) {
    case 'formal':
      m = m.replace(/^(Hi|Hey|Hello)\b[^,\n]*,?/i, `Dear ${p.firstName || 'there'},`)
           .replace(/^(Best|Cheers|Thanks)[,!]?$/mi, 'Kind regards,');
      break;
    case 'friendly':
      m = m.replace(/^(Dear|Hello|Hi)\b[^,\n]*,?/i, `Hey ${p.firstName || 'there'},`)
           .replace(/^(Kind regards|Best regards|Best)[,!]?$/mi, 'Cheers,');
      break;
    case 'question':
      if (!/\?\s*$/m.test(m)) {
        const i = lines.findIndex(l => /^(best|cheers|kind regards|thanks)/i.test(l.trim()));
        const q = 'Would you be open to a quick 15-minute chat this week?';
        if (i > 0) { lines.splice(i, 0, q, ''); m = lines.join('\n'); } else m = `${m}\n\n${q}`;
      }
      break;
    case 'shorter':
    case 'fit': {
      const limit = preset === 'fit' ? NOTE_LIMIT : Math.max(160, Math.round(m.length * 0.75));
      m = m.replace(/\s*A bit about me:[^\n]*/, '').replace(/\n{3,}/g, '\n\n');   // drop self-intro first
      // Then drop trailing sentences from multi-sentence paragraphs (never empties a paragraph).
      for (let guard = 0; m.length > limit && guard < 10; guard++) {
        const paras = m.split('\n\n');
        const idx = paras.findIndex((x, i) => i > 0 && i < paras.length - 1 && splitSentences(x).length > 1);
        if (idx === -1) break;
        const parts = splitSentences(paras[idx]); parts.pop();
        paras[idx] = parts.join(' ');
        m = paras.join('\n\n');
      }
      if (preset === 'fit' && m.length > limit) m = m.replace(/\n\n/g, '\n');           // compact layout
      if (preset === 'fit' && m.length > limit) m = m.slice(0, limit - 1).replace(/\s+\S*$/, '') + '…';
      break;
    }
  }
  return m;
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function getSettings() {
  return new Promise(resolve => chrome.storage.local.get(
    ['provider', 'apiKeys', 'models', 'userApiKey', 'userName', 'userBio', 'resumeBase64', 'resumeFileName'],
    resolve
  ));
}

function activeProvider(s) {
  // Legacy setting: a single Anthropic key stored as `userApiKey`.
  const keys = { ...(s.apiKeys || {}) };
  if (!keys.anthropic && s.userApiKey) keys.anthropic = s.userApiKey;
  const provider = s.provider || (keys.anthropic ? 'anthropic' : 'free');
  if (provider === 'free' || !PROVIDERS[provider]) return null;
  const apiKey = (keys[provider] || '').trim();
  if (!apiKey) return null;
  const model = ((s.models || {})[provider] || '').trim() || PROVIDERS[provider].defaultModel;
  return { provider, apiKey, model };
}

function cleanOutput(t) {
  let s = String(t || '').trim();
  s = s.replace(/^```[a-z]*\n?|```$/g, '').trim();
  s = s.replace(/^(subject|message)\s*:.*\n+/i, '');
  s = s.replace(/^(here('s| is) (the|your|a) [^\n:]*:)\s*\n+/i, '');
  if (/^["“].*["”]$/s.test(s)) s = s.slice(1, -1).trim();
  return s.replace(/\*\*(.+?)\*\*/g, '$1');
}

// ─── Greeting helpers ─────────────────────────────────────────────────────────
const GREETING_RE = /^(hi|hey|hello|dear|greetings|good (morning|afternoon|evening))\b/i;

function greetingFor(tone, firstName) {
  const n = firstName ? ` ${firstName}` : '';
  if (tone === 'Formal') return firstName ? `Dear ${firstName},` : 'Hello,';
  if (tone === 'Casual') return `Hey${n},`;
  return firstName ? `Hi ${firstName},` : 'Hi there,';
}
function signoffFor(tone) {
  return { Formal: 'Kind regards,', Casual: 'Cheers,' }[tone] || 'Best,';
}

// Models sometimes open with just "Nikhil," or skip the greeting entirely. Fix that.
function ensureGreeting(text, greeting, firstName) {
  const lines = String(text || '').split('\n');
  const first = (lines[0] || '').trim();
  if (GREETING_RE.test(first)) return text;
  const bareName = firstName && new RegExp(`^${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[,!.:—-]?$`, 'i').test(first);
  if (bareName || /^[\p{L}][\p{L} .'-]{0,30},$/u.test(first)) {   // "Nikhil," / "Nikhil Singh,"
    lines[0] = greeting;
    return lines.join('\n');
  }
  return `${greeting}\n\n${text}`;
}

function pruneEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => Array.isArray(v) ? v.length : !!v));
}

function properCase(w) {
  w = String(w || '').trim();
  if (!w) return '';
  return w === w.toLowerCase() || w === w.toUpperCase() ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w;
}
function firstNameOf(n) { return properCase(String(n || '').trim().split(/\s+/)[0]); }
function firstSentence(s) { return String(s).split(/(?<=[.!?])\s/)[0]; }
function splitSentences(t) { return String(t).match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(x => x.trim()).filter(Boolean) || [t]; }
function prettyCompany(c) {
  return String(c || '').replace(/,?\s+(inc\.?|llc|ltd\.?|pvt\.?\s*ltd\.?|private limited|limited|corp\.?|corporation|gmbh|plc)$/i, '').trim();
}
function ensurePeriod(s) { return /[.!?…]$/.test(s) ? s : s + '.'; }
function truncate(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function stringify(x) { return typeof x === 'string' ? x : (x?.school || x?.name || x?.title || Object.values(x || {}).join(', ')); }
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
