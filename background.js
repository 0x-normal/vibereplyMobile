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
const TIMEOUT_GROQ_MS = 20000; // Groq is fast, but its models now think briefly before answering
const TIMEOUT_DEEPSEEK_MS = 25000; // DeepSeek Flash thinks briefly first; usually answers in a few seconds
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
// mediaHidden: the post has media but this model can't see it (text-only fallback model).
function describePost(tweetText, context = {}, hasMedia, mediaKind, mediaHidden = false) {
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
  } else if (mediaHidden && mediaKind && mediaKind !== 'none') {
    lines.push(`It has ${mediaKind}, but you can't see it. Don't guess or describe what it shows; react to the text${context.altTexts?.length ? ' and the image descriptions' : ''}.`);
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

// opts.mediaHidden: see describePost.
// opts.keyPoints: also ask for "key_points" (the concrete things in the post) before the
// replies. Smaller models (Groq) write much more on-topic replies when they list these first.
function buildPrompt(tweetText, hasMedia, mediaKind, context, styleExamples, opts = {}) {
  const keyPointsStep = opts.keyPoints ? `
STEP 1b. In "key_points", list 2 to 4 concrete things from the post that a reply can react to: the main claim, names, numbers, what is in the image. Copy them from the post; don't invent any. Every reply below must be clearly about one of these, so that someone reading only the reply can tell which post it is under.
` : '';
  const shape = opts.keyPoints
    ? '{"read": "...", "key_points": ["...", "..."], "replies": ["...", "..."], "questions": ["...", "..."]}'
    : '{"read": "...", "replies": ["...", "..."], "questions": ["...", "..."]}';
  return `You suggest replies for someone scrolling X. Write like a regular person who actually read this post, not like an assistant.

THE POST
${describePost(tweetText, context, hasMedia, mediaKind, opts.mediaHidden)}

STEP 1. In "read", write one plain sentence: what the post is saying or showing, and what the poster is going for (a laugh, agreement, debate, news, an opinion, asking for help...). If something is unclear, say so instead of guessing.
${keyPointsStep}
STEP 2. Write replies a real person might post under it, based on your "read", in two lists:
- "replies": exactly ${STATEMENT_CANDIDATES} replies that are NOT questions. Mix them: a quick reaction, agreeing or disagreeing with a reason, a take, a small observation, adding something useful. None of them may be a question, a rhetorical question, or end with "?".
- "questions": exactly ${QUESTION_CANDIDATES} real questions you'd actually want the poster to answer, each about something specific in the post.
At most 2 of all the replies may be jokes, and only if the post is light.

${HUMAN_RULES}
${describeStyle(styleExamples)}
${REPLY_EXAMPLES}

Output ONLY valid JSON, nothing else:
${shape}`;
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

function buildImprovePrompt(tweetText, hasMedia, mediaKind, myReply, context, styleExamples, opts = {}) {
  return `You are helping someone polish their reply to an X (Twitter) post.

THE POST
${describePost(tweetText, context, hasMedia, mediaKind, opts.mediaHidden)}

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
      // ("key_points" is the model's notes about the post, not replies)
      replies = Object.entries(obj)
        .filter(([k, v]) => Array.isArray(v) && !/^(key_?points|details|facts|notes)$/i.test(k))
        .flatMap(([, v]) => v)
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

// ---- DeepSeek's own reply prompt (written by the user, kept word for word) ----
// 7 replies in a crypto-Twitter voice, one per reply type, in the type order.
// Tuned to be supportive: takes the post at face value instead of doubting it.
const DEEPSEEK_REPLY_COUNT = 7;

function buildDeepSeekPrompt(tweetText, hasMedia, mediaKind, context = {}) {
  const mediaLine = hasMedia
    ? `The post also contains ${mediaKind} (attached). Look at the visual content carefully.`
    : `The post has no media; rely on the caption.`;
  // Who posted it and the post it quotes, when there is one (only these two lines are added)
  const authorLine = context.author ? `Author: ${context.author}\n` : '';
  const quotedLine = context.quoted
    ? `\nQuoted post by ${context.quoted.author || 'someone'}: "${context.quoted.text || '(no text)'}"`
    : '';

  return `You are @0xnormal_, a crypto-native builder replying on X. Your niche: crypto Twitter, crypto markets, AI, global politics, self-development, and building SaaS solo.

POST
${authorLine}Text: "${tweetText || '(no text)'}"${quotedLine}
Media: ${mediaLine || '(no media description)'}

TASK
Write 7 reply options to THIS exact post. The goal is a reply that gets likes and profile clicks from the post's audience because it adds something: a useful angle, a real question, or genuine hype with a reason. Agreeing is fine when you add something.

THE ONE RULE THAT MATTERS MOST
Each reply must react to one specific claim, number, or detail in the post. If a reply could sit under 100 other posts, rewrite it.
If the post has no text, react only to the media.
Take the post at face value. Don't doubt the author's numbers, results, or story. Build on it, don't fact-check it.

REPLY TYPES (use each one exactly once)
1. add value: a missing fact, a second-order effect, or "what this actually means"
2. different angle: a "yes, and", something the author didn't mention that makes the point stronger. Only name a risk when the post is about money, hacks, or losses
3. builder angle: how a founder, trader, or builder should act on this
4. sharp question: one short question that makes the author want to reply
5. one-liner: a punchy, witty CT-style line, under 8 words
6. personal take: a short first-person reaction or experience ("been there", "i'd do X")
7. simple breakdown: explain the post's point in plain words for someone new

STYLE
- Max 25 words each. At least 3 replies under 10 words.
- CT voice: lowercase, short lines, confident, no corporate tone.
- Never end a reply with a period. Question marks are fine for questions.
- Sound like a peer who's in the market or building: supportive, not a cheerleader and not a critic.
- Only use numbers that appear in the post. Never invent stats, prices, or dates.
- Match the post's mood: serious on hacks, losses, and politics; playful on memes; on wins and milestones, be genuinely happy for them and build on it.

DO NOT
- Use hashtags, links, or @mentions (except the author when needed).
- Use more than 1 emoji in the whole set.
- Shill coins, give price targets, or say "not financial advice".
- Take a hard partisan side on politics. Explain the impact instead.
- Repeat or paraphrase the post.
- Use filler: "great post", "this 👆", "so true", "facts", "huge if true", "bullish" alone, "wagmi", "lfg", "this is the way", "who else", "can't stress this enough", "game changer".
- Start two replies with the same word.

EXAMPLES
Post: "BTC ETFs saw $1.5B in outflows this week"
Bad: "wow bearish times ahead."
Good: "outflows matter less than who's selling. basis trade unwinds look the same on the chart"
Good: "who's buying what they sell?"

Post: "I quit my job to build a SaaS"
Bad: "most solo saas die in year one, hope you saved up"
Good: "build the distribution before the product runs out your savings"

OUTPUT
Return ONLY a valid JSON array of 7 strings, in the type order above. No extra text, no markdown, no code fences. No string may end with "."
["reply one", "reply two", "reply three", "reply four", "reply five", "reply six", "reply seven"]`;
}

// Light cleanup that respects this prompt's rules: the author's @mention and one emoji
// are allowed, so only quotes, hashtags, dashes and a final period are fixed.
function cleanDeepSeekReply(s) {
  return fixDashes(String(s)
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/(^|\s)#\w+/g, '$1'))
    .replace(/(?<!\.)\.\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A JSON array of 7 replies, shown in the prompt's type order
function parseDeepSeekReplies(text) {
  const replies = parseReplies(text);
  if (replies.length < 2) {
    console.error('vibeReply: parse failed, raw text was:', text);
    throw new Error('Could not parse the replies.');
  }
  return { read: '', replies: replies.slice(0, DEEPSEEK_REPLY_COUNT).map(cleanDeepSeekReply).filter(Boolean) };
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
// These smaller models write nonsense replies when they answer without thinking or run
// at temperature 1.0, so both think briefly first (hidden from the answer) and run cooler
// (Groq recommends 0.5 to 0.7 for Qwen).
const GROQ_MODELS = [
  {
    id: 'qwen/qwen3.8-27b', label: 'Qwen 3.8', vision: true, maxImages: 3,
    sampling: { temperature: 0.7, top_p: 0.9 },
    reasoning: { reasoning_effort: 'low', reasoning_format: 'hidden' }
  },
  {
    id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', vision: false,
    sampling: { temperature: 0.8 },
    reasoning: { reasoning_effort: 'medium', include_reasoning: false }
  }
];

const REPLY_SYSTEM = `You write short replies to X (Twitter) posts the way a normal, sharp person would. First work out what the post actually says or shows and what the poster wants, then reply to exactly that. Every reply must make sense under this post and nowhere else: no generic lines, no random jokes, nothing that ignores what the post is about. Never reuse the content of the examples. Answer with JSON only.`;

// Groq can force the answer into an exact JSON shape (Structured Outputs), so a reply list
// never comes back broken or with extra fields.
const stringList = { type: 'array', items: { type: 'string' } };
const GROQ_SCHEMAS = new Map([
  [parseReplyList, {
    name: 'replies',
    schema: {
      type: 'object',
      properties: { read: { type: 'string' }, key_points: stringList, replies: stringList, questions: stringList },
      required: ['read', 'key_points', 'replies', 'questions'],
      additionalProperties: false
    }
  }],
  [parseImprove, {
    name: 'improved_reply',
    schema: {
      type: 'object',
      properties: { feedback: { type: 'string' }, fixed: { type: 'string' }, alternatives: stringList },
      required: ['feedback', 'fixed', 'alternatives'],
      additionalProperties: false
    }
  }]
]);

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

  const schema = GROQ_SCHEMAS.get(parse);
  const body = {
    model: model.id,
    messages: [
      { role: 'system', content: REPLY_SYSTEM },
      // Text-only models take a plain string
      { role: 'user', content: model.vision ? userContent : prompt }
    ],
    ...model.sampling,
    // Room for the hidden thinking plus the short JSON answer
    max_completion_tokens: 4096,
    ...model.reasoning,
    response_format: schema
      ? { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } }
      : { type: 'json_object' }
  };

  const started = Date.now();
  const send = () => fetchWithTimeout(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  }, Math.max(1000, timeoutMs - (Date.now() - started)));
  const errorMessage = r => r.data?.error?.message || `HTTP ${r.status}`;

  let res = await send();
  // If Groq rejects the JSON format or thinking settings for this model, retry once
  // without them rather than skipping a working model
  if (!res.ok && res.status === 400 && /json|schema|response_format|reasoning/i.test(errorMessage(res))) {
    console.warn(`vibeReply: Groq ${model.id} rejected a setting (${errorMessage(res)}); retrying without it`);
    if (/reasoning/i.test(errorMessage(res))) {
      Object.keys(model.reasoning || {}).forEach(k => { delete body[k]; });
    }
    delete body.response_format;
    res = await send();
  }

  if (!res.ok) {
    const err = new Error(errorMessage(res));
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
    // A text-only model is told the post has media it can't see, so it doesn't guess
    const usableMedia = model.vision ? images : [];
    const prompt = buildPromptFn(usableMedia.length > 0, {
      keyPoints: true,
      mediaHidden: mediaParts.length > 0 && usableMedia.length === 0
    });

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

// ---- DeepSeek (paid, cheap; reads images) ----
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-flash';
const DEEPSEEK_MAX_IMAGES = 4;

async function getDeepSeekSettings() {
  const r = await chrome.storage.local.get(['deepseekApiKeys', 'deepseekFirst']);
  return {
    keys: Array.isArray(r.deepseekApiKeys) ? r.deepseekApiKeys : [],
    // On by default: when you've added a paid DeepSeek key, it's what you want answering
    first: r.deepseekFirst !== false
  };
}

// original: send DeepSeek's own reply prompt as is (no system message, plain answer).
// It thinks briefly first, which makes it follow the rules (no made-up numbers, length)
// much better. DeepSeek ignores temperature while thinking; 0.7 applies only if thinking
// is ever rejected and the request is retried without it.
async function callDeepSeekOnce(apiKey, images, prompt, parse, timeoutMs, original = false) {
  const content = images.slice(0, DEEPSEEK_MAX_IMAGES).map(p => ({
    type: 'image_url',
    image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` }
  }));
  content.push({ type: 'text', text: prompt });
  const user = { role: 'user', content: images.length ? content : prompt };

  const body = original
    ? {
      model: DEEPSEEK_MODEL,
      messages: [user],
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
      temperature: 0.7,
      // Room for the short thinking plus 7 replies
      max_tokens: 4096,
      stream: false
    }
    : {
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'system', content: REPLY_SYSTEM }, user],
      // A short think first gives much more sensible replies; "low" keeps it quick
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
      // JSON mode (the prompt includes the word JSON and an example, as DeepSeek requires)
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      stream: false
    };

  const started = Date.now();
  const send = () => fetchWithTimeout(DEEPSEEK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  }, Math.max(1000, timeoutMs - (Date.now() - started)));
  const errorMessage = r => r.data?.error?.message || `HTTP ${r.status}`;

  let res = await send();
  // If a setting is rejected, retry once without it rather than giving up on DeepSeek
  if (!res.ok && (res.status === 400 || res.status === 422)) {
    const msg = errorMessage(res);
    let changed = false;
    if (/thinking|reasoning/i.test(msg)) { delete body.thinking; delete body.reasoning_effort; changed = true; }
    if (/json|response_format/i.test(msg)) { delete body.response_format; changed = true; }
    if (changed) {
      console.warn(`vibeReply: DeepSeek rejected a setting (${msg}); retrying without it`);
      res = await send();
    }
  }
  if (!res.ok) {
    const err = new Error(errorMessage(res));
    err.status = res.status;
    throw err;
  }

  const data = res.data;
  console.log('vibeReply: raw DeepSeek response', data);
  const text = String(data?.choices?.[0]?.message?.content || '').trim();
  if (!text) {
    // DeepSeek's JSON mode sends blank content when the model's JSON was invalid
    const err = new Error('DeepSeek returned an empty answer.');
    err.status = 'empty';
    throw err;
  }
  return parse(text);
}

