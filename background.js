// vibeReply - Background Service Worker
// Handles Gemini API calls and media fetching (to avoid page CORS).

console.log('vibeReply: background loaded');

// Open side panel when the extension icon is clicked
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(err => console.error('vibeReply: sidePanel.setPanelBehavior failed', err));
}

// Tried in order on each key. If the first is retired or out of quota for a key,
// the next one is used. (gemini-2.5-flash is closed to new users.)
// "fast" (default): Flash-Lite with minimal thinking answers in a second or two.
// "smart": 3.8 Flash writes a bit better but always thinks first, so it's slower.
const GEMINI_MODEL_ORDER = {
  fast: ['gemini-3.5-flash-lite', 'gemini-3.8-flash'],
  smart: ['gemini-3.8-flash', 'gemini-3.5-flash-lite']
};
const GEMINI_MODELS = GEMINI_MODEL_ORDER.fast;

async function getGeminiModels() {
  const { replySpeed } = await chrome.storage.local.get(['replySpeed']);
  return GEMINI_MODEL_ORDER[replySpeed] || GEMINI_MODEL_ORDER.fast;
}
const MODEL_LABELS = { 'gemini-3.8-flash': '3.8 Flash', 'gemini-3.5-flash-lite': '3.5 Flash-Lite' };
// Lowest thinking level each model supports, for speed (3.8 Flash can't go below "low")
const THINKING_LEVELS = { 'gemini-3.8-flash': 'low', 'gemini-3.5-flash-lite': 'minimal' };

// Time limits so a slow or stuck request can never hang the panel
const TIMEOUT_MEDIA_MS = 8000;
const TIMEOUT_GEMINI_MS = 20000;
// Flash-Lite normally answers in 1 to 3s; if it's that slow, it's stuck, so move on sooner
const MODEL_TIMEOUTS = { 'gemini-3.5-flash-lite': 12000, 'gemini-3.8-flash': 20000 };
const TIMEOUT_OPENROUTER_MS = 25000;
const TIMEOUT_GROQ_MS = 12000; // Groq is fast; if it isn't answering, move on
const TOTAL_BUDGET_MS = 60000; // stop trying new keys/models after this
const geminiEndpoint = model =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const OPENROUTER_MODEL = 'google/gemini-3.8-flash';
// Models that answered "not found / no longer available" during this worker's life
const retiredModels = new Set();
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Sends a short status line back to the tab that asked, so the panel shows what's happening
function progressReporter(sender, requestId) {
  const tabId = sender?.tab?.id;
  return text => {
    if (tabId == null || !requestId) return;
    chrome.tabs.sendMessage(tabId, { action: 'vibeProgress', requestId, text }).catch(() => {});
  };
}

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'generateReplies') {
    generateReplies({ ...req.data, onProgress: progressReporter(sender, req.data?.requestId) })
      .then(({ read, replies, meta }) => sendResponse({ success: true, read, replies, meta }))
      .catch(err => {
        console.error('vibeReply error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // async
  }
  if (req.action === 'improveReply') {
    improveReply({ ...req.data, onProgress: progressReporter(sender, req.data?.requestId) })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => {
        console.error('vibeReply improve error:', err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // async
  }
});

// fetch() plus reading the body, all under one time limit.
// read: 'json' | 'blob'. Throws an error with status 'timeout' when the limit is hit.
async function fetchWithTimeout(url, opts, ms, read = 'json') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    let data;
    if (read === 'blob') data = res.ok ? await res.blob() : null;
    else data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`timed out after ${Math.round(ms / 1000)}s`);
      err.status = 'timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAsBase64(url) {
  const res = await fetchWithTimeout(url, {}, TIMEOUT_MEDIA_MS, 'blob');
  if (!res.ok) throw new Error(`Failed to fetch media (${res.status})`);
  const blob = res.data;
  const mime = blob.type || 'image/jpeg';
  const buf = await blob.arrayBuffer();
  // Convert ArrayBuffer to base64
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  return { mime, base64 };
}

// Gemini vision/audio inline-data MIME allowlist.
// SVG, GIF, AVIF, ICO etc. are NOT supported and must be skipped.
const GEMINI_SUPPORTED_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif',
  'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv', 'video/mpg',
  'video/webm', 'video/wmv', 'video/3gpp', 'video/quicktime',
  'audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/mpeg',
]);
function isGeminiSupportedMime(mime) {
  if (!mime) return false;
  return GEMINI_SUPPORTED_MIMES.has(mime.toLowerCase().split(';')[0].trim());
}

