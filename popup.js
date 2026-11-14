// vibeReply - Popup script (multi-key + rotation)

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return k.slice(0, 4) + '...';
  return k.slice(0, 6) + '...' + k.slice(-4);
}

function parseKeys(raw) {
  return raw
    .split(/[\r\n,]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 20);
}

function fmtTimeRemaining(ms) {
  if (ms <= 0) return 'soon';
  if (ms < 60000) return '<1m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// One key manager per provider (Gemini, Groq). Both work the same way:
// paste keys to add them to the saved ones, see each key's status, copy or
// remove a key, reset the rotation state. Key state (quota / invalid) lives
// in the shared `keyState` map, indexed by the key itself.
function setupKeyManager({ name, storageKey, legacyKey, prefix, ids }) {
  const input = document.getElementById(ids.input);
  const saveBtn = document.getElementById(ids.save);
  const resetBtn = document.getElementById(ids.reset);
  const statusEl = document.getElementById(ids.status);
  const section = document.getElementById(ids.section);
  const list = document.getElementById(ids.list);

  function setStatus(count) {
    if (count > 0) {
      statusEl.textContent = `${count} key${count === 1 ? '' : 's'} configured`;
      statusEl.className = 'api-status connected';
    } else {
      statusEl.textContent = 'No keys configured';
      statusEl.className = 'api-status disconnected';
    }
  }

  async function getSavedKeys() {
    const r = await chrome.storage.local.get([storageKey]);
    return Array.isArray(r[storageKey]) ? r[storageKey] : [];
  }

  async function render() {
    const keys = await getSavedKeys();
    const { keyState = {} } = await chrome.storage.local.get(['keyState']);

    if (!keys.length) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';
    list.innerHTML = '';

    const now = Date.now();
    keys.forEach((key, i) => {
      const state = keyState[key] || {};
      const row = document.createElement('div');
      row.className = 'key-status-row';

      let badge = '<span class="badge badge-ok">ready</span>';
      if (state.invalid) {
        badge = '<span class="badge badge-bad">invalid</span>';
      } else if (state.exhaustedUntil && state.exhaustedUntil > now) {
        badge = `<span class="badge badge-warn">quota — ${fmtTimeRemaining(state.exhaustedUntil - now)}</span>`;
      } else {
        // Some models on this key are rate-limited, but the key still works with another
        const waits = Object.values(state.modelLimits || {}).filter(t => t > now);
        if (waits.length) {
          badge = `<span class="badge badge-warn">partly limited — ${fmtTimeRemaining(Math.min(...waits) - now)}</span>`;
        }
      }

      row.innerHTML = `
        <span class="key-index">#${i + 1}</span>
        <span class="key-mask"></span>
        <button class="key-copy-btn" type="button" title="Copy full key">Copy</button>
        ${badge}
        <button class="key-remove-btn" type="button" title="Remove this key">Remove</button>
      `;
      row.querySelector('.key-mask').textContent = maskKey(key);
      row.querySelector('.key-remove-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove ${name} key #${i + 1} (${maskKey(key)})?`)) return;
        await removeKey(key);
      });
      const copyBtn = row.querySelector('.key-copy-btn');
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(key);
          const prev = copyBtn.textContent;
          copyBtn.textContent = 'Copied';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = prev;
            copyBtn.classList.remove('copied');
          }, 1200);
        } catch (err) {
          copyBtn.textContent = 'Failed';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
        }
      });
      list.appendChild(row);
    });
  }

  async function removeKey(key) {
    const keys = (await getSavedKeys()).filter(k => k !== key);
    const { keyState = {} } = await chrome.storage.local.get(['keyState']);
    delete keyState[key];
    await chrome.storage.local.set({ [storageKey]: keys, keyState });
    setStatus(keys.length);
    await render();
  }

  async function load() {
    const r = await chrome.storage.local.get([storageKey, legacyKey]);
    let keys = r[storageKey];
    // Migrate old single-key storage
    if (!Array.isArray(keys) && r[legacyKey]) {
      keys = [r[legacyKey]];
      await chrome.storage.local.set({ [storageKey]: keys });
      await chrome.storage.local.remove(legacyKey);
    }
    keys = Array.isArray(keys) ? keys : [];
    setStatus(keys.length);
    // Don't pre-fill the textarea (security), but show count via status
    await render();
  }

  document.addEventListener('DOMContentLoaded', load);

  input.addEventListener('input', async () => {
    const typed = parseKeys(input.value);
    const saved = await getSavedKeys();
    const fresh = [...new Set(typed)].filter(k => !saved.includes(k));
    if (!input.value.trim()) {
      setStatus(saved.length);
    } else {
      statusEl.textContent = `${saved.length} saved + ${fresh.length} new`;
      statusEl.className = fresh.length || saved.length ? 'api-status connected' : 'api-status disconnected';
    }
  });

  function resetSaveBtn() {
    setTimeout(() => {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add Keys';
    }, 1800);
  }

  saveBtn.addEventListener('click', async () => {
    const typed = [...new Set(parseKeys(input.value))];
    if (!typed.length) {
      alert(`Please paste at least one valid ${name} API key (one per line).`);
      return;
    }

    // Warn if any keys do not start with the usual prefix
    const odd = typed.filter(k => !k.startsWith(prefix));
    if (odd.length) {
      if (!confirm(`${odd.length} key(s) do not start with "${prefix}". Save anyway?`)) return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      // Add to the existing keys instead of replacing them
      const saved = await getSavedKeys();
      const fresh = typed.filter(k => !saved.includes(k));
      const keys = [...saved, ...fresh];
      // Keep rotation state of existing keys; new keys start clean
      await chrome.storage.local.set({ [storageKey]: keys });
      setStatus(keys.length);
      const dupes = typed.length - fresh.length;
      saveBtn.textContent = fresh.length
        ? `Added ${fresh.length} key${fresh.length === 1 ? '' : 's'}${dupes ? ` (${dupes} already saved)` : ''}`
        : 'Already saved';
      input.value = '';
      await render();
      resetSaveBtn();
    } catch (e) {
      saveBtn.textContent = 'Error';
      resetSaveBtn();
    }
  });

  resetBtn.addEventListener('click', async () => {
    // Clear the state of this provider's keys only
    const keys = await getSavedKeys();
    const { keyState = {} } = await chrome.storage.local.get(['keyState']);
    keys.forEach(k => { delete keyState[k]; });
    await chrome.storage.local.set({ keyState });
    await render();
    resetBtn.textContent = 'Reset done';
    setTimeout(() => { resetBtn.textContent = 'Reset rotation state'; }, 1500);
  });

  // Refresh when the background marks a key (quota / invalid) and every 30s for the countdown
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.keyState || changes[storageKey])) render();
  });
  setInterval(render, 30000);
}

