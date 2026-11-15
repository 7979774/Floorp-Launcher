// ==UserScript==
// @name            UserChromeJSManager
// @description     userChrome.js のスクリプトの一覧と有効・無効の切り替え(about:userchromejs、アプリメニュー、ツールバーのボタン)
// @include         main
// @version         1.1.0
// @onlyonce
// @startup         UC.ucjsManager && UC.ucjsManager.onWindow(win);
// ==/UserScript==

// userChrome.js ローダー(onemen 氏の utils)用の管理画面。
// - ファイル名 rebuild_userChrome.uc.js はローダーが「userChromeJS.enabled が false でも必ず読み込む」
//   と決めている名前。全体を無効にしても、ここから有効に戻せるようにこの名前にしている
// - @onlyonce なので、最初のウィンドウで 1 回だけローダー側の長寿命のスコープに読み込まれる
//   (ウィンドウを閉じてもボタンや about: ページの処理が死なない)。ウィンドウごとの処理(アプリメニューの
//   項目)は @startup から UC.ucjsManager.onWindow(win) で呼ばれる
// - ツールバーのボタンは最初は「ツールバーをカスタマイズ」の中にしまってあり、使うときだけ自分で置く
// - 有効・無効は userChromeJS.scriptsDisabled(無効にするファイル名をカンマ区切り)と
//   userChromeJS.enabled(全体)で、ローダーが起動時に読む。切り替えは再起動後に反映される

