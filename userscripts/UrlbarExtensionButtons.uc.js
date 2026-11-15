// ==UserScript==
// @name            UrlbarExtensionButtons
// @description     拡張機能のボタンを、アドレスバーの中(☆が並んでいる右端の列)に移す
// @include         main
// @version         1.0.1
// ==/UserScript==

// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
// 拡張機能のボタン(CustomizableUI のウィジェット)の DOM の要素そのものを、アドレスバーの
// #page-action-buttons の中に作った箱へ移す。要素を移すだけなので、クリックで出るパネル・
// バッジ・アイコンの更新は拡張機能の本来の処理がそのまま行う。
// CustomizableUI 上の置き場所(ツールバー)は変えないので、このスクリプトを外すと元の場所に戻る。
// どの拡張機能を移すかは、ボタンの右クリックメニューで選び、設定 PREF に拡張機能の ID を並べて保存する。

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

  const LOG = '[UrlbarExtensionButtons]';
  // 移す拡張機能の ID をカンマ区切りで並べる(並び順がアドレスバーでの順番)
  const PREF = 'userChromeJS.urlbarExtensionButtons';
  const BOX_ID = 'floorp-ueb-box';
  const STYLE_ID = 'floorp-ueb-style';
  const MENU_CLASS = 'floorp-ueb-menuitem';
  // 移した要素の印。値は移す前の context 属性(無ければ空)
  const MOVED_ATTR = 'floorp-ueb-moved';
  const BROWSER_ACTION_SUFFIX = '-browser-action';
  // UrlbarIconDrawer.uc.js の「…」の中の箱
  const DRAWER_SELECTOR = '#floorp-drawer-box';

  const doc = win.document;
  const CUI = win.CustomizableUI;

  // ---- 設定 ----

  function readIds() {
    try {
      const raw = Services.prefs.getStringPref(PREF, '');
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
      return [...new Set(ids)];
    } catch (ex) {
      console.error(LOG, '設定の読み込みに失敗しました', ex);
      return [];
    }
  }

  function writeIds(ids) {
    try {
      Services.prefs.setStringPref(PREF, ids.join(','));
    } catch (ex) {
      console.error(LOG, '設定の保存に失敗しました', ex);
    }
  }

  // ext-browser.js の makeWidgetId と同じ規則
  function widgetIdFor(addonId) {
    return addonId.toLowerCase().replace(/[^a-z0-9_-]/g, '_') + BROWSER_ACTION_SUFFIX;
  }

  function isCustomizing() {
    return doc.documentElement.hasAttribute('customizing');
  }

  // ---- 見た目 ----

  const CSS = `
    #${BOX_ID} {
      display: flex;
      align-items: center;
    }
    #${BOX_ID}:empty {
      display: none;
    }
    #${BOX_ID} > .unified-extensions-item {
      margin: 0 !important;
      padding: 0 !important;
      min-width: 0 !important;
      background: none !important;
    }
    /* ツールバー用の付属部分(名前・歯車・メッセージ)は出さない */
    #${BOX_ID} .unified-extensions-item-contents,
    #${BOX_ID} .unified-extensions-item-menu-button,
    #${BOX_ID} .unified-extensions-item-messagebar-wrapper {
      display: none !important;
    }
    /* ☆などのアドレスバーのアイコンと同じ大きさ・余白・マウスを乗せたときの背景にする */
    #${BOX_ID} .unified-extensions-item-action-button {
      appearance: none !important;
      margin: 0 !important;
      padding: var(--urlbar-icon-padding, 6px) !important;
      border-radius: var(--urlbar-icon-border-radius, 4px) !important;
      background: none !important;
      min-width: 0 !important;
      min-height: 0 !important;
    }
    #${BOX_ID} .unified-extensions-item-action-button:hover {
      background-color: var(--urlbar-box-hover-bgcolor, color-mix(in srgb, currentColor 12%, transparent)) !important;
    }
    #${BOX_ID} .unified-extensions-item-action-button:hover:active,
    #${BOX_ID} .unified-extensions-item-action-button[open] {
      background-color: var(--urlbar-box-active-bgcolor, color-mix(in srgb, currentColor 20%, transparent)) !important;
    }
    #${BOX_ID} .unified-extensions-item-action-button > .toolbarbutton-badge-stack {
      padding: 0 !important;
      background: none !important;
      border-radius: 0 !important;
      min-height: 0 !important;
    }
    #${BOX_ID} .unified-extensions-item-action-button .toolbarbutton-icon {
      width: 16px !important;
      height: 16px !important;
      padding: 0 !important;
      background: none !important;
    }
  `;

  function injectStyle() {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.documentElement.appendChild(style);
  }

  // ---- 移す・戻す ----

  function getBox() {
    let box = doc.getElementById(BOX_ID);
    if (box) return box;
    const buttons = doc.getElementById('page-action-buttons');
    if (!buttons) return null;
    box = doc.createXULElement('hbox');
    box.id = BOX_ID;
    box.setAttribute('align', 'center');
    // ☆の左に並べる(☆が無い作りなら右端)
    const star = doc.getElementById('star-button-box');
    if (star && star.parentNode === buttons) {
      buttons.insertBefore(box, star);
    } else {
      buttons.appendChild(box);
    }
    return box;
  }

  // ツールバー(パネル以外)に置かれている拡張機能のボタンの要素を返す。無ければ null
  function toolbarNodeFor(addonId) {
    const widgetId = widgetIdFor(addonId);
    const widget = CUI.getWidget(widgetId);
    if (!widget || widget.provider !== CUI.PROVIDER_API) return null;
    const placement = CUI.getPlacementOfWidget(widgetId);
    if (!placement || CUI.getAreaType(placement.area) !== CUI.TYPE_TOOLBAR) return null;
    const instance = widget.forWindow(win);
    return (instance && instance.node) || null;
  }

  function moveIn(node, box, before) {
    if (!node.hasAttribute(MOVED_ATTR)) {
      node.setAttribute(MOVED_ATTR, node.getAttribute('context') || '');
    }
    // #page-action-buttons の右クリックメニュー(ページ操作用)ではなく、ツールバーのボタンと同じメニューを出す
    node.setAttribute('context', 'toolbar-context-menu');
    if (node.parentNode !== box || node.nextSibling !== before) {
      box.insertBefore(node, before);
    }
  }

  // CustomizableUI 上の置き場所(ツールバーの中の順番)へ戻す
  function moveOut(node) {
    const saved = node.getAttribute(MOVED_ATTR);
    node.removeAttribute(MOVED_ATTR);
    if (saved) {
      node.setAttribute('context', saved);
    } else {
      node.removeAttribute('context');
    }
    const placement = CUI.getPlacementOfWidget(node.id);
    const areaNode = placement && doc.getElementById(placement.area);
    const target = areaNode && CUI.getCustomizationTarget(areaNode);
    if (!target) {
      // 置き場所が無い(パレット)。ウィジェットの要素はパレットに置くのが CustomizableUI の作法
      win.gNavToolbox.palette.appendChild(node);
      return;
    }
    const ids = CUI.getWidgetIdsInArea(placement.area);
    for (let i = placement.position + 1; i < ids.length; i++) {
      const next = doc.getElementById(ids[i]);
      if (next && next.parentNode === target) {
        target.insertBefore(node, next);
        return;
      }
    }
    target.appendChild(node);
  }

  function apply() {
    if (isCustomizing()) return;
    const box = getBox();
    if (!box) {
      console.error(LOG, 'アドレスバーの #page-action-buttons が見つかりません');
      return;
    }
    const ids = readIds();
    const wanted = new Set();
    // 設定の順番どおりに、前から並べる
    let cursor = box.firstChild;
    for (const addonId of ids) {
      try {
        const node = toolbarNodeFor(addonId);
        if (!node) continue;
        wanted.add(node);
        // UrlbarIconDrawer.uc.js の「…」にまとめられているものは、そのままにする
        if (node.closest(DRAWER_SELECTOR)) continue;
        if (node === cursor) {
          cursor = cursor.nextSibling;
          continue;
        }
        moveIn(node, box, cursor);
      } catch (ex) {
        console.error(LOG, `ボタンを移せませんでした: ${addonId}`, ex);
      }
    }
    // 設定から外れたものは元に戻す(「…」にまとめられているものも)
    const drawn = [...doc.querySelectorAll(`${DRAWER_SELECTOR} > [${MOVED_ATTR}]`)];
    for (const node of [...box.children, ...drawn]) {
      if (wanted.has(node)) continue;
      try {
        moveOut(node);
      } catch (ex) {
        console.error(LOG, `ボタンを戻せませんでした: ${node.id}`, ex);
      }
    }
  }

  function restoreAll() {
    const box = doc.getElementById(BOX_ID);
    if (!box) return;
    for (const node of [...box.children]) {
      try {
        moveOut(node);
      } catch (ex) {
        console.error(LOG, `ボタンを戻せませんでした: ${node.id}`, ex);
      }
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    win.requestAnimationFrame(() => {
      scheduled = false;
      try {
        apply();
      } catch (ex) {
        console.error(LOG, 'ボタンの配置に失敗しました', ex);
      }
    });
  }

  // ---- 右クリックメニュー ----

  // 右クリックされた拡張機能のボタン(ツールバー・拡張機能パネル・アドレスバーのどれか)の拡張機能 ID
  function addonIdFromTrigger(popup) {
    const trigger = popup.triggerNode;
    const item = trigger && trigger.closest && trigger.closest('.unified-extensions-item[data-extensionid]');
    if (!item || !item.id.endsWith(BROWSER_ACTION_SUFFIX)) return null;
    return item.getAttribute('data-extensionid');
  }

  // 今このウィンドウのアドレスバーに出ているか(設定に入っていても、拡張機能のパネルにあれば出ていない)
  function isInUrlbar(addonId) {
    const node = doc.getElementById(widgetIdFor(addonId));
    // 「…」にまとめられているものも、アドレスバーにあるものとして扱う
    return !!node && (node.parentNode === doc.getElementById(BOX_ID) || !!node.closest(DRAWER_SELECTOR));
  }

  function toggle(addonId) {
    const ids = readIds();
    if (isInUrlbar(addonId)) {
      writeIds(ids.filter((id) => id !== addonId));
      return;
    }
    // 拡張機能のパネルの中にあるボタンは、先にツールバーへピン留めする(アドレスバーへはツールバーから移す)
    const widgetId = widgetIdFor(addonId);
    const placement = CUI.getPlacementOfWidget(widgetId);
    if (!placement || CUI.getAreaType(placement.area) !== CUI.TYPE_TOOLBAR) {
      CUI.addWidgetToArea(widgetId, CUI.AREA_NAVBAR);
    }
    if (ids.includes(addonId)) {
      // 設定はそのままなので、設定の監視では動かない。ここで並べ直す
      schedule();
    } else {
      ids.push(addonId);
      writeIds(ids);
    }
  }

  function onPopupShowing(event) {
    const popup = event.currentTarget;
    if (event.target !== popup) return;
    const item = popup.querySelector(`:scope > .${MENU_CLASS}`);
    if (!item) return;
    try {
      const addonId = addonIdFromTrigger(popup);
      item.hidden = !addonId;
      if (!addonId) return;
      item.setAttribute('label', isInUrlbar(addonId) ? L('アドレスバーから外す', 'Remove from Address Bar') : L('アドレスバーに置く', 'Move to Address Bar'));
      item.dataset.addonId = addonId;
    } catch (ex) {
      item.hidden = true;
      console.error(LOG, 'メニューの準備に失敗しました', ex);
    }
  }

  function onMenuCommand(event) {
    try {
      const addonId = event.currentTarget.dataset.addonId;
      if (addonId) toggle(addonId);
    } catch (ex) {
      console.error(LOG, '切り替えに失敗しました', ex);
    }
  }

  function addMenuItem(popupId) {
    const popup = doc.getElementById(popupId);
    if (!popup || popup.querySelector(`:scope > .${MENU_CLASS}`)) return null;
    const item = doc.createXULElement('menuitem');
    item.className = MENU_CLASS;
    item.hidden = true;
    item.addEventListener('command', onMenuCommand);
    // 拡張機能用の項目(「拡張機能を管理」など)の並びの先頭に入れる
    const anchor = popup.querySelector(
      '.customize-context-manageExtension, .unified-extensions-context-menu-management-separator'
    );
    popup.insertBefore(item, anchor || popup.firstChild);
    popup.addEventListener('popupshowing', onPopupShowing);
    return popup;
  }

  // ---- 監視 ----

  const cuiListener = {
    // CustomizableUI がボタンの要素をツールバーへ入れ直したとき(ツールバーの作り直しなど)
    onWidgetAfterDOMChange(node) {
      if (node.ownerDocument === doc && node.id.endsWith(BROWSER_ACTION_SUFFIX)) schedule();
    },
    // 拡張機能が有効になってボタンができたとき
    onWidgetAfterCreation(widgetId) {
      if (widgetId.endsWith(BROWSER_ACTION_SUFFIX)) schedule();
    },
    // 拡張機能の側で「ツールバーからピン留めを外す」をしたら、アドレスバーからも外す
    onWidgetAdded(widgetId, area) {
      if (!widgetId.endsWith(BROWSER_ACTION_SUFFIX) || CUI.getAreaType(area) === CUI.TYPE_TOOLBAR) return;
      const node = doc.getElementById(widgetId);
      const addonId = node && node.getAttribute('data-extensionid');
      const ids = readIds();
      if (addonId && ids.includes(addonId)) {
        writeIds(ids.filter((id) => id !== addonId));
      }
    },
  };

  const prefObserver = { observe: schedule };

  function onBeforeCustomization() {
    // ツールバーのカスタマイズ画面は、ツールバーの中の要素を前提に動くので、いったん元に戻す
    restoreAll();
  }

  function init() {
    try {
      injectStyle();
      const popups = ['toolbar-context-menu', 'unified-extensions-context-menu'].map(addMenuItem).filter(Boolean);
      CUI.addListener(cuiListener);
      Services.prefs.addObserver(PREF, prefObserver);
      win.addEventListener('beforecustomization', onBeforeCustomization);
      win.addEventListener('aftercustomization', schedule);
      apply();
      win.addEventListener('unload', () => {
        try {
          CUI.removeListener(cuiListener);
          Services.prefs.removeObserver(PREF, prefObserver);
          for (const popup of popups) popup.removeEventListener('popupshowing', onPopupShowing);
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
