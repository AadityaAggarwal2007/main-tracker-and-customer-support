(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var SITE_KEY = script.getAttribute('data-site-key');
  var SERVER_URL = script.getAttribute('data-server') || script.src.replace('/widget.js', '');
  var ACCENT = script.getAttribute('data-color') || '#1a1a1a';
  var TITLE = script.getAttribute('data-title') || 'Chat with us';
  var GREETING = script.getAttribute('data-greeting') || 'Hi there!';
  var SUBTITLE = script.getAttribute('data-subtitle') || 'You can ask questions about shopping, sizing/dimensions, shipping, returns, or order status.';

  if (!SITE_KEY) { console.error('[ChatWidget] Missing data-site-key'); return; }

  var QUICK_ACTIONS = ['Track my order', 'Best-selling product recommendations', 'Shipping and delivery details'];
  var customActions = script.getAttribute('data-actions');
  if (customActions) { try { QUICK_ACTIONS = JSON.parse(customActions); } catch(e) {} }

  var state = {
    open: false, view: 'welcome', conversationId: null, visitorId: null,
    lastTs: null, pollTimer: null, typing: false, status: 'ai_handling',
    sending: false, phoneSaved: false, aiResponseCount: 0
  };

  try {
    state.visitorId = localStorage.getItem('_cw_vid') || generateId();
    localStorage.setItem('_cw_vid', state.visitorId);
    state.conversationId = localStorage.getItem('_cw_cid_' + SITE_KEY) || null;
    state.lastTs = localStorage.getItem('_cw_ts_' + SITE_KEY) || null;
    state.phoneSaved = !!(localStorage.getItem('_cw_phone_' + SITE_KEY));
  } catch (e) { state.visitorId = generateId(); }

  function generateId() { return 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  var css = [
    // Wrapped in :where() so the reset carries zero specificity. As `#_cw_root *`
    // it scored (1,0,0) and beat every `._cw_class` rule below, silently zeroing
    // their padding — which is why bubbles rendered with text flush to the edge.
    ':where(#_cw_root *) { box-sizing: border-box; margin: 0; padding: 0; }',
    '#_cw_root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }',

    '#_cw_btn {',
    '  position: fixed; bottom: 20px; right: 24px;',
    '  z-index: 999998; height: 48px; border-radius: 24px;',
    '  background: #fff; border: 1px solid rgba(0,0,0,0.08); cursor: pointer;',
    '  box-shadow: 0 1px 8px rgba(0,0,0,0.06), 0 4px 24px rgba(0,0,0,0.06);',
    '  display: flex; align-items: center; gap: 8px;',
    '  padding: 0 20px 0 16px;',
    '  transition: box-shadow 0.25s ease;',
    '}',
    '#_cw_btn:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.10), 0 8px 32px rgba(0,0,0,0.08); }',
    '#_cw_btn svg { width: 18px; height: 18px; fill: ' + ACCENT + '; flex-shrink: 0; opacity: 0.85; }',
    '#_cw_btn_label { font-size: 14px; font-weight: 500; color: #1a1a1a; white-space: nowrap; }',
    '#_cw_badge {',
    '  position: absolute; top: -5px; right: -5px;',
    '  background: #dc2626; color: white; font-size: 10px; font-weight: 600;',
    '  border-radius: 50%; width: 18px; height: 18px;',
    '  display: none; align-items: center; justify-content: center;',
    '  border: 2px solid #fff;',
    '}',

    '#_cw_panel {',
    '  position: fixed; bottom: 76px; right: 24px; transform: translateY(8px);',
    '  z-index: 999999;',
    '  width: 380px; max-width: calc(100vw - 24px);',
    '  max-height: calc(100vh - 100px);',
    '  background: #fff; border-radius: 20px;',
    '  box-shadow: 0 0 0 1px rgba(0,0,0,0.04), 0 8px 40px rgba(0,0,0,0.12), 0 20px 60px rgba(0,0,0,0.06);',
    '  display: flex; flex-direction: column;',
    '  opacity: 0; pointer-events: none;',
    '  transition: opacity 0.2s ease, transform 0.2s ease;',
    '  overflow: hidden;',
    '}',
    '#_cw_panel._cw_open { transform: translateY(0); opacity: 1; pointer-events: all; }',

    '#_cw_head {',
    '  background: ' + ACCENT + '; color: white; padding: 18px 20px 16px;',
    '  display: flex; align-items: center; gap: 11px; flex-shrink: 0;',
    '}',
    '#_cw_panel._cw_expanded { width: 560px; height: 90vh; }',
    '#_cw_head_dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; flex-shrink: 0; }',
    '#_cw_head_info { flex: 1; }',
    '#_cw_head_title { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }',
    '#_cw_head_status { font-size: 12px; opacity: 0.7; margin-top: 2px; }',
    '#_cw_expand, #_cw_close {',
    '  background: rgba(255,255,255,0.1); border: none; cursor: pointer; color: white;',
    '  width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center;',
    '  opacity: 0.8; transition: opacity 0.15s, background 0.15s;',
    '}',
    '#_cw_expand:hover, #_cw_close:hover { opacity: 1; background: rgba(255,255,255,0.18); }',

    '#_cw_welcome {',
    '  padding: 18px 18px 14px; display: flex; flex-direction: column; gap: 10px;',
    '  overflow-y: auto; flex: 1;',
    '}',
    '#_cw_welcome_greeting { font-size: 18px; font-weight: 700; color: #111; letter-spacing: -0.02em; }',
    '#_cw_welcome_sub { font-size: 13px; color: #555; line-height: 1.5; }',
    '#_cw_disclaimer {',
    '  font-size: 11px; color: #999; line-height: 1.4;',
    '  padding: 8px 0 0; border-top: 1px solid #f0f0f0;',
    '}',
    '#_cw_disclaimer a { color: #888; text-decoration: underline; }',
    '#_cw_actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 2px; }',
    '._cw_action {',
    '  background: #fafafa; border: 1px solid #eaeaea; border-radius: 20px;',
    '  padding: 8px 14px; font-size: 13px; color: #333; cursor: pointer;',
    '  transition: all 0.15s ease; font-weight: 450; font-family: inherit;',
    '}',
    '._cw_action:hover { background: #f0f0f0; border-color: #ddd; }',
    '#_cw_welcome_input_wrap {',
    '  display: flex; gap: 8px; align-items: center;',
    '  border: 1.5px solid #e5e5e5; border-radius: 24px;',
    '  padding: 5px 5px 5px 16px; transition: border-color 0.2s;',
    '  margin-top: 4px;',
    '}',
    '#_cw_welcome_input_wrap:focus-within { border-color: #bbb; }',
    '#_cw_welcome_input {',
    '  flex: 1; border: none; outline: none; font-size: 14px;',
    '  background: transparent; color: #1a1a1a; font-family: inherit;',
    '}',
    '#_cw_welcome_input::placeholder { color: #aaa; }',
    '#_cw_welcome_send {',
    '  width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;',
    '  background: ' + ACCENT + '; border: none; cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: opacity 0.15s; opacity: 0.4;',
    '}',
    '#_cw_welcome_send:not(:disabled) { opacity: 1; }',
    '#_cw_welcome_send svg { width: 14px; height: 14px; fill: white; }',

    '#_cw_chat { display: none; flex-direction: column; flex: 1; min-height: 0; }',
    '#_cw_messages {',
    '  flex: 1; overflow-y: auto; padding: 20px 18px 16px; display: flex;',
    '  flex-direction: column; gap: 14px; scroll-behavior: smooth;',
    '}',
    '#_cw_messages::-webkit-scrollbar { width: 6px; }',
    '#_cw_messages::-webkit-scrollbar-track { background: transparent; }',
    '#_cw_messages::-webkit-scrollbar-thumb { background: #e3e3e3; border-radius: 3px; }',
    '#_cw_messages::-webkit-scrollbar-thumb:hover { background: #d0d0d0; }',
    '._cw_msg { max-width: 76%; display: flex; flex-direction: column; }',
    '._cw_msg._cw_visitor { align-self: flex-end; align-items: flex-end; }',
    '._cw_msg._cw_ai, ._cw_msg._cw_agent { align-self: flex-start; align-items: flex-start; }',
    // Consecutive messages from the same sender sit closer, so a burst reads as
    // one turn rather than several disconnected ones.
    '._cw_msg + ._cw_msg._cw_same { margin-top: -8px; }',
    '._cw_bubble {',
    '  padding: 13px 17px; border-radius: 20px; font-size: 14.5px; line-height: 1.6;',
    '  word-break: break-word; overflow-wrap: anywhere; white-space: pre-wrap;',
    '  letter-spacing: 0.005em;',
    '}',
    '._cw_visitor ._cw_bubble {',
    '  background: ' + ACCENT + '; color: #fff; border-bottom-right-radius: 7px;',
    '  box-shadow: 0 1px 2px rgba(0,0,0,0.12);',
    '}',
    '._cw_ai ._cw_bubble, ._cw_agent ._cw_bubble {',
    '  background: #f4f4f5; color: #18181b; border-bottom-left-radius: 7px;',
    '  box-shadow: 0 1px 2px rgba(0,0,0,0.04);',
    '}',
    '._cw_agent ._cw_bubble { border-left: 3px solid ' + ACCENT + '; }',
    '._cw_bubble a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }',
    '._cw_label { font-size: 11px; color: #8a8a8f; margin-bottom: 5px; padding: 0 6px; font-weight: 500; letter-spacing: 0.01em; }',
    '._cw_time { font-size: 10.5px; color: #b4b4b8; margin-top: 5px; padding: 0 6px; }',
    '#_cw_typing {',
    '  align-self: flex-start; padding: 14px 18px; background: #f4f4f5;',
    '  border-radius: 20px; border-bottom-left-radius: 7px;',
    '  display: none; align-items: center; gap: 5px;',
    '}',
    '._cw_dot { width: 5px; height: 5px; background: #bbb; border-radius: 50%; animation: _cw_bounce 1.2s infinite; }',
    '._cw_dot:nth-child(2) { animation-delay: 0.2s; }',
    '._cw_dot:nth-child(3) { animation-delay: 0.4s; }',
    '@keyframes _cw_bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-3px); } }',
    '#_cw_footer {',
    '  padding: 14px 16px 12px; border-top: 1px solid #f0f0f1;',
    '  display: flex; gap: 10px; align-items: flex-end; background: #fff;',
    '}',
    '#_cw_input {',
    '  flex: 1; border: 1.5px solid #e4e4e7; border-radius: 24px;',
    '  padding: 12px 18px; font-size: 14.5px; resize: none;',
    '  outline: none; max-height: 120px; min-height: 44px;',
    '  transition: border-color 0.18s, box-shadow 0.18s; line-height: 1.5; overflow-y: auto;',
    '  font-family: inherit; color: #18181b;',
    '}',
    '#_cw_input:focus { border-color: ' + ACCENT + '; box-shadow: 0 0 0 3px rgba(0,0,0,0.05); }',
    '#_cw_input::placeholder { color: #a1a1aa; }',
    '#_cw_send {',
    '  width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0;',
    '  background: ' + ACCENT + '; border: none; cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: opacity 0.15s, transform 0.15s; opacity: 0.35;',
    '}',
    '#_cw_send:not(:disabled) { opacity: 1; }',
    '#_cw_send:hover:not(:disabled) { filter: brightness(1.12); transform: scale(1.05); }',
    '#_cw_send:active:not(:disabled) { transform: scale(0.96); }',
    '#_cw_send svg { width: 16px; height: 16px; fill: white; }',
    '#_cw_powered { text-align: center; font-size: 10px; color: #d4d4d8; padding: 4px 0 12px; letter-spacing: 0.02em; }',

    '@media (max-width: 768px) {',
    '  #_cw_btn { bottom: 70px; right: 16px; }',
    '  #_cw_panel { bottom: 126px; right: 8px; width: calc(100vw - 16px); max-height: calc(100vh - 150px); border-radius: 16px; }',
    '}',

    '#_cw_save_banner { margin: 0 14px 10px; background: #f9fafb; border: 1px solid #efefef; border-radius: 12px; padding: 12px 14px; display: none; flex-direction: column; gap: 8px; flex-shrink: 0; }',
    '#_cw_save_title { font-size: 13px; font-weight: 600; color: #333; }',
    '#_cw_save_sub { font-size: 11px; color: #777; line-height: 1.4; }',
    '#_cw_save_row { display: flex; gap: 6px; }',
    '#_cw_save_ph { flex: 1; border: 1.5px solid #e5e5e5; border-radius: 20px; padding: 7px 12px; font-size: 13px; outline: none; font-family: inherit; color: #1a1a1a; }',
    '#_cw_save_ph:focus { border-color: #bbb; }',
    '#_cw_save_ph_btn { background: ' + ACCENT + '; color: white; border: none; border-radius: 20px; padding: 7px 14px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; white-space: nowrap; }',
    '#_cw_save_skip { font-size: 11px; color: #bbb; cursor: pointer; text-align: center; background: none; border: none; font-family: inherit; width: 100%; }',
    '#_cw_save_skip:hover { color: #888; }',

    '#_cw_resume_wrap { border-top: 1px solid #f0f0f0; padding-top: 10px; }',
    '#_cw_resume_toggle { background: none; border: none; font-size: 12px; color: #999; cursor: pointer; padding: 0; font-family: inherit; }',
    '#_cw_resume_toggle:hover { color: #555; text-decoration: underline; }',
    '#_cw_resume_form { margin-top: 8px; display: none; flex-direction: column; gap: 6px; }',
    '#_cw_resume_row { display: flex; gap: 6px; }',
    '#_cw_resume_ph { flex: 1; border: 1.5px solid #e5e5e5; border-radius: 20px; padding: 8px 12px; font-size: 13px; outline: none; font-family: inherit; color: #1a1a1a; }',
    '#_cw_resume_ph:focus { border-color: #bbb; }',
    '#_cw_resume_btn { background: ' + ACCENT + '; color: white; border: none; border-radius: 20px; padding: 8px 14px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; white-space: nowrap; }',
    '#_cw_resume_err { font-size: 11px; color: #e55; display: none; }'
  ].join('\n');

  var actionPills = QUICK_ACTIONS.map(function(a) {
    return '<button class="_cw_action">' + escapeHtml(a) + '</button>';
  }).join('');

  var SEND_ICON = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

  var root = document.createElement('div');
  root.id = '_cw_root';
  root.innerHTML = '<style>' + css + '</style>' +
    '<button id="_cw_btn" aria-label="Open chat">' +
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4C2.9 2 2 2.9 2 4v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>' +
      '<span id="_cw_btn_label">Chat</span>' +
      '<div id="_cw_badge"></div>' +
    '</button>' +
    '<div id="_cw_panel" role="dialog" aria-label="Chat">' +
      '<div id="_cw_head">' +
        '<div id="_cw_head_dot"></div>' +
        '<div id="_cw_head_info">' +
          '<div id="_cw_head_title">' + escapeHtml(TITLE) + '</div>' +
          '<div id="_cw_head_status">We typically reply in seconds</div>' +
        '</div>' +
        '<button id="_cw_expand" aria-label="Expand"><svg viewBox="0 0 24 24" width="14" height="14" fill="white"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg></button>' +
        '<button id="_cw_close" aria-label="Close"><svg viewBox="0 0 24 24" width="14" height="14" fill="white"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg></button>' +
      '</div>' +
      '<div id="_cw_welcome">' +
        '<div id="_cw_welcome_greeting">' + escapeHtml(GREETING) + '</div>' +
        '<div id="_cw_welcome_sub">' + escapeHtml(SUBTITLE) + '</div>' +
        '<div id="_cw_disclaimer">This chat is powered by AI and may make mistakes. Your messages are visible to the store. See <a href="#" target="_blank">privacy policy</a>.</div>' +
        '<div id="_cw_actions">' + actionPills + '</div>' +
        '<div id="_cw_resume_wrap">' +
          '<button id="_cw_resume_toggle">Already chatted with us? Resume →</button>' +
          '<div id="_cw_resume_form">' +
            '<div id="_cw_resume_row">' +
              '<input id="_cw_resume_ph" type="tel" placeholder="Your phone number" />' +
              '<button id="_cw_resume_btn">Continue</button>' +
            '</div>' +
            '<div id="_cw_resume_err">No conversation found for this number.</div>' +
          '</div>' +
        '</div>' +
        '<div id="_cw_welcome_input_wrap">' +
          '<input id="_cw_welcome_input" placeholder="Ask anything..." />' +
          '<button id="_cw_welcome_send" disabled aria-label="Send">' + SEND_ICON + '</button>' +
        '</div>' +
      '</div>' +
      '<div id="_cw_chat">' +
        '<div id="_cw_messages">' +
          '<div id="_cw_typing"><div class="_cw_dot"></div><div class="_cw_dot"></div><div class="_cw_dot"></div></div>' +
        '</div>' +
        '<div id="_cw_save_banner">' +
          '<div id="_cw_save_title">Save this conversation</div>' +
          '<div id="_cw_save_sub">Enter your phone to pick up where you left off — even from another device.</div>' +
          '<div id="_cw_save_row">' +
            '<input id="_cw_save_ph" type="tel" placeholder="+91 98765 43210" />' +
            '<button id="_cw_save_ph_btn">Save</button>' +
          '</div>' +
          '<button id="_cw_save_skip">Skip for now</button>' +
        '</div>' +
        '<div id="_cw_footer">' +
          '<textarea id="_cw_input" placeholder="Type a message..." rows="1"></textarea>' +
          '<button id="_cw_send" disabled aria-label="Send">' + SEND_ICON + '</button>' +
        '</div>' +
        '<div id="_cw_powered">Powered by Chat Support</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);

  var btn = document.getElementById('_cw_btn');
  var badge = document.getElementById('_cw_badge');
  var panel = document.getElementById('_cw_panel');
  var closeBtn = document.getElementById('_cw_close');
  var expandBtn = document.getElementById('_cw_expand');
  var welcomeView = document.getElementById('_cw_welcome');
  var chatView = document.getElementById('_cw_chat');
  var welcomeInput = document.getElementById('_cw_welcome_input');
  var welcomeSend = document.getElementById('_cw_welcome_send');
  var messagesEl = document.getElementById('_cw_messages');
  var input = document.getElementById('_cw_input');
  var sendBtn = document.getElementById('_cw_send');
  var typingEl = document.getElementById('_cw_typing');

  function normalizePhone(ph) {
    var d = ph.replace(/\D/g, '');
    if (d.startsWith('91') && d.length > 10) d = d.slice(2);
    return d.slice(-10);
  }

  function showSaveBanner() {
    if (state.phoneSaved) return;
    var banner = document.getElementById('_cw_save_banner');
    if (banner) banner.style.display = 'flex';
  }

  function savePhone() {
    var input = document.getElementById('_cw_save_ph');
    var phone = normalizePhone(input.value);
    if (phone.length < 10) { input.style.borderColor = '#e55'; return; }
    input.style.borderColor = '';
    api('/save-phone', {
      method: 'POST',
      body: JSON.stringify({ conversationId: state.conversationId, siteKey: SITE_KEY, phone: phone }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        state.phoneSaved = true;
        try { localStorage.setItem('_cw_phone_' + SITE_KEY, phone); } catch(e) {}
        var banner = document.getElementById('_cw_save_banner');
        if (banner) {
          banner.innerHTML = '<div style="font-size:13px;color:#22c55e;font-weight:500;text-align:center">Chat saved! Resume anytime with your phone number.</div>';
          setTimeout(function() { banner.style.display = 'none'; }, 3000);
        }
      }
    })
    .catch(function() {});
  }

  function resumeByPhone() {
    var input = document.getElementById('_cw_resume_ph');
    var err = document.getElementById('_cw_resume_err');
    var phone = normalizePhone(input.value);
    if (phone.length < 10) { input.style.borderColor = '#e55'; return; }
    input.style.borderColor = '';
    if (err) err.style.display = 'none';
    api('/resume', {
      method: 'POST',
      body: JSON.stringify({ siteKey: SITE_KEY, phone: phone }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.found && data.conversationId) {
        state.conversationId = data.conversationId;
        state.status = data.status;
        state.phoneSaved = true;
        try {
          localStorage.setItem('_cw_cid_' + SITE_KEY, data.conversationId);
          localStorage.setItem('_cw_phone_' + SITE_KEY, phone);
        } catch(e) {}
        switchToChat();
        if (data.messages && data.messages.length > 0) {
          data.messages.forEach(renderMessage);
        }
        startPolling();
      } else {
        if (err) err.style.display = 'block';
      }
    })
    .catch(function() {});
  }

  function formatTime(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function switchToChat() {
    state.view = 'chat';
    welcomeView.style.display = 'none';
    chatView.style.display = 'flex';
    panel.style.height = '480px';
    input.focus();
  }

  function renderMessage(msg) {
    if (document.querySelector('[data-id="' + msg.id + '"]')) return;
    var cls = msg.sender === 'visitor' ? '_cw_visitor' : (msg.sender === 'agent' ? '_cw_agent' : '_cw_ai');
    var label = msg.sender === 'visitor' ? 'You' : (msg.sender === 'agent' ? 'Support Agent' : 'Support');
    var div = document.createElement('div');
    div.className = '_cw_msg ' + cls;
    div.dataset.id = msg.id;

    // Group a run from one sender: tuck it closer and drop the repeated name.
    var prev = typingEl.previousElementSibling;
    var sameSender = prev && prev.classList && prev.classList.contains('_cw_msg') && prev.classList.contains(cls);
    if (sameSender) div.classList.add('_cw_same');

    div.innerHTML =
      (sameSender ? '' : '<div class="_cw_label">' + label + '</div>') +
      '<div class="_cw_bubble">' + escapeHtml(msg.content) + '</div>' +
      '<div class="_cw_time">' + formatTime(msg.createdAt) + '</div>';
    messagesEl.insertBefore(div, typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    if (msg.createdAt) {
      state.lastTs = msg.createdAt;
      try { localStorage.setItem('_cw_ts_' + SITE_KEY, state.lastTs); } catch(e) {}
    }
    if ((msg.sender === 'ai' || msg.sender === 'agent') && !state.phoneSaved) {
      state.aiResponseCount = (state.aiResponseCount || 0) + 1;
      if (state.aiResponseCount === 1) setTimeout(showSaveBanner, 800);
    }
  }

  function showTyping(show) {
    state.typing = show;
    typingEl.style.display = show ? 'flex' : 'none';
    if (show) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function updateSendBtn() { sendBtn.disabled = !input.value.trim(); }
  function updateWelcomeSend() { welcomeSend.disabled = !welcomeInput.value.trim(); }

  function togglePanel(open) {
    state.open = open;
    panel.classList.toggle('_cw_open', open);
    if (open) {
      badge.style.display = 'none';
      if (state.conversationId) {
        switchToChat();
        startPolling();
      } else {
        welcomeInput.focus();
      }
    } else {
      stopPolling();
    }
  }

  function api(path, opts) {
    return fetch(SERVER_URL + '/api/widget' + path, Object.assign({
      headers: { 'Content-Type': 'application/json' }
    }, opts));
  }

  function initConversation(firstMessage) {
    api('/conversation', {
      method: 'POST',
      body: JSON.stringify({ siteKey: SITE_KEY, visitorId: state.visitorId }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.conversationId) {
        state.conversationId = data.conversationId;
        state.status = data.status;
        try { localStorage.setItem('_cw_cid_' + SITE_KEY, data.conversationId); } catch(e) {}
        switchToChat();
        if (firstMessage) {
          doSendMessage(firstMessage, function() { startPolling(); });
        } else {
          startPolling();
        }
      }
    })
    .catch(function(err) { console.error('[ChatWidget] init error', err); });
  }

  function loadHistory() {
    if (!state.conversationId) return;
    api('/messages/' + state.conversationId + '?siteKey=' + encodeURIComponent(SITE_KEY))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.messages) {
        data.messages.forEach(renderMessage);
        state.status = data.status;
      }
    })
    .catch(function(err) { console.error('[ChatWidget] history error', err); });
  }

  function pollMessages() {
    if (!state.conversationId || state.sending) return;
    var url = '/messages/' + state.conversationId + '?siteKey=' + encodeURIComponent(SITE_KEY);
    if (state.lastTs) url += '&since=' + encodeURIComponent(state.lastTs);
    api(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.messages && data.messages.length > 0) {
        showTyping(false);
        data.messages.forEach(renderMessage);
        if (!state.open) {
          var newCount = data.messages.filter(function(m) { return m.sender !== 'visitor'; }).length;
          if (newCount > 0) {
            badge.style.display = 'flex';
            badge.textContent = parseInt(badge.textContent || '0') + newCount;
          }
        }
      }
      if (data.status) state.status = data.status;
    })
    .catch(function() {});
  }

  function startPolling() {
    if (state.pollTimer) return;
    loadHistory();
    state.pollTimer = setInterval(pollMessages, 3000);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function doSendMessage(content, callback) {
    if (!content || !state.conversationId) return;
    state.sending = true;
    var tempId = 'tmp_' + Date.now();
    var tempMsg = { id: tempId, sender: 'visitor', content: content, createdAt: new Date().toISOString() };
    renderMessage(tempMsg);
    showTyping(true);

    api('/message', {
      method: 'POST',
      body: JSON.stringify({ conversationId: state.conversationId, siteKey: SITE_KEY, content: content }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var tmp = document.querySelector('[data-id="' + tempId + '"]');
      if (tmp && data.message) tmp.dataset.id = data.message.id;
      if (data.message && data.message.createdAt) {
        state.lastTs = data.message.createdAt;
        try { localStorage.setItem('_cw_ts_' + SITE_KEY, state.lastTs); } catch(e) {}
      }
      // Always stop the indicator. Leaving it spinning on a missing reply looks
      // like the chat died, which reads worse than any error would.
      showTyping(false);
      if (data.aiResponse) renderMessage(data.aiResponse);
      state.sending = false;
      if (callback) callback();
    })
    .catch(function(err) {
      showTyping(false);
      state.sending = false;
      console.error('[ChatWidget] send error', err);
      if (callback) callback();
    });
  }

  function sendMessage() {
    var content = input.value.trim();
    if (!content) return;
    input.value = '';
    input.style.height = 'auto';
    updateSendBtn();
    doSendMessage(content);
  }

  function sendFromWelcome(content) {
    if (!content) return;
    welcomeInput.value = '';
    updateWelcomeSend();
    if (!state.conversationId) {
      initConversation(content);
    } else {
      switchToChat();
      doSendMessage(content);
    }
  }

  btn.addEventListener('click', function() { togglePanel(!state.open); });
  closeBtn.addEventListener('click', function() { togglePanel(false); });
  expandBtn.addEventListener('click', function() {
    // Width lives in the class too, so expanding actually gives the text more
    // room instead of just making a narrow column taller.
    panel.classList.toggle('_cw_expanded');
  });

  welcomeInput.addEventListener('input', updateWelcomeSend);
  welcomeInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); var val = welcomeInput.value.trim(); if (val) sendFromWelcome(val); }
  });
  welcomeSend.addEventListener('click', function() {
    var val = welcomeInput.value.trim(); if (val) sendFromWelcome(val);
  });

  var actionBtns = root.querySelectorAll('._cw_action');
  for (var i = 0; i < actionBtns.length; i++) {
    actionBtns[i].addEventListener('click', function() { sendFromWelcome(this.textContent); });
  }

  // Resume by phone
  var resumeToggle = document.getElementById('_cw_resume_toggle');
  var resumeForm = document.getElementById('_cw_resume_form');
  var resumePh = document.getElementById('_cw_resume_ph');
  var resumeBtn = document.getElementById('_cw_resume_btn');
  if (resumeToggle) {
    resumeToggle.addEventListener('click', function() {
      var shown = resumeForm.style.display === 'flex';
      resumeForm.style.display = shown ? 'none' : 'flex';
      if (!shown && resumePh) resumePh.focus();
    });
  }
  if (resumeBtn) {
    resumeBtn.addEventListener('click', resumeByPhone);
  }
  if (resumePh) {
    resumePh.addEventListener('keydown', function(e) { if (e.key === 'Enter') resumeByPhone(); });
  }

  // Save phone banner
  var savePh = document.getElementById('_cw_save_ph');
  var savePhBtn = document.getElementById('_cw_save_ph_btn');
  var saveSkip = document.getElementById('_cw_save_skip');
  if (savePhBtn) savePhBtn.addEventListener('click', savePhone);
  if (savePh) savePh.addEventListener('keydown', function(e) { if (e.key === 'Enter') savePhone(); });
  if (saveSkip) {
    saveSkip.addEventListener('click', function() {
      var banner = document.getElementById('_cw_save_banner');
      if (banner) banner.style.display = 'none';
      state.phoneSaved = true;
    });
  }

  input.addEventListener('input', function() {
    updateSendBtn();
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!sendBtn.disabled) sendMessage(); }
  });
  sendBtn.addEventListener('click', sendMessage);

  if (state.conversationId) {
    setTimeout(function() { startPolling(); }, 2000);
  }

})();
