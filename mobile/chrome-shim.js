// vibeReply - stand-in for the chrome.* APIs, so the extension's own code
// (background.js and popup.js) runs unchanged in the phone web app.
// Does nothing inside the real extension, where chrome.storage exists.
(function () {
  if (window.chrome && window.chrome.storage && window.chrome.storage.local) return;

  const PREFIX = 'vibeReply:';
  const changeListeners = [];

  const read = key => {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v == null ? undefined : JSON.parse(v);
    } catch (_) { return undefined; }
  };
  const allKeys = () => Object.keys(localStorage)
    .filter(k => k.startsWith(PREFIX))
    .map(k => k.slice(PREFIX.length));
  const fire = changes => {
    if (!Object.keys(changes).length) return;
    changeListeners.forEach(fn => { try { fn(changes, 'local'); } catch (e) { console.error(e); } });
  };

  const local = {
    async get(keys) {
      let names; let defaults = {};
      if (keys == null) names = allKeys();
      else if (typeof keys === 'string') names = [keys];
      else if (Array.isArray(keys)) names = keys;
      else { defaults = keys; names = Object.keys(keys); }
      const out = {};
      names.forEach(k => {
        const v = read(k);
        if (v !== undefined) out[k] = v;
        else if (k in defaults) out[k] = defaults[k];
      });
      return out;
    },
    async set(items) {
      const changes = {};
      Object.entries(items || {}).forEach(([k, v]) => {
        const oldValue = read(k);
        localStorage.setItem(PREFIX + k, JSON.stringify(v));
        changes[k] = { oldValue, newValue: v };
      });
      fire(changes);
    },
    async remove(keys) {
      const changes = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(k => {
        const oldValue = read(k);
        if (oldValue === undefined) return;
        localStorage.removeItem(PREFIX + k);
        changes[k] = { oldValue };
      });
      fire(changes);
    }
  };

  // Changes made in another page (the settings screen) show up here too
  window.addEventListener('storage', e => {
    if (e.storageArea !== localStorage || !e.key || !e.key.startsWith(PREFIX)) return;
    const parse = s => { try { return s == null ? undefined : JSON.parse(s); } catch (_) { return undefined; } };
    fire({ [e.key.slice(PREFIX.length)]: { oldValue: parse(e.oldValue), newValue: parse(e.newValue) } });
  });

  // Messages: the app talks to background.js in the same page
  const messageListeners = [];
  const tabListeners = [];
  const FAKE_SENDER = { tab: { id: 1 } };

  const chromeObj = window.chrome || {};
  chromeObj.storage = { local, onChanged: { addListener: fn => changeListeners.push(fn) } };
  chromeObj.runtime = {
    onMessage: { addListener: fn => messageListeners.push(fn) },
    sendMessage(msg) {
      return new Promise(resolve => {
        let answered = false;
        const reply = r => { if (!answered) { answered = true; resolve(r); } };
        messageListeners.forEach(fn => {
          try { fn(msg, FAKE_SENDER, reply); } catch (e) { console.error(e); }
        });
      });
    }
  };
  // background.js sends progress lines with chrome.tabs.sendMessage
  chromeObj.tabs = {
    async sendMessage(tabId, msg) {
      tabListeners.forEach(fn => { try { fn(msg); } catch (e) { console.error(e); } });
    }
  };
  window.chrome = chromeObj;
  window.vibeShim = { onTabMessage: fn => tabListeners.push(fn) };
})();