// How many candidates to ask for; the sloppiest are dropped and the best 6 shown:
// 2 questions and 4 that are not questions. A few spares of each kind are asked for
// so the slop filter has room to drop some.
const QUESTION_CANDIDATES = 3;
const STATEMENT_CANDIDATES = 7;
const REPLY_CANDIDATES = QUESTION_CANDIDATES + STATEMENT_CANDIDATES;
const QUESTIONS_SHOWN = 2;
const STATEMENTS_SHOWN = 4;
const REPLIES_SHOWN = QUESTIONS_SHOWN + STATEMENTS_SHOWN;

// Describes the post (text, author, quote, link card, media) for any prompt.
function describePost(tweetText, context = {}, hasMedia, mediaKind) {
  const lines = [];
  if (context.author) lines.push(`Posted by: ${context.author}`);
  if (context.replyingTo) lines.push(`This post is itself a reply to: ${context.replyingTo}`);
  lines.push(`Post text: "${tweetText || '(no text)'}"`);
  if (context.quoted) {
    lines.push(`It quotes a post by ${context.quoted.author || 'someone'}: "${context.quoted.text}"`);
  }
  if (context.card) lines.push(`Link preview in the post: "${context.card}"`);
  if (context.altTexts?.length) lines.push(`Image description(s) from the poster: ${context.altTexts.map(a => `"${a}"`).join(', ')}`);
  if (hasMedia) {
    lines.push(mediaKind === 'video'
      ? 'It has a video. You only get one still frame of it (attached), so don\'t claim to know what happens in the video beyond that frame and the text.'
      : `It has ${mediaKind} (attached).`);
  } else {
    lines.push('No media you can see; go by the text.');
  }
  return lines.join('\n');
}

// The user's own past replies, so suggestions sound like them.
function describeStyle(styleExamples) {
  if (!Array.isArray(styleExamples) || !styleExamples.length) return '';
  const sample = styleExamples.slice(0, 15).map(s => `- ${s}`).join('\n');
  return `
HOW THIS PERSON WRITES
These are replies they wrote themselves. Copy their voice: length, casing, punctuation, slang level, how direct they are. Do NOT reuse their content or phrases.
${sample}
`;
}

// Shared "sound like a real person" rules for every prompt that writes reply text.
const HUMAN_RULES = `HOW REAL REPLIES ON X LOOK
- They answer the post's actual point. Read alone, the reply still makes it obvious what it's under.
- Mostly plain: a quick reaction, agreeing or disagreeing with a reason, a small observation, a real question you'd want answered. Not every reply needs a twist.
- Short. Usually 4 to 15 words. Fragments are fine. Usually no full stop at the end. Starting lowercase is fine.
- Same language and tone as the post. A trading post gets a trader's reply with the post's own terms (tickers, numbers they gave). A meme gets a casual reply. A serious or sad post gets no jokes.
- Stay inside what the post says. If you're unsure what something in it means, react to the part that is clear.

NEVER
- Generic lines that fit under any post: "love this", "so true", "great point", "well said", "this is everything", "made my day", "couldn't agree more", "spot on", "facts".
- Assistant voice: praising the poster, "great question", "absolutely", "truly", "a testament to", "wishing you", "journey", "resonates", "dive into".
- Hype words: game changer, next level, insane, mind-blowing, legendary, iconic, revolutionary.
- Engagement bait: "who else", "agree?", "thoughts?", "let that sink in", "read that again".
- Templates: "not just X, it's Y", "X isn't just Y", "POV:", "me when", "here's the thing", lists of three, a moral or lesson at the end.
- Made-up facts, prices, numbers, or personal experiences ("I bought at 40", "my dog does this"). Only use what the post gives you.
- Describing or repeating the post back to the poster.
- Em dashes, semicolons, emojis, hashtags, @mentions, ALL CAPS, forced slang ("ngl", "fr fr", "lowkey"), fake typos.
- Shilling or promoting anything.`;

// A few contrasting examples. Different topics on purpose; never reuse their content.
const REPLY_EXAMPLES = `EXAMPLES (different posts; show the style only, never reuse the content)
Post: "finally finished restoring this 1972 honda" + photo of a red motorbike
  bad: "This is absolutely stunning! Your dedication truly shines through."
  good: "that red is perfect on it"
  good: "how long did the tank take"
Post: "$NVDA earnings tomorrow. holding through it"
  bad: "Bold move! Wishing you the best on this exciting journey."
  good: "what's the plan if it gaps down"
  good: "guidance is what moves it this time, not the beat"
Post: video, a dog won't get out of the pool while its owner calls it
  bad: "This dog is living its best life! Pure joy."
  good: "he heard you, he's just not coming"
Post: "anyone else's landlord ignoring repair requests for months?"
  bad: "So relatable! Landlords can be so frustrating sometimes."
  good: "put every request in writing with dates, it matters later"`;

