/*! Mkuu helper bubble for Neckrone8x sites (Stories, 8X Weather).
 *  A small chat that talks to the Mkuu AI server. No libraries. Everything that
 *  comes from the AI or from a story is inserted as TEXT, never as HTML.
 *
 *  Configure with data- attributes on the <script> tag (all optional):
 *    data-api            Mkuu server address
 *    data-site           "stories" (default) or "weather"
 *    data-story          story slug (stories site)
 *    data-subtitle       text under the "Mkuu" title
 *    data-placeholder    input placeholder
 *    data-welcome        first message
 *    data-chips          suggestion buttons, separated by |
 *    data-link-origins   other sites story cards may link to, separated by space
 *  A page can define window.MkuuHelperContext = function () { return "text"; }
 *  to send live page context (e.g. the current weather) with every message,
 *  and window.MkuuHelperNotice = function () { return {id, text} or null; }
 *  for a one-time "heads up" (e.g. an active alert): a dot appears on the
 *  button, and the note shows when the bubble opens. The page fires
 *  window "mkuu:context-changed" when either may have changed. */
(function (root) {
  'use strict';

  var DEFAULT_API = 'https://mkuu.neckrone8x.co.ke';
  var MAX_CHARS = 500;
  var MAX_CONTEXT = 2000;
  var SID_KEY = 'mkuu_helper_sid';
  var NOTICE_KEY = 'mkuu_helper_notices';

  var ICONS = {
    spark: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2zm7 11l.9 2.6 2.6.9-2.6.9L19 20l-.9-2.6-2.6-.9 2.6-.9L19 13zM5 14l.7 1.9 1.9.7-1.9.7L5 19.2l-.7-1.9-1.9-.7 1.9-.7L5 14z"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.4 20.4l17.5-7.5a1 1 0 000-1.8L3.4 3.6a1 1 0 00-1.4 1.2l2 6.2 9 1-9 1-2 6.2a1 1 0 001.4 1.2z"/></svg>',
    reset: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 10-2.3 5.7M20 4v7h-7"/></svg>',
    alert: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2.5c.5 0 1 .27 1.27.75l9.5 16.5A1.47 1.47 0 0121.5 22h-19a1.47 1.47 0 01-1.27-2.25l9.5-16.5c.27-.48.77-.75 1.27-.75zm0 6.25a1.1 1.1 0 00-1.1 1.17l.35 5.03a.75.75 0 001.5 0l.35-5.03A1.1 1.1 0 0012 8.75zm0 8.25a1.25 1.25 0 100 2.5 1.25 1.25 0 000-2.5z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M7 17L17 7M8 7h9v9"/></svg>'
  };

  // ───────────── small pure helpers (also used by the tests) ─────────────

  /** Only links that stay on THIS site are ever shown as story cards. */
  function sameSite(url, origin) {
    if (!/^https?:\/\//i.test(String(url || ''))) return false;   // a full address is required
    try {
      var u = new URL(String(url), origin);
      return u.origin === origin && (u.protocol === 'https:' || u.protocol === 'http:');
    } catch (e) {
      return false;
    }
  }

  /** Splits a stream into complete events and the unfinished rest. */
  function parseSSE(buffer) {
    var text = buffer.replace(/\r\n/g, '\n');
    var events = [], rest = text, at;
    while ((at = rest.indexOf('\n\n')) >= 0) {
      var block = rest.slice(0, at).trim();
      rest = rest.slice(at + 2);
      if (block.indexOf('data:') !== 0) continue;
      var payload = block.slice(5).trim();
      if (!payload) continue;
      try { events.push(JSON.parse(payload)); } catch (e) { /* skip a broken event */ }
    }
    return { events: events, rest: rest };
  }

  /** Puts text into a node: line breaks and **bold** only, all as text. */
  function renderText(doc, node, text) {
    node.textContent = '';
    String(text).split('\n').forEach(function (line, i) {
      if (i) node.appendChild(doc.createElement('br'));
      var re = /\*\*(.+?)\*\*/g, last = 0, m;
      while ((m = re.exec(line))) {
        if (m.index > last) node.appendChild(doc.createTextNode(line.slice(last, m.index)));
        var b = doc.createElement('strong');
        b.textContent = m[1];
        node.appendChild(b);
        last = m.index + m[0].length;
      }
      if (last < line.length) node.appendChild(doc.createTextNode(line.slice(last)));
    });
  }

  function shorten(text, n) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…';
  }

  function friendly(status, detail) {
    if ((status === 429 || status === 503) && typeof detail === 'string' && detail && detail.length < 160) return detail;
    if (status === 429) return 'You are sending messages too fast. Please wait a minute.';
    if (status === 503) return 'Mkuu has reached its limit for today. Please try again tomorrow.';
    return 'Mkuu is having trouble right now. Please try again in a moment.';
  }

  // ───────────── the widget ─────────────

  function init(opts) {
    opts = opts || {};
    var doc = opts.document || root.document;
    var win = opts.window || root;
    var api = String(opts.api || DEFAULT_API).replace(/\/+$/, '');
    var story = opts.story || '';
    var site = opts.site || 'stories';
    var origin = opts.origin || (win.location && win.location.origin) || '';
    var linkOrigins = [origin].concat(opts.linkOrigins || []);
    var getContext = opts.getContext || function () {
      return typeof win.MkuuHelperContext === 'function' ? win.MkuuHelperContext() : '';
    };
    var getNotice = opts.getNotice || function () {
      return typeof win.MkuuHelperNotice === 'function' ? win.MkuuHelperNotice() : null;
    };
    var subtitle = opts.subtitle || (story ? 'Helping with this story' : 'Stories helper');
    var placeholder = opts.placeholder || (story ? 'Ask about this story…' : 'Ask Mkuu…');
    var welcomeText = opts.welcome || (story
      ? 'Niaje! I am Mkuu. Ask me about this story: a short summary, what a word means, or something similar to read.'
      : 'Niaje! I am Mkuu. Ask me to recommend a story, or ask how the site works.');
    var chipList = (opts.chips && opts.chips.length) ? opts.chips : (story
      ? ['Summarize this story', 'What do the slang words mean?', 'Recommend a story like this']
      : ['Recommend a story about love', 'Any confessions?', 'How do I share my story?']);
    var fetchFn = opts.fetch || win.fetch.bind(win);
    var store = opts.storage;
    if (!store) { try { store = win.sessionStorage; } catch (e) { store = null; } }
    var raf = opts.raf || win.requestAnimationFrame || function (f) { return setTimeout(f, 16); };

    var sid = '';
    try { sid = (store && store.getItem(SID_KEY)) || ''; } catch (e) { sid = ''; }
    var busy = false, lastSend = 0;
    var shownNotices = [], pendingNotice = null;
    try { shownNotices = JSON.parse((store && store.getItem(NOTICE_KEY)) || '[]') || []; } catch (e) { shownNotices = []; }
    if (!Array.isArray(shownNotices)) shownNotices = [];

    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function icon(name, into) { into.innerHTML = ICONS[name]; return into; }

    // --- build the bubble ---
    var rootEl = el('div', 'mkh-root');
    var fab = icon('spark', el('button', 'mkh-fab'));
    var dot = el('span', 'mkh-dot');
    dot.hidden = true;
    fab.appendChild(dot);
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Ask Mkuu');
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-controls', 'mkh-panel');

    var panel = el('section', 'mkh-panel');
    panel.id = 'mkh-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Mkuu, ' + subtitle);
    panel.hidden = true;

    var head = el('header', 'mkh-head');
    var avatar = icon('spark', el('span', 'mkh-avatar'));
    var title = el('div', 'mkh-title');
    title.appendChild(el('strong', '', 'Mkuu'));
    title.appendChild(el('small', '', subtitle));
    var resetBtn = icon('reset', el('button', 'mkh-iconbtn'));
    resetBtn.type = 'button'; resetBtn.setAttribute('aria-label', 'Start a new chat');
    var closeBtn = icon('close', el('button', 'mkh-iconbtn'));
    closeBtn.type = 'button'; closeBtn.setAttribute('aria-label', 'Close');
    [avatar, title, resetBtn, closeBtn].forEach(function (n) { head.appendChild(n); });

    var log = el('div', 'mkh-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');

    var chips = el('div', 'mkh-chips');
    var form = el('form', 'mkh-form');
    var input = el('input', 'mkh-input');
    input.type = 'text';
    input.maxLength = MAX_CHARS;
    input.autocomplete = 'off';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', 'Your message to Mkuu');
    var sendBtn = icon('send', el('button', 'mkh-send'));
    sendBtn.type = 'submit'; sendBtn.setAttribute('aria-label', 'Send');
    form.appendChild(input); form.appendChild(sendBtn);
    var note = el('p', 'mkh-note', 'Mkuu is an AI and can make mistakes. Please do not share personal details.');

    [head, log, chips, form, note].forEach(function (n) { panel.appendChild(n); });
    rootEl.appendChild(panel); rootEl.appendChild(fab);
    doc.body.appendChild(rootEl);

    // --- messages ---
    function scrollDown() { log.scrollTop = log.scrollHeight; }

    function addMsg(who, text) {
      var m = el('div', 'mkh-msg mkh-' + who);
      if (text) renderText(doc, m, text);
      log.appendChild(m);
      scrollDown();
      return m;
    }

    function typing(m) {
      m.textContent = '';
      var dots = el('span', 'mkh-typing');
      for (var i = 0; i < 3; i++) dots.appendChild(el('i'));
      m.appendChild(dots);
    }

    function addCards(container, stories) {
      var shown = 0;
      (stories || []).forEach(function (s) {
        if (shown >= 3 || !s || !s.title) return;
        if (!linkOrigins.some(function (o) { return o && sameSite(s.url, o); })) return;
        shown++;
        var a = el('a', 'mkh-card');
        a.href = String(s.url);
        a.appendChild(el('span', 'mkh-cardtag', String(s.category || 'Story')));
        a.appendChild(el('span', 'mkh-cardtitle', String(s.title)));
        if (s.excerpt) a.appendChild(el('span', 'mkh-cardtext', shorten(s.excerpt, 130)));
        var cta = el('span', 'mkh-cardcta', 'Read full story ');
        var ar = icon('arrow', el('span', 'mkh-cardarrow'));
        cta.appendChild(ar);
        a.appendChild(cta);
        container.appendChild(a);
      });
      scrollDown();
    }

    function welcome() {
      log.textContent = '';
      addMsg('bot', welcomeText);
    }

    function setChips() {
      chips.textContent = '';
      chipList.forEach(function (label) {
        var b = el('button', 'mkh-chipbtn', label);
        b.type = 'button';
        b.addEventListener('click', function () { send(label); });
        chips.appendChild(b);
      });
    }

    function setBusy(v) {
      busy = v;
      sendBtn.disabled = v;
      input.disabled = v;
      rootEl.setAttribute('data-busy', v ? 'true' : 'false');
    }

    // --- one-time notice (e.g. an active alert) ---
    function noticeSeen(id) { return shownNotices.indexOf(id) >= 0; }

    function showNotice(n) {
      var m = el('div', 'mkh-msg mkh-bot mkh-notice');
      m.setAttribute('role', 'status');
      m.appendChild(icon('alert', el('span', 'mkh-noticeicon')));
      var body = el('span', 'mkh-noticetext');
      renderText(doc, body, n.text);
      m.appendChild(body);
      log.appendChild(m);
      scrollDown();
      shownNotices.push(n.id);
      shownNotices = shownNotices.slice(-20);
      try { if (store) store.setItem(NOTICE_KEY, JSON.stringify(shownNotices)); } catch (e) { /* private mode */ }
      pendingNotice = null;
      setDot(false);
    }

    function setDot(on) {
      dot.hidden = !on;
      fab.setAttribute('aria-label', on ? 'Ask Mkuu (1 new alert)' : 'Ask Mkuu');
    }

    function checkNotice() {
      var n = null;
      try { n = getNotice(); } catch (e) { n = null; }
      if (!n || !n.id || !n.text || noticeSeen(String(n.id))) {
        pendingNotice = null;
        setDot(false);
        return;
      }
      pendingNotice = { id: String(n.id), text: String(n.text).slice(0, 600) };
      if (!panel.hidden) showNotice(pendingNotice);
      else setDot(true);
    }

    // --- sending ---
    function readStream(res, bubble, onFirst) {
      var reader = res.body.getReader();
      var decoder = new (win.TextDecoder || TextDecoder)('utf-8');
      var buffer = '', answer = '', stories = null, gotAny = false, pending = false;

      function paint() {
        pending = false;
        renderText(doc, bubble, answer);
        scrollDown();
      }
      function handle(ev) {
        if (ev.meta && ev.meta.session_id) {
          sid = String(ev.meta.session_id);
          try { if (store) store.setItem(SID_KEY, sid); } catch (e) { /* private mode */ }
        }
        if (typeof ev.token === 'string') {
          if (!gotAny) { gotAny = true; bubble.textContent = ''; if (onFirst) onFirst(); }
          answer += ev.token;
          if (!pending) { pending = true; raf(paint); }
        }
        if (ev.error) {
          answer = 'Mkuu could not answer that. Please try again.';
          gotAny = true;
        }
        if (ev.done && Array.isArray(ev.stories)) stories = ev.stories;
      }
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buffer += decoder.decode(r.value, { stream: true });
          var out = parseSSE(buffer);
          buffer = out.rest;
          out.events.forEach(handle);
          return pump();
        });
      }
      return pump().then(function () {
        paint();
        if (!answer.trim() && !stories) renderText(doc, bubble, 'I got an empty reply. Please try again.');
        if (stories) addCards(bubble, stories);
      });
    }

    function send(text) {
      text = String(text || '').trim().slice(0, MAX_CHARS);
      var now = Date.now();
      if (!text || busy || now - lastSend < 1000) return Promise.resolve();
      lastSend = now;
      addMsg('user', text);
      var bubble = addMsg('bot', '');
      typing(bubble);
      setBusy(true);
      input.value = '';

      var controller = (win.AbortController || root.AbortController) ? new (win.AbortController || root.AbortController)() : null;
      var started = false;
      var killTimer = setTimeout(function () { if (controller) controller.abort(); }, 90000);
      var wakeTimer = setTimeout(function () {
        if (!started) renderText(doc, bubble, 'Mkuu is waking up, one moment…');
      }, 6000);

      var body = { message: text, mode: 'auto', site: site };
      if (story) body.story = story;
      var context = '';
      try { context = String(getContext() || '').trim(); } catch (e) { context = ''; }
      if (context) body.context = context.slice(0, MAX_CONTEXT);
      if (sid) body.session_id = sid;

      return fetchFn(api + '/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify(body),
        signal: controller ? controller.signal : undefined
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) {
            renderText(doc, bubble, friendly(res.status, j && j.detail));
          });
        }
        return readStream(res, bubble, function () { started = true; });
      }).catch(function () {
        renderText(doc, bubble, 'I cannot reach Mkuu right now. Please check your internet and try again.');
      }).then(function () {
        clearTimeout(killTimer); clearTimeout(wakeTimer);
        setBusy(false);
        try { input.focus(); } catch (e) { /* ignore */ }
      });
    }

    // --- open / close ---
    function setOpen(open) {
      panel.hidden = !open;
      rootEl.setAttribute('data-open', open ? 'true' : 'false');
      fab.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        if (pendingNotice) showNotice(pendingNotice);
        scrollDown();
        try { input.focus(); } catch (e) { /* ignore */ }
      }
    }

    fab.addEventListener('click', function () { setOpen(panel.hidden); });
    closeBtn.addEventListener('click', function () { setOpen(false); try { fab.focus(); } catch (e) { /* ignore */ } });
    resetBtn.addEventListener('click', function () {
      if (busy) return;
      sid = '';
      try { if (store) store.removeItem(SID_KEY); } catch (e) { /* ignore */ }
      welcome();
    });
    form.addEventListener('submit', function (e) { if (e && e.preventDefault) e.preventDefault(); send(input.value); });
    doc.addEventListener('keydown', function (e) { if (e && e.key === 'Escape' && !panel.hidden) setOpen(false); });

    welcome();
    setChips();
    checkNotice();
    if (win.addEventListener) win.addEventListener('mkuu:context-changed', checkNotice);

    return { send: send, open: function () { setOpen(true); }, close: function () { setOpen(false); }, panel: panel, log: log, input: input, form: form, fab: fab, chips: chips,
             sessionId: function () { return sid; }, checkNotice: checkNotice, dot: dot };
  }

  var api = { init: init, sameSite: sameSite, parseSSE: parseSSE, renderText: renderText, shorten: shorten, friendly: friendly };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  if (root.document && !root.__MKUU_HELPER_TEST && !root.__mkuuHelperLoaded) {
    root.__mkuuHelperLoaded = true;
    var script = root.document.currentScript || root.document.querySelector('script[data-api]');
    var attr = function (name) { return (script && script.getAttribute('data-' + name)) || ''; };
    var start = function () {
      init({
        api: attr('api'),
        story: attr('story'),
        site: attr('site'),
        subtitle: attr('subtitle'),
        placeholder: attr('placeholder'),
        welcome: attr('welcome'),
        chips: attr('chips') ? attr('chips').split('|').map(function (c) { return c.trim(); }).filter(Boolean) : null,
        linkOrigins: attr('link-origins') ? attr('link-origins').split(/\s+/).filter(Boolean) : null
      });
    };
    if (root.document.body) start();
    else root.document.addEventListener('DOMContentLoaded', start);
  }
})(typeof window !== 'undefined' ? window : globalThis);
