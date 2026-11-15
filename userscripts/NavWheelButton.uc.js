// ==UserScript==
// @name            NavWheelButton
// @description     戻る・進む・更新・中止を 1 つのボタンにまとめる。ボタンの上でホイールを回すと履歴の一覧が出て、手を止めるとそのページへ移る
// @include         main
// @version         1.2.2
// ==/UserScript==

// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
// ボタンは CustomizableUI のウィジェット(type: custom)。ウィジェットの登録は全ウィンドウで 1 回だけなので、
// 登録に使う関数がどこかのウィンドウのものだと、そのウィンドウを閉じたあと死んだ参照になる。
// そこで登録はシステム権限のサンドボックスの中で行い、onBuild では要素を作るだけにする。
// 動き(ホイール・クリック・一覧)は、各ウィンドウのこのスクリプトが自分のウィンドウの要素に付ける(attach)。

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

  const LOG = '[NavWheelButton]';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const WIDGET_ID = 'floorp-navwheel-button';
  const PANEL_ID = 'floorp-navwheel-panel';
  const STYLE_ID = 'floorp-navwheel-style';
  const HIDE_ATTR = 'floorp-navwheel-hide-original';
  const PREF = 'userChromeJS.navWheel.';
  const MIGRATED_PREF = PREF + 'migrated';
  // 一覧の行数が多いときも、選んでいる行が見えるようにスクロールする
  const MAX_STEPS = 4; // 見た目の伸びは 4 段まで(それ以上回しても形は変わらない)
  const PIXELS_PER_STEP = 50; // タッチパッドなど、ピクセル単位のホイールで 1 段とみなす量

  const doc = win.document;
  // gBrowser はウィンドウの読み込みの途中でできるので、ここでは確かめない(init で確かめる)
  const CUI = win.CustomizableUI;
  if (!CUI) {
    console.error(LOG, 'CustomizableUI が無いので動きません');
    return;
  }

  // ---- 設定 ----

  const DEFAULTS = {
    look: 'chevron', // chevron: 開く山かっこ / drop: しずく
    wheelDownGoesBack: true,
    delay: 600, // ホイールを止めてから移動するまで(ms)。0 = クリックで決める
    hideOriginal: true,
    maxRows: 0, // 一覧に出す件数。0 = 制限なし
    click: 'reload',
    middleClick: 'duplicate',
    shiftClick: 'reloadSkipCache',
    ctrlClick: 'none',
    altClick: 'none',
    shiftWheel: 'site',
    ctrlWheel: 'jump',
  };

  const ACTIONS = [
    ['reload', L('更新(読み込み中は中止)', 'Reload (stop while loading)')],
    ['reloadSkipCache', L('キャッシュを無視して更新', 'Reload, bypassing cache')],
    ['stop', L('中止', 'Stop')],
    ['back', L('戻る', 'Back')],
    ['forward', L('進む', 'Forward')],
    ['history', L('履歴の一覧', 'History list')],
    ['duplicate', L('タブを複製', 'Duplicate tab')],
    ['none', L('何もしない', 'Nothing')],
  ];
  const WHEEL_ACTIONS = [
    ['step', L('1 ページずつ', 'One page at a time')],
    ['site', L('同じサイトの中だけ', 'Within the same site')],
    ['jump', L('サイトの切れ目ごと', 'Jump between sites')],
    ['none', L('何もしない', 'Nothing')],
  ];
  const DELAYS = [
    [400, L('0.4 秒', '0.4 s')],
    [600, L('0.6 秒', '0.6 s')],
    [800, L('0.8 秒', '0.8 s')],
    [1000, L('1 秒', '1 s')],
    [1500, L('1.5 秒', '1.5 s')],
    [0, L('クリックで決める', 'On click')],
  ];
  const MAX_ROWS = [
    [0, L('制限なし', 'No limit')],
    [5, L('5 件', '5')],
    [10, L('10 件', '10')],
    [15, L('15 件', '15')],
    [20, L('20 件', '20')],
    [30, L('30 件', '30')],
  ];

  function getPref(key) {
    const def = DEFAULTS[key];
    const name = PREF + key;
    try {
      if (typeof def === 'boolean') return Services.prefs.getBoolPref(name, def);
      if (typeof def === 'number') return Services.prefs.getIntPref(name, def);
      return Services.prefs.getStringPref(name, def);
    } catch (ex) {
      console.error(LOG, `設定 ${name} を読めませんでした。既定値を使います`, ex);
      return def;
    }
  }

  function setPref(key, value) {
    const name = PREF + key;
    try {
      if (typeof value === 'boolean') Services.prefs.setBoolPref(name, value);
      else if (typeof value === 'number') Services.prefs.setIntPref(name, value);
      else Services.prefs.setStringPref(name, value);
    } catch (ex) {
      console.error(LOG, `設定 ${name} を保存できませんでした`, ex);
    }
  }

  // ---- しずくの形 ----

  // しずく: 半径 R の丸から、片側が流れ出すように伸びる。伸びた先は半円で閉じる(先の丸さ TIP、1 段の伸び LEN)
  const R = 7;
  const CX = 16;
  const CY = 16;
  const TIP = 3;
  const LEN = 2.5;

  function dropPath(x) {
    const s = Math.sign(x) || 1;
    const a = Math.abs(x);
    if (a < 0.02) {
      return `M${CX - R} ${CY}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0Z`;
    }
    const L = R + a * LEN;
    const tr = Math.min(R * 0.9, Math.max(1, TIP - a * 0.15));
    const w = R * (1 - Math.min(0.2, a * 0.04));
    const tx = CX + s * L - s * tr;
    const n = Math.max(tr * 0.75, Math.min(w, tr + (w - tr) * 0.35));
    const mx = CX + s * (L - tr) * 0.55;
    const sweep = s > 0 ? 1 : 0;
    return `M${CX} ${CY - w} C ${CX + s * R * 0.8} ${CY - w} ${mx} ${CY - n} ${tx} ${CY - tr} ` +
      `A ${tr} ${tr} 0 0 ${sweep} ${tx} ${CY + tr} C ${mx} ${CY + n} ${CX + s * R * 0.8} ${CY + w} ${CX} ${CY + w} ` +
      `A ${w} ${w} 0 0 ${sweep} ${CX} ${CY - w} Z`;
  }

  // 山かっこの形(ふだん / 中止の ×)。d を CSS で切り替えると、同じ命令の並びなので形が滑らかに変わる
  const CHEV_L = 'M14 9 L8 16 L14 23';
  const CHEV_R = 'M18 9 L24 16 L18 23';
  const STOP_L = 'M11.5 11.5 L16 16 L11.5 20.5';
  const STOP_R = 'M20.5 11.5 L16 16 L20.5 20.5';

  const CSS = `
    #${WIDGET_ID} {
      -moz-window-dragging: no-drag;
    }
    #${WIDGET_ID} > .nw-box {
      box-sizing: border-box;
      width: calc(2 * var(--toolbarbutton-inner-padding, 8px) + 16px);
      height: calc(2 * var(--toolbarbutton-inner-padding, 8px) + 16px);
      margin: 0 var(--toolbarbutton-outer-padding, 2px);
      /* ツールバーの高さの真ん中に置く(ほかのボタンのアイコンと高さをそろえる) */
      align-self: center;
      border-radius: var(--toolbarbutton-border-radius, 4px);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--toolbarbutton-icon-fill, currentColor);
    }
    #${WIDGET_ID}:not([disabled]) > .nw-box:hover {
      background-color: var(--toolbarbutton-hover-background);
    }
    #${WIDGET_ID}:not([disabled]) > .nw-box:hover:active,
    #${WIDGET_ID}[open] > .nw-box {
      background-color: var(--toolbarbutton-active-background);
    }
    #${WIDGET_ID} svg {
      width: 16px;
      height: 16px;
      overflow: visible;
      pointer-events: none;
    }
    /* 見た目の切り替え */
    #${WIDGET_ID}:not([look="drop"]) .nw-drop-g,
    #${WIDGET_ID}[look="drop"] .nw-chev-g {
      display: none;
    }
    /* 山かっこ */
    #${WIDGET_ID} .nw-chev-g {
      transform-origin: ${CX}px ${CY}px;
    }
    #${WIDGET_ID} .nw-chev {
      fill: none;
      stroke: currentColor;
      stroke-width: 2.4;
      stroke-linecap: round;
      stroke-linejoin: round;
      transition: d 0.25s cubic-bezier(0.3, 1.4, 0.5, 1), transform 0.25s, opacity 0.25s;
    }
    #${WIDGET_ID} .nw-chev-l { d: path("${CHEV_L}"); }
    #${WIDGET_ID} .nw-chev-r { d: path("${CHEV_R}"); }
    /* しずく */
    #${WIDGET_ID} .nw-drop {
      fill: currentColor;
      transform-origin: ${CX}px ${CY}px;
      transition: opacity 0.2s, transform 0.25s cubic-bezier(0.3, 1.4, 0.5, 1);
    }
    #${WIDGET_ID} .nw-stop {
      fill: currentColor;
      opacity: 0;
      transform: scale(0.5);
      transform-origin: ${CX}px ${CY}px;
      transition: opacity 0.2s, transform 0.25s cubic-bezier(0.3, 1.4, 0.5, 1);
    }
    /* 読み込み中: 山かっこは 2 枚が回り、しずくは跳ねる */
    #${WIDGET_ID}[loading]:not([selecting]) .nw-chev-g {
      animation: floorp-nw-spin 1.1s cubic-bezier(0.5, 0, 0.5, 1) infinite;
    }
    #${WIDGET_ID}[loading]:not([selecting]) .nw-drop {
      animation: floorp-nw-bounce 0.7s ease-in-out infinite;
    }
    /* 読み込み中にマウスを乗せると中止の形: 山かっこは × に組み変わり、しずくは ■ になる */
    #${WIDGET_ID}[loading]:not([selecting]) > .nw-box:hover .nw-chev-g,
    #${WIDGET_ID}[loading]:not([selecting]) > .nw-box:hover .nw-drop {
      animation: none;
    }
    #${WIDGET_ID}[loading]:not([selecting]) > .nw-box:hover .nw-chev-l { d: path("${STOP_L}"); }
    #${WIDGET_ID}[loading]:not([selecting]) > .nw-box:hover .nw-chev-r { d: path("${STOP_R}"); }
    #${WIDGET_ID}[loading]:not([selecting]) > .nw-box:hover .nw-drop {
      opacity: 0;
      transform: scale(0.6);
    }
    #${WIDGET_ID}[loading]:not([selecting]) > .nw-box:hover .nw-stop {
      opacity: 1;
      transform: scale(1);
    }
    @keyframes floorp-nw-spin {
      to { transform: rotate(360deg); }
    }
    @keyframes floorp-nw-bounce {
      0%, 100% { transform: translateY(0); }
      40% { transform: translateY(-4px); }
    }
    /* 元の戻る・進むボタン(ブラウザ本体が外せないボタンにしているので、置いている間は隠す) */
    :root[${HIDE_ATTR}]:not([customizing]) #back-button,
    :root[${HIDE_ATTR}]:not([customizing]) #forward-button {
      display: none !important;
    }

    /* ---- 履歴の一覧と設定 ---- */
    #${PANEL_ID} {
      --panel-padding: 0;
    }
    #${PANEL_ID} .nw-inner {
      min-width: 200px;
      max-width: 400px;
      padding: 4px;
    }
    #${PANEL_ID} .nw-head {
      align-items: center;
      padding: 2px 2px 4px 8px;
      min-height: 26px;
    }
    #${PANEL_ID} .nw-head-title {
      flex: 1;
      margin: 0;
      font-size: 0.9em;
      opacity: 0.7;
    }
    #${PANEL_ID} .nw-icon-btn {
      appearance: none;
      width: 20px;
      height: 20px;
      min-width: 0;
      margin: 0;
      padding: 4px;
      border-radius: 4px;
      -moz-context-properties: fill;
      fill: currentColor;
    }
    #${PANEL_ID} .nw-icon-btn:hover {
      background-color: var(--button-hover-bgcolor, color-mix(in srgb, currentColor 12%, transparent));
    }
    #${PANEL_ID} .nw-icon-btn > .toolbarbutton-icon {
      width: 12px;
      height: 12px;
    }
    #${PANEL_ID} .nw-icon-btn > .toolbarbutton-text {
      display: none;
    }
    #${PANEL_ID} .nw-list {
      max-height: 420px;
      overflow-y: auto;
    }
    #${PANEL_ID} .nw-row {
      align-items: center;
      gap: 8px;
      padding: 5px 10px 5px 8px;
      border-radius: 4px;
      cursor: default;
    }
    #${PANEL_ID} .nw-row:hover {
      background-color: color-mix(in srgb, currentColor 10%, transparent);
    }
    #${PANEL_ID} .nw-row[selected] {
      background-color: color-mix(in srgb, var(--focus-outline-color, AccentColor) 22%, transparent);
    }
    #${PANEL_ID} .nw-row[current] > .nw-title {
      font-weight: 600;
    }
    #${PANEL_ID} .nw-dotbox {
      width: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex: none;
    }
    /* 塗り = 戻れる、白抜き = 進める、大きい点 = いま */
    #${PANEL_ID} .nw-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      box-sizing: border-box;
      background-color: currentColor;
      opacity: 0.55;
    }
    #${PANEL_ID} .nw-row[forward] .nw-dot {
      background-color: transparent;
      border: 1px solid currentColor;
    }
    #${PANEL_ID} .nw-row[current] .nw-dot {
      width: 10px;
      height: 10px;
      opacity: 1;
      background-color: var(--focus-outline-color, AccentColor);
    }
    #${PANEL_ID} .nw-favicon {
      width: 16px;
      height: 16px;
      flex: none;
    }
    #${PANEL_ID} .nw-title {
      flex: 1;
      min-width: 0;
      margin: 0;
    }
    #${PANEL_ID} .nw-settings {
      padding: 2px 6px 6px;
      min-width: 300px;
    }
    #${PANEL_ID} .nw-set-row {
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 30px;
    }
    #${PANEL_ID} .nw-set-row > label {
      margin: 0;
    }
    #${PANEL_ID} .nw-set-row > menulist {
      margin: 0;
      min-width: 0;
    }
    #${PANEL_ID} .nw-sep {
      border-top: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      margin: 6px 0;
    }
    #${PANEL_ID} .nw-seg {
      display: flex;
      border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
      border-radius: 6px;
      overflow: hidden;
    }
    #${PANEL_ID} .nw-seg > button {
      appearance: none;
      border: none;
      margin: 0;
      padding: 3px 10px;
      background: transparent;
      color: inherit;
      font: inherit;
    }
    #${PANEL_ID} .nw-seg > button + button {
      border-inline-start: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    }
    #${PANEL_ID} .nw-seg > button:hover {
      background-color: color-mix(in srgb, currentColor 10%, transparent);
    }
    #${PANEL_ID} .nw-seg > button[selected] {
      background-color: color-mix(in srgb, var(--focus-outline-color, AccentColor) 25%, transparent);
    }
  `;

  // ---- ウィジェットの登録(全ウィンドウで 1 回) ----

  function ensureWidget() {
    const w = CUI.getWidget(WIDGET_ID);
    if (w && w.provider === CUI.PROVIDER_API) return;
    // 登録をサンドボックスの中で行う(冒頭のコメント参照)
    const sb = Components.utils.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
      sandboxName: 'NavWheelButton widget',
      wantComponents: false,
    });
    sb.CustomizableUI = CUI;
    sb.WIDGET_ID = WIDGET_ID;
    sb.WIDGET_LABEL = L('戻る・進む・更新', 'Back, Forward, Reload');
    Components.utils.evalInSandbox(`
      CustomizableUI.createWidget({
        id: WIDGET_ID,
        type: 'custom',
        label: WIDGET_LABEL,
        removable: true,
        onBuild(d) {
          const item = d.createXULElement('toolbaritem');
          item.id = WIDGET_ID;
          item.className = 'chromeclass-toolbar-additional';
          item.setAttribute('label', WIDGET_LABEL);
          item.setAttribute('removable', 'true');
          item.setAttribute('overflows', 'false');
          try {
            const hook = d.defaultView.FloorpNavWheel;
            if (hook) hook.attach(item);
          } catch (e) {
            Components.utils.reportError(e);
          }
          return item;
        },
      });
    `, sb);
  }

  // 初回だけ: 戻るボタンの場所に置き、更新ボタンをパレットへしまう(戻る・進むは外せないので CSS で隠す)
  function migrateOnce() {
    if (Services.prefs.getBoolPref(MIGRATED_PREF, false)) return;
    Services.prefs.setBoolPref(MIGRATED_PREF, true);
    try {
      if (!CUI.getPlacementOfWidget(WIDGET_ID)) {
        const back = CUI.getPlacementOfWidget('back-button');
        if (back) CUI.addWidgetToArea(WIDGET_ID, back.area, back.position);
        else CUI.addWidgetToArea(WIDGET_ID, CUI.AREA_NAVBAR, 0);
      }
      if (CUI.getPlacementOfWidget('stop-reload-button')) CUI.removeWidgetFromArea('stop-reload-button');
    } catch (ex) {
      console.error(LOG, 'ボタンをツールバーに置けませんでした', ex);
    }
  }

  // ---- 履歴 ----

  function hostOf(url) {
    try {
      const u = Services.io.newURI(url);
      return u.host || u.prePath;
    } catch (ex) {
      return url;
    }
  }

  function readHistory() {
    const browser = win.gBrowser.selectedBrowser;
    const sh = browser.browsingContext && browser.browsingContext.sessionHistory;
    if (!sh || !sh.count) {
      return { index: 0, entries: [{ title: browser.contentTitle || browser.currentURI.spec, url: browser.currentURI.spec }] };
    }
    const entries = [];
    for (let i = 0; i < sh.count; i++) {
      const e = sh.getEntryAtIndex(i);
      const url = e.URI ? e.URI.spec : '';
      entries.push({ title: e.title || url, url });
    }
    return { index: sh.index, entries };
  }

  function isLoading() {
    const cmd = doc.getElementById('Browser:Stop');
    return !!cmd && !cmd.hasAttribute('disabled');
  }

  // ---- 操作 ----

  function runAction(name, node) {
    const BC = win.BrowserCommands;
    try {
      switch (name) {
        case 'reload':
          if (isLoading()) BC.stop();
          else BC.reload();
          flash(node);
          break;
        case 'reloadSkipCache':
          BC.reloadSkipCache();
          flash(node);
          break;
        case 'stop':
          BC.stop();
          break;
        case 'back':
          if (win.gBrowser.canGoBack) win.gBrowser.goBack();
          break;
        case 'forward':
          if (win.gBrowser.canGoForward) win.gBrowser.goForward();
          break;
        case 'history':
          openPanel(node, 'browse');
          break;
        case 'duplicate':
          win.duplicateTabIn(win.gBrowser.selectedTab, 'tab');
          break;
        case 'none':
        default:
          break;
      }
    } catch (ex) {
      console.error(LOG, `操作「${name}」に失敗しました`, ex);
    }
  }

  // 更新したときの手応え(山かっこは左右に開いて戻る、しずくはつぶれて弾む)
  function flash(node) {
    try {
      if (node.getAttribute('look') === 'drop') {
        node.querySelector('.nw-drop').animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(0.6)' }, { transform: 'scale(1.15)' }, { transform: 'scale(1)' }],
          { duration: 450 });
      } else {
        node.querySelector('.nw-chev-l').animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], { duration: 350 });
        node.querySelector('.nw-chev-r').animate(
          [{ transform: 'translateX(0)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }], { duration: 350 });
      }
    } catch (ex) {
      console.error(LOG, 'アニメーションに失敗しました', ex);
    }
  }

  function clickActionFor(e) {
    if (e.shiftKey) return getPref('shiftClick');
    if (e.ctrlKey || e.metaKey) return getPref('ctrlClick');
    if (e.altKey) return getPref('altClick');
    return getPref(e.button === 1 ? 'middleClick' : 'click');
  }

  // ---- ボタンの中身 ----

  function svgEl(name, attrs) {
    const el = doc.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  function buildIcon(node) {
    const box = doc.createElementNS(HTML_NS, 'div');
    box.className = 'nw-box';
    const svg = svgEl('svg', { viewBox: '6 6 20 20' });
    const chev = svgEl('g', { class: 'nw-chev-g' });
    chev.append(svgEl('path', { class: 'nw-chev nw-chev-l' }), svgEl('path', { class: 'nw-chev nw-chev-r' }));
    const drop = svgEl('g', { class: 'nw-drop-g' });
    drop.append(
      svgEl('path', { class: 'nw-drop', d: dropPath(0) }),
      svgEl('rect', { class: 'nw-stop', x: 10.5, y: 10.5, width: 11, height: 11, rx: 2.5 }));
    svg.append(chev, drop);
    box.appendChild(svg);
    node.appendChild(box);
  }

  // ---- 見た目の動き(ホイールで選んでいる間) ----

  // しずくはばねで動かす(x = 何段分伸びるか、負は戻る方向)
  const springs = new WeakMap();
  function setStretch(node, off) {
    const x = Math.max(-MAX_STEPS, Math.min(MAX_STEPS, off));
    // 山かっこ: 回した方向の羽がのび、反対側は薄くなる
    const l = node.querySelector('.nw-chev-l');
    const r = node.querySelector('.nw-chev-r');
    if (l && r) {
      l.style.transform = x < 0 ? `translateX(${-1.5 - Math.abs(x) * 1.1}px)` : '';
      r.style.transform = x > 0 ? `translateX(${1.5 + Math.abs(x) * 1.1}px)` : '';
      l.style.opacity = x > 0 ? '0.35' : '';
      r.style.opacity = x < 0 ? '0.35' : '';
    }
    let sp = springs.get(node);
    if (!sp) {
      sp = { x: 0, v: 0, target: 0, running: false };
      springs.set(node, sp);
    }
    sp.target = x;
    if (sp.running) return;
    sp.running = true;
    const path = node.querySelector('.nw-drop');
    const step = () => {
      sp.v = (sp.v + (sp.target - sp.x) * 0.12) * 0.78;
      sp.x += sp.v;
      const rest = Math.abs(sp.target - sp.x) < 0.005 && Math.abs(sp.v) < 0.005;
      if (rest) sp.x = sp.target;
      try {
        if (path) path.setAttribute('d', dropPath(sp.x));
      } catch (ex) {
        console.error(LOG, 'しずくの形を描けませんでした', ex);
        sp.running = false;
        return;
      }
      if (rest || !node.isConnected) {
        sp.running = false;
        return;
      }
      win.requestAnimationFrame(step);
    };
    win.requestAnimationFrame(step);
  }

  // ---- 一覧(パネル) ----

  // state.mode: 'wheel'(ホイールで選んでいる。止めると移動)/ 'browse'(右クリックなどで開いた。押して選ぶ)
  // range: 一覧に出している履歴の範囲 [最初, 最後](表示件数で絞ったとき)
  const state = { node: null, mode: null, hist: null, sel: 0, timer: 0, acc: 0, range: [0, 0] };

  function getPanel() {
    let panel = doc.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = doc.createXULElement('panel');
    panel.id = PANEL_ID;
    panel.setAttribute('type', 'arrow');
    panel.setAttribute('noautofocus', 'true');
    panel.setAttribute('role', 'menu');
    const inner = doc.createXULElement('vbox');
    inner.className = 'nw-inner';
    panel.appendChild(inner);
    panel.addEventListener('popuphidden', (e) => {
      if (e.target !== panel) return;
      endSelecting();
    });
    panel.addEventListener('wheel', onWheel, { passive: false });
    panel.addEventListener('mouseleave', onMouseLeave);
    doc.getElementById('mainPopupSet').appendChild(panel);
    return panel;
  }

  function openPanel(node, mode) {
    const panel = getPanel();
    state.node = node;
    state.mode = mode;
    state.hist = readHistory();
    state.sel = state.hist.index;
    state.range = initialRange();
    // ホイールで選んでいる間は、外をクリックしても閉じない(閉じるのは移動・Esc・マウスを外したとき)
    if (mode === 'wheel') panel.setAttribute('noautohide', 'true');
    else panel.removeAttribute('noautohide');
    showList();
    if (panel.state === 'closed') {
      node.setAttribute('open', 'true');
      panel.openPopup(node.querySelector('.nw-box') || node, 'after_start', 0, 0, false, false);
      win.addEventListener('keydown', onKey, true);
    }
  }

  function closePanel() {
    const panel = doc.getElementById(PANEL_ID);
    if (panel && panel.state !== 'closed') panel.hidePopup();
    else endSelecting();
  }

  function endSelecting() {
    win.clearTimeout(state.timer);
    win.removeEventListener('keydown', onKey, true);
    if (state.node) {
      state.node.removeAttribute('open');
      state.node.removeAttribute('selecting');
      setStretch(state.node, 0);
    }
    state.mode = null;
    state.acc = 0;
  }

  function clearInner() {
    const inner = getPanel().querySelector('.nw-inner');
    while (inner.firstChild) inner.firstChild.remove();
    return inner;
  }

  function iconButton(icon, tooltip, onClick) {
    const b = doc.createXULElement('toolbarbutton');
    b.className = 'nw-icon-btn';
    b.setAttribute('image', icon);
    b.setAttribute('tooltiptext', tooltip);
    b.addEventListener('command', onClick);
    return b;
  }

  function showList() {
    const inner = clearInner();
    const head = doc.createXULElement('hbox');
    head.className = 'nw-head';
    const title = doc.createXULElement('label');
    title.className = 'nw-head-title';
    title.setAttribute('value', L('履歴', 'History'));
    head.append(title, iconButton('chrome://global/skin/icons/settings.svg', L('ボタンの設定', 'Button settings'), () => {
      // 設定を開いたら、ホイールの選択はやめて、パネルは普通に閉じられるようにする
      win.clearTimeout(state.timer);
      state.mode = 'browse';
      getPanel().removeAttribute('noautohide');
      if (state.node) {
        state.node.removeAttribute('selecting');
        setStretch(state.node, 0);
      }
      showSettings();
    }));
    const list = doc.createXULElement('vbox');
    list.className = 'nw-list';
    const { entries, index } = state.hist;
    // ホイールを回す向きと、一覧で選ぶ行が動く向きをそろえる。
    // 下に回すと戻る(既定)なら、新しいもの(進める)を上・古いもの(戻れる)を下に。逆の設定なら並びも逆に
    const order = [];
    for (let i = state.range[0]; i <= state.range[1]; i++) order.push(i);
    if (getPref('wheelDownGoesBack')) order.reverse();
    for (const i of order) {
      const e = entries[i];
      const row = doc.createXULElement('hbox');
      row.className = 'nw-row';
      row.dataset.index = String(i);
      if (i === index) row.setAttribute('current', 'true');
      else if (i > index) row.setAttribute('forward', 'true');
      row.setAttribute('tooltiptext', `${e.title}\n${e.url}`);
      const dotbox = doc.createElementNS(HTML_NS, 'div');
      dotbox.className = 'nw-dotbox';
      const dot = doc.createElementNS(HTML_NS, 'div');
      dot.className = 'nw-dot';
      dotbox.appendChild(dot);
      const img = doc.createXULElement('image');
      img.className = 'nw-favicon';
      img.setAttribute('src', e.url ? 'page-icon:' + e.url : 'chrome://global/skin/icons/defaultFavicon.svg');
      img.addEventListener('error', () => img.setAttribute('src', 'chrome://global/skin/icons/defaultFavicon.svg'), { once: true });
      const label = doc.createXULElement('label');
      label.className = 'nw-title';
      label.setAttribute('value', e.title);
      label.setAttribute('crop', 'end');
      row.append(dotbox, img, label);
      row.addEventListener('click', (ev) => onRowClick(ev, i));
      row.addEventListener('auxclick', (ev) => {
        if (ev.button === 1) onRowClick(ev, i);
      });
      list.appendChild(row);
    }
    // ホイールで選んでいる間は、見出し(「履歴」と歯車)を出さずに一覧だけにする
    if (state.mode === 'wheel') inner.append(list);
    else inner.append(head, list);
    markSelected();
  }

  // 表示件数で絞るときの最初の範囲: いまのページを真ん中にして前後を同じ数ずつ。片側が足りなければもう片側を多めに
  function initialRange() {
    const n = state.hist.entries.length;
    const k = getPref('maxRows');
    if (!(k > 0) || k >= n) return [0, n - 1];
    let start = state.hist.index - Math.floor((k - 1) / 2);
    start = Math.max(0, Math.min(n - k, start));
    return [start, start + k - 1];
  }

  // 選んだ行が範囲の外に出たら、範囲をずらして一覧を作り直す。作り直したら true
  function followSelection() {
    const [start, end] = state.range;
    const k = end - start + 1;
    if (state.sel >= start && state.sel <= end) return false;
    const ns = state.sel < start ? state.sel : state.sel - k + 1;
    state.range = [ns, ns + k - 1];
    showList();
    return true;
  }

  function markSelected() {
    if (followSelection()) return; // showList の中で markSelected がもう一度呼ばれる
    const panel = getPanel();
    for (const row of panel.querySelectorAll('.nw-row')) {
      const on = state.mode === 'wheel' && Number(row.dataset.index) === state.sel && state.sel !== state.hist.index;
      if (on) {
        row.setAttribute('selected', 'true');
        row.scrollIntoView({ block: 'nearest' });
      } else {
        row.removeAttribute('selected');
      }
    }
  }

  function onRowClick(ev, i) {
    ev.stopPropagation();
    try {
      const delta = i - state.hist.index;
      if (ev.button === 1) {
        // 中クリック: その履歴のページを新しいタブで開く。URL だけを開き、戻る・進むの履歴はコピーしない
        // (duplicateTabIn だと履歴ごと複製されるため使わない)
        const url = state.hist.entries[i]?.url;
        if (url) {
          win.openTrustedLinkIn(url, 'tab', { relatedToCurrent: true });
        } else {
          console.warn(LOG, '履歴の URL が取れないので新しいタブで開けませんでした', i);
        }
      } else if (ev.button === 0 && delta !== 0) {
        win.gBrowser.gotoIndex(i);
      } else if (ev.button !== 0) {
        return;
      }
    } catch (ex) {
      console.error(LOG, '履歴のページへ移れませんでした', ex);
    }
    closePanel();
  }

  function commit() {
    win.clearTimeout(state.timer);
    const { sel, hist } = state;
    if (hist && sel !== hist.index) {
      try {
        win.gBrowser.gotoIndex(sel);
      } catch (ex) {
        console.error(LOG, '履歴のページへ移れませんでした', ex);
      }
    }
    closePanel();
  }

  // ---- ホイール ----

  function wheelSteps(e) {
    if (e.deltaMode !== e.DOM_DELTA_PIXEL) return Math.sign(e.deltaY);
    state.acc += e.deltaY;
    if (Math.abs(state.acc) < PIXELS_PER_STEP) return 0;
    const s = Math.sign(state.acc);
    state.acc = 0;
    return s;
  }

  // 次に選ぶ位置。how: step / site(同じサイトの中だけ)/ jump(サイトの切れ目ごと)
  function nextIndex(how, dir) {
    const { entries, index } = state.hist;
    const last = entries.length - 1;
    let i = state.sel;
    if (how === 'site') {
      const n = i + dir;
      if (n < 0 || n > last) return i;
      return hostOf(entries[n].url) === hostOf(entries[index].url) ? n : i;
    }
    if (how === 'jump') {
      const h = hostOf(entries[i].url);
      let n = i + dir;
      while (n >= 0 && n <= last && hostOf(entries[n].url) === h) n += dir;
      return Math.max(0, Math.min(last, n));
    }
    return Math.max(0, Math.min(last, i + dir));
  }

  function onWheel(e) {
    if (doc.documentElement.hasAttribute('customizing')) return;
    // 右クリックなどで開いた一覧・設定の間は、ホイールで選ばない(一覧はふつうにスクロールする)
    if (state.mode === 'browse') return;
    const node = e.currentTarget.id === PANEL_ID ? state.node : e.currentTarget;
    if (!node) return;
    const how = e.shiftKey ? getPref('shiftWheel') : (e.ctrlKey || e.metaKey) ? getPref('ctrlWheel') : 'step';
    if (how === 'none') return;
    e.preventDefault();
    e.stopPropagation();
    const s = wheelSteps(e);
    if (!s) return;
    // 下に回す(deltaY > 0)と戻るのが既定。設定で逆にできる
    const dir = (s > 0) === getPref('wheelDownGoesBack') ? -1 : 1;
    try {
      if (state.mode !== 'wheel') openPanel(node, 'wheel');
      state.sel = nextIndex(how, dir);
      node.setAttribute('selecting', 'true');
      setStretch(node, state.sel - state.hist.index);
      markSelected();
      win.clearTimeout(state.timer);
      const delay = getPref('delay');
      if (delay > 0) state.timer = win.setTimeout(commit, delay);
    } catch (ex) {
      console.error(LOG, 'ホイールの処理に失敗しました', ex);
      closePanel();
    }
  }

  // ホイールで選んでいる途中にマウスがボタンと一覧の両方から外れたら、やめる
  function onMouseLeave() {
    if (state.mode !== 'wheel') return;
    win.setTimeout(() => {
      if (state.mode !== 'wheel') return;
      const panel = doc.getElementById(PANEL_ID);
      const overNode = state.node && state.node.matches(':hover');
      const overPanel = panel && panel.matches(':hover');
      if (!overNode && !overPanel) closePanel();
    }, 150);
  }

  function onKey(e) {
    if (!state.mode) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePanel();
    } else if (e.key === 'Enter' && state.mode === 'wheel') {
      e.preventDefault();
      e.stopPropagation();
      commit();
    }
  }

  // ---- 設定の画面 ----

  function segmented(options, value, onChange) {
    const box = doc.createElementNS(HTML_NS, 'div');
    box.className = 'nw-seg';
    for (const [v, label] of options) {
      const b = doc.createElementNS(HTML_NS, 'button');
      b.textContent = label;
      if (v === value) b.setAttribute('selected', 'true');
      b.addEventListener('click', () => {
        for (const x of box.children) x.toggleAttribute('selected', x === b);
        onChange(v);
      });
      box.appendChild(b);
    }
    return box;
  }

  function menulist(options, value, onChange) {
    const ml = doc.createXULElement('menulist');
    const mp = doc.createXULElement('menupopup');
    ml.appendChild(mp);
    for (const [v, label] of options) {
      const mi = doc.createXULElement('menuitem');
      mi.setAttribute('label', label);
      mi.setAttribute('value', String(v));
      mp.appendChild(mi);
    }
    ml.addEventListener('command', () => {
      const raw = ml.value;
      const hit = options.find(([v]) => String(v) === raw);
      if (hit) onChange(hit[0]);
    });
    // 値は要素が文書に入ってから入れる(入る前だと選ばれない)
    ml.dataset.initial = String(value);
    return ml;
  }

  function setRow(labelText, control) {
    const row = doc.createXULElement('hbox');
    row.className = 'nw-set-row';
    const label = doc.createXULElement('label');
    label.setAttribute('value', labelText);
    row.append(label, control);
    return row;
  }

  function showSettings() {
    const inner = clearInner();
    const head = doc.createXULElement('hbox');
    head.className = 'nw-head';
    const title = doc.createXULElement('label');
    title.className = 'nw-head-title';
    title.setAttribute('value', L('ボタンの設定', 'Button settings'));
    head.append(iconButton('chrome://global/skin/icons/arrow-left.svg', L('履歴に戻る', 'Back to history'), () => {
      // 表示件数を変えたかもしれないので、範囲を出し直す
      state.range = initialRange();
      showList();
    }), title);
    const box = doc.createXULElement('vbox');
    box.className = 'nw-settings';
    const sep = () => {
      const d = doc.createXULElement('box');
      d.className = 'nw-sep';
      return d;
    };
    box.append(
      setRow(L('見た目', 'Look'), segmented([['chevron', L('山かっこ', 'Chevrons')], ['drop', L('しずく', 'Drop')]], getPref('look'), (v) => setPref('look', v))),
      // 並びとホイールの向きは 1 つの設定(wheelDownGoesBack)。ホイールは並びに合わせて、下に回すと下の行へ動く
      setRow(L('一覧の並び', 'List order'), segmented([[true, L('新しい順', 'Newest first')], [false, L('古い順', 'Oldest first')]], getPref('wheelDownGoesBack'),
        (v) => setPref('wheelDownGoesBack', v))),
      setRow(L('表示件数', 'Rows shown'), menulist(MAX_ROWS, getPref('maxRows'), (v) => setPref('maxRows', v))),
      setRow(L('止めてから移動まで', 'Go after pausing'), menulist(DELAYS, getPref('delay'), (v) => setPref('delay', v))),
      setRow(L('元の戻る・進むボタン', 'Original Back/Forward'), segmented([[true, L('隠す', 'Hide')], [false, L('出す', 'Show')]], getPref('hideOriginal'),
        (v) => setPref('hideOriginal', v))),
      sep());
    for (const [key, label] of [
      ['click', L('クリック', 'Click')], ['middleClick', L('中クリック', 'Middle-click')],
      ['shiftClick', L('Shift+クリック', 'Shift+click')], ['ctrlClick', L('Ctrl+クリック', 'Ctrl+click')], ['altClick', L('Alt+クリック', 'Alt+click')],
    ]) {
      box.append(setRow(label, menulist(ACTIONS, getPref(key), (v) => setPref(key, v))));
    }
    box.append(sep());
    for (const [key, label] of [['shiftWheel', L('Shift+ホイール', 'Shift+wheel')], ['ctrlWheel', L('Ctrl+ホイール', 'Ctrl+wheel')]]) {
      box.append(setRow(label, menulist(WHEEL_ACTIONS, getPref(key), (v) => setPref(key, v))));
    }
    inner.append(head, box);
    for (const ml of box.querySelectorAll('menulist')) {
      try {
        ml.value = ml.dataset.initial;
      } catch (ex) {
        console.error(LOG, '設定の値を表示できませんでした', ex);
      }
    }
  }

  // ---- ボタンに動きを付ける ----

  const attached = new WeakSet();

  function tooltipText() {
    const name = (key) => (ACTIONS.find(([v]) => v === getPref(key)) || ['', L('何もしない', 'Nothing')])[1];
    const down = getPref('wheelDownGoesBack');
    return L(
      `戻る・進む・更新\nホイール: ${down ? '下で戻る・上で進む' : '下で進む・上で戻る'}\n` +
        `クリック: ${name('click')}\n中クリック: ${name('middleClick')}\n右クリック: 履歴の一覧`,
      `Back, Forward, Reload\nWheel: ${down ? 'down = back, up = forward' : 'down = forward, up = back'}\n` +
        `Click: ${name('click')}\nMiddle-click: ${name('middleClick')}\nRight-click: history list`);
  }

  function refreshNode(node) {
    node.setAttribute('look', getPref('look') === 'drop' ? 'drop' : 'chevron');
    node.setAttribute('tooltiptext', tooltipText());
    node.toggleAttribute('loading', isLoading());
  }

  function attach(node) {
    // 自分のウィンドウのボタンだけ(ほかのウィンドウのボタンには、そのウィンドウのスクリプトが付ける)
    if (node.ownerDocument !== doc || attached.has(node)) return;
    attached.add(node);
    try {
      buildIcon(node);
      refreshNode(node);
      node.addEventListener('wheel', onWheel, { passive: false });
      node.addEventListener('mouseleave', onMouseLeave);
      node.addEventListener('click', (e) => {
        if (e.button !== 0 || doc.documentElement.hasAttribute('customizing')) return;
        // ホイールで選んでいる途中のクリックは「いま決める」
        if (state.mode === 'wheel') {
          commit();
          return;
        }
        runAction(clickActionFor(e), node);
      });
      node.addEventListener('auxclick', (e) => {
        if (e.button !== 1 || doc.documentElement.hasAttribute('customizing')) return;
        e.preventDefault();
        runAction(clickActionFor(e), node);
      });
      node.addEventListener('contextmenu', (e) => {
        if (doc.documentElement.hasAttribute('customizing')) return;
        // 右クリックは履歴の一覧に固定(設定への入口が、この一覧の歯車だけなので)
        e.preventDefault();
        e.stopPropagation();
        runAction('history', node);
      });
    } catch (ex) {
      console.error(LOG, 'ボタンの準備に失敗しました', ex);
    }
  }

  function currentNode() {
    const node = doc.getElementById(WIDGET_ID);
    return node && node.localName === 'toolbaritem' ? node : null;
  }

  // 新しいボタンがツールバーにある間だけ、元の戻る・進むを隠す
  function updateHideOriginal() {
    const node = currentNode();
    const placed = !!(node && node.closest('toolbar') && CUI.getPlacementOfWidget(WIDGET_ID));
    const want = placed && getPref('hideOriginal');
    if (doc.documentElement.hasAttribute(HIDE_ATTR) !== want) doc.documentElement.toggleAttribute(HIDE_ATTR, want);
  }

  // ---- 初期化 ----

  function init() {
    if (!win.gBrowser) {
      console.error(LOG, 'gBrowser が無いので動きません');
      return;
    }
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElementNS(HTML_NS, 'style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.documentElement.appendChild(style);
    }
    win.FloorpNavWheel = { attach };
    ensureWidget();
    migrateOnce();
    const node = currentNode();
    if (node) attach(node);
    updateHideOriginal();

    // 読み込み中かどうかは、ブラウザ本体の中止コマンドの disabled で分かる(タブを切り替えても本体が合わせる)
    const stopCmd = doc.getElementById('Browser:Stop');
    let mo = null;
    if (stopCmd) {
      mo = new win.MutationObserver(() => {
        const n = currentNode();
        if (n) n.toggleAttribute('loading', isLoading());
      });
      mo.observe(stopCmd, { attributes: true, attributeFilter: ['disabled'] });
    }

    const prefObserver = {
      observe() {
        const n = currentNode();
        if (n) refreshNode(n);
        updateHideOriginal();
      },
    };
    Services.prefs.addObserver(PREF, prefObserver);

    const cuiListener = {
      // この知らせは全部のウィンドウのリスナーに届く。自分のウィンドウのものだけ扱う(扱わないと、新しい
      // ウィンドウを開くたびに、開いているウィンドウの数だけアイコンが重なって増える)
      onWidgetAfterDOMChange(n) {
        if (n.id === WIDGET_ID && n.ownerDocument === doc) {
          attach(n);
          updateHideOriginal();
        }
      },
      onWidgetAdded: updateHideOriginal,
      onWidgetRemoved: updateHideOriginal,
      onCustomizeEnd(w) {
        if (w !== win) return;
        const n = currentNode();
        if (n) attach(n);
        updateHideOriginal();
      },
    };
    CUI.addListener(cuiListener);

    const onTabSelect = () => {
      if (state.mode) closePanel();
    };
    win.gBrowser.tabContainer.addEventListener('TabSelect', onTabSelect);

    win.addEventListener('unload', () => {
      try {
        if (mo) mo.disconnect();
        Services.prefs.removeObserver(PREF, prefObserver);
        CUI.removeListener(cuiListener);
        win.gBrowser.tabContainer.removeEventListener('TabSelect', onTabSelect);
      } catch (ex) {
        console.error(LOG, '後片付けに失敗しました', ex);
      }
    }, { once: true });
  }

  const safeInit = () => {
    try {
      init();
    } catch (ex) {
      console.error(LOG, '初期化に失敗しました', ex);
    }
  };
  if (win.gBrowserInit && win.gBrowserInit.delayedStartupFinished) {
    safeInit();
  } else {
    const obs = (subject, topic) => {
      if (subject === win) {
        Services.obs.removeObserver(obs, topic);
        safeInit();
      }
    };
    Services.obs.addObserver(obs, 'browser-delayed-startup-finished');
  }
})(window);
