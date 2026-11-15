// ==UserScript==
// @name            CookieManager
// @description     アドレスバーのアイコンから、いまのサイトの cookie を見る・編集・削除・書き出しし、終了時に残すかを切り替える
// @include         main
// @version         1.1.0
// ==/UserScript==

// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
// アドレスバーの #page-action-buttons にアイコンを置き、押すとパネルを開く。
// cookie はブラウザ本体の cookie の仕組み(Services.cookies)を直接読み書きする。どこにも送らない。
// 一覧の範囲は「いまのタブのサイトのドメイン全体」(www.example.com なら example.com とそのサブドメイン)。
// 「終了時に残す」は、Floorp の「閉じたときに Cookie とサイトデータを削除する」の例外
// (権限 persist-data-on-shutdown の ALLOW。設定画面の「例外を管理」と同じもの)をドメイン全体に付け外しする。

(function (win) {
  'use strict';

  // 画面に出す文字の言葉。ブラウザーの言語が日本語なら日本語、それ以外は英語
  // (ブラウザーコンソールに出す開発向けのメッセージは日本語のまま)
  const UI_JA = (() => {
    try {
      return Services.locale.appLocaleAsBCP47.toLowerCase().startsWith('ja');
    } catch (ex) {
      return true;
    }
  })();
  const L = (ja, en) => (UI_JA ? ja : en);

  const LOG = '[CookieManager]';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const BUTTON_ID = 'floorp-ckm-button';
  const PANEL_ID = 'floorp-ckm-panel';
  const STYLE_ID = 'floorp-ckm-style';
  const KEEP_PERM = 'persist-data-on-shutdown';
  // 期限なし(セッション cookie)のときに add へ渡す期限。ext-cookies.js と同じ
  const SESSION_EXPIRY = Number.MAX_SAFE_INTEGER;

  const doc = win.document;

  // 書き出しの形式
  const FORMATS = {
    json: { label: 'JSON', ext: 'json', filter: '*.json' },
    netscape: { label: L('cookies.txt(Netscape 形式)', 'cookies.txt (Netscape format)'), ext: 'txt', filter: '*.txt' },
    // HttpOnly の印(#HttpOnly_)を付けない cookies.txt。# で始まる行をコメントとして読み飛ばすツール向け
    netscapePlain: { label: L('cookies.txt(HttpOnly の印なし)', 'cookies.txt (no HttpOnly marker)'), ext: 'txt', filter: '*.txt' },
    header: { label: L('Cookie ヘッダー', 'Cookie header'), ext: 'txt', filter: '*.txt' },
  };

  // [値, 画面の表示, JSON での書き方(拡張機能の cookies API・Cookie-Editor と同じ)]
  const SAMESITE = [
    [Ci.nsICookie.SAMESITE_UNSET, L('指定なし', 'Unspecified'), 'unspecified'],
    [Ci.nsICookie.SAMESITE_NONE, 'None', 'no_restriction'],
    [Ci.nsICookie.SAMESITE_LAX, 'Lax', 'lax'],
    [Ci.nsICookie.SAMESITE_STRICT, 'Strict', 'strict'],
  ];

  // クッキーの形のアイコン(欠けた円と粒)。mask に使うので色は currentColor で塗る
  const ICON_URL = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<path fill="black" fill-rule="evenodd" d="M8 1a7 7 0 1 0 7 7 2.5 2.5 0 0 1-2.9-2.6A2.5 2.5 0 0 1 9.1 2.6 2.4 2.4 0 0 1 8 1Zm-2.5 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm4 3.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm-5 2a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm3-3a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z"/>' +
    '</svg>'
  );

  const CSS = `
    #${BUTTON_ID} > .floorp-ckm-icon {
      width: 16px;
      height: 16px;
      background-color: currentColor;
      mask: url("${ICON_URL}") center / 16px 16px no-repeat;
    }
    #${PANEL_ID} {
      --ckm-line: color-mix(in srgb, currentColor 18%, transparent);
      --ckm-soft: color-mix(in srgb, currentColor 7%, transparent);
      --ckm-muted: color-mix(in srgb, currentColor 65%, transparent);
      --ckm-danger: #d70022;
    }
    @media (prefers-color-scheme: dark) {
      #${PANEL_ID} { --ckm-danger: #ff848b; }
    }
    #${PANEL_ID} .ckm-root {
      width: 440px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      font: menu;
      font-size: 13px;
    }
    #${PANEL_ID} .ckm-title { font-weight: 600; font-size: 14px; }
    #${PANEL_ID} .ckm-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    #${PANEL_ID} .ckm-grow { flex: 1; }
    #${PANEL_ID} .ckm-muted { color: var(--ckm-muted); font-size: 12px; }
    #${PANEL_ID} .ckm-status { min-height: 1.3em; color: var(--ckm-muted); font-size: 12px; }
    #${PANEL_ID} .ckm-status[data-kind="error"] { color: var(--ckm-danger); }
    #${PANEL_ID} button, #${PANEL_ID} select, #${PANEL_ID} input, #${PANEL_ID} textarea {
      font: inherit;
      color: inherit;
    }
    #${PANEL_ID} button {
      appearance: none;
      padding: 3px 10px;
      border: 1px solid var(--ckm-line);
      border-radius: 4px;
      background: var(--ckm-soft);
      cursor: pointer;
    }
    #${PANEL_ID} button:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
    #${PANEL_ID} button.ckm-danger { color: var(--ckm-danger); }
    #${PANEL_ID} button.ckm-danger[data-armed] { background: var(--ckm-danger); color: white; border-color: var(--ckm-danger); }
    #${PANEL_ID} select, #${PANEL_ID} input[type="text"], #${PANEL_ID} input[type="datetime-local"], #${PANEL_ID} textarea {
      padding: 2px 4px;
      border: 1px solid var(--ckm-line);
      border-radius: 4px;
      background: transparent;
      min-width: 0;
    }
    #${PANEL_ID} option { background: Field; color: FieldText; }
    #${PANEL_ID} :is(button, input, select):disabled { opacity: 0.5; cursor: default; }
    #${PANEL_ID} .ckm-list {
      max-height: 420px;
      overflow-y: auto;
      border: 1px solid var(--ckm-line);
      border-radius: 6px;
    }
    #${PANEL_ID} .ckm-empty { padding: 16px; text-align: center; color: var(--ckm-muted); }
    #${PANEL_ID} .ckm-item { border-bottom: 1px solid var(--ckm-line); }
    #${PANEL_ID} .ckm-item:last-child { border-bottom: none; }
    #${PANEL_ID} .ckm-head { display: block; padding: 6px 10px; cursor: pointer; }
    #${PANEL_ID} .ckm-head:hover { background: var(--ckm-soft); }
    #${PANEL_ID} .ckm-name { font-family: monospace; font-weight: 600; word-break: break-all; }
    #${PANEL_ID} .ckm-value { font-family: monospace; color: var(--ckm-muted); font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #${PANEL_ID} .ckm-form {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px 8px;
      align-items: center;
      padding: 8px 10px 10px;
      background: var(--ckm-soft);
    }
    #${PANEL_ID} .ckm-form > .ckm-label { color: var(--ckm-muted); font-size: 12px; }
    #${PANEL_ID} .ckm-form textarea { font-family: monospace; resize: vertical; min-height: 3.5em; word-break: break-all; }
    #${PANEL_ID} .ckm-form input[type="text"] { font-family: monospace; }
    #${PANEL_ID} .ckm-form .ckm-full { grid-column: 1 / -1; }
    #${PANEL_ID} .ckm-new { border: 1px solid var(--ckm-line); border-radius: 6px; overflow: hidden; }
    #${PANEL_ID} label { display: inline-flex; align-items: center; gap: 4px; }
  `;

  // ---- 小さな道具 ----

  function h(tag, attrs, ...children) {
    const el = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(typeof c === 'string' ? doc.createTextNode(c) : c);
    }
    return el;
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // ミリ秒 → datetime-local の値(ローカル時刻)
  function toLocalInput(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatExpiry(cookie) {
    if (cookie.isSession) return L('セッション', 'Session');
    const d = new Date(cookie.expiry);
    const when = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return L(`${when}まで`, `until ${when}`);
  }

  function sameSiteJson(value) {
    const found = SAMESITE.find(([v]) => v === value);
    return found ? found[2] : 'unspecified';
  }

  // ---- いまのタブのサイト ----

  // 一覧の対象: http(s) のページのときだけ。ホスト・ドメイン全体・cookie の区画(コンテナ・プライベート)を返す
  function currentSite() {
    const browser = win.gBrowser.selectedBrowser;
    const uri = browser.currentURI;
    if (!uri || !/^https?$/.test(uri.scheme) || !uri.host) return null;
    let baseDomain;
    try {
      baseDomain = Services.eTLD.getBaseDomain(uri);
    } catch (ex) {
      // IP アドレスや localhost は base domain が無いのでホストそのもの
      baseDomain = uri.host;
    }
    const oa = browser.contentPrincipal ? browser.contentPrincipal.originAttributes : {};
    return {
      uri,
      host: uri.host,
      baseDomain,
      https: uri.scheme === 'https',
      originAttributes: {
        userContextId: oa.userContextId || 0,
        privateBrowsingId: oa.privateBrowsingId || 0,
        firstPartyDomain: oa.firstPartyDomain || '',
      },
    };
  }

  function listCookies(site) {
    // getCookiesFromHost はドメイン全体(同じ base domain)の cookie をまとめて返す
    const cookies = Services.cookies.getCookiesFromHost(site.baseDomain, site.originAttributes);
    return cookies.sort((a, b) =>
      a.rawHost.localeCompare(b.rawHost) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  }

  // ---- 書き込み ----

  // spec: { host(先頭の . はドメイン cookie), path, name, value, secure, httpOnly, session, expiry(ms), sameSite, schemeMap }
  function addCookie(spec, originAttributes) {
    const expiry = spec.session ? SESSION_EXPIRY : Services.cookies.maybeCapExpiry(spec.expiry);
    const cv = Services.cookies.add(
      spec.host, spec.path, spec.name, spec.value,
      spec.secure, spec.httpOnly, spec.session, expiry,
      originAttributes, spec.sameSite, spec.schemeMap, false
    );
    if (cv && cv.result !== Ci.nsICookieValidation.eOK) {
      throw new Error(`cookie を保存できませんでした(理由の番号 ${cv.result})`);
    }
  }

  function removeCookie(cookie) {
    Services.cookies.remove(cookie.host, cookie.name, cookie.path, cookie.originAttributes);
  }

  function specOf(cookie) {
    return {
      host: cookie.host, path: cookie.path, name: cookie.name, value: cookie.value,
      secure: cookie.isSecure, httpOnly: cookie.isHttpOnly, session: cookie.isSession,
      expiry: cookie.expiry, sameSite: cookie.sameSite, schemeMap: cookie.schemeMap,
    };
  }

  // 編集: 古いものを消して新しいものを足す。足すのに失敗したら古いものを戻す
  function replaceCookie(oldCookie, spec) {
    const backup = specOf(oldCookie);
    const oa = oldCookie.originAttributes;
    removeCookie(oldCookie);
    try {
      addCookie(spec, oa);
    } catch (ex) {
      try {
        addCookie(backup, oa);
      } catch (ex2) {
        console.error(LOG, '元の cookie を戻せませんでした', backup.name, ex2);
      }
      throw ex;
    }
  }

  // ---- 終了時に残す ----

  function shutdownClearingOn() {
    try {
      return Services.prefs.getBoolPref('privacy.sanitize.sanitizeOnShutdown', false) &&
        Services.prefs.getBoolPref('privacy.clearOnShutdown_v2.cookiesAndStorage', false);
    } catch (ex) {
      console.error(LOG, '終了時の削除の設定を読めませんでした', ex);
      return false;
    }
  }

  function keepPermissions(baseDomain) {
    return Services.perms.getAllByTypes([KEEP_PERM]).filter((perm) => {
      try {
        return perm.capability === Ci.nsIPermissionManager.ALLOW_ACTION && perm.principal.baseDomain === baseDomain;
      } catch (ex) {
        return false;
      }
    });
  }

  function isKept(site) {
    return keepPermissions(site.baseDomain).length > 0;
  }

  function setKept(site, keep) {
    if (keep) {
      // ドメイン全体に効くように、base domain の http と https の両方に付ける(「例外を管理」と同じ形)
      for (const scheme of ['https', 'http']) {
        const principal = Services.scriptSecurityManager.createContentPrincipalFromOrigin(`${scheme}://${site.baseDomain}`);
        Services.perms.addFromPrincipal(principal, KEEP_PERM, Ci.nsIPermissionManager.ALLOW_ACTION);
      }
    } else {
      // サブドメインに個別に付いているものも含めて外す
      for (const perm of keepPermissions(site.baseDomain)) {
        Services.perms.removePermission(perm);
      }
    }
  }

  // ---- 書き出し ----

  function exportText(cookies, format) {
    if (format === 'json') {
      return JSON.stringify(cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.host,
        hostOnly: !c.isDomain,
        path: c.path,
        secure: c.isSecure,
        httpOnly: c.isHttpOnly,
        sameSite: sameSiteJson(c.sameSite),
        session: c.isSession,
        // UNIX 時間(秒)。セッション cookie には付けない
        ...(c.isSession ? {} : { expirationDate: Math.floor(c.expiry / 1000) }),
      })), null, 2) + '\n';
    }
    if (format === 'netscape' || format === 'netscapePlain') {
      const lines = ['# Netscape HTTP Cookie File', ''];
      for (const c of cookies) {
        // HttpOnly は行頭の #HttpOnly_ で表す(curl・yt-dlp が読める形)。印なしの形式では付けない
        const mark = format === 'netscape' && c.isHttpOnly ? '#HttpOnly_' : '';
        const domain = mark + c.host;
        lines.push([
          domain,
          c.isDomain ? 'TRUE' : 'FALSE',
          c.path,
          c.isSecure ? 'TRUE' : 'FALSE',
          c.isSession ? 0 : Math.floor(c.expiry / 1000),
          c.name,
          c.value,
        ].join('\t'));
      }
      return lines.join('\n') + '\n';
    }
    // Cookie ヘッダー: いまのページに送られる cookie だけでなく、一覧のものをすべて並べる
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  function copyText(text) {
    Cc['@mozilla.org/widget/clipboardhelper;1'].getService(Ci.nsIClipboardHelper).copyString(text);
  }

  function saveText(text, defaultName, format) {
    return new Promise((resolve, reject) => {
      const fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
      fp.init(win.browsingContext, L('cookie を保存', 'Save cookies'), Ci.nsIFilePicker.modeSave);
      fp.defaultString = defaultName;
      fp.defaultExtension = FORMATS[format].ext;
      fp.appendFilter(FORMATS[format].label, FORMATS[format].filter);
      fp.appendFilters(Ci.nsIFilePicker.filterAll);
      fp.open(async (result) => {
        try {
          if (result === Ci.nsIFilePicker.returnCancel || !fp.file) {
            resolve(null);
            return;
          }
          await IOUtils.writeUTF8(fp.file.path, text);
          resolve(fp.file.path);
        } catch (ex) {
          reject(ex);
        }
      });
    });
  }

  // ---- パネル ----

  let panel = null;
  let root = null;
  // 開いている編集欄(cookie のキー、または 'new')。開いている間は自動で描き直さない
  let editingKey = null;
  let lastFormat = 'json';
  let statusTimer = 0;
  // 描き直しても消えないように、表示中のメッセージを覚えておく
  let statusText = '';
  let statusKind = '';

  function keyOf(c) {
    return `${c.host}\n${c.path}\n${c.name}`;
  }

  function showStatus() {
    const el = root && root.querySelector('.ckm-status');
    if (!el) return;
    el.textContent = statusText;
    if (statusKind) el.dataset.kind = statusKind;
    else delete el.dataset.kind;
  }

  function setStatus(text, kind) {
    statusText = text || '';
    statusKind = kind || '';
    showStatus();
    win.clearTimeout(statusTimer);
    if (statusText && statusKind !== 'error') {
      statusTimer = win.setTimeout(() => setStatus(''), 4000);
    }
  }

  function reportError(message, ex) {
    console.error(LOG, message, ex);
    setStatus(`${message}: ${ex && ex.message ? ex.message : ex}`, 'error');
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = doc.createXULElement('panel');
    panel.id = PANEL_ID;
    panel.setAttribute('type', 'arrow');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', L('cookie の管理', 'Cookie manager'));
    root = h('div', { class: 'ckm-root' });
    panel.appendChild(root);
    panel.addEventListener('popupshowing', (e) => {
      if (e.target === panel) render();
    });
    panel.addEventListener('popupshown', (e) => {
      if (e.target === panel) button && button.setAttribute('open', 'true');
    });
    panel.addEventListener('popuphidden', (e) => {
      if (e.target !== panel) return;
      if (button) button.removeAttribute('open');
      editingKey = null;
      statusText = '';
      statusKind = '';
    });
    doc.getElementById('mainPopupSet').appendChild(panel);
    return panel;
  }

  // 編集欄。cookie が null なら新しく作る欄
  function buildForm(site, cookie, onDone) {
    const isNew = !cookie;
    const inSession = cookie ? cookie.isSession : true;
    // 新しい cookie の既定の期限は 30 日後
    const expiry = cookie && !cookie.isSession ? cookie.expiry : Date.now() + 30 * 24 * 3600 * 1000;

    const name = h('input', { type: 'text', value: cookie ? cookie.name : '', spellcheck: 'false' });
    const value = h('textarea', { rows: '3', spellcheck: 'false' });
    value.value = cookie ? cookie.value : '';
    const domain = h('input', { type: 'text', value: cookie ? cookie.host : site.host, spellcheck: 'false' });
    const path = h('input', { type: 'text', value: cookie ? cookie.path : '/', spellcheck: 'false' });
    const session = h('input', { type: 'checkbox', checked: inSession });
    const expires = h('input', { type: 'datetime-local', value: toLocalInput(expiry), disabled: inSession });
    session.addEventListener('change', () => { expires.disabled = session.checked; });
    const secure = h('input', { type: 'checkbox', checked: cookie ? cookie.isSecure : site.https });
    const httpOnly = h('input', { type: 'checkbox', checked: cookie ? cookie.isHttpOnly : false });
    const sameSite = h('select', {},
      SAMESITE.map(([v, label]) => h('option', { value: String(v), selected: cookie ? cookie.sameSite === v : v === Ci.nsICookie.SAMESITE_LAX }, label)));

    const save = () => {
      try {
        const host = domain.value.trim();
        if (!name.value && !value.value) throw new Error('名前か値を入れてください');
        if (!host) throw new Error('ドメインを入れてください');
        // SameSite=None は Secure が無いとブラウザが受け付けない
        if (Number(sameSite.value) === Ci.nsICookie.SAMESITE_NONE && !secure.checked) {
          throw new Error('SameSite を None にするときは Secure にもチェックを入れてください');
        }
        let expiryMs = 0;
        if (!session.checked) {
          expiryMs = new Date(expires.value).getTime();
          if (!Number.isFinite(expiryMs)) throw new Error('期限の日時が正しくありません');
        }
        const spec = {
          host,
          path: path.value.trim() || '/',
          name: name.value,
          value: value.value,
          secure: secure.checked,
          httpOnly: httpOnly.checked,
          session: session.checked,
          expiry: expiryMs,
          sameSite: Number(sameSite.value),
          schemeMap: cookie ? cookie.schemeMap : (site.https ? Ci.nsICookie.SCHEME_HTTPS : Ci.nsICookie.SCHEME_HTTP),
        };
        if (isNew) {
          addCookie(spec, site.originAttributes);
        } else {
          replaceCookie(cookie, spec);
        }
        editingKey = null;
        onDone(isNew ? L(`「${spec.name}」を作りました`, `Created "${spec.name}"`) : L(`「${spec.name}」を保存しました`, `Saved "${spec.name}"`));
      } catch (ex) {
        reportError('保存できませんでした', ex);
      }
    };

    const buttons = h('div', { class: 'ckm-row ckm-full' },
      h('button', { onclick: save }, isNew ? L('作る', 'Create') : L('保存', 'Save')),
      isNew ? null : h('button', {
        class: 'ckm-danger',
        onclick: () => {
          try {
            removeCookie(cookie);
            editingKey = null;
            onDone(L(`「${cookie.name}」を消しました`, `Deleted "${cookie.name}"`));
          } catch (ex) {
            reportError('消せませんでした', ex);
          }
        },
      }, L('消す', 'Delete')),
      h('span', { class: 'ckm-grow' }),
      h('button', { onclick: () => { editingKey = null; render(); } }, L('やめる', 'Cancel')));

    return h('div', { class: 'ckm-form' },
      h('span', { class: 'ckm-label' }, L('名前', 'Name')), name,
      h('span', { class: 'ckm-label' }, L('値', 'Value')), value,
      h('span', { class: 'ckm-label' }, L('ドメイン', 'Domain')), domain,
      h('span', { class: 'ckm-label' }, L('パス', 'Path')), path,
      h('span', { class: 'ckm-label' }, L('期限', 'Expires')),
      h('div', { class: 'ckm-row' }, h('label', {}, session, L('セッション', 'Session')), expires),
      h('span', { class: 'ckm-label' }, L('属性', 'Flags')),
      h('div', { class: 'ckm-row' },
        h('label', {}, secure, 'Secure'),
        h('label', {}, httpOnly, 'HttpOnly'),
        h('label', {}, 'SameSite', sameSite)),
      h('div', { class: 'ckm-full ckm-muted' },
        L('ドメインを「.example.com」のように . で始めると、サブドメインにも送られます。', 'A domain starting with a dot (like ".example.com") is also sent to subdomains.')),
      buttons);
  }

  function render() {
    if (!root) return;
    root.textContent = '';
    const site = currentSite();
    if (!site) {
      root.append(h('div', { class: 'ckm-empty' }, L('このページには cookie がありません(http・https のページだけ扱います)', 'No cookies for this page (only http and https pages are handled)')));
      return;
    }
    let cookies = [];
    try {
      cookies = listCookies(site);
    } catch (ex) {
      console.error(LOG, 'cookie を読めませんでした', ex);
    }
    const after = (message) => {
      render();
      setStatus(message);
    };

    // 見出しと「終了時に残す」
    const keep = h('input', { type: 'checkbox', checked: isKept(site) });
    keep.addEventListener('change', () => {
      try {
        setKept(site, keep.checked);
        setStatus(keep.checked ? L(`${site.baseDomain} を終了時に残します`, `${site.baseDomain} will be kept on exit`) : L(`${site.baseDomain} を終了時に残さないようにしました`, `${site.baseDomain} will no longer be kept on exit`));
      } catch (ex) {
        keep.checked = !keep.checked;
        reportError('切り替えられませんでした', ex);
      }
    });
    root.append(
      h('div', { class: 'ckm-title' }, L(`${site.baseDomain} の cookie(${cookies.length} 個)`, `Cookies for ${site.baseDomain} (${cookies.length})`)),
      h('div', { class: 'ckm-row' },
        h('label', {}, keep, L('終了時に残す', 'Keep on exit')),
        h('span', { class: 'ckm-muted' }, shutdownClearingOn()
          ? L('(Floorp を閉じたときに消す設定の例外にします)', '(adds an exception to "delete when Floorp is closed")')
          : L('(いまは「閉じたときに消す」設定がオフなので、どの cookie も残ります)', '("delete when closed" is off, so all cookies are kept)'))));

    // 操作の行
    const deleteAll = h('button', { class: 'ckm-danger', disabled: !cookies.length }, L('すべて消す', 'Delete all'));
    let armTimer = 0;
    deleteAll.addEventListener('click', () => {
      // 1 回目は確認の表示だけ。3 秒以内にもう一度押すと消す
      if (!deleteAll.hasAttribute('data-armed')) {
        deleteAll.setAttribute('data-armed', '');
        deleteAll.textContent = L('もう一度押すと消す', 'Press again to delete');
        armTimer = win.setTimeout(() => {
          deleteAll.removeAttribute('data-armed');
          deleteAll.textContent = L('すべて消す', 'Delete all');
        }, 3000);
        return;
      }
      win.clearTimeout(armTimer);
      let failed = 0;
      for (const c of cookies) {
        try {
          removeCookie(c);
        } catch (ex) {
          failed++;
          console.error(LOG, 'cookie を消せませんでした', c.name, ex);
        }
      }
      editingKey = null;
      render();
      if (failed) setStatus(L(`${failed} 個を消せませんでした`, `Couldn't delete ${failed}`), 'error');
      else setStatus(L(`${cookies.length} 個を消しました`, `Deleted ${cookies.length}`));
    });

    const format = h('select', {},
      Object.entries(FORMATS).map(([k, f]) => h('option', { value: k, selected: k === lastFormat }, f.label)));
    format.addEventListener('change', () => { lastFormat = format.value; });
    const copyBtn = h('button', {
      disabled: !cookies.length,
      onclick: () => {
        try {
          copyText(exportText(listCookies(site), format.value));
          setStatus(L(`${FORMATS[format.value].label} でコピーしました`, `Copied as ${FORMATS[format.value].label}`));
        } catch (ex) {
          reportError('コピーできませんでした', ex);
        }
      },
    }, L('コピー', 'Copy'));
    const saveBtn = h('button', {
      disabled: !cookies.length,
      onclick: async () => {
        const fmt = format.value;
        const now = new Date();
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
        const fileName = `cookies-${site.baseDomain}-${stamp}.${FORMATS[fmt].ext}`;
        let text;
        try {
          text = exportText(listCookies(site), fmt);
        } catch (ex) {
          reportError('書き出せませんでした', ex);
          return;
        }
        // 保存の画面(ネイティブのダイアログ)を出す前にパネルを閉じる。開いたままだと画面の切り替えで閉じて操作が切れる
        panel.hidePopup();
        try {
          const saved = await saveText(text, fileName, fmt);
          if (saved) console.info(LOG, '保存しました', saved);
        } catch (ex) {
          console.error(LOG, '保存できませんでした', ex);
          Services.prompt.alert(win, L('cookie の管理', 'Cookie manager'), L(`保存できませんでした: ${ex.message || ex}`, `Couldn't save: ${ex.message || ex}`));
        }
      },
    }, L('保存…', 'Save…'));

    root.append(
      h('div', { class: 'ckm-row' },
        h('button', { onclick: () => { editingKey = 'new'; render(); } }, L('＋ 新しく作る', '+ New')),
        h('span', { class: 'ckm-grow' }),
        deleteAll),
      h('div', { class: 'ckm-row' },
        h('span', { class: 'ckm-muted' }, L('書き出し', 'Export')), format, copyBtn, saveBtn),
      h('div', { class: 'ckm-muted' }, L('書き出したテキストがあれば、パスワードなしでログインできます。人に渡さないでください。', 'Anyone with the exported text can sign in without a password. Do not share it.')));

    if (editingKey === 'new') {
      root.append(h('div', { class: 'ckm-new' }, buildForm(site, null, after)));
    }

    // 一覧
    const list = h('div', { class: 'ckm-list' });
    if (!cookies.length) {
      list.append(h('div', { class: 'ckm-empty' }, L('cookie はありません', 'No cookies')));
    }
    for (const c of cookies) {
      const key = keyOf(c);
      const flags = [c.isSecure && 'Secure', c.isHttpOnly && 'HttpOnly'].filter(Boolean).join(' ');
      const head = h('div', {
        class: 'ckm-head',
        title: L('クリックで編集', 'Click to edit'),
        onclick: () => {
          editingKey = editingKey === key ? null : key;
          render();
        },
      },
      h('div', { class: 'ckm-row' },
        h('span', { class: 'ckm-name ckm-grow' }, c.name || L('(名前なし)', '(no name)')),
        h('span', { class: 'ckm-muted' }, formatExpiry(c))),
      h('div', { class: 'ckm-value' }, c.value || L('(空)', '(empty)')),
      h('div', { class: 'ckm-muted' }, `${c.host}${c.path}${flags ? '  ' + flags : ''}`));
      const item = h('div', { class: 'ckm-item' }, head);
      if (editingKey === key) item.append(buildForm(site, c, after));
      list.append(item);
    }
    root.append(list, h('div', { class: 'ckm-status' }));
    showStatus();
  }

  // パネルが開いている間に cookie が変わったら(ページが書き換えたなど)描き直す。編集中は描き直さない
  let refreshTimer = 0;
  const cookieObserver = {
    observe() {
      if (!panel || panel.state !== 'open' || editingKey) return;
      win.clearTimeout(refreshTimer);
      refreshTimer = win.setTimeout(() => {
        try {
          if (panel.state === 'open' && !editingKey) render();
        } catch (ex) {
          console.error(LOG, '描き直しに失敗しました', ex);
        }
      }, 300);
    },
  };

  // ---- アドレスバーのアイコン ----

  let button = null;

  function createButton() {
    const buttons = doc.getElementById('page-action-buttons');
    if (!buttons) throw new Error('アドレスバーの #page-action-buttons が見つかりません');
    button = doc.createXULElement('hbox');
    button.id = BUTTON_ID;
    button.className = 'urlbar-page-action';
    button.setAttribute('role', 'button');
    button.setAttribute('tooltiptext', L('cookie の管理', 'Cookie manager'));
    button.appendChild(h('span', { class: 'floorp-ckm-icon' }));
    button.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      try {
        const p = ensurePanel();
        if (p.state === 'open' || p.state === 'showing') {
          p.hidePopup();
        } else {
          p.openPopup(button, 'bottomright topright', 0, 0, false, false, e);
        }
      } catch (ex) {
        console.error(LOG, 'パネルを開けませんでした', ex);
      }
    });
    const star = doc.getElementById('star-button-box');
    if (star && star.parentNode === buttons) buttons.insertBefore(button, star);
    else buttons.appendChild(button);
  }

  // http・https のページのときだけアイコンを出す
  function updateButton() {
    if (!button) return;
    const uri = win.gBrowser.selectedBrowser.currentURI;
    button.hidden = !(uri && /^https?$/.test(uri.scheme));
  }

  const progressListener = {
    QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
    onLocationChange(webProgress) {
      if (!webProgress || webProgress.isTopLevel) updateButton();
    },
  };

  function injectStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElementNS(HTML_NS, 'style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.documentElement.appendChild(style);
  }

  function init() {
    try {
      injectStyle();
      createButton();
      updateButton();
      win.gBrowser.addProgressListener(progressListener);
      Services.obs.addObserver(cookieObserver, 'cookie-changed');
      win.addEventListener('unload', () => {
        try {
          win.gBrowser.removeProgressListener(progressListener);
          Services.obs.removeObserver(cookieObserver, 'cookie-changed');
        } catch (ex) {
          console.error(LOG, '後片付けに失敗しました', ex);
        }
      }, { once: true });
    } catch (ex) {
      console.error(LOG, '初期化に失敗しました', ex);
    }
  }

  if (win.gBrowserInit && win.gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    const obs = (subject, topic) => {
      if (subject === win) {
        Services.obs.removeObserver(obs, topic);
        init();
      }
    };
    Services.obs.addObserver(obs, 'browser-delayed-startup-finished');
  }
})(window);
