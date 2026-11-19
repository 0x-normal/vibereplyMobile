// vibeReply - Content Script
// Injects a "Vibe Reply" button on each tweet, extracts caption + media,
// sends to background for Gemini, then shows 6 reply options (2 of them questions) with copy buttons.

(function () {
  'use strict';

  // Slightly longer than the background's own 60s budget, as a last-resort stop
  const REQUEST_TIMEOUT_MS = 70000;

  // "Type into reply": wait before each letter (ms, random in min..max), and how much
  // longer to pause between words and after punctuation (pause = multiplier)
  const TYPING_SPEEDS = {
    fast:   { min: 60,  max: 140, pause: 0.5 }, // about 100 words a minute
    normal: { min: 90,  max: 230, pause: 1 },   // about 60
    slow:   { min: 150, max: 380, pause: 1.6 }  // about 40
  };

  // Shown when the panel is opened with the pencil icon (write your own reply, no AI)
  const WRITE_HINT = 'Write or paste your reply below, then press Type into reply.';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const rand = (min, max) => min + Math.random() * (max - min);

  // Splits text into what a person types as one key each: emoji and accented
  // letters stay whole instead of being cut into broken halves
  function splitLetters(text) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment);
    }
    return Array.from(text);
  }

  // The key a letter comes from, for the keydown / keyup sent around it
  function keyInfo(ch) {
    if (/^[a-z]$/i.test(ch)) {
      const up = ch.toUpperCase();
      return { key: ch, code: `Key${up}`, keyCode: up.charCodeAt(0), shiftKey: ch === up };
    }
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0) };
    if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32 };
    if (ch === '\n') return { key: 'Enter', code: 'Enter', keyCode: 13 };
    return { key: ch, code: '', keyCode: 0 };
  }

  // Letters and digits only, lowercased: to check the reply box got the whole reply
  // even though X may show links, mentions or emoji differently
  const lettersOnly = s => (s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

  class VibeReply {
    constructor() {
      this.hasKeys = false;
      this.panel = null;
      this.isGenerating = false;
      this.isImproving = false;
      this.currentTweet = null;
      this.currentData = null;
      this.currentTweetAt = 0;
      this.progressJobs = new Map();
      // Typing a reply into X's reply box: the running job, and the last box the user clicked into
      this.typing = null;
      this.lastEditor = null;
      this.lastEditorAt = 0;
      this.typeBarTimer = null;
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
      const keyFields = ['geminiApiKeys', 'geminiApiKey', 'groqApiKeys', 'groqApiKey', 'openrouterApiKey', 'deepseekApiKeys'];
      const refresh = async () => {
        const r = await chrome.storage.local.get(keyFields);
        let keys = r.geminiApiKeys;
        if (!keys && r.geminiApiKey) keys = [r.geminiApiKey];
        const hasGemini = Array.isArray(keys) && keys.length > 0;
        const hasGroq = (Array.isArray(r.groqApiKeys) && r.groqApiKeys.length > 0) || !!r.groqApiKey;
        const hasDeepSeek = Array.isArray(r.deepseekApiKeys) && r.deepseekApiKeys.length > 0;
        this.hasKeys = hasGemini || hasGroq || hasDeepSeek || !!r.openrouterApiKey;
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
      // Remember the last X text box the user clicked into (not ours), to type the reply there
      document.addEventListener('focusin', e => {
        const box = this.editableRoot(e.target);
        if (box && !this.panel.contains(box)) {
          this.lastEditor = box;
          this.lastEditorAt = Date.now();
        }
      }, true);
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
            <textarea class="vibe-my-reply" id="vibeMyReply" rows="3" placeholder="Write or paste your reply. AI can fix it, or it can be typed into the post's reply box letter by letter..."></textarea>
            <div class="vibe-improve-actions">
              <button class="vibe-improve-btn" id="vibeImproveBtn" type="button">Fix &amp; improve</button>
              <button class="vibe-improve-btn vibe-type-own-btn" id="vibeTypeOwnBtn" type="button" title="Type this into the post's reply box, letter by letter">Type into reply</button>
            </div>
            <div class="vibe-status" id="vibeImproveStatus" style="display:none;"></div>
            <div class="vibe-replies" id="vibeImproveResult"></div>
          </div>
        </div>
        <div class="vibe-type-bar" id="vibeTypeBar">
          <span class="vibe-type-text" id="vibeTypeText"></span>
          <button class="vibe-type-stop" id="vibeTypeStop" type="button">Stop</button>
        </div>
      `;
      document.body.appendChild(panel);
      this.panel = panel;

      // Clicks in the panel are not clicks "outside" X's reply window, so they don't
      // close it, and pressing a panel button keeps the cursor in X's reply box
      ['pointerdown', 'mousedown', 'focusin'].forEach(type => {
        panel.addEventListener(type, e => e.stopPropagation());
      });

      const stopBtn = panel.querySelector('#vibeTypeStop');
      stopBtn.addEventListener('mousedown', e => e.preventDefault());
      stopBtn.addEventListener('click', () => {
        if (this.typing) this.typing.cancelled = true;
      });
      const typeOwnBtn = panel.querySelector('#vibeTypeOwnBtn');
      typeOwnBtn.addEventListener('mousedown', e => e.preventDefault());
      typeOwnBtn.addEventListener('click', () => {
        const text = panel.querySelector('#vibeMyReply').value;
        if (!text.trim()) {
          this.setStatus('Write or paste your reply first.', 'error', '#vibeImproveStatus');
          return;
        }
        this.setStatus('', 'info', '#vibeImproveStatus');
        this.typeIntoReplyBox(async () => text, typeOwnBtn);
      });

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
        <div class="vibe-card-actions">
          <button class="vibe-copy-btn vibe-type-btn" type="button" title="Type into the reply box, letter by letter">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/></svg>
          </button>
          <button class="vibe-copy-btn" type="button" title="Copy reply">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          </button>
        </div>
      `;
      card.querySelector('.vibe-reply-num').textContent = badge;
      card.querySelector('.vibe-reply-text').textContent = text;
      const btn = card.querySelector('.vibe-copy-btn:not(.vibe-type-btn)');
      btn.addEventListener('click', () => this.copyText(text, btn));
      const typeBtn = card.querySelector('.vibe-type-btn');
      typeBtn.addEventListener('mousedown', e => e.preventDefault());
      typeBtn.addEventListener('click', () => this.typeIntoReplyBox(() => this.withSuffix(text), card));
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

    // The reply with the next suffix from settings added (the rotation moves on), if any are set
    async withSuffix(text) {
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
          await chrome.storage.local.set({ suffixRotationIdx: (idx + 1) % list.length });
          return text + sep + chosen;
        }
      } catch (_) { /* storage not available; use the reply as is */ }
      return text;
    }

    async copyText(text, btn) {
      try {
        await navigator.clipboard.writeText(await this.withSuffix(text));
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

    // ---------- Typing a reply into X's reply box ----------
    // Instead of pasting, the reply is typed into the post's reply box one letter at a
    // time at a person's pace, through the browser's own text insertion: each letter
    // arrives as a typed letter, never as a paste. It never presses Reply; the user
    // checks the text and sends it.

    // The text box el belongs to (a textarea, or the outermost element of an
    // editable area), or null when el is not in one
    editableRoot(el) {
      if (!el || el.nodeType !== 1) return null;
      if (el.tagName === 'TEXTAREA') return el.disabled || el.readOnly ? null : el;
      if (!el.isContentEditable) return null;
      let root = el;
      while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement;
      return root;
    }

    // An X text box that is still on the page and visible (never one of ours)
    isUsableBox(el) {
      return !!el && el.isConnected && !this.panel.contains(el) && el.getClientRects().length > 0;
    }

    // The text box of an open pop-up window, like the one X's Reply button opens
    modalReplyBox() {
      const modals = [...document.querySelectorAll('[aria-modal="true"]')].reverse(); // topmost first
      for (const modal of modals) {
        const box = [...modal.querySelectorAll('textarea, [contenteditable]')]
          .map(el => this.editableRoot(el))
          .find(el => this.isUsableBox(el));
        if (box) return box;
      }
      return null;
    }

    // The post's own Reply button (never the vibeReply ones next to it)
    findReplyButton(post) {
      if (!post || !post.isConnected) return null;
      const bar = this.getActionBar(post);
      if (!bar) return null;
      return bar.querySelector('[data-testid="reply"], [data-engagement-action="reply"]') ||
        [...bar.querySelectorAll('button, [role="button"]')]
          .filter(b => !b.closest('.vibe-trigger-btn, .vibe-write-btn'))
          .find(b => /\brepl(y|ies)\b/i.test(b.getAttribute('aria-label') || '')) ||
        null;
    }

    // Where to type: an open reply window, else the box the user clicked into after
    // picking this post, else the post's reply box, opened with its Reply button
    async findReplyBox(job) {
      const modal = this.modalReplyBox();
      if (modal) return modal;
      if (this.isUsableBox(this.lastEditor) && this.lastEditorAt >= this.currentTweetAt) return this.lastEditor;

      const replyBtn = this.findReplyButton(this.currentTweet);
      if (!replyBtn) return null;
      this.setTypeBar('Opening the reply box...', 'info', true);
      const clickedAt = Date.now();
      replyBtn.click();
      while (Date.now() - clickedAt < 5000 && !job.cancelled) {
        await sleep(100);
        const box = this.modalReplyBox() ||
          (this.isUsableBox(this.lastEditor) && this.lastEditorAt >= clickedAt ? this.lastEditor : null);
        if (box) {
          await sleep(350); // let the window finish opening
          return box.isConnected ? box : this.modalReplyBox();
        }
      }
      return null;
    }

    boxText(box) {
      return box.tagName === 'TEXTAREA' ? box.value : (box.innerText || '');
    }

    // Puts the cursor in the box: where the user left it if the box already has it,
    // else after any text already there. ok is false if the box won't take the cursor.
    async placeCursor(box) {
      if (this.editableRoot(document.activeElement) === box) return { ok: true, moved: false };
      box.focus();
      await sleep(60); // let the editor handle the focus first
      if (this.editableRoot(document.activeElement) !== box) return { ok: false };
      if (box.tagName === 'TEXTAREA') {
        box.setSelectionRange(box.value.length, box.value.length);
      } else {
        // After the last bit of text in the box (an empty box needs nothing)
        const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
        let last = null;
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (node.data.length && node.parentElement && node.parentElement.isContentEditable) last = node;
        }
        const sel = window.getSelection();
        if (last && sel) {
          const range = document.createRange();
          range.setStart(last, last.data.length);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      await sleep(80); // editors pick up a cursor move a moment later
      return { ok: true, moved: true };
    }

    // The box to type the next letter in: the same one while it has the cursor, or the
    // one X put in its place (X sometimes rebuilds the box). null if the cursor went elsewhere.
    liveBox(box) {
      const active = this.editableRoot(document.activeElement);
      if (active === box && box.isConnected) return box;
      if (!box.isConnected && this.isUsableBox(active)) return active;
      return null;
    }

    fireKey(target, type, k) {
      const ev = new KeyboardEvent(type, {
        key: k.key, code: k.code, shiftKey: !!k.shiftKey,
        bubbles: true, cancelable: true, composed: true
      });
      if (k.keyCode) {
        Object.defineProperty(ev, 'keyCode', { get: () => k.keyCode });
        Object.defineProperty(ev, 'which', { get: () => k.keyCode });
      }
      target.dispatchEvent(ev);
      return ev;
    }

    execInsert(command, value) {
      try {
        return document.execCommand(command, false, value);
      } catch (_) {
        return false;
      }
    }

    // Puts text in at the cursor in the same steps as a key press, so every kind of editor
    // keeps up: editors that insert text themselves get the chance first (newer ones
    // listen to "beforeinput", X's Draft.js to "textInput"); if none did, the browser
    // inserts it, which sends the normal "input" event. Inserting it directly instead
    // would change the page under Draft.js and break it. Returns false if nothing took it.
    insertAtCursor(box, inputType, data) {
      const before = new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true, composed: true });
      box.dispatchEvent(before);
      if (before.defaultPrevented) return true;
      if (data != null) {
        try {
          const ev = document.createEvent('TextEvent');
          ev.initTextEvent('textInput', true, true, window, data);
          box.dispatchEvent(ev);
          if (ev.defaultPrevented) return true;
        } catch (_) { /* no TextEvent in this browser */ }
      }
      const isArea = box.tagName === 'TEXTAREA';
      const text = data == null ? '\n' : data;
      if (this.execInsert(isArea || data != null ? 'insertText' : 'insertLineBreak', text)) return true;
      if (isArea) {
        box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
        box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
        return true;
      }
      return false;
    }

    // Types one letter where the cursor is, with a key press around it.
    // Returns false if the box didn't take it.
    typeLetter(box, ch) {
      const k = keyInfo(ch);
      const isArea = box.tagName === 'TEXTAREA';
      const down = this.fireKey(box, 'keydown', k);
      let ok;
      if (ch === '\n') {
        // Rich editors (like X's) add the new line themselves on Enter
        ok = down.defaultPrevented || this.insertAtCursor(box, isArea ? 'insertLineBreak' : 'insertParagraph', null);
      } else {
        ok = this.insertAtCursor(box, 'insertText', ch);
      }
      this.fireKey(box, 'keyup', k);
      return ok;
    }

    async getTypingSpeed() {
      try {
        const { typingSpeed } = await chrome.storage.local.get(['typingSpeed']);
        return TYPING_SPEEDS[typingSpeed] || TYPING_SPEEDS.normal;
      } catch (_) {
        return TYPING_SPEEDS.normal;
      }
    }

    // Wait before the letter that follows prev: a bit random, and longer between some
    // words and after punctuation or a new line, like a person typing
    letterDelay(prev, speed) {
      let ms = rand(speed.min, speed.max);
      if (prev === ' ' && Math.random() < 0.25) ms += rand(120, 420) * speed.pause;
      else if (/[.,!?;:]/.test(prev)) ms += rand(150, 450) * speed.pause;
      else if (prev === '\n') ms += rand(250, 600) * speed.pause;
      return Math.round(ms);
    }

    // Types a reply into the post's reply box. getText gives the text; it is asked only
    // once the box is found, so the suffix rotation moves on only when a reply is typed.
    // sourceEl (the reply card or button) is highlighted while it types.
    async typeIntoReplyBox(getText, sourceEl) {
      if (this.typing) return;
      const job = { cancelled: false };
      this.typing = job;
      this.panel.classList.add('vibe-is-typing');
      if (sourceEl) sourceEl.classList.add('vibe-typing-source');
      let typed = 0;
      let total = 0;
      try {
        this.setTypeBar('Looking for the reply box...', 'info', true);
        let box = await this.findReplyBox(job);
        if (job.cancelled) {
          this.setTypeBar('Stopped.', 'info');
          return;
        }
        if (!box) throw new Error("Couldn't find the reply box. Click Reply on the post, then press Type again.");
        const place = await this.placeCursor(box);
        if (!place.ok) throw new Error("Couldn't put the cursor in the reply box. Click into it, then press Type again.");

        let text = String((await getText()) || '').replace(/\r\n?/g, '\n');
        if (!text.trim()) throw new Error('Nothing to type.');
        // Adding to text already in the box: keep a space between the two
        const before = this.boxText(box);
        if (place.moved && before.trim() && !/\s$/.test(before)) text = ' ' + text.replace(/^\s+/, '');

        const letters = splitLetters(text);
        total = letters.length;
        const speed = await this.getTypingSpeed();
        for (let i = 0; i < letters.length; i++) {
          if (i > 0) await sleep(this.letterDelay(letters[i - 1], speed));
          if (job.cancelled) break;
          box = this.liveBox(box);
          if (!box) {
            throw new Error(`Stopped after ${typed} of ${total} letters: the cursor left the reply box. ` +
              'Leave the cursor in the box while it types.');
          }
          if (!this.typeLetter(box, letters[i])) {
            throw new Error(`Stopped after ${typed} of ${total} letters: the reply box didn't take the text.`);
          }
          typed++;
          this.setTypeBar(`Typing... ${typed}/${total}`, 'info', true);
        }

        if (job.cancelled) {
          this.setTypeBar(`Stopped after ${typed} of ${total} letters.`, 'info');
        } else if (box.isConnected && !lettersOnly(this.boxText(box)).includes(lettersOnly(text))) {
          this.setTypeBar('Typed, but some letters may be missing. Check the reply box before sending.', 'error');
        } else {
          this.setTypeBar('Typed. Check the reply box, then press Reply.', 'ok');
        }
      } catch (err) {
        console.error('vibeReply typing error:', err);
        this.setTypeBar(err.message, 'error');
      } finally {
        this.typing = null;
        this.panel.classList.remove('vibe-is-typing');
        if (sourceEl) sourceEl.classList.remove('vibe-typing-source');
      }
    }

    // The bar at the bottom of the panel: typing progress, with a Stop button while it types
    setTypeBar(text, kind = 'info', busy = false) {
      const bar = this.panel.querySelector('#vibeTypeBar');
      clearTimeout(this.typeBarTimer);
      bar.className = `vibe-type-bar vibe-type-bar-visible vibe-type-${kind}`;
      bar.querySelector('#vibeTypeText').textContent = text;
      bar.querySelector('#vibeTypeStop').style.display = busy ? '' : 'none';
      if (!busy) {
        this.typeBarTimer = setTimeout(() => bar.classList.remove('vibe-type-bar-visible'),
          kind === 'error' ? 15000 : 6000);
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

    // Adds two buttons to the post's action bar: the AI replies (sparkle) and
    // "write your own reply" (pencil), which needs no AI
    addReplyButton(tweetEl) {
      const actionBar = this.getActionBar(tweetEl);
      if (!actionBar) return;
      const existing = [...tweetEl.querySelectorAll('.vibe-trigger-btn, .vibe-write-btn')];
      if (existing.length === 2 && existing.every(b => actionBar.contains(b))) return;
      existing.forEach(b => b.remove()); // left behind by a re-render

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

      const writeBtn = document.createElement('button');
      writeBtn.className = 'vibe-write-btn';
      writeBtn.type = 'button';
      writeBtn.title = 'Write your own reply (no AI)';
      writeBtn.setAttribute('aria-label', 'Write your own reply, no AI');
      writeBtn.innerHTML = `
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 21h8"/><path d="m15 5 4 4"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>
      `;
      writeBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        this.openForWriting(writeBtn.closest('article') || tweetEl);
      });
      writeBtn.addEventListener('mousedown', e => e.stopPropagation());

      // New layout: Bookmark and Share sit together in the last cell of the bar.
      // Put the buttons right after Share, at the end of the bar like before.
      const share = actionBar.querySelector('[data-engagement-action="share"]');
      const cluster = share && share.parentElement !== actionBar ? share.parentElement : null;
      const target = cluster && actionBar.contains(cluster) ? cluster : actionBar;
      target.appendChild(btn);
      target.appendChild(writeBtn);
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
    // Reads the post and shows it at the top of the panel. Only reads the page: no AI.
    showPostInfo(tweetEl) {
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
      return this.currentData;
    }

    // The pencil icon: opens the panel on this post to write or paste your own reply
    // and type it into the reply box. Never calls the AI, so it needs no API key.
    // The AI is used only if you then press Regenerate or Fix & improve.
    openForWriting(tweetEl) {
      const isNew = this.currentTweet !== tweetEl;
      if (isNew) {
        // New post: clear the old draft, replies and suggestions
        this.currentTweetAt = Date.now();
        this.panel.querySelector('#vibeMyReply').value = '';
        this.panel.querySelector('#vibeImproveResult').innerHTML = '';
        this.setStatus('', 'info', '#vibeImproveStatus');
        this.panel.querySelector('#vibeReplies').innerHTML = '';
        this.panel.querySelector('#vibeMeta').textContent = '';
        this.setRead('');
      }
      this.currentTweet = tweetEl;
      try {
        this.showPostInfo(tweetEl);
      } catch (err) {
        console.error('vibeReply: could not read the post', err);
      }
      // Same post with replies already shown (or still coming): leave them as they are
      if (isNew || !(this.isGenerating || this.panel.querySelector('#vibeReplies').children.length)) {
        this.setStatus(WRITE_HINT, 'info');
      }
      this.showPanel();
      this.panel.querySelector('#vibeMyReply').focus({ preventScroll: true });
    }

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
      if (this.currentTweet !== tweetEl) this.currentTweetAt = Date.now();
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
        const { tweetText, urls, kind, context } = this.showPostInfo(tweetEl);
        this.setRead('');

        this.panel.querySelector('#vibeReplies').innerHTML = '';
        this.panel.querySelector('#vibeMeta').textContent = '';
        const response = await this.sendWithProgress(
          'generateReplies',
          { tweetText, mediaUrls: urls, mediaKind: kind, context },
          '#vibeStatus',
          isRegenerate ? 'Regenerating...' : 'Analyzing post...'
        );

        // The panel moved on to writing a reply to another post meanwhile: drop these
        if (this.currentTweet !== tweetEl) {
          this.setStatus(WRITE_HINT, 'info');
          return;
        }
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
        this.setStatus(this.currentTweet === tweetEl ? `Error: ${err.message}` : WRITE_HINT,
          this.currentTweet === tweetEl ? 'error' : 'info');
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