// Tries each usable DeepSeek key. Out of balance (402) and rate limits (429) are
// remembered in keyState so the next request skips that key for a while.
// original: { buildPromptFn, parse } to use DeepSeek's own reply prompt instead
async function tryDeepSeek(allKeys, available, mediaParts, buildPromptFn, parse, timeLeft, onProgress, original = null) {
  const images = mediaParts.filter(p => p.inline_data.mime_type.startsWith('image/'));
  const prompt = original
    ? original.buildPromptFn(images.length > 0)
    : buildPromptFn(images.length > 0, {
      keyPoints: true,
      mediaHidden: mediaParts.length > 0 && images.length === 0
    });
  if (original) parse = original.parse;
  let lastErr = null;
  for (const key of available) {
    const keyNum = allKeys.indexOf(key) + 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      const budget = Math.min(TIMEOUT_DEEPSEEK_MS, timeLeft());
      if (budget < 3000) throw lastErr || new Error('DeepSeek: out of time.');
      try {
        console.log(`vibeReply: trying DeepSeek key #${keyNum}`);
        onProgress(`Asking DeepSeek Flash (key ${keyNum})...`);
        const out = await callDeepSeekOnce(key, images, prompt, parse, budget, !!original);
        return { ...out, model: 'DeepSeek Flash' };
      } catch (err) {
        lastErr = err;
        const status = err.status;
        console.warn(`vibeReply: DeepSeek key #${keyNum} failed (${status || 'no-status'}): ${err.message}`);
        // Blank JSON answer: one more try on the same key usually works
        if (status === 'empty' && attempt === 0) continue;
        if (status === 401 || status === 403) {
          await updateKeyState(key, { invalid: true, lastError: err.message });
        } else if (status === 402) {
          lastErr = new Error('DeepSeek account is out of balance. Top up at platform.deepseek.com.');
          await updateKeyState(key, { exhaustedUntil: Date.now() + 30 * 60000, lastError: lastErr.message });
        } else if (status === 429) {
          await updateKeyState(key, { exhaustedUntil: Date.now() + 60000, lastError: err.message });
        } else if (status === 400 || status === 422) {
          throw err; // the request itself is wrong; another key won't help
        }
        break; // next key
      }
    }
  }
  throw lastErr || new Error('DeepSeek: nothing left to try.');
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
    buildPromptFn: (hasMedia, opts) => buildPrompt(tweetText, hasMedia, mediaKind || 'media', context, style, opts),
    parse: parseReplyList,
    // DeepSeek writes replies with its own prompt (7 replies, crypto-Twitter voice)
    deepseekOriginal: {
      buildPromptFn: hasMedia => buildDeepSeekPrompt(tweetText, hasMedia, mediaKind || 'media', context),
      parse: parseDeepSeekReplies
    }
  });
}