setupKeyManager({
  name: 'Gemini',
  storageKey: 'geminiApiKeys',
  legacyKey: 'geminiApiKey',
  prefix: 'AIza',
  ids: {
    input: 'apiKeys', save: 'saveBtn', reset: 'resetBtn',
    status: 'apiStatus', section: 'keyStatusSection', list: 'keyStatusList'
  }
});

// Paid; before or after Gemini depending on the "Use DeepSeek first" switch
setupKeyManager({
  name: 'DeepSeek',
  storageKey: 'deepseekApiKeys',
  legacyKey: 'deepseekApiKey',
  prefix: 'sk-',
  ids: {
    input: 'deepseekKeys', save: 'saveDeepseekBtn', reset: 'resetDeepseekBtn',
    status: 'deepseekStatus', section: 'deepseekStatusSection', list: 'deepseekStatusList'
  }
});

const deepseekFirstBox = document.getElementById('deepseekFirst');
document.addEventListener('DOMContentLoaded', async () => {
  const { deepseekFirst } = await chrome.storage.local.get(['deepseekFirst']);
  deepseekFirstBox.checked = deepseekFirst !== false;
});
deepseekFirstBox.addEventListener('change', () => {
  chrome.storage.local.set({ deepseekFirst: deepseekFirstBox.checked });
});

// Fallback after Gemini, before OpenRouter
setupKeyManager({
  name: 'Groq',
  storageKey: 'groqApiKeys',
  legacyKey: 'groqApiKey',
  prefix: 'gsk_',
  ids: {
    input: 'groqKeys', save: 'saveGroqBtn', reset: 'resetGroqBtn',
    status: 'groqStatus', section: 'groqStatusSection', list: 'groqStatusList'
  }
});

