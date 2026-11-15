// ==UserScript==
// @name            TabMixMultiRow
// @description     Tab Mix Plus の複数行タブを使いやすくする(スクロールボタンの配置とホイール操作、空き部分のダブルクリックで新しいタブ、行末の区切り線)
// @include         main
// @version         2.1.0
// ==/UserScript==

// 必要なもの: Tab Mix Plus(タブバーを複数行表示にしているとき)。
//
// 1. スクロールボタンを Tab Groups のボタンの下に置く
//    Tab Groups のボタン(tabGroups-tabview-button)がスクロールボタンと同じタブバーにあるときだけ配置を変える。
//    ボタンが無い・別のツールバーにあるときは配置はそのままで、ホイール操作だけが効く。
// 2. スクロールボタンの上のホイールで 1 行ずつスクロールする
// 3. 2 行以上のとき、最後の行の空き部分のダブルクリックでも新しいタブを開けるようにする
//    Firefox はダブルクリック先がタブバー(#tabbrowser-arrowscrollbox)そのもののときだけ新しいタブを開く。
//    Tab Mix Plus は複数行のとき #tabbrowser-arrowscrollbox-periphery(新しいタブボタンなどの入れ物)を
//    最後の行の空き部分いっぱいに広げるので、そこがダブルクリック先になって無視される。
//    入れ物だけクリックを素通りさせ、中のボタンは今までどおり押せるようにする。
// 4. 各行の右端のタブの右にも区切り線を出す
//    Floorp の Lepton デザイン(protonfix など)は、区切り線を各タブの左端(.tab-stack::before)と、
//    最後のタブの右端(::after)にだけ描く。行の右端のタブの右に来るはずの線は次のタブの左端の線なので、
//    次のタブが下の行に回り込むと消える。行の右端のタブに属性を付け、そこにも右端の線を描く。
//    Lepton の線を使うデザイン(protonfix・lepton)のときだけ付ける(fluerial・photon には何もしない)。
// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。