async function improveReply({ tweetText, mediaUrls, mediaKind, context, myReply, onProgress }) {
  const draft = String(myReply || '').trim();
  if (!draft) throw new Error('Write your reply first.');
  const style = await getStyleExamples();
  return runWithProviders({
    mediaUrls,
    onProgress,
    buildPromptFn: (hasMedia, opts) => buildImprovePrompt(tweetText, hasMedia, mediaKind || 'media', draft, context, style, opts),
    parse: parseImprove
  });
}

// ---- Rotate through DeepSeek (when first), Gemini keys, DeepSeek (when not first), Groq, then OpenRouter ----
// deepseekOriginal: optional { buildPromptFn, parse } that DeepSeek uses instead of the shared prompt
async function runWithProviders({ mediaUrls, buildPromptFn, parse, deepseekOriginal = null, onProgress = () => {} }) {
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  const timeLeft = () => deadline - Date.now();
  // Adds which model answered and how long the whole request took
  const done = (out, model) => ({ ...out, meta: { model, ms: Date.now() - started } });
  const [{ keys, state }, groqKeys, openrouterKey, geminiModels, deepseek] = await Promise.all([
    getKeysAndState(), getGroqKeys(), getOpenRouterKey(), getGeminiModels(), getDeepSeekSettings()
  ]);
  // Groq / DeepSeek keys that aren't invalid or waiting out a limit (same state map as Gemini keys)
  const groqAvailable = pickAvailableKeys(groqKeys, state);
  const groqKey = groqAvailable.length > 0;
  const deepseekAvailable = pickAvailableKeys(deepseek.keys, state);
  const deepseekKey = deepseekAvailable.length > 0;

  if (!keys.length && !groqKeys.length && !openrouterKey && !deepseek.keys.length) {
    throw new Error('No API keys configured. Open the side panel and add a Gemini, DeepSeek, Groq, or OpenRouter key.');
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
  const available = pickAvailableKeys(keys, state);
  let lastErr = null;

  // 0) DeepSeek first, when it's set to go first (the default once a key is added)
  if (deepseek.first && deepseekKey) {
    const othersLeft = available.length > 0 || groqKey || !!openrouterKey;
    // Leave time for the other providers in case DeepSeek fails
    const dsTimeLeft = () => timeLeft() - (othersLeft ? 15000 : 0);
    try {
      const { model, ...out } = await tryDeepSeek(deepseek.keys, deepseekAvailable, mediaParts, buildPromptFn, parse, dsTimeLeft, onProgress, deepseekOriginal);
      return done(out, model);
    } catch (err) {
      lastErr = err;
      console.error('vibeReply: DeepSeek failed:', err.message);
    }
  }

  // 1) Try every available Gemini key in order, each with every model

  // Keep some time for DeepSeek (when it comes after Gemini) / Groq / OpenRouter if they're configured
  const reserved = (deepseekKey && !deepseek.first ? TIMEOUT_DEEPSEEK_MS : 0) +
    (groqKey ? TIMEOUT_GROQ_MS : 0) + (openrouterKey ? TIMEOUT_OPENROUTER_MS : 0);
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

  // 2) DeepSeek after Gemini, when it isn't set to go first
  if (!deepseek.first && deepseekKey) {
    const dsTimeLeft = () => timeLeft() - (groqKey ? 8000 : 0) - (openrouterKey ? 8000 : 0);
    try {
      const { model, ...out } = await tryDeepSeek(deepseek.keys, deepseekAvailable, mediaParts, buildPromptFn, parse, dsTimeLeft, onProgress, deepseekOriginal);
      return done(out, model);
    } catch (err) {
      lastErr = err;
      console.error('vibeReply: DeepSeek fallback failed:', err.message);
    }
  }

  // 3) Fall back to Groq if a key is usable (keep time for OpenRouter after it)
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

  // 5) Nothing worked
  if (!available.length && !groqKey && !openrouterKey) {
    // DeepSeek was the only one left to try: show its own reason (e.g. out of balance)
    if (deepseekKey && lastErr) throw new Error(`DeepSeek failed: ${lastErr.message}`);
    throw new Error(groqKeys.length || deepseek.keys.length
      ? 'All your keys are out of quota, out of balance, or invalid. Check Key Status in the side panel, or add another key.'
      : 'All Gemini keys are exhausted or invalid, and no DeepSeek, Groq, or OpenRouter key is configured.');
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
