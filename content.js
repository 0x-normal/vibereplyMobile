// vibeReply - Content Script
// Injects a "Vibe Reply" button on each tweet, extracts caption + media,
// sends to background for Gemini, then shows 6 reply options (2 of them questions) with copy buttons.

(function () {
  'use strict';

  // Slightly longer than the background's own 60s budget, as a last-resort stop
  const REQUEST_TIMEOUT_MS = 70000;

  class VibeReply {
    constructor() {
      this.hasKeys = false;
      this.panel = null;
      this.isGenerating = false;
      this.isImproving = false;
      this.currentTweet = null;
      this.currentData = null;
      this.progressJobs = new Map();
      this.init();
    }

    async init() {
      console.log('vibeReply: init');
      await this.loadApiKeys();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.setup());
      } else {
        this.setup();
      }
    }

    async loadApiKeys() {
      const keyFields = ['geminiApiKeys', 'geminiApiKey', 'groqApiKeys', 'groqApiKey', 'openrouterApiKey'];
      const refresh = async () => {
        const r = await chrome.storage.local.get(keyFields);
        let keys = r.geminiApiKeys;
        if (!keys && r.geminiApiKey) keys = [r.geminiApiKey];
        const hasGemini = Array.isArray(keys) && keys.length > 0;
        const hasGroq = (Array.isArray(r.groqApiKeys) && r.groqApiKeys.length > 0) || !!r.groqApiKey;
        this.hasKeys = hasGemini || hasGroq || !!r.openrouterApiKey;
      };
      try {
        await refresh();
      } catch (e) {
        console.error('vibeReply: failed to load API keys', e);
      }
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (keyFields.some(k => changes[k])) refresh().catch(() => {});
      });
    }

    setup() {
      // Live progress lines sent by the background while a request runs
      chrome.runtime.onMessage.addListener(msg => {
        if (msg?.action !== 'vibeProgress') return;
        const job = this.progressJobs.get(msg.requestId);
        if (!job) return;
        job.text = msg.text;
        job.render();
      });
      this.createPanel();
      this.observeTweets();
      this.addButtonsToExistingTweets();
    }

    // ---------- UI: floating panel ----------
    createPanel() {
      const old = document.getElementById('vibe-reply-panel');
      if (old) old.remove();

      const panel = document.createElement('div');
      panel.id = 'vibe-reply-panel';
      panel.className = 'vibe-panel';
      panel.innerHTML = `
        <div class="vibe-header">
          <h3>vibeReply</h3>
          <div class="vibe-header-actions">
            <button class="vibe-icon-btn" id="vibeRegenBtn" title="Regenerate">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
            </button>
            <button class="vibe-icon-btn" id="vibeCloseBtn" title="Close">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>
        </div>
        <div class="vibe-body">
          <div class="vibe-original">
            <div class="vibe-original-label">Original post</div>
            <div class="vibe-original-text" id="vibeOriginalText">Click the Vibe Reply icon on any post.</div>
            <div class="vibe-media-info" id="vibeMediaInfo"></div>
            <div class="vibe-read" id="vibeRead" style="display:none;"></div>
          </div>
          <div class="vibe-status" id="vibeStatus" style="display:none;"></div>
          <div class="vibe-replies" id="vibeReplies"></div>
          <div class="vibe-meta" id="vibeMeta"></div>
          <div class="vibe-improve">
            <label class="vibe-original-label" for="vibeMyReply">Your reply</label>
            <textarea class="vibe-my-reply" id="vibeMyReply" rows="3" placeholder="Write your own reply and AI will fix it or suggest better ways to say it..."></textarea>
            <button class="vibe-improve-btn" id="vibeImproveBtn" type="button">Fix &amp; improve</button>
            <div class="vibe-status" id="vibeImproveStatus" style="display:none;"></div>
            <div class="vibe-replies" id="vibeImproveResult"></div>
          </div>
        </div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;

      panel.querySelector('#vibeCloseBtn').addEventListener('click', () => this.hidePanel());
      panel.querySelector('#vibeRegenBtn').addEventListener('click', () => {
        if (this.currentTweet) this.runForTweet(this.currentTweet, true);
      });

      const myReply = panel.querySelector('#vibeMyReply');
      // Keep X's keyboard shortcuts (j, k, l, r, n...) from firing while typing
      ['keydown', 'keyup', 'keypress'].forEach(type => {
        myReply.addEventListener(type, e => e.stopPropagation());
      });
      myReply.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          this.improveMyReply();
        }
      });
      panel.querySelector('#vibeImproveBtn').addEventListener('click', () => this.improveMyReply());
      this.makeDraggable();
    }

    // ---------- Moving the panel ----------
    // Click and hold the header, then drag the panel anywhere on the screen.
    // The spot is remembered; double-click the header to put it back.
    makeDraggable() {
      const panel = this.panel;
      const header = panel.querySelector('.vibe-header');
      header.title = 'Drag to move, double-click to reset';
      let drag = null;

      header.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('button')) return;
        // offsetLeft/Top ignore the slide-in transform, unlike getBoundingClientRect
        drag = { dx: e.clientX - panel.offsetLeft, dy: e.clientY - panel.offsetTop, id: e.pointerId };
        header.setPointerCapture(e.pointerId);
        panel.classList.add('vibe-dragging');
        e.preventDefault();
      });
      header.addEventListener('pointermove', e => {
        if (!drag || e.pointerId !== drag.id) return;
        this.placePanel(e.clientX - drag.dx, e.clientY - drag.dy);
      });
      const end = e => {
        if (!drag || e.pointerId !== drag.id) return;
        drag = null;
        panel.classList.remove('vibe-dragging');
        this.savePanelPos({ left: panel.offsetLeft, top: panel.offsetTop });
      };
      header.addEventListener('pointerup', end);
      header.addEventListener('pointercancel', end);

      header.addEventListener('dblclick', e => {
        if (e.target.closest('button')) return;
        this.resetPanelPos();
        this.savePanelPos(null);
      });

      // Keep it on screen when the window gets smaller
      window.addEventListener('resize', () => {
        if (this.panelPos) this.placePanel(this.panelPos.left, this.panelPos.top);
      });

      chrome.storage.local.get(['panelPos']).then(({ panelPos }) => {
        if (panelPos && Number.isFinite(panelPos.left) && Number.isFinite(panelPos.top)) {
          this.placePanel(panelPos.left, panelPos.top);
        }
      }).catch(() => {});
    }

    // Puts the panel's top-left corner at (left, top), kept fully on screen sideways and
    // with the header always reachable; the panel gets shorter if it would run off the bottom.
    placePanel(left, top) {
      const panel = this.panel;
      const margin = 8;
      const w = panel.offsetWidth;
      const headerH = panel.querySelector('.vibe-header').offsetHeight || 56;
      // Visible area without the page scrollbar
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const x = Math.min(Math.max(left, margin), Math.max(margin, vw - w - margin));
      const y = Math.min(Math.max(top, margin), Math.max(margin, vh - headerH - margin));
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.style.right = 'auto';
      panel.style.maxHeight = `${Math.max(headerH, vh - y - margin)}px`;
      this.panelPos = { left: x, top: y };
    }

    resetPanelPos() {
      ['left', 'top', 'right', 'maxHeight'].forEach(p => { this.panel.style[p] = ''; });
      this.panelPos = null;
    }

    savePanelPos(pos) {
      const p = pos ? chrome.storage.local.set({ panelPos: pos }) : chrome.storage.local.remove('panelPos');
      p.catch(() => {}); // extension reloaded: nothing to save to
    }

    showPanel() {
      this.panel.classList.add('vibe-panel-visible');
    }
    hidePanel() {
      this.panel.classList.remove('vibe-panel-visible');
    }

    // Sends a request to the background, showing its live progress plus a seconds
    // counter in the given status box. Never waits longer than REQUEST_TIMEOUT_MS.
    async sendWithProgress(action, data, statusSel, initialText) {
      const requestId = `${action}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const started = Date.now();
      const job = { text: initialText };
      this.progressJobs.set(requestId, job);

      const render = () => {
        const secs = Math.floor((Date.now() - started) / 1000);
        this.setStatus(secs >= 2 ? `${job.text} ${secs}s` : job.text, 'info', statusSel);
      };
      job.render = render;
      render();
      const ticker = setInterval(render, 1000);

      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `No answer after ${REQUEST_TIMEOUT_MS / 1000}s. Gemini may be overloaded; try again in a minute.`
        )), REQUEST_TIMEOUT_MS);
      });

      try {
        return await Promise.race([
          chrome.runtime.sendMessage({ action, data: { ...data, requestId } }),
          timeout
        ]);
      } catch (err) {
        if (/Extension context invalidated/i.test(err.message || '')) {
          throw new Error('The extension was reloaded. Refresh this page and try again.');
        }
        throw err;
      } finally {
        clearInterval(ticker);
        clearTimeout(timer);
        this.progressJobs.delete(requestId);
      }
    }

    // Shows how the AI understood the post, so a misread is easy to spot
    setRead(text) {
      const el = this.panel.querySelector('#vibeRead');
      el.textContent = text ? `AI read it as: ${text}` : '';
      el.style.display = text ? 'block' : 'none';
    }

    setStatus(text, kind = 'info', selector = '#vibeStatus') {
      const el = this.panel.querySelector(selector);
      if (!text) {
        el.style.display = 'none';
        el.textContent = '';
        return;
      }
      el.style.display = 'block';
      el.className = `vibe-status vibe-status-${kind}`;
      el.textContent = text;
    }

    renderReplies(replies) {
      const container = this.panel.querySelector('#vibeReplies');
      container.innerHTML = '';
      replies.forEach((text, i) => container.appendChild(this.makeReplyCard(text, String(i + 1))));
    }

    makeReplyCard(text, badge, extraClass = '') {
      const card = document.createElement('div');
      card.className = `vibe-reply-card ${extraClass}`.trim();
      card.innerHTML = `
        <div class="vibe-reply-num"></div>
        <div class="vibe-reply-text"></div>
        <button class="vibe-copy-btn" title="Copy reply">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
        </button>
      `;
      card.querySelector('.vibe-reply-num').textContent = badge;
      card.querySelector('.vibe-reply-text').textContent = text;
      const btn = card.querySelector('.vibe-copy-btn');
      btn.addEventListener('click', () => this.copyText(text, btn));
      return card;
    }

    renderImproveResult({ feedback, fixed, alternatives }) {
      const container = this.panel.querySelector('#vibeImproveResult');
      container.innerHTML = '';

      if (feedback) {
        const note = document.createElement('div');
        note.className = 'vibe-improve-feedback';
        note.textContent = feedback;
        container.appendChild(note);
      }

      const fixedLabel = document.createElement('div');
      fixedLabel.className = 'vibe-original-label vibe-improve-label';
      fixedLabel.textContent = 'Corrected';
      container.appendChild(fixedLabel);
      container.appendChild(this.makeReplyCard(fixed, '✓', 'vibe-reply-fixed'));

      if (alternatives && alternatives.length) {
        const altLabel = document.createElement('div');
        altLabel.className = 'vibe-original-label vibe-improve-label';
        altLabel.textContent = 'Better ways to say it';
        container.appendChild(altLabel);
        alternatives.forEach((text, i) => container.appendChild(this.makeReplyCard(text, String(i + 1))));
      }
    }

    async improveMyReply() {
      if (this.isImproving) return;
      const statusSel = '#vibeImproveStatus';
      const myReply = this.panel.querySelector('#vibeMyReply').value.trim();

      if (!this.hasKeys) {
        this.setStatus('Add a Gemini, Groq, or OpenRouter key in the side panel first.', 'error', statusSel);
        return;
      }
      if (!this.currentData) {
        this.setStatus('Click the Vibe Reply icon on a post first.', 'error', statusSel);
        return;
      }
      if (!myReply) {
        this.setStatus('Write your reply first.', 'error', statusSel);
        return;
      }

      this.isImproving = true;
      const btn = this.panel.querySelector('#vibeImproveBtn');
      btn.disabled = true;
      btn.textContent = 'Checking...';
      this.panel.querySelector('#vibeImproveResult').innerHTML = '';
      try {
        const { tweetText, urls, kind, context } = this.currentData;
        const response = await this.sendWithProgress(
          'improveReply',
          { tweetText, mediaUrls: urls, mediaKind: kind, context, myReply },
          statusSel,
          'Checking your reply...'
        );
        if (!response || !response.success) {
          throw new Error(response?.error || 'Unknown error');
        }
        this.setStatus('', 'info', statusSel);
        this.renderImproveResult(response.result);
      } catch (err) {
        console.error('vibeReply improve error:', err);
        this.setStatus(`Error: ${err.message}`, 'error', statusSel);
      } finally {
        this.isImproving = false;
        btn.disabled = false;
        btn.textContent = 'Fix & improve';
      }
    }

    async copyText(text, btn) {
      try {
        let finalText = text;
        try {
          const r = await chrome.storage.local.get(['replySuffixes', 'replySuffix', 'suffixRotationIdx']);
          let list = Array.isArray(r.replySuffixes) ? r.replySuffixes : null;
          if (!list && typeof r.replySuffix === 'string' && r.replySuffix.length) {
            list = [r.replySuffix]; // legacy fallback
          }
          if (list && list.length) {
            const idx = Number.isInteger(r.suffixRotationIdx) ? r.suffixRotationIdx : 0;
            const chosen = list[idx % list.length];
            const sep = /^[\s\n]/.test(chosen) ? '' : ' ';
            finalText = text + sep + chosen;
            await chrome.storage.local.set({ suffixRotationIdx: (idx + 1) % list.length });
          }
        } catch (_) { /* storage not available; copy raw */ }
        await navigator.clipboard.writeText(finalText);
        const original = btn.innerHTML;
        btn.classList.add('vibe-copied');
        btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
        setTimeout(() => {
          btn.classList.remove('vibe-copied');
          btn.innerHTML = original;
        }, 1500);
      } catch (e) {
        console.error('Copy failed', e);
      }
    }

    // ---------- Finding posts on the page ----------
    // X ships two layouts: the old one marks everything with data-testid
    // ("tweet", "tweetText", "User-Name", "tweetPhoto"...); the new one (late 2026)
    // has no data-testid at all. A post is an <article> with an action bar
    // (div[role="group"]); a quoted post is an <article> inside it, wrapped in a
    // div[role="link"] (data-slot="embedded-tweet-frame" in the new layout).
    findPosts(root = document) {
      const found = new Set();
      if (root.matches && root.matches('article')) found.add(root);
      if (root.querySelectorAll) root.querySelectorAll('article').forEach(a => found.add(a));
      return [...found].filter(a => !a.parentElement?.closest('article') && this.getActionBar(a));
    }

    // The post's own Reply / Repost / Like bar (never one inside a quoted post)
    getActionBar(post) {
      return [...post.querySelectorAll('[role="group"]')].find(g => !this.isInQuote(g, post)) || null;
    }

    // ---------- Tweet button injection ----------
    addButtonsToExistingTweets() {
      this.findPosts().forEach(t => this.addReplyButton(t));
    }

    observeTweets() {
      // X re-renders posts often (and may build the action bar after the post),
      // so rescan on changes, at most once per frame, and put back any lost button.
      let queued = false;
      const obs = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          this.addButtonsToExistingTweets();
        });
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    addReplyButton(tweetEl) {
      const actionBar = this.getActionBar(tweetEl);
      if (!actionBar) return;
      const existing = tweetEl.querySelector('.vibe-trigger-btn');
      if (existing && actionBar.contains(existing)) return;
      if (existing) existing.remove(); // left behind by a re-render

      const btn = document.createElement('button');
      btn.className = 'vibe-trigger-btn';
      btn.type = 'button';
      btn.title = 'Generate vibe replies';
      btn.setAttribute('aria-label', 'Generate vibe replies');
      btn.innerHTML = `
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4"/><path d="m16.24 7.76 2.83-2.83"/><path d="M18 12h4"/><path d="m16.24 16.24 2.83 2.83"/><path d="M12 18v4"/><path d="m4.93 19.07 2.83-2.83"/><path d="M2 12h4"/><path d="m4.93 4.93 2.83 2.83"/></svg>
      `;
      btn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        // Use the live post: X may have swapped the element since the button was added
        this.runForTweet(btn.closest('article') || tweetEl, false);
      });
      btn.addEventListener('mousedown', e => e.stopPropagation());

      // New layout: Bookmark and Share sit together in the last cell of the bar.
      // Put the button right after Share, at the end of the bar like before.
      const share = actionBar.querySelector('[data-engagement-action="share"]');
      const cluster = share && share.parentElement !== actionBar ? share.parentElement : null;
      if (cluster && actionBar.contains(cluster)) {
        cluster.appendChild(btn);
      } else {
        actionBar.appendChild(btn);
      }
    }

    // ---------- Extraction ----------
    // The quoted post's box inside tweetEl, if any
    findQuoteBox(tweetEl) {
      // New layout
      const frame = tweetEl.querySelector('[data-slot="embedded-tweet-frame"]');
      if (frame) return frame;
      const inner = tweetEl.querySelector('article');
      if (inner) return inner.closest('div[role="link"]') || inner;
      // Old layout: a div[role="link"] holding the quoted post's text or name
      const el = [...tweetEl.querySelectorAll('[data-testid="tweetText"], [data-testid="User-Name"]')]
        .find(e => this.isInQuote(e, tweetEl));
      return el ? el.closest('div[role="link"]') : null;
    }

    // True when el sits inside a quoted post embedded in tweetEl
    isInQuote(el, tweetEl) {
      const art = el.closest('article');
      if (art && art !== tweetEl && tweetEl.contains(art)) return true;
      const box = el.closest('div[role="link"], [data-slot="embedded-tweet-frame"]');
      return !!box && box !== tweetEl && tweetEl.contains(box);
    }

    // Visible text of an element, without the inline <script>s the new layout puts in posts
    cleanText(el, max = 1000) {
      if (!el) return '';
      let text;
      if (el.querySelector('script, style')) {
        const copy = el.cloneNode(true);
        copy.querySelectorAll('script, style').forEach(s => s.remove());
        text = copy.textContent;
      } else {
        text = el.innerText || el.textContent;
      }
      return (text || '').replace(/\s+/g, ' ').trim().slice(0, max);
    }

    // Post text elements inside scope (old: data-testid="tweetText"; new: div[dir="auto"])
    textEls(scope) {
      const old = [...scope.querySelectorAll('[data-testid="tweetText"]')];
      if (old.length) return old;
      return [...scope.querySelectorAll('div[dir="auto"]')].filter(d =>
        !d.closest('[role="group"]') &&
        // Not the text of a link preview card
        !d.closest('a[href^="https://t.co/"], a[href^="http://t.co/"]'));
    }

    extractTweetText(tweetEl) {
      return this.cleanText(this.textEls(tweetEl).find(el => !this.isInQuote(el, tweetEl)));
    }

    // "Display Name (@handle)" for the post header inside scope
    readAuthorIn(scope, tweetEl) {
      const outside = el => !tweetEl || scope !== tweetEl || !this.isInQuote(el, tweetEl);
      const old = [...scope.querySelectorAll('[data-testid="User-Name"]')].find(outside);
      if (old) return this.readAuthor(old);

      // New layout: the header has a profile link with the name, and one with "@handle"
      const links = [...scope.querySelectorAll('a[href^="/"]')].filter(outside);
      const handleLink = links.find(a => /^@\w{1,15}$/.test(this.cleanText(a)));
      if (!handleLink) return '';
      const handle = this.cleanText(handleLink);
      const href = handleLink.getAttribute('href');
      const nameLink = links.find(a => a !== handleLink && a.getAttribute('href') === href &&
        !a.querySelector('img') && this.cleanText(a) && !this.cleanText(a).startsWith('@'));
      const name = nameLink ? this.cleanText(nameLink, 60) : '';
      return [name, `(${handle})`].filter(Boolean).join(' ');
    }

    // "Display Name (@handle)" from an old-layout User-Name block
    readAuthor(userNameEl) {
      if (!userNameEl) return '';
      const text = this.cleanText(userNameEl);
      const handle = (text.match(/@\w{1,15}/) || [''])[0];
      // Name is whatever comes before the @handle (the time comes after it)
      const name = (handle ? text.slice(0, text.indexOf(handle)) : text.split('·')[0]).trim();
      return [name, handle && `(${handle})`].filter(Boolean).join(' ');
    }

    // Photos in the post (old: inside data-testid="tweetPhoto"; new: plain <img> from pbs.twimg.com/media)
    photoImgs(tweetEl) {
      const imgs = [...tweetEl.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]')];
      return [...new Set(imgs)];
    }

    // Extra context so the AI understands what the post is really about
    extractContext(tweetEl) {
      const ctx = {};
      ctx.author = this.readAuthorIn(tweetEl, tweetEl);

      // "Replying to @someone" line, when this post is itself a reply
      const replyLine = [...tweetEl.querySelectorAll('div')]
        .find(d => d.children.length <= 3 && /^Replying to\s+@/i.test((d.innerText || '').trim()));
      if (replyLine) ctx.replyingTo = this.cleanText(replyLine, 120).replace(/^Replying to\s*/i, '');

      // Quoted post
      const quoteBox = this.findQuoteBox(tweetEl);
      if (quoteBox) {
        const quoteText = this.textEls(quoteBox)[0];
        const author = this.readAuthorIn(quoteBox, null);
        if (quoteText || author) {
          ctx.quoted = { author, text: this.cleanText(quoteText, 600) };
        }
      }

      // Link preview card (old: data-testid="card.wrapper"; new: a t.co link outside the text)
      let card = tweetEl.querySelector('[data-testid="card.wrapper"]');
      if (!card) {
        card = [...tweetEl.querySelectorAll('a[href^="https://t.co/"], a[href^="http://t.co/"]')]
          .find(a => !a.closest('div[dir="auto"]') && !this.isInQuote(a, tweetEl) && this.cleanText(a).length > 3);
      }
      if (card) ctx.card = this.cleanText(card, 300);

      // Image descriptions written by the poster (X's default alt is just "Image")
      const alts = this.photoImgs(tweetEl)
        .map(img => (img.alt || '').trim())
        .filter(a => a.length > 3 && !/^image$/i.test(a));
      if (alts.length) ctx.altTexts = alts.slice(0, 4);

      return ctx;
    }

    extractMedia(tweetEl) {
      const urls = [];
      let kind = null;

      // Images: tweet photos
      this.photoImgs(tweetEl).forEach(img => {
        let src = img.currentSrc || img.src;
        if (!src) return;
        // "medium" (max 1200px) is plenty for the AI and much smaller to download and send than "large"
        src = src.replace(/([?&])name=\w+/, '$1name=medium');
        urls.push(src);
      });
      if (urls.length) kind = 'image(s)';

      // Video: use the poster (still frame on pbs.twimg.com); the new layout may show
      // only a thumbnail <img> until the video loads
      const posters = [
        ...[...tweetEl.querySelectorAll('video')].map(v => v.poster),
        ...[...tweetEl.querySelectorAll('img[src*="video_thumb/"]')].map(i => i.src)
      ].filter(Boolean);
      if (posters.length) {
        urls.push(...posters);
        kind = kind ? 'image(s) + video' : 'video';
      }

      // Dedupe; ask for jpg, which works with every provider (the new layout asks for webp)
      const unique = [...new Set(urls.map(u => u.replace(/([?&])format=webp/, '$1format=jpg')))];
      return { urls: unique, kind: kind || 'none' };
    }

    // ---------- Main flow ----------
    async runForTweet(tweetEl, isRegenerate) {
      if (this.isGenerating) return;
      if (!this.hasKeys) {
        alert('vibeReply: please add a Gemini, Groq, or OpenRouter API key in the extension side panel first.');
        return;
      }

      this.isGenerating = true;
      if (!isRegenerate && this.currentTweet !== tweetEl) {
        // New post: clear the old draft and its suggestions
        this.panel.querySelector('#vibeMyReply').value = '';
        this.panel.querySelector('#vibeImproveResult').innerHTML = '';
        this.setStatus('', 'info', '#vibeImproveStatus');
      }
      this.currentTweet = tweetEl;
      this.showPanel();

      const triggerBtn = tweetEl.querySelector('.vibe-trigger-btn');
      const originalBtnHTML = triggerBtn ? triggerBtn.innerHTML : null;
      if (triggerBtn) {
        triggerBtn.classList.add('vibe-loading');
        triggerBtn.setAttribute('aria-busy', 'true');
        triggerBtn.setAttribute('aria-label', 'Generating vibe replies');
        triggerBtn.title = 'Generating vibe replies';
        triggerBtn.innerHTML = `<span class="vibe-spinner" aria-hidden="true"></span>`;
      }

      try {
        const tweetText = this.extractTweetText(tweetEl);
        const { urls, kind } = this.extractMedia(tweetEl);
        const context = this.extractContext(tweetEl);
        this.currentData = { tweetText, urls, kind, context };

        this.panel.querySelector('#vibeOriginalText').textContent =
          tweetText || (context.quoted ? `(quote of ${context.quoted.author || 'a post'})` : '(no caption)');
        const info = [urls.length ? `Media: ${kind} (${urls.length})` : 'Media: none'];
        if (context.quoted) info.push('quote post');
        if (context.replyingTo) info.push(`reply to ${context.replyingTo}`);
        this.panel.querySelector('#vibeMediaInfo').textContent = info.join(' · ');
        this.setRead('');

        this.panel.querySelector('#vibeReplies').innerHTML = '';
        this.panel.querySelector('#vibeMeta').textContent = '';
        const response = await this.sendWithProgress(
          'generateReplies',
          { tweetText, mediaUrls: urls, mediaKind: kind, context },
          '#vibeStatus',
          isRegenerate ? 'Regenerating...' : 'Analyzing post...'
        );

        if (!response || !response.success) {
          throw new Error(response?.error || 'Unknown error');
        }

        this.setStatus('', 'info');
        this.setRead(response.read);
        this.renderReplies(response.replies);
        if (response.meta) {
          this.panel.querySelector('#vibeMeta').textContent =
            `${response.meta.model} · ${(response.meta.ms / 1000).toFixed(1)}s`;
        }
      } catch (err) {
        console.error('vibeReply error:', err);
        this.setStatus(`Error: ${err.message}`, 'error');
      } finally {
        this.isGenerating = false;
        if (triggerBtn && originalBtnHTML) {
          triggerBtn.classList.remove('vibe-loading');
          triggerBtn.removeAttribute('aria-busy');
          triggerBtn.setAttribute('aria-label', 'Generate vibe replies');
          triggerBtn.title = 'Generate vibe replies';
          triggerBtn.innerHTML = originalBtnHTML;
        }
      }
    }
  }

  const vibe = new VibeReply();
  window.__vibeReply = vibe;
})();