// ---- Reply suffixes (multi, round-robin) ----
const suffixInput = document.getElementById('replySuffix');
const suffixStatus = document.getElementById('suffixStatus');
const saveSuffixBtn = document.getElementById('saveSuffixBtn');
const resetSuffixBtn = document.getElementById('resetSuffixBtn');
const clearSuffixBtn = document.getElementById('clearSuffixBtn');

function parseSuffixes(raw) {
  return raw.split(/\r?\n/).map(s => s.replace(/\s+$/, '')).filter(s => s.length > 0);
}

function setSuffixStatus(list, idx) {
  if (list && list.length) {
    const next = list[idx % list.length] || '';
    const preview = next.length > 24 ? next.slice(0, 24) + '…' : next;
    suffixStatus.textContent = `${list.length} suffix${list.length === 1 ? '' : 'es'} — next: "${preview}"`;
    suffixStatus.className = 'api-status connected';
  } else {
    suffixStatus.textContent = 'No suffix set';
    suffixStatus.className = 'api-status disconnected';
  }
}

async function loadSuffix() {
  const r = await chrome.storage.local.get(['replySuffixes', 'replySuffix', 'suffixRotationIdx']);
  let list = Array.isArray(r.replySuffixes) ? r.replySuffixes : null;
  // Migrate old single-string format
  if (!list && typeof r.replySuffix === 'string' && r.replySuffix.length) {
    list = [r.replySuffix];
    await chrome.storage.local.set({ replySuffixes: list });
    await chrome.storage.local.remove('replySuffix');
  }
  list = list || [];
  const idx = Number.isInteger(r.suffixRotationIdx) ? r.suffixRotationIdx : 0;
  suffixInput.value = list.join('\n');
  setSuffixStatus(list, idx);
}

document.addEventListener('DOMContentLoaded', loadSuffix);

saveSuffixBtn.addEventListener('click', async () => {
  const list = parseSuffixes(suffixInput.value);
  saveSuffixBtn.disabled = true;
  try {
    if (list.length) {
      await chrome.storage.local.set({ replySuffixes: list, suffixRotationIdx: 0 });
    } else {
      await chrome.storage.local.remove(['replySuffixes', 'suffixRotationIdx']);
    }
    await chrome.storage.local.remove('replySuffix'); // clean legacy
    setSuffixStatus(list, 0);
    saveSuffixBtn.textContent = list.length ? `Saved ${list.length}` : 'Cleared';
    setTimeout(() => {
      saveSuffixBtn.disabled = false;
      saveSuffixBtn.textContent = 'Save Suffixes';
    }, 1500);
  } catch (e) {
    saveSuffixBtn.textContent = 'Error';
    setTimeout(() => {
      saveSuffixBtn.disabled = false;
      saveSuffixBtn.textContent = 'Save Suffixes';
    }, 1500);
  }
});

resetSuffixBtn.addEventListener('click', async () => {
  const { replySuffixes = [] } = await chrome.storage.local.get(['replySuffixes']);
  await chrome.storage.local.set({ suffixRotationIdx: 0 });
  setSuffixStatus(replySuffixes, 0);
  resetSuffixBtn.textContent = 'Reset!';
  setTimeout(() => { resetSuffixBtn.textContent = 'Reset rotation'; }, 1200);
});

clearSuffixBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['replySuffixes', 'replySuffix', 'suffixRotationIdx']);
  suffixInput.value = '';
  setSuffixStatus([], 0);
  clearSuffixBtn.textContent = 'Cleared';
  setTimeout(() => { clearSuffixBtn.textContent = 'Clear'; }, 1200);
});

// ---- Reply speed (which Gemini model goes first) ----
const speedRadios = document.querySelectorAll('input[name="replySpeed"]');

async function loadSpeed() {
  const { replySpeed = 'fast' } = await chrome.storage.local.get(['replySpeed']);
  speedRadios.forEach(r => { r.checked = r.value === replySpeed; });
}

document.addEventListener('DOMContentLoaded', loadSpeed);

