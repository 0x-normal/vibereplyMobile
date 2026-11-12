// vibeReply phone app.
// Share a post from the X app (or paste its link). The post is read through FxTwitter's
// public API, then the extension's own background.js (loaded on this page) writes the
// replies with the same prompt, rules and Gemini -> Groq -> OpenRouter rotation.
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const FXTWITTER = id => `https://api.fxtwitter.com/i/status/${id}`;
  const POST_TIMEOUT_MS = 12000;

  let current = null; // { id, url, data: { tweetText, mediaUrls, mediaKind, context } }
  let activeRequest = null;
  let activeImprove = null;
  let seq = 0;
  let generating = false;

  // ---------- Small helpers ----------
  function showStatus(el, text, kind = 'info') {
    el.hidden = !text;
    el.textContent = text || '';
    el.className = `status status-${kind}`;
  }
  const status = (text, kind) => showStatus($('status'), text, kind);

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // Post id from any X / Twitter / FxTwitter link, or a bare id
  function findStatusId(str) {
    const s = String(str || '');
    const m = s.match(/\/status(?:es)?\/(\d{1,25})/) || s.trim().match(/^(\d{5,25})$/);
    return m ? m[1] : null;
  }

  async function hasAnyKey() {
    const r = await chrome.storage.local.get(['geminiApiKeys', 'geminiApiKey', 'groqApiKeys', 'groqApiKey', 'openrouterApiKey']);
    return (Array.isArray(r.geminiApiKeys) && r.geminiApiKeys.length > 0) ||
      (Array.isArray(r.groqApiKeys) && r.groqApiKeys.length > 0) ||
      !!r.geminiApiKey || !!r.groqApiKey || !!r.openrouterApiKey;
  }

  // ---------- Reading the post ----------
  async function fetchPost(id) {
    let res;
    try {
      res = await fetchWithTimeout(FXTWITTER(id), {}, POST_TIMEOUT_MS); // from background.js
    } catch (e) {
      throw new Error(e.status === 'timeout'
        ? 'Loading the post took too long. Check your connection and try again.'
        : 'Could not load the post. Check your connection and try again.');
    }
    const t = res.data && res.data.tweet;
    if (!res.ok || !t) {
      if (res.status === 404) throw new Error('Could not find that post. It may be deleted.');
      if (res.status === 401 || res.status === 403) throw new Error('That post is from a private account, so it can\'t be read.');
      throw new Error(`Could not load the post (error ${res.status}). Try again in a moment.`);
    }
    return t;
  }

  const who = a => (a ? [a.name, a.screen_name && `(@${a.screen_name})`].filter(Boolean).join(' ') : '');

  // Photos at medium size (enough for the AI, quick to download)
  function photoUrl(url) {
    try {
      const u = new URL(url);
      u.searchParams.set('name', 'medium');
      if (u.searchParams.get('format') === 'webp') u.searchParams.set('format', 'jpg');
      return u.toString();
    } catch (_) { return url; }
  }

  // Same shape the extension's content script sends to background.js
  function toPayload(t) {
    const all = (t.media && t.media.all) || [];
    const urls = [];
    const altTexts = [];
    let photos = 0;
    let videos = 0;
    all.forEach(m => {
      if (m.type === 'photo') {
        photos++;
        urls.push(photoUrl(m.url));
        if (m.altText) altTexts.push(m.altText);
      } else if (m.type === 'video' || m.type === 'gif') {
        videos++;
        if (m.thumbnail_url) urls.push(m.thumbnail_url);
      }
    });
    let kind = 'none';
    if (photos && videos) kind = 'image(s) + video';
    else if (photos) kind = 'image(s)';
    else if (videos) kind = 'video';

    let tweetText = String(t.text || '').trim();
    if (t.poll && Array.isArray(t.poll.choices) && t.poll.choices.length) {
      tweetText += `\n\nPoll: ${t.poll.choices.map(c => c.label).filter(Boolean).join(' / ')}`;
    }

    const context = {};
    const author = who(t.author);
    if (author) context.author = author;
    if (t.replying_to) context.replyingTo = `@${t.replying_to}`;
    if (t.quote && (t.quote.text || t.quote.author)) {
      context.quoted = { author: who(t.quote.author), text: String(t.quote.text || '(no text)').slice(0, 600) };
    }
    if (t.article && (t.article.title || t.article.preview_text)) {
      context.card = [t.article.title, t.article.preview_text].filter(Boolean).join(': ').slice(0, 300);
    }
    if (altTexts.length) context.altTexts = altTexts.slice(0, 4);

    return { tweetText, mediaUrls: [...new Set(urls)].slice(0, 4), mediaKind: kind, context };
  }

  function renderPost(t, data) {
    $('intro').hidden = true;
    $('postCard').hidden = false;
    $('postAuthor').textContent = data.context.author || '';
    $('postText').textContent = t.text || '(no text)';
    $('postText').classList.remove('expanded');
    $('openInX').href = t.url || `https://x.com/i/status/${t.id}`;

    const media = $('postMedia');
    media.innerHTML = '';
    data.mediaUrls.forEach(u => {
      const img = document.createElement('img');
      img.src = u;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      media.appendChild(img);
    });
    media.hidden = !data.mediaUrls.length;

    const info = [data.mediaUrls.length ? `Media: ${data.mediaKind} (${data.mediaUrls.length})` : 'Media: none'];
    if (data.context.replyingTo) info.push(`reply to ${data.context.replyingTo}`);
    if (data.context.quoted) info.push(`quotes ${data.context.quoted.author || 'a post'}`);
    $('postInfo').textContent = info.join(' · ');
    $('postRead').hidden = true;
  }

  async function loadPost(id) {
    if (!(await hasAnyKey())) {
      openSettings();
      toast('Add a Gemini key first, then tap Done');
      $('linkInput').value = `https://x.com/i/status/${id}`;
      return;
    }
    activeRequest = null;
    activeImprove = null;
    generating = false;
    $('repliesSection').hidden = true;
    $('postCard').hidden = true;
    status('Loading the post...');
    try {
      const t = await fetchPost(id);
      const data = toPayload(t);
      current = { id, url: t.url, data };
      renderPost(t, data);
      $('myReply').value = '';
      $('improveResult').hidden = true;
      showStatus($('improveStatus'), '');
      await generate();
    } catch (e) {
      status(e.message, 'error');
    }
  }

  // ---------- Replies ----------
  vibeShim.onTabMessage(msg => {
    if (!msg || msg.action !== 'vibeProgress') return;
    if (msg.requestId === activeRequest) status(msg.text);
    else if (msg.requestId === activeImprove) showStatus($('improveStatus'), msg.text);
  });

  async function generate() {
    if (!current || generating) return;
    generating = true;
    const requestId = `r${++seq}`;
    activeRequest = requestId;
    $('regenBtn').disabled = true;
    $('repliesSection').hidden = true;
    status('Writing replies...');
    try {
      const res = await chrome.runtime.sendMessage({ action: 'generateReplies', data: { ...current.data, requestId } });
      if (activeRequest !== requestId) return; // a newer post was opened meanwhile
      if (!res || !res.success) {
        status(`Error: ${(res && res.error) || 'unknown error'}`, 'error');
        return;
      }
      status('');
      if (res.read) {
        $('postRead').textContent = `AI read it as: ${res.read}`;
        $('postRead').hidden = false;
      }
      renderReplies($('replies'), res.replies);
      $('meta').textContent = res.meta ? `${res.meta.model} · ${(res.meta.ms / 1000).toFixed(1)}s` : '';
      $('repliesSection').hidden = false;
    } finally {
      if (activeRequest === requestId) {
        generating = false;
        $('regenBtn').disabled = false;
      }
    }
  }

  function renderReplies(container, list, firstFixed = false) {
    container.innerHTML = '';
    list.forEach((text, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'reply' + (firstFixed && i === 0 ? ' fixed' : '');
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = firstFixed ? (i === 0 ? '✓' : String(i)) : String(i + 1);
      const body = document.createElement('span');
      body.className = 'text';
      body.textContent = text;
      card.append(num, body);
      card.addEventListener('click', () => copyReply(text, card));
      container.appendChild(card);
    });
  }

  // Copies the reply plus the next suffix from Settings (same rotation as the extension)
  async function copyReply(text, card) {
    let finalText = text;
    try {
      const r = await chrome.storage.local.get(['replySuffixes', 'replySuffix', 'suffixRotationIdx']);
      let list = Array.isArray(r.replySuffixes) ? r.replySuffixes : null;
      if (!list && typeof r.replySuffix === 'string' && r.replySuffix.length) list = [r.replySuffix];
      if (list && list.length) {
        const idx = Number.isInteger(r.suffixRotationIdx) ? r.suffixRotationIdx : 0;
        const chosen = list[idx % list.length];
        finalText = text + (/^\s/.test(chosen) ? '' : ' ') + chosen;
        await chrome.storage.local.set({ suffixRotationIdx: (idx + 1) % list.length });
      }
    } catch (_) { /* copy without suffix */ }

    const ok = await writeClipboard(finalText);
    if (!ok) { toast('Could not copy. Long-press the reply to select it.'); return; }
    document.querySelectorAll('.reply.copied').forEach(el => el.classList.remove('copied'));
    card.classList.add('copied');
    if (navigator.vibrate) navigator.vibrate(15);
    toast('Copied. Go back to X and paste it.');
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  // ---------- Fix & improve ----------
  async function improve() {
    if (!current || activeImprove) return;
    const myReply = $('myReply').value.trim();
    if (!myReply) { toast('Write your reply first'); $('myReply').focus(); return; }
    const requestId = `i${++seq}`;
    activeImprove = requestId;
    const btn = $('improveBtn');
    btn.disabled = true;
    btn.textContent = 'Working...';
    $('improveResult').hidden = true;
    showStatus($('improveStatus'), 'Checking your reply...');
    try {
      const res = await chrome.runtime.sendMessage({ action: 'improveReply', data: { ...current.data, myReply, requestId } });
      if (activeImprove !== requestId) return;
      if (!res || !res.success) {
        showStatus($('improveStatus'), `Error: ${(res && res.error) || 'unknown error'}`, 'error');
        return;
      }
      showStatus($('improveStatus'), '');
      const { feedback, fixed, alternatives } = res.result;
      $('improveFeedback').textContent = feedback || 'Looks good.';
      renderReplies($('improveReplies'), [fixed, ...(alternatives || [])].filter(Boolean), true);
      $('improveResult').hidden = false;
    } finally {
      if (activeImprove === requestId) activeImprove = null;
      btn.disabled = false;
      btn.textContent = 'Fix & improve';
    }
  }

  // ---------- Settings (the extension's own settings page) ----------
  function openSettings() {
    const frame = $('settingsFrame');
    if (!frame.src) frame.src = '../popup.html';
    $('settingsView').hidden = false;
    document.body.classList.add('no-scroll');
  }
  async function closeSettings() {
    $('settingsView').hidden = true;
    document.body.classList.remove('no-scroll');
    await refreshIntro();
    // A link was waiting for keys to be added
    const id = findStatusId($('linkInput').value);
    if (!current && id && (await hasAnyKey())) loadPost(id);
  }

  async function refreshIntro() {
    $('noKeysNote').hidden = await hasAnyKey();
  }

  // ---------- Install prompt ----------
  let installEvent = null;
  const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installEvent = e;
    $('installNote').hidden = false;
    $('installBtn').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    $('installNote').hidden = true;
    $('installBtn').hidden = true;
    toast('Installed. vibeReply is now in X\'s Share menu.');
  });

  // ---------- Wiring ----------
  function submitLink(value) {
    const id = findStatusId(value);
    if (!id) {
      status('That doesn\'t look like a post link. It should contain /status/ and a number.', 'error');
      return;
    }
    $('linkInput').blur();
    loadPost(id);
  }

  $('linkForm').addEventListener('submit', e => {
    e.preventDefault();
    submitLink($('linkInput').value);
  });
  $('linkInput').addEventListener('paste', () => {
    setTimeout(() => { if (findStatusId($('linkInput').value)) submitLink($('linkInput').value); }, 0);
  });
  $('pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      $('linkInput').value = text.trim();
      submitLink(text);
    } catch (_) {
      $('linkInput').focus();
      toast('Long-press the box and tap Paste');
    }
  });
  $('regenBtn').addEventListener('click', generate);
  $('improveBtn').addEventListener('click', improve);
  $('myReply').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); improve(); }
  });
  $('postText').addEventListener('click', () => $('postText').classList.toggle('expanded'));
  $('settingsBtn').addEventListener('click', openSettings);
  $('openSettingsLink').addEventListener('click', e => { e.preventDefault(); openSettings(); });
  $('settingsDone').addEventListener('click', closeSettings);
  $('installBtn').addEventListener('click', async () => {
    if (!installEvent) return;
    installEvent.prompt();
    await installEvent.userChoice.catch(() => {});
    installEvent = null;
  });
  chrome.storage.onChanged.addListener(changes => {
    if (['geminiApiKeys', 'groqApiKeys', 'openrouterApiKey'].some(k => k in changes)) refreshIntro();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('vibeReply: service worker failed', err));
  }

  // Opened from the Share menu: ./?title=...&text=...&url=...
  async function start() {
    await refreshIntro();
    if (!isInstalled()) $('installNote').hidden = false;
    const params = new URLSearchParams(location.search);
    const shared = ['url', 'text', 'title'].map(k => params.get(k) || '').join(' ').trim();
    if (shared) {
      history.replaceState(null, '', location.pathname);
      const id = findStatusId(shared);
      if (id) {
        $('linkInput').value = `https://x.com/i/status/${id}`;
        loadPost(id);
      } else {
        status('What you shared has no post link in it. In X, use Share on a post.', 'error');
      }
    }
  }
  start();
})();