function buildPrompt(tweetText, hasMedia, mediaKind, context, styleExamples) {
  return `You suggest replies for someone scrolling X. Write like a regular person who actually read this post, not like an assistant.

THE POST
${describePost(tweetText, context, hasMedia, mediaKind)}

STEP 1. In "read", write one plain sentence: what the post is saying or showing, and what the poster is going for (a laugh, agreement, debate, news, an opinion, asking for help...). If something is unclear, say so instead of guessing.

STEP 2. Write replies a real person might post under it, based on your "read", in two lists:
- "replies": exactly ${STATEMENT_CANDIDATES} replies that are NOT questions. Mix them: a quick reaction, agreeing or disagreeing with a reason, a take, a small observation, adding something useful. None of them may be a question, a rhetorical question, or end with "?".
- "questions": exactly ${QUESTION_CANDIDATES} real questions you'd actually want the poster to answer, each about something specific in the post.
At most 2 of all the replies may be jokes, and only if the post is light.

${HUMAN_RULES}
${describeStyle(styleExamples)}
${REPLY_EXAMPLES}

Output ONLY valid JSON, nothing else:
{"read": "...", "replies": ["...", "..."], "questions": ["...", "..."]}`;
}

// Casual questions often drop the "?", so also look at how the reply starts.
const QUESTION_START = /^(what|what'?s|how|how'?s|why|who|who'?s|whose|when|where|which|is|are|was|were|do|does|did|can|could|would|will|should|has|have (you|they|we|u)|any|anyone|anybody|isn'?t|aren'?t|don'?t|doesn'?t|didn'?t|won'?t|wouldn'?t|can'?t|ever)\b/i;

function isQuestion(reply) {
  const r = String(reply).trim().replace(/^["'“‘]+|["'”’.!\s]+$/g, '');
  return /\?$/.test(r) || QUESTION_START.test(r);
}


// Phrases that mark a reply as generic / AI-sounding. Used to rank candidates.
const SLOP_PATTERNS = [
  /\b(love this|love that|this is everything|so wholesome|wholesome content|made my day|absolutely (stunning|amazing|incredible|beautiful)|couldn'?t agree more|so much this|pure joy|chef'?s kiss|we (don'?t|do not) deserve|the internet needed this|needed this today|my heart|heart ?warming|i'?m obsessed|obsessed with this|core memory|hits different|living (his|her|their|its) best life|main character|nature is healing|10\/10)\b/i,
  /\b(game[- ]?changer|next level|mind[- ]?blow(n|ing)|revolutionary|legendary|iconic|unlock|the future is here)\b/i,
  /\b(so true|great point|well said|spot on|great question|absolutely|truly|a testament|wishing you|journey|resonates|dive into|so relatable|shines through|your dedication|can be so)\b/i,
  /^(facts|this|same|real|exactly|yes)\W*$/i,
  /\b(who else|let that sink in|read that again|most people won'?t|thoughts\?|agree\?)/i,
  /\b(here'?s the thing|unpopular opinion|let'?s dive in|in today'?s|pov:|me when)\b/i,
  /\bnot (just|only|merely) [^,.]{1,40}[,—–-]+\s*(it'?s|but|this is)\b/i,
  /\b(isn'?t|is not|aren'?t) just (a|an|about)\b/i,
  /\b(ngl|lowkey|fr fr|no cap)\b/i,
  /[—–;]|!!|#\w/,
];

function slopScore(reply) {
  return SLOP_PATTERNS.reduce((n, re) => n + (re.test(reply) ? 1 : 0), 0);
}

// Dashes, semicolons, "!!" and hashtags: sanitizeReply cleans these up, so a reply
// whose only problem is one of them can still be used.
const FIXABLE_SLOP = SLOP_PATTERNS[SLOP_PATTERNS.length - 1];

// Best `count` of a list: least sloppy first (stable, keeps model order on ties).
// Generic or AI-sounding wording is always dropped; better to show fewer replies.
function pickLeastSloppy(list, count) {
  return list
    .map((r, i) => ({ r, i, s: slopScore(r) }))
    .filter(x => x.s - (FIXABLE_SLOP.test(x.r) ? 1 : 0) === 0)
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, count)
    .map(x => x.r);
}

// Drop duplicates, sort by kind (whatever list the model put them in), and pick
// 2 questions + 4 non-questions. Questions go in slots 2 and 5 so they don't bunch up.
function pickReplyMix(replies) {
  const seen = new Set();
  const unique = replies.filter(r => {
    const key = r.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const questions = pickLeastSloppy(unique.filter(isQuestion), QUESTIONS_SHOWN);
  const statements = pickLeastSloppy(unique.filter(r => !isQuestion(r)), STATEMENTS_SHOWN);

  const out = [...statements];
  if (questions[0] !== undefined) out.splice(Math.min(1, out.length), 0, questions[0]);
  if (questions[1] !== undefined) out.splice(Math.min(4, out.length), 0, questions[1]);
  return out;
}

function buildImprovePrompt(tweetText, hasMedia, mediaKind, myReply, context, styleExamples) {
  return `You are helping someone polish their reply to an X (Twitter) post.

THE POST
${describePost(tweetText, context, hasMedia, mediaKind)}

Their draft reply: "${myReply}"
${describeStyle(styleExamples)}

Your job:
1. Check the draft for grammar, spelling, word choice, whether it makes sense as a reply to THIS post, and whether it sounds generic or AI-like (see the list below).
2. Write a corrected version that keeps their meaning, tone, voice, and level of certainty. Fix mistakes only; don't rewrite it into something else and don't add new claims. If it is already correct, return it unchanged.
3. Write 3 alternative ways to make the same point that sound like a native speaker casually replying. Keep their idea and stance; you may tie it more closely to what is in the post, but never add facts, stories, or experiences they didn't give. Each one distinct in wording and shape (e.g. shorter, more direct, drier).

${HUMAN_RULES}

RULES:
- Reply in the same language as the draft. Match their register; don't copy their typos and don't exaggerate slang.
- Max 25 words each.
- Don't add emojis unless the draft had them.
- "feedback" is ONE short sentence telling them what was wrong, including if the draft is generic (e.g. it would fit under any post) or uses one of the patterns above. If nothing was wrong, say "Looks good, no mistakes." Plain and friendly.
- Output ONLY valid JSON in exactly this shape, nothing else:
{"feedback": "...", "fixed": "...", "alternatives": ["...", "...", "..."]}`;
}

function parseImprove(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  let obj = null;
  try { obj = JSON.parse(cleaned); } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { obj = JSON.parse(match[0]); } catch (_) {}
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.fixed) {
    console.error('vibeReply: improve parse failed, raw text was:', text);
    throw new Error('Could not parse the improved reply. Raw response logged to console.');
  }

  const clean = s => String(s || '').replace(/^["'“‘]+|["'”’]+$/g, '').replace(/\s+/g, ' ').trim();
  const alternatives = (Array.isArray(obj.alternatives) ? obj.alternatives : [])
    .map(clean).filter(Boolean).slice(0, 3).map(fixDashes);
  return {
    feedback: String(obj.feedback || '').replace(/\s+/g, ' ').trim(),
    fixed: clean(obj.fixed),
    alternatives
  };
}

// Expects {"read": "...", "replies": [...]}, but also accepts a bare array
// or another wrapper key. Returns { read, replies }.
function parseReplyList(text) {
  let read = '';
  let replies = [];
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const obj = JSON.parse((cleaned.match(/\{[\s\S]*\}/) || [cleaned])[0]);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      read = String(obj.read || obj.understanding || '').replace(/\s+/g, ' ').trim();
      // Every list of strings in the answer ("replies", "questions", or another name);
      // each reply is sorted into question / not-question by its text afterwards
      replies = Object.values(obj)
        .filter(v => Array.isArray(v))
        .flat()
        .map(s => String(s).trim())
        .filter(Boolean);
    }
  } catch (_) {}
  if (replies.length < 2) replies = parseReplies(text);
  if (replies.length < 2) {
    console.error('vibeReply: parse failed, raw text was:', text);
    throw new Error('Could not parse the replies. Raw response logged to console.');
  }
  // Rank on the raw text (before dashes/hashtags are cleaned) so slop markers still count
  let picked = pickReplyMix(replies);
  // Model ignored the rules and everything was sloppy: show the raw list rather than nothing
  if (picked.length < 2) picked = replies.slice(0, REPLIES_SHOWN);
  return { read, replies: picked.map(r => sanitizeReply(r)) };
}

function parseReplies(text) {
  // Strip code fences if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // Try direct JSON parse
  try {
    const arr = JSON.parse(cleaned);
    if (Array.isArray(arr)) return arr.map(s => String(s).trim()).filter(Boolean);
  } catch (_) {}

  // Try to extract first [...] block
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr = JSON.parse(match[0]);
      if (Array.isArray(arr)) return arr.map(s => String(s).trim()).filter(Boolean);
    } catch (_) {}
  }

  // Fallback: split lines
  const lines = cleaned.split(/\n+/).map(l => l.replace(/^\s*[-*\d.\)\"]+\s*/, '').replace(/\"$/, '').trim()).filter(Boolean);
  return lines.slice(0, REPLY_CANDIDATES);
}

// ---- Multi-key rotation helpers ----

// Compute next reset timestamp = next 09:00 UTC (~midnight Pacific Time).
function nextDailyResetTs() {
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0, 0));
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }
  return reset.getTime();
}

async function getKeysAndState() {
  const r = await chrome.storage.local.get(['geminiApiKeys', 'geminiApiKey', 'keyState']);
  let keys = r.geminiApiKeys;
  if (!keys && r.geminiApiKey) {
    keys = [r.geminiApiKey];
    await chrome.storage.local.set({ geminiApiKeys: keys });
    await chrome.storage.local.remove('geminiApiKey');
  }
  return { keys: keys || [], state: r.keyState || {} };
}

async function updateKeyState(key, patch) {
  const { keyState = {} } = await chrome.storage.local.get(['keyState']);
  const prev = keyState[key] || {};
  keyState[key] = { ...prev, ...patch };
  await chrome.storage.local.set({ keyState });
}

function pickAvailableKeys(keys, state) {
  const now = Date.now();
  return keys.filter(k => {
    const s = state[k] || {};
    if (s.invalid) return false;
    if (s.exhaustedUntil && s.exhaustedUntil > now) return false;
    return true;
  });
}

// ---- Single-attempt API call with one key ----
async function callGeminiOnce(apiKey, model, mediaParts, prompt, parse, timeoutMs = TIMEOUT_GEMINI_MS) {
  const body = {
    contents: [
      { role: 'user', parts: [...mediaParts, { text: prompt }] }
    ],
    generationConfig: {
      // Gemini 3 models are tuned for the default temperature of 1.0
      temperature: 1.0,
      // Thinking tokens count toward this limit, so leave room beyond the short JSON answer
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      // Gemini 3 uses thinkingLevel (thinkingBudget is for 2.5 and errors here).
      // Lowest level per model keeps replies fast.
      thinkingConfig: { thinkingLevel: THINKING_LEVELS[model] || 'low' }
    }
  };

  const started = Date.now();
  const send = () => fetchWithTimeout(`${geminiEndpoint(model)}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, Math.max(1000, timeoutMs - (Date.now() - started)));

  const errorMessage = r => r.data?.error?.message || `HTTP ${r.status}`;

  let res = await send();
  let msg = res.ok ? '' : errorMessage(res);

  // If this model rejects the thinking setting, retry once with the model's default
  if (!res.ok && res.status === 400 && /thinking/i.test(msg)) {
    console.warn(`vibeReply: ${model} rejected thinkingConfig (${msg}); retrying without it`);
    delete body.generationConfig.thinkingConfig;
    res = await send();
    msg = res.ok ? '' : errorMessage(res);
  }

  if (!res.ok) {
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const data = res.data;
  console.log('vibeReply: raw Gemini response', data);
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') || '';
  const finishReason = candidate?.finishReason;

  if (!text) {
    if (finishReason === 'MAX_TOKENS') throw new Error('Gemini hit token limit before producing output.');
    if (finishReason === 'SAFETY') throw new Error('Gemini blocked the response for safety.');
    throw new Error(`Gemini returned no text (finishReason: ${finishReason || 'unknown'}).`);
  }

  return parse(text);
}

// ---- OpenRouter (fallback) ----
async function callOpenRouterOnce(apiKey, mediaParts, prompt, parse, timeoutMs = TIMEOUT_OPENROUTER_MS) {
  // Convert Gemini-style inline_data parts into OpenAI image_url data-URLs
  const userContent = [];
  for (const p of mediaParts) {
    const { mime_type, data } = p.inline_data;
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mime_type};base64,${data}` }
    });
  }
  userContent.push({ type: 'text', text: prompt });

  const body = {
    model: OPENROUTER_MODEL,
    messages: [{ role: 'user', content: userContent }],
    temperature: 1.0,
    max_tokens: 4096,
    reasoning: { effort: 'low' },
    response_format: { type: 'json_object' }
  };

  const res = await fetchWithTimeout(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/0x-normal/vibereply',
      'X-Title': 'vibeReply'
    },
    body: JSON.stringify(body)
  }, timeoutMs);

  if (!res.ok) {
    const msg = res.data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const data = res.data;
  console.log('vibeReply: raw OpenRouter response', data);
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('OpenRouter returned no text.');

  return parse(text);
}

