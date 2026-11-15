// ==UserScript==
// @name            TabGroupsHelptextFix
// @description     Tab Groups のオプション画面で、説明が出ている項目の 1 回目のクリックが効かない問題を直す
// @include         main
// @version         1.0.0
// ==/UserScript==

// 必要なもの: Tab Groups (tabgroups@quicksaver)
// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
//
// 原因: オプション画面(about:tabgroups)の説明は、マウスを乗せた項目を基準に開くパネル
// (.helptext-panel)。Firefox の panel.js は type="arrow" のパネルに consumeoutsideclicks="false"
// を付けるが、この値は「基準の要素の上のクリックはパネルを閉じるのに使って捨てる」という意味になる。
// そのため説明を出している項目を押すと、1 回目は説明が閉じるだけで項目に届かない。
// "never" にすると、パネルは閉じつつクリックも項目に届く。

(function (win) {
  'use strict';

  const LOG = '[TabGroupsHelptextFix]';
  const PAGE = 'about:tabgroups';
  const PANEL_SELECTOR = '.helptext-panel';
  // 同じ文書に二重に付けないための目印
  const HOOKED = Symbol('floorp-tghf-hooked');

  function isTargetDocument(doc) {
    try {
      return !!doc && typeof doc.documentURI === 'string' && doc.documentURI.startsWith(PAGE);
    } catch (ex) {
      return false;
    }
  }

  function fixPanel(panel) {
    if (panel.getAttribute('consumeoutsideclicks') !== 'never') {
      panel.setAttribute('consumeoutsideclicks', 'never');
    }
  }

  // パネルは Tab Groups が後から差し込み、panel.js も接続時に属性を付けるので、
  // 開く直前(popupshowing)に毎回直す。クリック時に読まれる値なので、ここで変えれば間に合う
  function onPopupShowing(event) {
    try {
      const panel = event.target;
      if (panel && typeof panel.matches === 'function' && panel.matches(PANEL_SELECTOR)) {
        fixPanel(panel);
      }
    } catch (ex) {
      console.error(LOG, '説明パネルの設定に失敗しました', ex);
    }
  }

  function hookDocument(doc) {
    if (!isTargetDocument(doc) || doc[HOOKED]) {
      return;
    }
    doc[HOOKED] = true;
    doc.addEventListener('popupshowing', onPopupShowing, true);
    // 既に差し込まれているパネルがあれば今のうちに直す(開いている最中でも次のクリックから効く)
    try {
      for (const panel of doc.querySelectorAll(PANEL_SELECTOR)) {
        fixPanel(panel);
      }
    } catch (ex) {
      console.error(LOG, '既存の説明パネルの設定に失敗しました', ex);
    }
  }

  // about:tabgroups はリモートでない(親プロセスの)文書なので、読み込みをオブザーバーで拾える。
  // 他のウィンドウのタブで開いた分もここで拾うが、目印で二重には付けない
  const observer = {
    observe(subject) {
      try {
        if (isTargetDocument(subject)) {
          hookDocument(subject);
        }
      } catch (ex) {
        console.error(LOG, '文書の確認に失敗しました', ex);
      }
    },
  };

  // スクリプトより先に読み込まれていた(セッション復元などの)タブにも付ける
  function hookExistingTabs() {
    const gb = win.gBrowser;
    if (!gb) {
      return;
    }
    for (const browser of gb.browsers) {
      try {
        if (!browser.isRemoteBrowser && browser.currentURI && browser.currentURI.spec.startsWith(PAGE)) {
          hookDocument(browser.contentDocument);
        }
      } catch (ex) {
        console.error(LOG, '開いているタブの確認に失敗しました', ex);
      }
    }
  }

  try {
    Services.obs.addObserver(observer, 'document-element-inserted');
    win.addEventListener('unload', () => {
      try {
        Services.obs.removeObserver(observer, 'document-element-inserted');
      } catch (ex) {
        console.error(LOG, 'オブザーバーの解除に失敗しました', ex);
      }
    }, { once: true });
    hookExistingTabs();
  } catch (ex) {
    console.error(LOG, '初期化に失敗しました', ex);
  }
})(window);
