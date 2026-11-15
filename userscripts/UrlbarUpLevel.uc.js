// ==UserScript==
// @name            UrlbarUpLevel
// @description     URL の上の階層へ移動する。Ctrl を押している間はアドレスバーの URL を区切りごとにクリックでき、☆ の並びの ↑ ボタンで上の階層の一覧を出す
// @include         main
// @version         1.0.2
// ==/UserScript==

// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
// 上の階層の順番: クエリ(?…)とフラグメント(#…)を外す → パスを 1 つずつ上がる → サブドメインを 1 つずつ削る
// (example.com のような登録できるドメインで止まる)。
// 区切りのクリックは、アドレスバーの入力欄の上に透明な箱を重ね、URL の文字の位置に合わせて区切りごとの
// 当たり判定を置く。Ctrl を押している間だけクリックを受け付けるので、普通のクリックはいつもどおり編集になる。

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

  const LOG = '[UrlbarUpLevel]';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const BUTTON_ID = 'floorp-uplevel-button';
  const MENU_ID = 'floorp-uplevel-menu';
  const OVERLAY_ID = 'floorp-uplevel-overlay';
  const STYLE_ID = 'floorp-uplevel-style';

  const doc = win.document;

  // 上向きの矢印と、その上の横線(「上の階層」)。mask に使うので色は currentColor で塗る
  const ICON_URL = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 2.5h10M8 14V6M4.5 9.5 8 6l3.5 3.5"/>' +
    '</svg>'
  );

  const CSS = `
    #${BUTTON_ID} > .floorp-uplevel-icon {
      width: 16px;
      height: 16px;
      background-color: currentColor;
      mask: url("${ICON_URL}") center / 16px 16px no-repeat;
    }
    /* 一覧にはチェックもアイコンも無いので、チェック用に空けてある左の余白を詰める。
       Floorp のデザイン Lepton は padding-inline-start: var(--menu-background-padding-default) !important
       (1em + 24px)を付けていて、こちらの !important では上書きできないので、その変数をこのメニューで変える */
    #${MENU_ID} {
      --menu-background-padding-default: var(--context-menu-background-padding, 12px);
    }
    #${OVERLAY_ID} {
      position: absolute;
      top: 0;
      bottom: 0;
      overflow: hidden;
      pointer-events: none;
      z-index: 2;
    }
    #${OVERLAY_ID}[hidden] {
      display: none;
    }
    #${OVERLAY_ID} > .floorp-uplevel-seg {
      position: absolute;
      top: 15%;
      bottom: 15%;
      pointer-events: auto;
      cursor: pointer;
      border-radius: 3px;
      /* 区切りが分かるように、点線の下線を出す */
      box-shadow: inset 0 -1px 0 color-mix(in srgb, currentColor 45%, transparent);
    }
    #${OVERLAY_ID} > .floorp-uplevel-seg:hover {
      background-color: color-mix(in srgb, currentColor 14%, transparent);
      box-shadow: inset 0 -2px 0 currentColor;
    }
  `;

  // ---- 上の階層 ----

  function baseDomainOf(host) {
    try {
      return Services.eTLD.getBaseDomainFromHost(host);
    } catch (ex) {
      // IP アドレス・localhost・単一ラベルのホストは削らない
      return host;
    }
  }

  // いまの URL から近い順に、上の階層の URL を並べる
  function parentLevels(spec) {
    let url;
    try {
      url = new URL(spec);
    } catch (ex) {
      return [];
    }
    if (!/^(https?|ftp|file):$/.test(url.protocol)) return [];
    const out = [];
    const push = (href) => {
      if (href !== spec && !out.includes(href)) out.push(href);
    };

    // 1. クエリとフラグメントを外す
    url.search = '';
    url.hash = '';
    push(url.href);

    // 2. パスを 1 つずつ上がる。/a/b/c → /a/b/ → /a/ → /
    const segs = url.pathname.split('/');
    if (segs.length > 1 && segs[segs.length - 1] === '') segs.pop();
    while (segs.length > 1) {
      segs.pop();
      url.pathname = segs.join('/') + '/';
      push(url.href);
    }

    // 3. サブドメインを 1 つずつ削る。www.sub.example.com → sub.example.com → example.com
    if (url.protocol !== 'file:' && url.hostname) {
      const base = baseDomainOf(url.hostname);
      let host = url.hostname;
      while (host !== base && host.includes('.') && host.endsWith('.' + base)) {
        host = host.slice(host.indexOf('.') + 1);
        url.hostname = host;
        push(url.href);
      }
    }
    return out;
  }

  // 一覧に出す形(%エンコードを戻して読みやすく)
  function displayOf(href) {
    try {
      return win.losslessDecodeURI(Services.io.newURI(href));
    } catch (ex) {
      return href;
    }
  }

  function currentSpec() {
    const uri = win.gBrowser.selectedBrowser.currentURI;
    return uri ? uri.spec : '';
  }

  function openUrl(href, where) {
    win.openTrustedLinkIn(href, where || 'current');
  }

  // ---- ↑ ボタンと一覧 ----

  let button = null;
  let menu = null;

  function ensureMenu() {
    if (menu) return menu;
    menu = doc.createXULElement('menupopup');
    menu.id = MENU_ID;
    menu.addEventListener('popupshowing', (e) => {
      if (e.target !== menu) return;
      try {
        fillMenu();
      } catch (ex) {
        console.error(LOG, '一覧を作れませんでした', ex);
      }
    });
    menu.addEventListener('popupshown', (e) => {
      if (e.target === menu && button) button.setAttribute('open', 'true');
    });
    menu.addEventListener('popuphidden', (e) => {
      if (e.target === menu && button) button.removeAttribute('open');
    });
    doc.getElementById('mainPopupSet').appendChild(menu);
    return menu;
  }

  function fillMenu() {
    menu.textContent = '';
    const levels = parentLevels(currentSpec());
    if (!levels.length) {
      const empty = doc.createXULElement('menuitem');
      empty.setAttribute('label', L('上の階層はありません', 'No parent levels'));
      empty.setAttribute('disabled', 'true');
      menu.appendChild(empty);
      return;
    }
    for (const href of levels) {
      const item = doc.createXULElement('menuitem');
      item.setAttribute('label', displayOf(href));
      item.setAttribute('tooltiptext', href);
      item.addEventListener('command', (e) => {
        try {
          // Ctrl・Shift などを押しながらなら新しいタブ・ウィンドウ(リンクと同じ決まり)
          openUrl(href, win.BrowserUtils.whereToOpenLink(e, false, true));
        } catch (ex) {
          console.error(LOG, '移動できませんでした', href, ex);
        }
      });
      // 中クリックは新しいタブ(メニューは閉じる)
      item.addEventListener('click', (e) => {
        if (e.button !== 1) return;
        try {
          openUrl(href, 'tab');
          menu.hidePopup();
        } catch (ex) {
          console.error(LOG, '新しいタブで開けませんでした', href, ex);
        }
      });
      menu.appendChild(item);
    }
  }

  function createButton() {
    const buttons = doc.getElementById('page-action-buttons');
    if (!buttons) throw new Error('アドレスバーの #page-action-buttons が見つかりません');
    button = doc.createXULElement('hbox');
    button.id = BUTTON_ID;
    button.className = 'urlbar-page-action';
    button.setAttribute('role', 'button');
    button.setAttribute('tooltiptext', L('上の階層へ', 'Go up a level'));
    button.appendChild(doc.createElementNS(HTML_NS, 'span')).className = 'floorp-uplevel-icon';
    // アドレスバーにフォーカスが移らないように mousedown を止め、一覧は click で開く
    // (ほかのアドレスバーのアイコンと同じく click で動くので、UrlbarIconDrawer.uc.js の「…」の中からも押せる)
    button.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      try {
        const m = ensureMenu();
        if (m.state === 'open' || m.state === 'showing') {
          m.hidePopup();
        } else {
          m.openPopup(button, 'after_end', 0, 0, false, false, e);
        }
      } catch (ex) {
        console.error(LOG, '一覧を開けませんでした', ex);
      }
    });
    // ☆ の左(ほかのスクリプトのアイコンより右)に置く
    const star = doc.getElementById('star-button-box');
    if (star && star.parentNode === buttons) buttons.insertBefore(button, star);
    else buttons.appendChild(button);
  }

  function updateButton() {
    if (!button) return;
    button.hidden = parentLevels(currentSpec()).length === 0;
  }

  // ---- Ctrl+クリックの区切り ----

  let overlay = null;
  let measureCanvas = null;
  let ctrlDown = false;

  function urlbarInput() {
    return win.gURLBar && win.gURLBar.inputField;
  }

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    const input = urlbarInput();
    const box = input && input.parentNode;
    if (!box) return null;
    overlay = doc.createElementNS(HTML_NS, 'div');
    overlay.id = OVERLAY_ID;
    overlay.hidden = true;
    overlay.addEventListener('mousedown', onSegMouseDown, true);
    overlay.addEventListener('click', onSegClick, true);
    overlay.addEventListener('auxclick', onSegClick, true);
    // 入力欄の親を基準に位置を決めるので、親を position: relative にしておく
    if (win.getComputedStyle(box).position === 'static') box.style.position = 'relative';
    box.appendChild(overlay);
    return overlay;
  }

  // 表示中の URL の文字列を、区切りごとの { start, end, href } に分ける。
  // 表示は https:// が省かれたり、%エンコードが戻されたりしているので、表示の文字列そのものを区切り、
  // 本物の URL の区切りと数が合うときだけ対応させる
  function segmentsOf(display, spec) {
    let url;
    try {
      url = new URL(spec);
    } catch (ex) {
      return [];
    }
    if (!/^(https?|ftp|file):$/.test(url.protocol)) return [];
    const segs = [];
    const add = (start, end, href) => {
      if (end > start && href !== spec) segs.push({ start, end, href });
    };
    const origin = url.protocol === 'file:' ? 'file://' : url.origin;

    const isFile = url.protocol === 'file:';
    // file:///D:/a は「file://」の後ろ(/D:/a)がそのままパス。ほかは「scheme://」の後ろがホスト
    const prefix = isFile
      ? (display.match(/^file:\/\//i) || [''])[0]
      : (display.match(/^[a-z][a-z0-9+.-]*:\/\/+/i) || [''])[0];
    const rest = display.slice(prefix.length);
    let hostEnd = isFile ? 0 : rest.search(/[/?#]/);
    if (hostEnd < 0) hostEnd = rest.length;
    const hostDisp = rest.slice(0, hostEnd);

    // ホスト: 各ラベルを押すと、そこから右のホストへ(登録できるドメインはまとめて 1 つ)
    if (url.protocol !== 'file:' && url.hostname) {
      const hostOnly = hostDisp.replace(/:\d+$/, '').replace(/^[^@]*@/, '');
      const hostOffset = prefix.length + hostDisp.indexOf(hostOnly);
      const dispLabels = hostOnly.split('.');
      const realLabels = url.hostname.split('.');
      const base = baseDomainOf(url.hostname);
      const baseCount = base.split('.').length;
      if (dispLabels.length === realLabels.length && realLabels.length >= baseCount) {
        let pos = hostOffset;
        const subCount = realLabels.length - baseCount;
        for (let i = 0; i < subCount; i++) {
          const u = new URL(origin);
          u.hostname = realLabels.slice(i).join('.');
          // サブドメインのラベルとその後ろの「.」
          add(pos, pos + dispLabels[i].length + 1, u.href);
          pos += dispLabels[i].length + 1;
        }
        const u = new URL(origin);
        u.hostname = base;
        // 登録できるドメインとポート
        add(pos, prefix.length + hostEnd, u.href);
      }
    }

    // パス: 各区切りを押すと、その区切りまでの階層へ
    const pathAndRest = rest.slice(hostEnd);
    let pathEnd = pathAndRest.search(/[?#]/);
    if (pathEnd < 0) pathEnd = pathAndRest.length;
    const pathDisp = pathAndRest.slice(0, pathEnd);
    const dispParts = pathDisp.split('/');
    const realParts = url.pathname.split('/');
    if (pathDisp && dispParts.length === realParts.length) {
      let pos = prefix.length + hostEnd;
      for (let k = 1; k < realParts.length; k++) {
        const segStart = pos;
        pos += 1 + dispParts[k].length;
        if (!realParts[k]) continue;
        const isLast = k === realParts.length - 1;
        // 最後の区切り(ファイル名)はそのまま、途中の区切りは「/」で終わるディレクトリにする
        const path = realParts.slice(0, k + 1).join('/') + (isLast ? '' : '/');
        add(segStart, pos, (url.protocol === 'file:' ? 'file://' + (url.host || '') : origin) + path);
      }
    }
    return segs;
  }

  function measure(text, cs) {
    if (!measureCanvas) measureCanvas = doc.createElementNS(HTML_NS, 'canvas');
    const ctx = measureCanvas.getContext('2d');
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    try {
      ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    } catch (ex) {
      // letterSpacing に対応していなければそのまま
    }
    return ctx.measureText(text).width;
  }

  // 入力欄の文字の表示領域(テキストエディターの中身)。取れなければ入力欄そのもの
  function textArea(input) {
    try {
      return (input.editor && input.editor.rootElement) || input;
    } catch (ex) {
      return input;
    }
  }

  function canShowSegments() {
    const urlbar = win.gURLBar;
    if (!urlbar || urlbar.focused) return false;
    // アドレスバーがいまのページの URL を表示しているときだけ(入力途中の文字ではない)
    if (urlbar.getAttribute('pageproxystate') !== 'valid') return false;
    return true;
  }

  function showSegments() {
    const ov = ensureOverlay();
    if (!ov) return;
    ov.textContent = '';
    ov.hidden = true;
    if (!canShowSegments()) return;
    const input = urlbarInput();
    const display = input.value;
    const segs = segmentsOf(display, currentSpec());
    if (!segs.length) return;
    const area = textArea(input);
    const parentRect = ov.parentNode.getBoundingClientRect();
    const areaRect = area.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const cs = win.getComputedStyle(input);
    // 箱は入力欄と同じ範囲(はみ出た分は隠す)。区切りの位置は文字の表示領域の左端から測る
    ov.style.left = `${inputRect.left - parentRect.left}px`;
    ov.style.width = `${inputRect.width}px`;
    const origin = areaRect.left - inputRect.left - Math.max(area.scrollLeft || 0, input.scrollLeft || 0);
    for (const seg of segs) {
      const el = doc.createElementNS(HTML_NS, 'div');
      el.className = 'floorp-uplevel-seg';
      el.dataset.href = seg.href;
      el.title = displayOf(seg.href);
      el.style.left = `${origin + measure(display.slice(0, seg.start), cs)}px`;
      el.style.width = `${measure(display.slice(seg.start, seg.end), cs)}px`;
      ov.appendChild(el);
    }
    ov.hidden = false;
  }

  function hideSegments() {
    if (overlay) {
      overlay.hidden = true;
      overlay.textContent = '';
    }
  }

  function onSegMouseDown(e) {
    // アドレスバーにフォーカスが移って編集にならないようにする
    if (!e.target.dataset || !e.target.dataset.href) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onSegClick(e) {
    const href = e.target.dataset && e.target.dataset.href;
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'click' && e.button !== 0) return;
    if (e.type === 'auxclick' && e.button !== 1) return;
    try {
      // Ctrl+クリックはこのタブで、Ctrl+中クリックは新しいタブで開く
      openUrl(href, e.button === 1 ? 'tab' : 'current');
    } catch (ex) {
      console.error(LOG, '移動できませんでした', href, ex);
    } finally {
      hideSegments();
    }
  }

  function onKeyDown(e) {
    try {
      if (e.key === 'Control') {
        if (!ctrlDown && !e.repeat) {
          ctrlDown = true;
          showSegments();
        }
        return;
      }
      // Ctrl+T などのショートカットを押したときは区切りを消す
      if (ctrlDown) hideSegments();
    } catch (ex) {
      console.error(LOG, '区切りを出せませんでした', ex);
    }
  }

  function onKeyUp(e) {
    if (e.key !== 'Control') return;
    ctrlDown = false;
    hideSegments();
  }

  function onBlur() {
    ctrlDown = false;
    hideSegments();
  }

  // ---- 準備 ----

  const progressListener = {
    QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
    onLocationChange(webProgress) {
      if (webProgress && !webProgress.isTopLevel) return;
      updateButton();
      hideSegments();
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
      win.addEventListener('keydown', onKeyDown, true);
      win.addEventListener('keyup', onKeyUp, true);
      win.addEventListener('blur', onBlur);
      win.addEventListener('unload', () => {
        try {
          win.gBrowser.removeProgressListener(progressListener);
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