// ---- Groq (fallback after Gemini, before OpenRouter) ----
// OpenAI-compatible API. Qwen 3.8 reads images (max 3); gpt-oss is text-only and
// is used if Qwen is unavailable, overloaded, or out of quota.
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS = [
  { id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8', vision: true, maxImages: 3, extra: { reasoning_effort: 'none' } },
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', vision: false, extra: { reasoning_effort: 'low' } }
];

async function callGroqOnce(apiKey, model, mediaParts, prompt, parse, timeoutMs) {
  const userContent = [];
  if (model.vision) {
    for (const p of mediaParts.slice(0, model.maxImages)) {
      const { mime_type, data } = p.inline_data;
      // Groq vision takes images only (no video)
      if (!mime_type.startsWith('image/')) continue;
      userContent.push({ type: 'image_url', image_url: { url: `data:${mime_type};base64,${data}` } });
    }
  }
  userContent.push({ type: 'text', text: prompt });

  const body = {
    model: model.id,
    // Text-only models take a plain string
    messages: [{ role: 'user', content: model.vision ? userContent : prompt }],
    temperature: 1.0,
    max_completion_tokens: 2048,
    ...model.extra
  };

  const res = await fetchWithTimeout(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  }, timeoutMs);

  if (!res.ok) {
    const msg = res.data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const data = res.data;
  console.log(`vibeReply: raw Groq (${model.id}) response`, data);
  // Drop any <think>...</think> block a reasoning model may include
  const text = String(data?.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!text) throw new Error('Groq returned no text.');
  return parse(text);
}

// Groq says how long to wait in its rate-limit message ("Please try again in 2h3m12.5s").
function groqRetryMs(msg) {
  const m = /try again in\s+((?:[\d.]+\s*(?:ms|h|m|s)\s*)+)/i.exec(msg || '');
  if (!m) return 60000;
  const unitMs = { h: 3600000, m: 60000, s: 1000, ms: 1 };
  let ms = 0;
  for (const [, n, unit] of m[1].matchAll(/([\d.]+)\s*(ms|h|m|s)/g)) {
    ms += (parseFloat(n) || 0) * unitMs[unit];
  }
  return Math.max(1000, Math.ceil(ms));
}

// Tries the image-reading model on every available Groq key first, then the
// text-only model on every key, so one rate-limited key doesn't cost us the images.
// Rate limits are per key and per model; they are remembered in keyState so later
// requests skip a limited pair, and a key counts as out of quota only when every
// model on it is limited. Returns the result, or throws the last error.
async function tryGroq(allKeys, available, state, mediaParts, buildPromptFn, parse, timeLeft, onProgress) {
  let lastErr = null;
  const pool = [...available];
  const limits = {}; // key -> { modelId: timestamp when it can be used again }
  for (const k of pool) limits[k] = { ...((state[k] || {}).modelLimits || {}) };
  const images = mediaParts.filter(p => p.inline_data.mime_type.startsWith('image/'));

  nextModel:
  for (const model of GROQ_MODELS) {
    // A text-only model gets a prompt that doesn't mention attached media
    const usableMedia = model.vision ? images : [];
    const prompt = buildPromptFn(usableMedia.length > 0);

    for (const key of [...pool]) {
      if ((limits[key][model.id] || 0) > Date.now()) continue;
      const budget = Math.min(TIMEOUT_GROQ_MS, timeLeft());
      if (budget < 3000) break nextModel;
      const keyNum = allKeys.indexOf(key) + 1;
      try {
        console.log(`vibeReply: trying Groq key #${keyNum} with ${model.id}`);
        onProgress(`Trying Groq ${model.label} (key ${keyNum})...`);
        const out = await callGroqOnce(key, model, usableMedia, prompt, parse, budget);
        return { ...out, model: `Groq ${model.label}` };
      } catch (err) {
        lastErr = err;
        const status = err.status;
        console.warn(`vibeReply: Groq key #${keyNum} / ${model.id} failed (${status || 'no-status'}): ${err.message}`);
        if (status === 429) {
          limits[key][model.id] = Date.now() + groqRetryMs(err.message);
          const patch = { modelLimits: limits[key], lastError: err.message };
          const untils = GROQ_MODELS.map(m => limits[key][m.id] || 0);
          if (untils.every(u => u > Date.now())) patch.exhaustedUntil = Math.min(...untils);
          await updateKeyState(key, patch);
          continue; // next key, same model
        }
        if (status === 401 || status === 403) {
          await updateKeyState(key, { invalid: true, lastError: err.message });
          pool.splice(pool.indexOf(key), 1);
          continue;
        }
        // Bad request, timeout, server error: another key won't fix it, try the next model
        continue nextModel;
      }
    }
  }
  throw lastErr || new Error('Groq: nothing left to try.');
}

async function getGroqKeys() {
  const r = await chrome.storage.local.get(['groqApiKeys', 'groqApiKey']);
  let keys = r.groqApiKeys;
  // Migrate old single-key storage
  if (!Array.isArray(keys) && r.groqApiKey) {
    keys = [r.groqApiKey];
    await chrome.storage.local.set({ groqApiKeys: keys });
    await chrome.storage.local.remove('groqApiKey');
  }
  return Array.isArray(keys) ? keys : [];
}

async function getOpenRouterKey() {
  const r = await chrome.storage.local.get(['openrouterApiKey']);
  return r.openrouterApiKey || '';
}

// ---- Main entries ----
async function getStyleExamples() {
  const r = await chrome.storage.local.get(['styleExamples']);
  return Array.isArray(r.styleExamples) ? r.styleExamples : [];
}

async function generateReplies({ tweetText, mediaUrls, mediaKind, context, onProgress }) {
  const style = await getStyleExamples();
  return runWithProviders({
    mediaUrls,
    onProgress,
    buildPromptFn: hasMedia => buildPrompt(tweetText, hasMedia, mediaKind || 'media', context, style),
    parse: parseReplyList
  });
}

async function improveReply({ tweetText, mediaUrls, mediaKind, context, myReply, onProgress }) {
  const draft = String(myReply || '').trim();
  if (!draft) throw new Error('Write your reply first.');
  const style = await getStyleExamples();
  return runWithProviders({
    mediaUrls,
    onProgress,
    buildPromptFn: hasMedia => buildImprovePrompt(tweetText, hasMedia, mediaKind || 'media', draft, context, style),
    parse: parseImprove
  });
}

// ---- Rotate through Gemini keys, then Groq, then OpenRouter ----
async function runWithProviders({ mediaUrls, buildPromptFn, parse, onProgress = () => {} }) {
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  const timeLeft = () => deadline - Date.now();
  // Adds which model answered and how long the whole request took
  const done = (out, model) => ({ ...out, meta: { model, ms: Date.now() - started } });
  const [{ keys, state }, groqKeys, openrouterKey, geminiModels] = await Promise.all([
    getKeysAndState(), getGroqKeys(), getOpenRouterKey(), getGeminiModels()
  ]);
  // Groq keys that aren't invalid or waiting out a rate limit (same state map as Gemini keys)
  const groqAvailable = pickAvailableKeys(groqKeys, state);
  const groqKey = groqAvailable.length > 0;

  if (!keys.length && !groqKeys.length && !openrouterKey) {
    throw new Error('No API keys configured. Open the side panel and add a Gemini, Groq, or OpenRouter key.');
  }

  // Fetch media once (shared across all attempts), all in parallel
  const limited = (mediaUrls || []).slice(0, 4);
  if (limited.length) onProgress('Loading media...');
  const fetched = await Promise.all(limited.map(url =>
    fetchAsBase64(url).catch(e => {
      console.warn('vibeReply: skipping media', url, e.message);
      return null;
    })
  ));
  const mediaParts = [];
  fetched.forEach((m, idx) => {
    if (!m) return;
    if (!isGeminiSupportedMime(m.mime)) {
      console.warn(`vibeReply: skipping media with unsupported MIME ${m.mime}: ${limited[idx]}`);
      return;
    }
    mediaParts.push({ inline_data: { mime_type: m.mime, data: m.base64 } });
  });
  const hasMedia = mediaParts.length > 0;
  const prompt = buildPromptFn(hasMedia);

  // 1) Try every available Gemini key in order, each with every model
  const available = pickAvailableKeys(keys, state);
  let lastErr = null;

  // Keep some time for Groq / OpenRouter if they're configured
  const reserved = (groqKey ? TIMEOUT_GROQ_MS : 0) + (openrouterKey ? TIMEOUT_OPENROUTER_MS : 0);
  const geminiBudgetLeft = () => timeLeft() - reserved;
  let stopGemini = false;
  let ranOutOfTime = false;
  for (let i = 0; i < available.length && !stopGemini; i++) {
    const key = available[i];
    const keyNum = keys.indexOf(key) + 1;
    let quotaHits = 0;    // models that hit their quota on this key
    let otherFail = false; // a model failed for another reason

    for (const model of geminiModels) {
      if (retiredModels.has(model)) continue;
      const budget = Math.min(MODEL_TIMEOUTS[model] || TIMEOUT_GEMINI_MS, geminiBudgetLeft());
      if (budget < 3000) { ranOutOfTime = true; stopGemini = true; break; }
      try {
        console.log(`vibeReply: trying Gemini key #${keyNum} (${i + 1}/${available.length}) with ${model}`);
        onProgress(`Asking Gemini ${MODEL_LABELS[model] || model} (key ${keyNum})...`);
        const out = await callGeminiOnce(key, model, mediaParts, prompt, parse, budget);
        return done(out, `Gemini ${MODEL_LABELS[model] || model}`);
      } catch (err) {
        lastErr = err;
        const status = err.status;
        const msg = err.message || '';
        console.warn(`vibeReply: Gemini key #${keyNum} / ${model} failed (${status || 'no-status'}): ${msg}`);

        // Model retired / not available to this account: skip it from now on
        if (status === 404 || /no longer available|not found|is not supported|deprecated/i.test(msg)) {
          retiredModels.add(model);
          continue;
        }
        // Quota is per model, so try the next model on the same key
        if (status === 429) { quotaHits++; continue; }
        otherFail = true;
        if (status === 401 || status === 403) {
          await updateKeyState(key, { invalid: true, lastError: msg });
          break; // bad key: go to the next key
        }
        // Timeouts and transient server-side errors (overloaded, gateway, etc.): try the next model/key.
        if (status === 'timeout' || status === 500 || status === 502 || status === 503 || status === 504 ||
            /overload|high demand|unavailable|temporar/i.test(msg)) {
          continue;
        }
        // Other unknown error (bad request, unparseable answer): try OpenRouter fallback
        stopGemini = true;
        break;
      }
    }

    if (quotaHits > 0 && !otherFail) {
      await updateKeyState(key, { exhaustedUntil: nextDailyResetTs(), lastError: lastErr.message });
    }
  }
  if (geminiModels.every(m => retiredModels.has(m))) {
    // Don't stay stuck for the whole worker lifetime if Google changes its mind
    retiredModels.clear();
  }

  // 2) Fall back to Groq if a key is usable (keep time for OpenRouter after it)
  if (groqKey) {
    const groqTimeLeft = () => timeLeft() - (openrouterKey ? TIMEOUT_OPENROUTER_MS : 0);
    try {
      console.log('vibeReply: falling back to Groq');
      const { model, ...out } = await tryGroq(groqKeys, groqAvailable, state, mediaParts, buildPromptFn, parse, groqTimeLeft, onProgress);
      return done(out, model);
    } catch (err) {
      lastErr = err;
      console.error('vibeReply: Groq fallback failed:', err.message);
    }
  }

  // 3) Fall back to OpenRouter if a key is configured
  if (openrouterKey && timeLeft() > 3000) {
    try {
      console.log('vibeReply: falling back to OpenRouter');
      onProgress('Trying OpenRouter...');
      const out = await callOpenRouterOnce(openrouterKey, mediaParts, prompt, parse,
        Math.min(TIMEOUT_OPENROUTER_MS, timeLeft()));
      return done(out, 'OpenRouter');
    } catch (err) {
      lastErr = err;
      console.error('vibeReply: OpenRouter fallback failed:', err.message);
    }
  }

  // 4) Nothing worked
  if (!available.length && !groqKey && !openrouterKey) {
    throw new Error(groqKeys.length
      ? 'All Gemini and Groq keys are out of quota or invalid. Check Key Status in the side panel, or add another key.'
      : 'All Gemini keys are exhausted or invalid, and no Groq or OpenRouter key is configured.');
  }
  if (ranOutOfTime && !groqKey && !openrouterKey) {
    throw new Error(`Gemini is too slow right now (gave up after ${Math.round(TOTAL_BUDGET_MS / 1000)}s). Last error: ${lastErr?.message || 'none'}. Try again in a minute.`);
  }
  throw new Error(`All providers failed. Last error: ${lastErr?.message || 'unknown'}`);
}

function sanitizeReply(s) {
  // Remove emoji ranges
  let out = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F600}-\u{1F64F}]/gu, '');
  // Strip surrounding quotes
  out = out.replace(/^["'\u201C\u2018]+|["'\u201D\u2019]+$/g, '');
  // Drop hashtags and @mentions the model slipped in
  out = out.replace(/(^|\s)[#@][\w]+/g, '$1');
  out = fixDashes(out);
  // Collapse spaces
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

// Em/en dashes are a strong AI tell in casual replies; turn them into commas.
function fixDashes(s) {
  return s
    .replace(/\s*[\u2014\u2013]\s*$/g, '')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim();
}
