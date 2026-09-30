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
    sending: false, phoneSaved: false, aiResponseCount: 0, verifying: false
  };

  try {
    state.visitorId = localStorage.getItem('_cw_vid') || generateId();
    localStorage.setItem('_cw_vid', state.visitorId);
    state.conversationId = localStorage.getItem('_cw_cid_' + SITE_KEY) || null;
    state.lastTs = localStorage.getItem('_cw_ts_' + SITE_KEY) || null;
    state.phoneSaved = !!(localStorage.getItem('_cw_phone_' + SITE_KEY));
  } catch (e) { state.visitorId = generateId(); }

  // The store's name above replies ("Vastora Support"), never a bare "AI".
  // data-brand on the script tag wins; otherwise the site name the widget API
  // sends, remembered so a returning visitor sees it before any request.
  var BRAND_ATTR = cleanBrand(script.getAttribute('data-brand'));
  var brand = BRAND_ATTR;
  if (!brand) { try { brand = cleanBrand(localStorage.getItem('_cw_brand_' + SITE_KEY)); } catch (e) {} }

  function cleanBrand(v) {
    v = typeof v === 'string' ? v.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 60) : '';
    return v ? v.charAt(0).toUpperCase() + v.slice(1) : '';
  }

  function supportLabel() {
    if (!brand) return 'Support';
    return /\bsupport$/i.test(brand) ? brand : brand + ' Support';
  }

  // Called with siteName from the widget API. Labels already on screen that
  // still show the fallback take the name too.
  function setBrand(siteName) {
    if (BRAND_ATTR) return;
    var b = cleanBrand(siteName);
    if (!b || b === brand) return;
    brand = b;
    try { localStorage.setItem('_cw_brand_' + SITE_KEY, b); } catch (e) {}
    var labels = document.querySelectorAll('#_cw_root ._cw_ai ._cw_label, #_cw_root ._cw_agent ._cw_label');
    for (var i = 0; i < labels.length; i++) labels[i].textContent = supportLabel();
  }

  function generateId() { return 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // Escape first, then wrap bare URLs in real anchors. The URL match stops
  // before any trailing punctuation, so a full stop written straight after a
  // tracking link stays outside the href and the link still opens. It also
  // stops at an asterisk: "**https://…/abc**" pasted as bold opens the page.
  function linkify(s) {
    return escapeHtml(s).replace(
      /(https?:\/\/[^\s<>"'*]*[^\s<>"'*.,;:!?)\]])/g,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );
  }

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

    // Pre-chat form: a customer proves an order (Order ID + full phone) before
    // chatting, or carries on as a visitor. Shown only when there is no chat yet.
    '#_cw_verify {',
    '  padding: 18px 18px 14px; display: none; flex-direction: column; gap: 12px;',
    '  overflow-y: auto; flex: 1;',
    '}',
    '#_cw_verify_title { font-size: 17px; font-weight: 700; color: #111; letter-spacing: -0.02em; line-height: 1.3; }',
    '#_cw_verify_sub { font-size: 13px; color: #555; line-height: 1.5; margin-top: -6px; }',
    '._cw_vfield { display: flex; flex-direction: column; gap: 5px; }',
    '._cw_vlabel { font-size: 12px; font-weight: 600; color: #444; }',
    '._cw_vinput {',
    '  width: 100%; border: 1.5px solid #e5e5e5; border-radius: 12px; padding: 10px 14px;',
    '  font-size: 14px; outline: none; font-family: inherit; color: #1a1a1a; background: #fff;',
    '  transition: border-color 0.2s;',
    '}',
    '._cw_vinput:focus { border-color: #bbb; }',
    '._cw_vinput::placeholder { color: #aaa; }',
    '#_cw_verify_err { font-size: 12px; color: #d33; line-height: 1.4; display: none; }',
    '#_cw_verify_btn {',
    '  background: ' + ACCENT + '; color: white; border: none; border-radius: 24px; padding: 11px 16px;',
    '  font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; width: 100%;',
    '  transition: opacity 0.15s;',
    '}',
    '#_cw_verify_btn:disabled { opacity: 0.6; cursor: default; }',
    '#_cw_verify_or { font-size: 11px; color: #aaa; text-align: center; }',
    '#_cw_visitor_btn {',
    '  background: #fff; color: #333; border: 1.5px solid #e5e5e5; border-radius: 24px; padding: 10px 16px;',
    '  font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit; width: 100%;',
    '  transition: background 0.15s, border-color 0.15s;',
    '}',
    '#_cw_visitor_btn:hover { background: #fafafa; border-color: #ddd; }',
    '#_cw_verify_resume { background: none; border: none; font-size: 12px; color: #999; cursor: pointer; padding: 0; font-family: inherit; align-self: center; }',
    '#_cw_verify_resume:hover { color: #555; text-decoration: underline; }',
    '#_cw_verify_disclaimer { font-size: 11px; color: #999; line-height: 1.4; padding: 8px 0 0; border-top: 1px solid #f0f0f0; }',
    '#_cw_verify_disclaimer a { color: #888; text-decoration: underline; }',
    '._cw_note ._cw_bubble { border-left: 3px solid #22c55e; }',

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
    '._cw_files { display: flex; flex-direction: column; gap: 6px; white-space: normal; }',
    '._cw_files._cw_gap { margin-bottom: 8px; }',
    '._cw_bubble a._cw_img { display: block; line-height: 0; text-decoration: none; }',
    '._cw_img img { display: block; width: 220px; max-width: 100%; height: auto; max-height: 240px; object-fit: cover; border-radius: 12px; background: #e9e9ec; }',
    '._cw_file { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: #fff; border: 1px solid #e4e4e7; border-radius: 12px; min-width: 0; }',
    '._cw_file svg { width: 22px; height: 22px; flex-shrink: 0; fill: #71717a; }',
    '._cw_file_meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.35; }',
    '._cw_bubble a._cw_file_name { font-size: 13px; font-weight: 500; color: #18181b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-decoration: none; }',
    '._cw_file_links { font-size: 11.5px; color: #71717a; }',
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
    // 16px stops phones zooming the page when a form field gets focus.
    '  ._cw_vinput { font-size: 16px; }',
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
      '<div id="_cw_verify">' +
        '<div id="_cw_verify_title">Verify yourself and continue a chat</div>' +
        '<div id="_cw_verify_sub">Your Order ID is in your order confirmation message.</div>' +
        '<div class="_cw_vfield">' +
          '<label class="_cw_vlabel" for="_cw_verify_oid">Order ID</label>' +
          '<input id="_cw_verify_oid" class="_cw_vinput" type="text" maxlength="40" autocomplete="off" placeholder="e.g. #1234 or tracking ID" />' +
        '</div>' +
        '<div class="_cw_vfield">' +
          '<label class="_cw_vlabel" for="_cw_verify_ph">Complete phone number</label>' +
          '<input id="_cw_verify_ph" class="_cw_vinput" type="tel" inputmode="numeric" maxlength="20" autocomplete="tel" placeholder="+91 98765 43210" />' +
        '</div>' +
        '<div id="_cw_verify_err" role="alert"></div>' +
        '<button id="_cw_verify_btn" type="button">Verify &amp; continue</button>' +
        '<div id="_cw_verify_or">or</div>' +
        '<button id="_cw_visitor_btn" type="button">Continue with a visitor</button>' +
        '<button id="_cw_verify_resume" type="button">Already chatted with us? Resume →</button>' +
        '<div id="_cw_verify_disclaimer">This chat is powered by AI and may make mistakes. Your messages are visible to the store. Your phone number is used to find your order and to let you resume this chat. See <a href="#" target="_blank">privacy policy</a>.</div>' +
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
  var verifyView = document.getElementById('_cw_verify');
  var verifyOid = document.getElementById('_cw_verify_oid');
  var verifyPh = document.getElementById('_cw_verify_ph');
  var verifyBtn = document.getElementById('_cw_verify_btn');
  var verifyErr = document.getElementById('_cw_verify_err');
  var visitorBtn = document.getElementById('_cw_visitor_btn');
  var verifyResume = document.getElementById('_cw_verify_resume');
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
      body: JSON.stringify({ siteKey: SITE_KEY, phone: phone, visitorId: state.visitorId }),
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.found && data.conversationId) {
        state.conversationId = data.conversationId;
        state.status = data.status;
        state.phoneSaved = true;
        setBrand(data.siteName);
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

  var FILE_ICON = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>';

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // Files a support agent sent: images as previews that open full size, other
  // files as a card with open and download links. Only our own file URLs are
  // rendered.
  function renderFiles(files) {
    var out = '';
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || typeof f.url !== 'string' || !/^\/api\/widget\/files\/[a-f0-9]{64}$/.test(f.url)) continue;
      var url = escapeHtml(SERVER_URL + f.url);
      var name = escapeHtml(String(f.name || 'file'));
      if (f.kind === 'image') {
        out += '<a class="_cw_img" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
          '<img src="' + url + '" alt="' + name + '" loading="lazy"></a>';
      } else {
        out += '<div class="_cw_file">' + FILE_ICON +
          '<div class="_cw_file_meta">' +
            '<a class="_cw_file_name" href="' + url + '" target="_blank" rel="noopener noreferrer" title="' + name + '">' + name + '</a>' +
            '<span class="_cw_file_links">' + formatSize(Number(f.size) || 0) + ' · ' +
              '<a href="' + url + '" target="_blank" rel="noopener noreferrer">Open</a> · ' +
              '<a href="' + url + '?download=1">Download</a>' +
            '</span>' +
          '</div></div>';
      }
    }
    return out;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    if (!ts || isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // The API sends created_at; the old chat server sent createdAt, and
  // messages made in this script still use that.
  function msgTime(msg) { return msg.created_at || msg.createdAt; }

  // `since` for the next poll: the latest server time seen, including edits
  // and deletions. Never a time from this browser's clock.
  function advanceTs(msg) {
    var ts = msg.changed_at || msg.created_at;
    if (!ts) return;
    if (state.lastTs && new Date(state.lastTs) >= new Date(ts)) return;
    state.lastTs = ts;
    try { localStorage.setItem('_cw_ts_' + SITE_KEY, state.lastTs); } catch(e) {}
  }

  function switchToChat() {
    state.view = 'chat';
    welcomeView.style.display = 'none';
    verifyView.style.display = 'none';
    chatView.style.display = 'flex';
    panel.style.height = '480px';
    input.focus();
  }

  function bubbleHtml(msg) {
    // A files-only reply also carries a text stand-in for older views; the
    // files themselves say it here.
    var files = (msg.metadata && Array.isArray(msg.metadata.attachments)) ? renderFiles(msg.metadata.attachments) : '';
    var showText = !(files && msg.metadata.captionless);
    if (files) files = '<div class="_cw_files' + (showText ? ' _cw_gap' : '') + '">' + files + '</div>';
    return files + (showText ? linkify(msg.content) : '');
  }

  function timeText(msg) {
    var t = formatTime(msgTime(msg));
    return msg.edited_at ? (t ? t + ' · ' : '') + 'Edited' : t;
  }

  // An image has no height until it loads, so follow it down once it does:
  // while the scroll after a new message is still settling, or if the customer
  // is at the bottom anyway — not when they have scrolled up to read.
  function followImages(div) {
    state.pinUntil = Date.now() + 2000;
    var imgs = div.getElementsByTagName('img');
    for (var j = 0; j < imgs.length; j++) {
      imgs[j].addEventListener('load', function () {
        var gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
        if (Date.now() < state.pinUntil || gap <= this.offsetHeight + 80) messagesEl.scrollTop = messagesEl.scrollHeight;
      });
    }
  }

  // The team deleted a message this chat shows. If it carried the sender's
  // name for a run of messages, the next one in the run takes the name over.
  function removeMessage(el) {
    var next = el.nextElementSibling;
    var label = el.classList.contains('_cw_same') ? null : el.querySelector('._cw_label');
    el.parentNode.removeChild(el);
    if (label && next && next.classList.contains('_cw_same')) {
      next.classList.remove('_cw_same');
      next.insertBefore(label, next.firstChild);
    }
  }

  // For messages from /messages (history and polls): shown, and `since` moves on.
  function renderMessage(msg) { showMessage(msg, true); }

  // moveSince is false for the reply to the visitor's own send. That reply is
  // newer than anything the team did while the AI was writing (an agent's
  // reply, an edit, a deletion), so moving `since` to it would skip those. The
  // next poll fetches from the old `since`; messages already shown are skipped.
  function showMessage(msg, moveSince) {
    var existing = document.querySelector('[data-id="' + msg.id + '"]');
    if (existing || msg.deleted) {
      // Already shown: the team may have edited or deleted it since.
      if (existing && msg.deleted) {
        removeMessage(existing);
      } else if (existing && msg.edited_at && existing.getAttribute('data-edited') !== msg.edited_at) {
        existing.setAttribute('data-edited', msg.edited_at);
        existing.querySelector('._cw_bubble').innerHTML = bubbleHtml(msg);
        existing.querySelector('._cw_time').textContent = timeText(msg);
        followImages(existing);
      }
      if (moveSince) advanceTs(msg);
      return;
    }

    var cls = msg.sender === 'visitor' ? '_cw_visitor' : (msg.sender === 'agent' ? '_cw_agent' : '_cw_ai');
    var label = msg.sender === 'visitor' ? 'You' : supportLabel();
    var div = document.createElement('div');
    div.className = '_cw_msg ' + cls;
    div.dataset.id = msg.id;
    if (msg.edited_at) div.setAttribute('data-edited', msg.edited_at);

    // Group a run from one sender: tuck it closer and drop the repeated name.
    var prev = typingEl.previousElementSibling;
    var sameSender = prev && prev.classList && prev.classList.contains('_cw_msg') && prev.classList.contains(cls);
    if (sameSender) div.classList.add('_cw_same');

    div.innerHTML =
      (sameSender ? '' : '<div class="_cw_label">' + escapeHtml(label) + '</div>') +
      '<div class="_cw_bubble">' + bubbleHtml(msg) + '</div>' +
      '<div class="_cw_time">' + escapeHtml(timeText(msg)) + '</div>';
    messagesEl.insertBefore(div, typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    followImages(div);
    if (moveSince) advanceTs(msg);
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
      } else if (state.view === 'verify') {
        verifyOid.focus();
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
        setBrand(data.siteName);
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
    // Messages on screen when the request left; one of them missing from the
    // answer was deleted by the team in the meantime.
    var shownBefore = [];
    var shown = messagesEl.querySelectorAll('._cw_msg');
    for (var i = 0; i < shown.length; i++) {
      var shownId = shown[i].getAttribute('data-id') || '';
      if (shownId.indexOf('tmp_') !== 0) shownBefore.push({ el: shown[i], id: shownId });
    }

    api('/messages/' + state.conversationId + '?siteKey=' + encodeURIComponent(SITE_KEY))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      setBrand(data && data.siteName);
      if (data.messages) {
        // Start `since` again from the server's clock. An older copy of this
        // script could have saved a time from the visitor's own clock.
        state.lastTs = null;
        var ids = {};
        data.messages.forEach(function(m) { ids[m.id] = true; });
        shownBefore.forEach(function(s) {
          if (s.el.parentNode && !ids[s.id]) removeMessage(s.el);
        });
        data.messages.forEach(renderMessage);
        state.status = data.status;
      }
    })
    .catch(function(err) { console.error('[ChatWidget] history error', err); });
  }

  function pollMessages() {
    if (!state.conversationId || state.sending) return;
    var url = '/messages/' + state.conversationId + '?siteKey=' + encodeURIComponent(SITE_KEY);
    // changes=1: also send what the team edited or deleted since then.
    if (state.lastTs) url += '&since=' + encodeURIComponent(state.lastTs) + '&changes=1';
    api(url)
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.messages && data.messages.length > 0) {
        // Only replies this chat has not shown yet count as unread; a poll can
        // repeat messages or carry edits and deletions of old ones.
        var newCount = data.messages.filter(function(m) {
          return m.sender !== 'visitor' && !m.deleted && !document.querySelector('[data-id="' + m.id + '"]');
        }).length;
        showTyping(false);
        data.messages.forEach(renderMessage);
        if (!state.open && newCount > 0) {
          badge.style.display = 'flex';
          badge.textContent = parseInt(badge.textContent || '0') + newCount;
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
      // Always stop the indicator. Leaving it spinning on a missing reply looks
      // like the chat died, which reads worse than any error would.
      showTyping(false);
      if (data.aiResponse) showMessage(data.aiResponse, false);
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

  /* ── Pre-chat form ── */

  // The chat as it was before the form: the welcome view, where the first
  // message creates the conversation.
  function showWelcome() {
    state.view = 'welcome';
    verifyView.style.display = 'none';
    welcomeView.style.display = 'flex';
    welcomeInput.focus();
  }

  function showVerify() {
    state.view = 'verify';
    welcomeView.style.display = 'none';
    verifyView.style.display = 'flex';
  }

  function verifyError(text) {
    verifyErr.textContent = text;
    verifyErr.style.display = text ? 'block' : 'none';
  }

  // Shown in this browser only: never sent, never stored.
  function showVerifiedNote(orderId, firstName) {
    var div = document.createElement('div');
    div.className = '_cw_msg _cw_ai _cw_note';
    div.setAttribute('data-id', 'tmp_verified');
    var label = document.createElement('div');
    label.className = '_cw_label';
    label.textContent = supportLabel();
    var bubble = document.createElement('div');
    bubble.className = '_cw_bubble';
    bubble.textContent = (firstName ? 'Hi ' + firstName + '! ' : '') +
      'Verified \u2713 Order ' + orderId + '. How can we help you today?';
    div.appendChild(label);
    div.appendChild(bubble);
    messagesEl.insertBefore(div, typingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function submitVerify() {
    if (state.verifying) return;
    var orderId = verifyOid.value.replace(/^\s+|\s+$/g, '');
    var phone = normalizePhone(verifyPh.value);
    verifyOid.style.borderColor = orderId ? '' : '#e55';
    verifyPh.style.borderColor = phone.length === 10 ? '' : '#e55';
    if (!orderId || phone.length !== 10) return;
    verifyError('');
    state.verifying = true;
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying\u2026';

    function done(message) {
      state.verifying = false;
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify & continue';
      if (message) verifyError(message);
    }

    api('/verify', {
      method: 'POST',
      body: JSON.stringify({ siteKey: SITE_KEY, visitorId: state.visitorId, orderId: orderId, phone: phone }),
    })
    .then(function(r) {
      return r.json().then(
        function(data) { return { status: r.status, data: data || {} }; },
        function() { return { status: r.status, data: {} }; }
      );
    })
    .then(function(res) {
      var data = res.data;
      if (data.verified === true && data.conversationId) {
        done('');
        state.conversationId = data.conversationId;
        if (data.status) state.status = data.status;
        state.phoneSaved = true;
        setBrand(data.siteName);
        try {
          localStorage.setItem('_cw_cid_' + SITE_KEY, data.conversationId);
          localStorage.setItem('_cw_phone_' + SITE_KEY, phone);
        } catch(e) {}
        verifyPh.value = '';
        switchToChat();
        showVerifiedNote(String(data.orderId || orderId), data.firstName ? String(data.firstName) : '');
        startPolling();
      } else if (res.status === 429 || data.error === 'too_many_attempts') {
        done('Too many attempts. Please try again later or continue as a visitor.');
      } else if (data.error === 'not_found') {
        done('We couldn\'t find an order with these details. Please check your Order ID and phone number.');
      } else {
        done('Something went wrong. Please try again or continue as a visitor.');
      }
    })
    .catch(function(err) {
      console.error('[ChatWidget] verify error', err);
      done('Something went wrong. Please try again or continue as a visitor.');
    });
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

  // Pre-chat form
  verifyBtn.addEventListener('click', submitVerify);
  visitorBtn.addEventListener('click', function() { verifyError(''); showWelcome(); });
  // Picking up an earlier chat lives in the welcome view: open it there.
  verifyResume.addEventListener('click', function() {
    verifyError('');
    showWelcome();
    var form = document.getElementById('_cw_resume_form');
    var ph = document.getElementById('_cw_resume_ph');
    if (form) form.style.display = 'flex';
    if (ph) ph.focus();
  });
  verifyOid.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submitVerify(); } });
  verifyPh.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); submitVerify(); } });
  verifyOid.addEventListener('input', function() { this.style.borderColor = ''; });
  verifyPh.addEventListener('input', function() { this.style.borderColor = ''; });
  // A visitor with a chat already never sees the form.
  if (!state.conversationId) showVerify();

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