(function () {
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

  const LOG = '[UserChromeJSManager]';
  const SELF = 'rebuild_userChrome.uc.js';
  const PREF_ENABLED = 'userChromeJS.enabled';
  const PREF_DISABLED = 'userChromeJS.scriptsDisabled';
  const BUTTON_ID = 'floorp-ucjs-manager-button';
  const APPMENU_ITEM_ID = 'appMenu-floorp-ucjs-manager-button';
  const ABOUT_NAME = 'userchromejs';
  const ABOUT_URL = 'about:' + ABOUT_NAME;
  // about:userchromejs の中身。CSP でインラインのスタイルを禁じた空のページなので、
  // スタイルは windowUtils でシートとして入れ、DOM はここで組み立てる
  const PAGE_CHROME_URL = 'chrome://browser/content/blanktab.html';
  const ABOUT_CID = Components.ID('{6f0a3c52-7d1e-4b8a-9c3e-2a5d8f1b4e70}');

  // ツールバーのボタンのアイコン(「</>」)。data: の SVG では context-fill が使えないので、
  // 明るいテーマ用と暗いテーマ用の色を決め打ちした 2 つを用意して CSS で切り替える
  const iconSvg = color => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.5" ` +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4M9 2.5l-2 11"/></svg>'
  );
  const ICON_FOR_LIGHT = iconSvg('#15141a');
  const ICON_FOR_DARK = iconSvg('#fbfbfe');

  // 起動時の状態(切り替えが再起動待ちかどうかの判断に使う)
  const startupGlobalEnabled = getGlobalEnabled();

  // ローダーのスコープには console が無いことがあるので、無ければ Cu.reportError で出す
  function logError(what, ex) {
    try {
      console.error(LOG, what, ex);
    } catch (e) {
      Cu.reportError(`${LOG} ${what}: ${ex}`);
    }
  }

  function getGlobalEnabled() {
    try {
      return Services.prefs.getBoolPref(PREF_ENABLED, true);
    } catch (ex) {
      return true;
    }
  }

  function getDisabledList() {
    let value = '';
    try {
      value = Services.prefs.getStringPref(PREF_DISABLED, '');
    } catch (ex) {
      value = '';
    }
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }

  function setScriptEnabled(filename, enabled) {
    const list = getDisabledList().filter(name => name !== filename);
    if (!enabled) {
      list.push(filename);
    }
    Services.prefs.setStringPref(PREF_DISABLED, list.join(','));
  }

  function chromeDir() {
    return Services.dirsvc.get('UChrm', Ci.nsIFile);
  }

  function readHeader(file) {
    const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
    stream.init(file, 0x01, 0, 0);
    const cv = Cc['@mozilla.org/intl/converter-input-stream;1'].createInstance(Ci.nsIConverterInputStream);
    cv.init(stream, 'UTF-8', 1024, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
    const data = {};
    let text = '';
    try {
      while (cv.readString(4096, data)) {
        text += data.value;
        if (text.includes('// ==/UserScript==') || text.length > 65536) {
          break;
        }
      }
    } finally {
      cv.close();
    }
    const header = (text.match(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/) || [''])[0];
    const get = name => {
      const m = header.match(new RegExp('^// @' + name + '\\s+(.+?)\\s*$', 'im'));
      return m ? m[1] : '';
    };
    return { name: get('name'), version: get('version'), description: get('description') };
  }

  // chrome フォルダの *.uc.js を読み直して一覧にする(ローダーが起動時に読んだ一覧に無い新しいファイルも出す)
  function listScripts() {
    const loaded = getLoaderScripts();
    const disabled = new Set(getDisabledList());
    const out = [];
    try {
      const entries = chromeDir().directoryEntries;
      while (entries.hasMoreElements()) {
        const file = entries.getNext().QueryInterface(Ci.nsIFile);
        if (!file.isFile() || !/\.uc\.js$/i.test(file.leafName)) {
          continue;
        }
        let meta = { name: '', version: '', description: '' };
        try {
          meta = readHeader(file);
        } catch (ex) {
          logError(`ヘッダーを読めませんでした: ${file.leafName}`, ex);
        }
        const filename = file.leafName;
        const known = loaded ? loaded[filename] : null;
        out.push({
          filename,
          name: meta.name || filename.replace(/\.uc\.js$/i, ''),
          version: meta.version,
          description: meta.description,
          enabled: !disabled.has(filename),
          running: !!(known && known.isRunning),
          self: filename === SELF,
        });
      }
    } catch (ex) {
      logError('chrome フォルダを読めませんでした', ex);
    }
    out.sort((a, b) => (a.self - b.self) || a.name.localeCompare(b.name));
    return out;
  }

  // ローダーが起動時に読んだスクリプト(isRunning を見るため)。どのブラウザウィンドウにも同じものが付いている
  function getLoaderScripts() {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    try {
      return win && win._uc && win._uc.scripts ? win._uc.scripts : null;
    } catch (ex) {
      return null;
    }
  }

  // 再起動すると状態が変わるか(スクリプトごと)
  function statusOf(s) {
    const globalOn = getGlobalEnabled();
    if (s.self) {
      return { text: L('動作中(このスクリプト自身は無効にできません)', 'Running (this script cannot be disabled)'), pending: false };
    }
    const willRun = globalOn && s.enabled;
    if (s.running && willRun) {
      return { text: L('動作中', 'Running'), pending: false };
    }
    if (s.running && !willRun) {
      return { text: L('再起動すると止まります', 'Stops after restart'), pending: true };
    }
    if (!s.running && willRun) {
      return { text: L('再起動すると動きます', 'Runs after restart'), pending: true };
    }
    return { text: L('停止中', 'Stopped'), pending: false };
  }

  function hasPending() {
    if (getGlobalEnabled() !== startupGlobalEnabled) {
      return true;
    }
    return listScripts().some(s => statusOf(s).pending);
  }

  function openFolder() {
    try {
      chromeDir().launch();
    } catch (ex) {
      logError('chrome フォルダを開けませんでした', ex);
    }
  }

  function restart() {
    try {
      const cancel = Cc['@mozilla.org/supports-PRBool;1'].createInstance(Ci.nsISupportsPRBool);
      Services.obs.notifyObservers(cancel, 'quit-application-requested', 'restart');
      if (cancel.data) {
        return; // 閉じるのを取り消された(未保存のフォームなど)
      }
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    } catch (ex) {
      logError('再起動できませんでした', ex);
    }
  }

  function openPage(win) {
    try {
      const gb = win.gBrowser;
      const existing = gb.tabs.find(t => t.linkedBrowser.currentURI.spec === ABOUT_URL);
      if (existing) {
        gb.selectedTab = existing;
        existing.linkedBrowser.reload();
        return;
      }
      gb.selectedTab = gb.addTrustedTab(ABOUT_URL);
    } catch (ex) {
      logError('一覧のページを開けませんでした', ex);
    }
  }

  // -------------------------------------------------------------------------
  // about:userchromejs

  const aboutModule = {
    QueryInterface: ChromeUtils.generateQI(['nsIAboutModule']),
    newChannel(uri, loadInfo) {
      const channel = Services.io.newChannelFromURIWithLoadInfo(Services.io.newURI(PAGE_CHROME_URL), loadInfo);
      channel.originalURI = uri;
      return channel;
    },
    // 親プロセスで(chrome の権限で)開く
    getURIFlags() {
      return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
    },
    getChromeURI() {
      return Services.io.newURI(PAGE_CHROME_URL);
    },
  };

  const aboutFactory = {
    QueryInterface: ChromeUtils.generateQI(['nsIFactory']),
    createInstance(iid) {
      return aboutModule.QueryInterface(iid);
    },
  };

  function registerAbout() {
    const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
    if (!registrar.isCIDRegistered(ABOUT_CID)) {
      registrar.registerFactory(ABOUT_CID, ABOUT_URL, '@mozilla.org/network/protocol/about;1?what=' + ABOUT_NAME, aboutFactory);
    }
  }

  const PAGE_CSS = `
    :root { color-scheme: light dark; font: message-box; font-size: 15px; }
    body { margin: 0; padding: 32px 40px; background: Canvas; color: CanvasText; }
    main { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 22px; font-weight: 600; margin: 0 0 6px; }
    .lead { margin: 0 0 20px; opacity: .75; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
    button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
      background: color-mix(in srgb, CanvasText 6%, Canvas); color: inherit; cursor: pointer; }
    button:hover { background: color-mix(in srgb, CanvasText 12%, Canvas); }
    button.primary { background: AccentColor; color: AccentColorText; border-color: AccentColor; }
    button.primary:hover { filter: brightness(1.1); }
    button[hidden] { display: none; }
    .notice { margin: 0 0 16px; padding: 10px 14px; border-radius: 6px; background: color-mix(in srgb, #f59e0b 18%, Canvas); }
    .notice[hidden] { display: none; }
    .card { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 8px; margin-bottom: 10px;
      padding: 12px 16px; display: flex; gap: 16px; align-items: center; }
    .card.global { background: color-mix(in srgb, CanvasText 4%, Canvas); }
    .info { flex: 1; min-width: 0; }
    .title { font-weight: 600; }
    .version { font-weight: normal; opacity: .65; margin-left: 6px; }
    .desc { margin-top: 3px; opacity: .85; }
    .meta { margin-top: 4px; font-size: 12.5px; opacity: .6; }
    .status.pending { color: #d97706; opacity: 1; font-weight: 600; }
    .card.off .title, .card.off .desc { opacity: .55; }
    label.switch { position: relative; width: 42px; height: 24px; flex-shrink: 0; }
    label.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    label.switch span { position: absolute; inset: 0; border-radius: 12px; cursor: pointer;
      background: color-mix(in srgb, CanvasText 30%, Canvas); transition: background .15s; }
    label.switch span::before { content: ""; position: absolute; left: 3px; top: 3px; width: 18px; height: 18px;
      border-radius: 50%; background: Canvas; transition: transform .15s; }
    label.switch input:checked + span { background: AccentColor; }
    label.switch input:checked + span::before { transform: translateX(18px); }
    label.switch input:disabled + span { cursor: default; opacity: .5; }
    label.switch input:focus-visible + span { outline: 2px solid AccentColor; outline-offset: 2px; }
  `;

  function el(doc, tag, props, children) {
    const node = doc.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === 'class') {
          node.className = v;
        } else if (k === 'text') {
          node.textContent = v;
        } else if (k.startsWith('on')) {
          node.addEventListener(k.slice(2), v);
        } else if (v === true) {
          node.setAttribute(k, '');
        } else if (v !== false && v != null) {
          node.setAttribute(k, v);
        }
      }
    }
    for (const c of children || []) {
      if (c) {
        node.append(c);
      }
    }
    return node;
  }

  function makeSwitch(doc, checked, disabled, label, onChange) {
    const input = el(doc, 'input', { type: 'checkbox', 'aria-label': label });
    input.checked = checked;
    input.disabled = disabled;
    input.addEventListener('change', () => {
      try {
        onChange(input.checked);
      } catch (ex) {
        logError('切り替えに失敗しました', ex);
      }
    });
    return el(doc, 'label', { class: 'switch', title: label }, [input, el(doc, 'span')]);
  }

  function renderPage(doc) {
    try {
      const win = doc.defaultView;
      if (!win.__ucjsSheet) {
        win.windowUtils.loadSheetUsingURIString('data:text/css;charset=utf-8,' + encodeURIComponent(PAGE_CSS),
          win.windowUtils.AUTHOR_SHEET);
        win.__ucjsSheet = true;
      }
      doc.title = L('userChrome.js スクリプト', 'userChrome.js Scripts');
      const rerender = () => renderPage(doc);
      const scripts = listScripts();
      const globalOn = getGlobalEnabled();

      const notice = el(doc, 'p', { class: 'notice', hidden: !hasPending(),
        text: L('変更は再起動すると反映されます。', 'Changes take effect after a restart.') });
      const restartBtn = el(doc, 'button', { class: 'primary', hidden: !hasPending(), text: L('再起動して反映', 'Restart to Apply'), onclick: restart });

      const globalCard = el(doc, 'div', { class: 'card global' }, [
        el(doc, 'div', { class: 'info' }, [
          el(doc, 'div', { class: 'title', text: L('userChrome.js を使う', 'Use userChrome.js') }),
          el(doc, 'div', { class: 'desc', text: L('オフにすると、このページ以外のすべてのスクリプトが止まります(再起動後)。', 'When off, every script except this page stops (after a restart).') }),
        ]),
        makeSwitch(doc, globalOn, false, L('userChrome.js を使う', 'Use userChrome.js'), (on) => {
          Services.prefs.setBoolPref(PREF_ENABLED, on);
          rerender();
        }),
      ]);

      const cards = scripts.map((s) => {
        const st = statusOf(s);
        return el(doc, 'div', { class: 'card' + ((s.enabled && globalOn) || s.self ? '' : ' off') }, [
          el(doc, 'div', { class: 'info' }, [
            el(doc, 'div', { class: 'title' }, [doc.createTextNode(s.name), s.version ? el(doc, 'span', { class: 'version', text: s.version }) : null]),
            s.description ? el(doc, 'div', { class: 'desc', text: s.description }) : null,
            el(doc, 'div', { class: 'meta' }, [
              doc.createTextNode(s.filename + ' ・ '),
              el(doc, 'span', { class: 'status' + (st.pending ? ' pending' : ''), text: st.text }),
            ]),
          ]),
          makeSwitch(doc, s.self || s.enabled, s.self, L(`${s.name} を有効にする`, `Enable ${s.name}`), (on) => {
            setScriptEnabled(s.filename, on);
            rerender();
          }),
        ]);
      });

      const main = el(doc, 'main', null, [
        el(doc, 'h1', { text: L('userChrome.js スクリプト', 'userChrome.js Scripts') }),
        el(doc, 'p', { class: 'lead', text: L(`${chromeDir().path} にある .uc.js の一覧です。`, `.uc.js files in ${chromeDir().path}`) }),
        el(doc, 'div', { class: 'toolbar' }, [
          restartBtn,
          el(doc, 'button', { text: L('chrome フォルダを開く', 'Open chrome Folder'), onclick: openFolder }),
          el(doc, 'button', { text: L('一覧を読み直す', 'Reload List'), onclick: rerender }),
        ]),
        notice,
        globalCard,
        ...cards,
      ]);
      const body = doc.body || doc.documentElement.appendChild(doc.createElement('body'));
      body.replaceChildren(main);
    } catch (ex) {
      logError('一覧のページを作れませんでした', ex);
    }
  }

  const pageObserver = {
    observe(subject) {
      try {
        const doc = subject;
        if (!doc || typeof doc.documentURI !== 'string' || !doc.documentURI.startsWith(ABOUT_URL)) {
          return;
        }
        doc.addEventListener('DOMContentLoaded', () => renderPage(doc), { once: true });
      } catch (ex) {
        logError('一覧のページの準備に失敗しました', ex);
      }
    },
  };

  // -------------------------------------------------------------------------
  // ツールバーのボタン(押すとメニュー)

  function buildMenu(popup) {
    const doc = popup.ownerDocument;
    const win = doc.defaultView;
    const xul = (tag, attrs) => {
      const node = doc.createXULElement(tag);
      for (const [k, v] of Object.entries(attrs || {})) {
        if (v === true) {
          node.setAttribute(k, 'true');
        } else if (v !== false && v != null) {
          node.setAttribute(k, v);
        }
      }
      return node;
    };
    popup.replaceChildren();
    const globalOn = getGlobalEnabled();
    for (const s of listScripts()) {
      const st = statusOf(s);
      const item = xul('menuitem', {
        type: 'checkbox',
        label: (s.version ? `${s.name} ${s.version}` : s.name) + (st.pending ? L('(再起動で反映)', ' (after restart)') : ''),
        tooltiptext: [s.description, s.filename, st.text].filter(Boolean).join('\n'),
        closemenu: 'none',
        disabled: s.self || !globalOn,
      });
      if (s.self || s.enabled) {
        item.setAttribute('checked', 'true');
      }
      item.addEventListener('command', () => {
        try {
          // チェックの状態ではなく今の設定から反転させる(クリック以外の操作でも同じになるように)
          setScriptEnabled(s.filename, getDisabledList().includes(s.filename));
          buildMenu(popup);
        } catch (ex) {
          logError('切り替えに失敗しました', ex);
        }
      });
      popup.appendChild(item);
    }
    popup.appendChild(xul('menuseparator'));
    const globalItem = xul('menuitem', { type: 'checkbox', label: L('userChrome.js を使う(全体)', 'Use userChrome.js (all)'), closemenu: 'none' });
    if (globalOn) {
      globalItem.setAttribute('checked', 'true');
    }
    globalItem.addEventListener('command', () => {
      try {
        Services.prefs.setBoolPref(PREF_ENABLED, !getGlobalEnabled());
        buildMenu(popup);
      } catch (ex) {
        logError('切り替えに失敗しました', ex);
      }
    });
    popup.appendChild(globalItem);
    popup.appendChild(xul('menuseparator'));
    const pageItem = xul('menuitem', { label: L('一覧のページを開く', 'Open Script List Page') });
    pageItem.addEventListener('command', () => openPage(win));
    const folderItem = xul('menuitem', { label: L('chrome フォルダを開く', 'Open chrome Folder') });
    folderItem.addEventListener('command', openFolder);
    const restartItem = xul('menuitem', { label: hasPending() ? L('再起動して反映', 'Restart to Apply') : L('再起動', 'Restart') });
    restartItem.addEventListener('command', restart);
    popup.append(pageItem, folderItem, restartItem);
  }

  function registerStyle() {
    const css = `
      @-moz-document url("chrome://browser/content/browser.xhtml") {
        #${BUTTON_ID} {
          list-style-image: url("${ICON_FOR_LIGHT}");
        }
        :root[lwtheme-brighttext] #${BUTTON_ID} {
          list-style-image: url("${ICON_FOR_DARK}");
        }
        @media (prefers-color-scheme: dark) {
          :root:not([lwtheme]) #${BUTTON_ID} {
            list-style-image: url("${ICON_FOR_DARK}");
          }
        }
        #${BUTTON_ID} > .toolbarbutton-menu-dropmarker { display: none; }
      }`;
    const sss = Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService);
    const uri = Services.io.newURI('data:text/css;charset=utf-8,' + encodeURIComponent(css));
    if (!sss.sheetRegistered(uri, sss.USER_SHEET)) {
      sss.loadAndRegisterSheet(uri, sss.USER_SHEET);
    }
  }

  function createButton(CustomizableUI) {
    if (CustomizableUI.getWidget(BUTTON_ID)?.provider === CustomizableUI.PROVIDER_API) {
      return;
    }
    // defaultArea を付けない: 最初はツールバーに置かず、カスタマイズのパレットに入れておく
    CustomizableUI.createWidget({
      id: BUTTON_ID,
      type: 'custom',
      label: 'userChrome.js',
      tooltiptext: L('userChrome.js スクリプトの一覧', 'userChrome.js script list'),
      onBuild(doc) {
        const button = doc.createXULElement('toolbarbutton');
        button.id = BUTTON_ID;
        button.className = 'toolbarbutton-1 chromeclass-toolbar-additional';
        button.setAttribute('type', 'menu');
        button.setAttribute('label', 'userChrome.js');
        button.setAttribute('tooltiptext', L('userChrome.js スクリプトの一覧', 'userChrome.js script list'));
        const popup = doc.createXULElement('menupopup');
        popup.addEventListener('popupshowing', (event) => {
          if (event.target === popup) {
            try {
              buildMenu(popup);
            } catch (ex) {
              logError('メニューを作れませんでした', ex);
            }
          }
        });
        button.appendChild(popup);
        return button;
      },
    });
  }

  // -------------------------------------------------------------------------
  // アプリメニュー(≡)の「拡張機能とテーマ」の下に項目を足す。メニューの中身は開くときに作られるので、
  // ViewShowing のたびに無ければ足す

  function onViewShowing(event) {
    try {
      const view = event.target;
      // Floorp は appMenu-mainView、Firefox は appMenu-protonMainView
      if (!view || (view.id !== 'appMenu-mainView' && view.id !== 'appMenu-protonMainView')) {
        return;
      }
      const doc = view.ownerDocument;
      if (doc.getElementById(APPMENU_ITEM_ID)) {
        return;
      }
      const win = doc.defaultView;
      const item = doc.createXULElement('toolbarbutton');
      item.id = APPMENU_ITEM_ID;
      item.className = 'subviewbutton';
      item.setAttribute('label', L('userChrome.js スクリプト', 'userChrome.js Scripts'));
      item.addEventListener('command', () => {
        try {
          win.PanelUI.hide();
        } catch (ex) {
          logError('アプリメニューを閉じられませんでした', ex);
        }
        openPage(win);
      });
      const anchor = view.querySelector('#appMenu-extensions-themes-button');
      if (anchor && anchor.parentNode) {
        anchor.after(item);
      } else {
        (view.querySelector('.panel-subview-body') || view).appendChild(item);
      }
    } catch (ex) {
      logError('アプリメニューに項目を足せませんでした', ex);
    }
  }

  // ブラウザウィンドウが開くたびに(@startup から)呼ばれる
  function onWindow(win) {
    try {
      if (!win || win.__floorpUcjsManagerHooked || win.location.href !== 'chrome://browser/content/browser.xhtml') {
        return;
      }
      win.__floorpUcjsManagerHooked = true;
      win.document.addEventListener('ViewShowing', onViewShowing, true);
    } catch (ex) {
      logError('ウィンドウの準備に失敗しました', ex);
    }
  }

  try {
    window.UC.ucjsManager = { onWindow, openPage };
    registerAbout();
    Services.obs.addObserver(pageObserver, 'document-element-inserted');
    registerStyle();
    // @onlyonce では window は最初のブラウザウィンドウ。CustomizableUI はウィンドウをまたいで共通
    createButton(window.CustomizableUI);
  } catch (ex) {
    logError('初期化に失敗しました', ex);
  }
})();