speedRadios.forEach(r => r.addEventListener('change', () => {
  if (r.checked) chrome.storage.local.set({ replySpeed: r.value });
}));

// ---- My reply style (examples of the user's own replies) ----
const styleInput = document.getElementById('styleExamples');
const styleStatus = document.getElementById('styleStatus');
const saveStyleBtn = document.getElementById('saveStyleBtn');
const MAX_STYLE_EXAMPLES = 15;

function parseStyle(raw) {
  return [...new Set(raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 1))];
}

function setStyleStatus(count, saved = true) {
  if (count) {
    const extra = count > MAX_STYLE_EXAMPLES ? ` (first ${MAX_STYLE_EXAMPLES} used)` : '';
    styleStatus.textContent = `${count} example${count === 1 ? '' : 's'}${saved ? ' saved' : ''}${extra}`;
    styleStatus.className = 'api-status connected';
  } else {
    styleStatus.textContent = 'No examples';
    styleStatus.className = 'api-status disconnected';
  }
}

async function loadStyle() {
  const { styleExamples = [] } = await chrome.storage.local.get(['styleExamples']);
  styleInput.value = styleExamples.join('\n');
  setStyleStatus(styleExamples.length);
}

document.addEventListener('DOMContentLoaded', loadStyle);

styleInput.addEventListener('input', () => setStyleStatus(parseStyle(styleInput.value).length, false));

saveStyleBtn.addEventListener('click', async () => {
  const list = parseStyle(styleInput.value).slice(0, MAX_STYLE_EXAMPLES);
  saveStyleBtn.disabled = true;
  try {
    if (list.length) await chrome.storage.local.set({ styleExamples: list });
    else await chrome.storage.local.remove('styleExamples');
    styleInput.value = list.join('\n');
    setStyleStatus(list.length);
    saveStyleBtn.textContent = list.length ? `Saved ${list.length}` : 'Cleared';
  } catch (e) {
    saveStyleBtn.textContent = 'Error';
  }
  setTimeout(() => {
    saveStyleBtn.disabled = false;
    saveStyleBtn.textContent = 'Save Style';
  }, 1500);
});

// ---- OpenRouter fallback ----
const orInput = document.getElementById('openrouterKey');
const orStatus = document.getElementById('orStatus');
const saveOrBtn = document.getElementById('saveOrBtn');

function setOrStatus(configured) {
  if (configured) {
    orStatus.textContent = 'OpenRouter configured';
    orStatus.className = 'api-status connected';
  } else {
    orStatus.textContent = 'Not configured';
    orStatus.className = 'api-status disconnected';
  }
}

async function loadOrKey() {
  const r = await chrome.storage.local.get(['openrouterApiKey']);
  setOrStatus(!!r.openrouterApiKey);
}

document.addEventListener('DOMContentLoaded', loadOrKey);

orInput.addEventListener('input', () => {
  setOrStatus(orInput.value.trim().length > 20);
});

saveOrBtn.addEventListener('click', async () => {
  const key = orInput.value.trim();
  if (!key) {
    // Allow clearing
    await chrome.storage.local.remove('openrouterApiKey');
    setOrStatus(false);
    saveOrBtn.textContent = 'Cleared';
    setTimeout(() => { saveOrBtn.textContent = 'Save OpenRouter Key'; }, 1500);
    return;
  }
  if (key.length < 20) {
    alert('Please enter a valid OpenRouter API key (starts with "sk-or-").');
    return;
  }
  if (!key.startsWith('sk-or-')) {
    if (!confirm('OpenRouter keys usually start with "sk-or-". Save anyway?')) return;
  }
  saveOrBtn.disabled = true;
  saveOrBtn.textContent = 'Saving...';
  try {
    await chrome.storage.local.set({ openrouterApiKey: key });
    setOrStatus(true);
    saveOrBtn.textContent = 'Saved!';
    orInput.value = '';
    setTimeout(() => {
      saveOrBtn.disabled = false;
      saveOrBtn.textContent = 'Save OpenRouter Key';
    }, 1500);
  } catch (e) {
    saveOrBtn.textContent = 'Error';
    setTimeout(() => {
      saveOrBtn.disabled = false;
      saveOrBtn.textContent = 'Save OpenRouter Key';
    }, 1500);
  }
});