(function (win) {
  'use strict';

  const LOG = '[TabMixMultiRow]';
  const doc = win.document;
  const ATTR = 'floorp-tmmr-scroll';
  const STYLE_ID = 'floorp-tmmr-style';
  const SHADOW_STYLE_ID = 'floorp-tmmr-shadow-style';
  // 行の右端のタブに付ける属性(4. 区切り線)
  const ROWEND_ATTR = 'floorp-tmmr-rowend';
  // これより低い隙間しか無いときは重ねずに元の位置のままにする(矢印が潰れて押せなくなるため)
  const MIN_HEIGHT = 16;
  // タッチパッドなどのピクセル単位のホイールは、この量がたまるごとに 1 行動かす
  const PIXELS_PER_ROW = 50;

  let pixelAccum = 0;
  let scheduled = false;
  let resizeObserver = null;
  let mutationObserver = null;
  let observedButton = null;
  // タブの幅が変わると行の変わり目も変わるので、タブ 1 枚ずつの大きさを見る
  let tabResizeObserver = null;

  function el(id) {
    return doc.getElementById(id);
  }

  function warn(what, ex) {
    console.error(LOG, what, ex);
  }

  // ウィンドウ全体の CSS。スクロールボタンの位置と大きさは update() がカスタムプロパティで渡す
  function ensureDocumentStyle() {
    if (!el(STYLE_ID)) {
      const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      style.id = STYLE_ID;
      style.textContent = `
        #TabsToolbar-customization-target:has(> #tabmix-scrollbox[${ATTR}]) {
          position: relative !important;
        }
        #tabmix-scrollbox[${ATTR}] {
          position: absolute !important;
          left: var(--floorp-tmmr-left) !important;
          top: var(--floorp-tmmr-top) !important;
          width: var(--floorp-tmmr-width) !important;
          height: var(--floorp-tmmr-height) !important;
          min-height: 0 !important;
          margin: 0 !important;
        }
        /* 3. 空き部分のダブルクリック: 入れ物は素通り、中のボタンは押せる */
        #tabbrowser-arrowscrollbox-periphery {
          pointer-events: none !important;
        }
        #tabbrowser-arrowscrollbox-periphery > * {
          pointer-events: auto !important;
        }
        /* 4. 行の右端のタブの右の区切り線。Lepton の最後のタブの右の線と同じ位置・色・大きさ。
           選択中・マウスを乗せたタブでは消す(Lepton と同じ) */
        #tabbrowser-tabs:not([orient="vertical"]) .tabbrowser-tab[${ROWEND_ATTR}]:not([visuallyselected], [multiselected], :hover) .tab-stack::after {
          content: "" !important;
          display: block !important;
          position: absolute !important;
          top: 50% !important;
          right: 0 !important;
          width: 1px !important;
          height: 20px !important;
          opacity: 1 !important;
          background-color: var(--toolbarseparator-color) !important;
          transform: translateX(var(--end-tab-separator-position-x, 0px)) translateY(var(--tab-separator-position-y, -50%)) !important;
        }
      `;
      doc.documentElement.appendChild(style);
    }
  }

  function ensureShadowStyle(scrollbox) {
    // ボタンの中身は shadow DOM の中にあるので、そこにもスタイルを入れる。
    // 2 行表示のように隙間が狭いときは、2 つのボタンで高さを等分して縮める
    const root = scrollbox.shadowRoot;
    if (root && !root.getElementById(SHADOW_STYLE_ID)) {
      const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      style.id = SHADOW_STYLE_ID;
      style.textContent = `
        :host([${ATTR}]) > toolbarbutton {
          flex: 1 1 0 !important;
          height: auto !important;
          min-height: 0 !important;
          padding-block: 0 !important;
          overflow: hidden;
        }
        :host([${ATTR}]) > toolbarbutton > .toolbarbutton-icon {
          padding-block: 0 !important;
        }
      `;
      root.appendChild(style);
    }
  }

  function restore(scrollbox) {
    if (scrollbox && scrollbox.hasAttribute(ATTR)) {
      scrollbox.removeAttribute(ATTR);
    }
  }

  function setVar(target, name, px) {
    const value = Math.round(px) + 'px';
    if (target.style.getPropertyValue(name) !== value) {
      target.style.setProperty(name, value);
    }
  }

  function update() {
    scheduled = false;
    updateScrollButtons();
    updateRowEnds();
  }

  // 1. スクロールボタンの配置
  function updateScrollButtons() {
    const scrollbox = el('tabmix-scrollbox');
    const button = el('tabGroups-tabview-button');
    const target = el('TabsToolbar-customization-target');
    watchButton(button);
    if (!scrollbox || !target) {
      return;
    }
    try {
      ensureShadowStyle(scrollbox);
      const multiRow = scrollbox.getAttribute('tabmix-flowing') === 'multibar';
      // 行が最大行数に収まっていてスクロールボタンが出ていないときは、空の枠を残さないよう元に戻す
      const overflowing = scrollbox.getAttribute('overflowing') === 'true';
      if (!multiRow || !overflowing || !button || button.parentNode !== target || button.hidden || button.collapsed) {
        restore(scrollbox);
        return;
      }
      const tr = target.getBoundingClientRect();
      const br = button.getBoundingClientRect();
      if (br.width === 0 || br.height === 0) {
        restore(scrollbox);
        return;
      }
      const top = br.bottom - tr.top;
      const height = tr.height - top;
      if (height < MIN_HEIGHT) {
        restore(scrollbox);
        return;
      }
      setVar(target, '--floorp-tmmr-left', br.left - tr.left);
      setVar(target, '--floorp-tmmr-top', top);
      setVar(target, '--floorp-tmmr-width', br.width);
      setVar(target, '--floorp-tmmr-height', height);
      if (!scrollbox.hasAttribute(ATTR)) {
        scrollbox.setAttribute(ATTR, 'true');
      }
    } catch (ex) {
      warn('配置の更新に失敗しました', ex);
      restore(scrollbox);
    }
  }

  // 4. 行の右端のタブに属性を付ける(区切り線は CSS が描く)
  function updateRowEnds() {
    const gb = win.gBrowser;
    if (!gb) {
      return;
    }
    try {
      const scrollbox = el('tabmix-scrollbox');
      const multiRow = !!scrollbox && scrollbox.getAttribute('tabmix-flowing') === 'multibar';
      // ピン留めしたタブは別の入れ物、Tab Groups で隠したタブは行に並ばないので数えない
      const tabs = multiRow ? gb.visibleTabs.filter((t) => !t.pinned) : [];
      const ends = new Set();
      // Lepton の区切り線を使うデザイン(protonfix・lepton)のときだけ付ける
      const themed = tabs.length > 0 && usesLeptonSeparator(tabs[0]);
      if (themed) {
        let prev = null;
        let prevTop = 0;
        for (const tab of tabs) {
          const r = tab.getBoundingClientRect();
          if (r.width === 0) {
            continue;
          }
          // 次のタブの上端が変わったら、ひとつ前のタブがその行の右端
          if (prev && Math.abs(r.top - prevTop) > 2) {
            ends.add(prev);
          }
          prev = tab;
          prevTop = r.top;
        }
        if (prev) {
          ends.add(prev);
        }
      }
      for (const tab of gb.tabs) {
        const want = ends.has(tab);
        if (want !== tab.hasAttribute(ROWEND_ATTR)) {
          if (want) {
            tab.setAttribute(ROWEND_ATTR, 'true');
          } else {
            tab.removeAttribute(ROWEND_ATTR);
          }
        }
      }
    } catch (ex) {
      warn('行の右端の区切り線の更新に失敗しました', ex);
    }
  }

  // Lepton は最後のタブの右の線の位置を --end-tab-separator-position-x で決めている。
  // これがあるデザイン(Floorp 12.21 では protonfix・lepton)だけを対象にする。
  // fluerial は形の違う線を自分で描き、photon は別の方式なので、同じ線を足すと合わない
  function usesLeptonSeparator(tab) {
    const stack = tab.querySelector('.tab-stack');
    return !!stack && win.getComputedStyle(stack).getPropertyValue('--end-tab-separator-position-x').trim() !== '';
  }

  function observeTab(event) {
    if (tabResizeObserver && event.target) {
      tabResizeObserver.observe(event.target);
    }
    schedule();
  }

  function unobserveTab(event) {
    if (tabResizeObserver && event.target) {
      tabResizeObserver.unobserve(event.target);
    }
    schedule();
  }

  // 並び替え・ピン留めでは大きさが変わらないことがあるので、イベントでも計算し直す
  const TAB_EVENTS = ['TabMove', 'TabShow', 'TabHide', 'TabPinned', 'TabUnpinned', 'TabSelect'];

  // 位置を変えるとタブの幅が変わって行数が変わることがあるので、1 フレームにまとめて計算し直す
  function schedule() {
    if (!scheduled) {
      scheduled = true;
      win.requestAnimationFrame(update);
    }
  }

  // Tab Groups のボタンは後から作られたり、カスタマイズで作り直されたりするので、そのたびに監視し直す
  function watchButton(button) {
    if (button === observedButton || !resizeObserver) {
      return;
    }
    if (observedButton) {
      resizeObserver.unobserve(observedButton);
    }
    observedButton = button;
    if (button) {
      resizeObserver.observe(button);
    }
  }

  function onWheel(event) {
    const scrollbox = el('tabmix-scrollbox');
    if (!scrollbox || event.target !== scrollbox || scrollbox.getAttribute('tabmix-flowing') !== 'multibar') {
      return;
    }
    const arrowScrollbox = el('tabbrowser-arrowscrollbox');
    if (!arrowScrollbox || typeof arrowScrollbox.scrollByIndex !== 'function') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const delta = event.deltaY || event.deltaX;
    if (!delta) {
      return;
    }
    let rows;
    if (event.deltaMode === win.WheelEvent.DOM_DELTA_PIXEL) {
      pixelAccum += delta;
      rows = Math.trunc(pixelAccum / PIXELS_PER_ROW);
      pixelAccum -= rows * PIXELS_PER_ROW;
    } else {
      rows = delta > 0 ? 1 : -1;
    }
    if (!rows) {
      return;
    }
    // Tab Mix Plus の「ホイールの向きを逆にする」設定に合わせる
    if (Services.prefs.getBoolPref('extensions.tabmix.reversedScroll', false)) {
      rows = -rows;
    }
    try {
      arrowScrollbox.scrollByIndex(rows);
    } catch (ex) {
      warn('スクロールに失敗しました', ex);
    }
  }

  function init() {
    const toolbar = el('TabsToolbar');
    if (!toolbar) {
      return;
    }
    ensureDocumentStyle();
    resizeObserver = new win.ResizeObserver(schedule);
    resizeObserver.observe(toolbar);
    // スクロールボタンの出し入れ(行数の変化)や、ツールバーのカスタマイズでの並び替えを拾う
    mutationObserver = new win.MutationObserver(schedule);
    mutationObserver.observe(toolbar, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['tabmix-flowing', 'overflowing', 'hidden', 'collapsed'],
    });
    toolbar.addEventListener('wheel', onWheel, { passive: false });
    win.addEventListener('aftercustomization', schedule);
    // 4. タブ 1 枚ずつの大きさの変化(開く・閉じるときのアニメーション、幅の変化)で行の変わり目を数え直す
    const tabContainer = win.gBrowser && win.gBrowser.tabContainer;
    if (tabContainer) {
      tabResizeObserver = new win.ResizeObserver(schedule);
      for (const tab of win.gBrowser.tabs) {
        tabResizeObserver.observe(tab);
      }
      tabContainer.addEventListener('TabOpen', observeTab);
      tabContainer.addEventListener('TabClose', unobserveTab);
      for (const type of TAB_EVENTS) {
        tabContainer.addEventListener(type, schedule);
      }
    }
    win.addEventListener('unload', () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (tabResizeObserver) {
        tabResizeObserver.disconnect();
      }
      if (tabContainer) {
        tabContainer.removeEventListener('TabOpen', observeTab);
        tabContainer.removeEventListener('TabClose', unobserveTab);
        for (const type of TAB_EVENTS) {
          tabContainer.removeEventListener(type, schedule);
        }
      }
      toolbar.removeEventListener('wheel', onWheel);
      win.removeEventListener('aftercustomization', schedule);
    }, { once: true });
    schedule();
  }

  try {
    if (win.gBrowserInit && win.gBrowserInit.delayedStartupFinished) {
      init();
    } else {
      // Tab Mix Plus がタブバーを作り終えてから始める
      const observer = (subject, topic) => {
        if (subject === win) {
          Services.obs.removeObserver(observer, 'browser-delayed-startup-finished');
          try {
            init();
          } catch (ex) {
            warn('初期化に失敗しました', ex);
          }
        }
      };
      Services.obs.addObserver(observer, 'browser-delayed-startup-finished');
    }
  } catch (ex) {
    warn('初期化に失敗しました', ex);
  }
})(window);
