// ==UserScript==
// @name            UrlbarIconDrawer
// @description     アドレスバーの右端のアイコンを「<」ボタンにまとめる。「<」を押すと、まとめたアイコンがその場で横にスライドして出る。アイコンはドラッグで並べ替えられる
// @include         main
// @version         1.4.0
// ==/UserScript==

// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
// アイコンの要素はどれも動かさない(ブラウザ本体・Floorp・拡張機能が自分のアイコンを作り直したり消したり
// するので、要素を動かすとその処理とぶつかる。1.2 までは箱へ移していたため、Floorp のアプリのインストールの
// ボタンが作り直されるたびに古いものが残って増えていた)。
// 代わりに、まとめたアイコンに印(STASHED_ATTR)を付け、CSS の order で「<」のすぐ左に並べ、閉じているときは
// 幅 0 に縮めて隠す。「<」を押すと幅が戻って(スライドして)出る。並べ替えも order で行う。
// 対象は #page-action-buttons の中のアイコン(☆・共有・リーダービューなど、ほかのスクリプトのアイコン)と、
// UrlbarExtensionButtons.uc.js がアドレスバーに置いた拡張機能のボタン。
// どれをまとめるかは、アイコンを右クリックして選び、アイコンの id をカンマ区切りで設定 PREF に保存する。
// 並びはアイコンの id をカンマ区切りで ORDER_PREF に保存する。

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

  const LOG = '[UrlbarIconDrawer]';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const PREF = 'userChromeJS.urlbarIconDrawer';
  const BUTTON_ID = 'floorp-drawer-button';
  const STYLE_ID = 'floorp-drawer-style';
  const CONTEXT_ID = 'floorp-drawer-context';
  const MENU_CLASS = 'floorp-drawer-menuitem';
  const MENU_SEP_CLASS = 'floorp-drawer-menuseparator';
  // まとめたアイコンの印
  const STASHED_ATTR = 'floorp-drawer-stashed';
  // まとめたアイコンのうち、見えている先頭のもの(左側の角を丸める)
  const FIRST_ATTR = 'floorp-drawer-first';
  // 開いている印(#page-action-buttons と「<」に付ける)
  const OPEN_ATTR = 'floorp-drawer-open';
  // UrlbarExtensionButtons.uc.js の箱(拡張機能のボタンの置き場所)
  const UEB_BOX_ID = 'floorp-ueb-box';
  // まとめられないもの(このボタン自身・拡張機能の箱そのもの)
  const NOT_STASHABLE = new Set([BUTTON_ID, UEB_BOX_ID]);
  // まとめたアイコンの order の始まり(まとめていないアイコンより後ろ、「<」(9999)より前)
  const STASHED_ORDER_BASE = 9000;
  // スライドの時間(ミリ秒)
  const SLIDE_MS = 250;
  // スライドの間だけ付ける印(閉じたときの「幅 0」を止めて、アイコンを元の大きさに戻しておく)
  const SLIDING_ATTR = 'floorp-drawer-sliding';
  // 並べ替えの並び(アイコンの id のカンマ区切り)
  const ORDER_PREF = 'userChromeJS.urlbarIconOrder';
  // この距離(px)より動かしたらドラッグとみなす(それまではいつものクリック)
  const DRAG_THRESHOLD = 6;
  // ドラッグ中のアイコンの印
  const DRAGGING_ATTR = 'floorp-drawer-dragging';

  const doc = win.document;

  // 山かっこ(閉じているときは左向き「出す」、開いているときは右向き「畳む」)。幅 8px の細いアイコン
  const chevron = (d) => 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 16" fill="none" stroke="black" stroke-width="1.6" ' +
    `stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
  );
  const ICON_CLOSED = chevron('M6 3.5 1.5 8 6 12.5');
  const ICON_OPEN = chevron('M2 3.5 6.5 8 2 12.5');

  const ROW = '#page-action-buttons';
  const CSS = `
    :root {
      --floorp-drawer-tint: color-mix(in srgb, currentColor 12%, transparent);
      --floorp-drawer-tint-hover: color-mix(in srgb, currentColor 22%, transparent);
    }
    /* ほかのアイコンより幅を狭くする(左右の余白を詰める) */
    #${BUTTON_ID} {
      padding-inline: 3px !important;
      min-width: 0 !important;
      width: auto !important;
    }
    #${BUTTON_ID} > .floorp-drawer-icon {
      width: 8px;
      height: 16px;
      background-color: currentColor;
      mask: url("${ICON_CLOSED}") center / 8px 16px no-repeat;
    }
    #${BUTTON_ID}[${OPEN_ATTR}] > .floorp-drawer-icon {
      mask-image: url("${ICON_OPEN}");
    }
    /* 開いている間は、まとめたアイコンの並びと「<」に同じ薄い背景を付けて、ひとつながりのまとまりに見せる
       (先頭のアイコンは左側だけ角を丸め、「<」は右側だけ角を丸める) */
    #${BUTTON_ID}[${OPEN_ATTR}] {
      background-color: var(--floorp-drawer-tint) !important;
      border-start-start-radius: 0 !important;
      border-end-start-radius: 0 !important;
    }
    #${BUTTON_ID}[${OPEN_ATTR}]:hover {
      background-color: var(--floorp-drawer-tint-hover) !important;
    }
    /* 並べ替え: 拡張機能の箱の中身もアドレスバーのアイコンと同じ列に並ぶようにし(order が効くように)、
       キーボード移動用の印は先頭、「<」はいちばん右に固定する */
    ${ROW} > #${UEB_BOX_ID} {
      display: contents !important;
    }
    ${ROW} > toolbartabstop {
      order: -1;
    }
    ${ROW} > #${BUTTON_ID} {
      order: 9999;
    }
    /* まとめたアイコン: 閉じているときは幅 0 に縮める。開け閉めのスライドは slide() が動かす
       (スライドの間は SLIDING_ATTR を付けて元の大きさのままにし、余白と切り抜きで見える幅を変える) */
    ${ROW} [${STASHED_ATTR}] {
      flex-shrink: 0;
      overflow: hidden !important;
    }
    ${ROW}:not([${OPEN_ATTR}]):not([${SLIDING_ATTR}]) [${STASHED_ATTR}] {
      max-width: 0 !important;
      min-width: 0 !important;
      opacity: 0;
      padding-inline: 0 !important;
      margin-inline: 0 !important;
      border-inline-width: 0 !important;
      pointer-events: none;
    }
    ${ROW}:is([${OPEN_ATTR}], [${SLIDING_ATTR}]) [${STASHED_ATTR}] {
      background-color: var(--floorp-drawer-tint) !important;
      border-radius: 0 !important;
    }
    ${ROW}[${OPEN_ATTR}] [${STASHED_ATTR}]:not(.unified-extensions-item):hover {
      background-color: var(--floorp-drawer-tint-hover) !important;
    }
    ${ROW}:is([${OPEN_ATTR}], [${SLIDING_ATTR}]) [${STASHED_ATTR}][${FIRST_ATTR}] {
      border-start-start-radius: var(--urlbar-icon-border-radius, 4px) !important;
      border-end-start-radius: var(--urlbar-icon-border-radius, 4px) !important;
    }
    /* ドラッグ中のアイコンだけ半透明にする(同じ印をウィンドウ(:root)にも付けてカーソルを変えているので、
       アドレスバーの中に限る。限らないとウィンドウ全体が半透明になる) */
    ${ROW} [${DRAGGING_ATTR}] {
      opacity: 0.5;
    }
    :root[${DRAGGING_ATTR}] {
      cursor: grabbing !important;
    }
    /* 自前の右クリックメニューにはチェックもアイコンも無いので、チェック用に空けてある左の余白を詰める。
       Floorp のデザイン Lepton は padding-inline-start: var(--menu-background-padding-default) !important
       を付けていて、こちらの !important では上書きできないので、その変数をこのメニューで変える */
    #${CONTEXT_ID} {
      --menu-background-padding-default: var(--context-menu-background-padding, 12px);
    }
  `;

  // ---- 設定 ----

  function readList(pref) {
    try {
      const raw = Services.prefs.getStringPref(pref, '');
      return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    } catch (ex) {
      console.error(LOG, `設定の読み込みに失敗しました: ${pref}`, ex);
      return [];
    }
  }

  function writeList(pref, ids) {
    try {
      Services.prefs.setStringPref(pref, ids.join(','));
    } catch (ex) {
      console.error(LOG, `設定の保存に失敗しました: ${pref}`, ex);
    }
  }

  // ---- アイコン ----

  let button = null;
  let isOpen = false;

  function actionsBox() {
    return doc.getElementById('page-action-buttons');
  }

  // アイコンの置き場所(アドレスバーの右端・拡張機能の箱)
  function isIconParent(el) {
    return !!el && (el.id === 'page-action-buttons' || el.id === UEB_BOX_ID);
  }

  function isStashable(n) {
    return !!n.id && !NOT_STASHABLE.has(n.id) && n.localName !== 'toolbartabstop';
  }

  // 右クリック・ドラッグされた要素から、アイコンを探す
  function iconFrom(node) {
    for (let n = node; n && n !== doc.documentElement; n = n.parentNode) {
      if (isIconParent(n.parentNode)) return isStashable(n) ? n : null;
    }
    return null;
  }

  // アドレスバーの右端のアイコン(DOM の順)。拡張機能の箱の中身も 1 列に平らに並べる
  function allItems() {
    const out = [];
    const actions = actionsBox();
    if (!actions) return out;
    for (const n of actions.children) {
      if (n.id === UEB_BOX_ID) {
        out.push(...[...n.children].filter(isStashable));
      } else if (isStashable(n)) {
        out.push(n);
      }
    }
    return out;
  }

  // まとめた列 / まとめていない列のアイコン
  function groupItems(stashed) {
    return allItems().filter((n) => n.hasAttribute(STASHED_ATTR) === stashed);
  }

  function isCustomizing() {
    return doc.documentElement.hasAttribute('customizing');
  }

  // 印・並び・「<」をいまの設定とアイコンに合わせる(要素は動かさない)
  let applying = false;
  function apply() {
    if (isCustomizing() || !button) return;
    applying = true;
    try {
      const ids = readList(PREF);
      const items = allItems();
      for (const n of items) {
        const want = ids.includes(n.id);
        if (n.hasAttribute(STASHED_ATTR) !== want) n.toggleAttribute(STASHED_ATTR, want);
      }
      // アドレスバーの外へ出たもの(カスタマイズ中にツールバーへ戻った拡張機能のボタンなど)の印は外す
      for (const n of doc.querySelectorAll(`[${STASHED_ATTR}]`)) {
        if (!items.includes(n)) n.removeAttribute(STASHED_ATTR);
      }
      applyOrder();
      updateButton();
    } finally {
      applying = false;
    }
  }

  // 変化がまとめて来ても 1 回だけ合わせる。requestAnimationFrame は、ウィンドウが隠れていると止まって
  // しまうので使わず、いまの処理が終わった直後(マイクロタスク)に行う
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    Promise.resolve().then(() => {
      scheduled = false;
      try {
        apply();
      } catch (ex) {
        console.error(LOG, '並べ直しに失敗しました', ex);
      }
    });
  }

  // いまの見た目の順(order の小さい順)
  function visualItems(stashed) {
    return groupItems(stashed).sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0));
  }

  // まとめたアイコンのうち、いま表示されるもの(リーダービューのように、ページによって隠れるものがある)
  function visibleStashed() {
    return visualItems(true).filter((n) => !n.hidden);
  }

  function updateButton() {
    if (!button) return;
    const visible = visibleStashed();
    // 先頭の印(左側の角を丸める)を付け直す
    // 属性は変わるときだけ書き換える(同じ値でも書くと MutationObserver に届き、見張りと書き換えが
    // 果てしなく繰り返してブラウザが固まる)
    for (const n of doc.querySelectorAll(`[${FIRST_ATTR}]`)) {
      if (n !== visible[0]) n.removeAttribute(FIRST_ATTR);
    }
    if (visible[0] && !visible[0].hasAttribute(FIRST_ATTR)) visible[0].setAttribute(FIRST_ATTR, 'true');
    const hide = visible.length === 0;
    if (button.hidden !== hide) button.hidden = hide;
    if (hide && isOpen) setOpen(false);
  }

  function setOpen(open) {
    const actions = actionsBox();
    if (!actions || !button) return;
    const changed = isOpen !== open;
    isOpen = open;
    actions.toggleAttribute(OPEN_ATTR, open);
    button.toggleAttribute(OPEN_ATTR, open);
    button.setAttribute('tooltiptext', open ? L('アイコンを格納', 'Collapse icons') : L('アイコンを展開', 'Expand icons'));
    // 起動したときの「閉じる」(もともと閉じている)ではスライドしない(一瞬アイコンが見えてしまう)
    if (changed) slide(actions, open);
  }

  // 開け閉めのスライド(引き出しのように、まとめたアイコンの並びがひとかたまりで「<」の後ろから出入りする)。
  // アイコンは本体の場所から動かせない(並びの親を変えると本体や拡張機能が困る)ので、1 つずつ動かして
  // ひとかたまりに見せる: 左のアイコンから順に、右の余白を負にして詰めた幅を戻しつつ、はみ出した右側を
  // clip-path で切る。並び全体の幅が一定の速さで増え、左にあるアイコンほど早く全部見え、見えている部分は
  // 左へ押し出されていく(閉じるときはその逆で、右のアイコンから消える)
  let slideToken = 0;
  function slide(actions, open) {
    const items = visibleStashed();
    for (const n of items) for (const a of n.getAnimations()) a.cancel();
    const token = ++slideToken;
    const reduce = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !items.length) {
      actions.removeAttribute(SLIDING_ATTR);
      return;
    }
    try {
      // 元の大きさに戻して測る(同じ処理の中なので、戻した途中の姿は描かれない)
      actions.setAttribute(SLIDING_ATTR, 'true');
      const sized = items
        .map((n) => {
          const cs = win.getComputedStyle(n);
          const ms = parseFloat(cs.marginInlineStart) || 0;
          const me = parseFloat(cs.marginInlineEnd) || 0;
          const r = n.getBoundingClientRect();
          return { n, w: r.width, ms, me, left: r.left };
        })
        .filter((x) => x.w > 0)
        .sort((a, b) => a.left - b.left);
      const total = sized.reduce((t, x) => t + x.ms + x.w + x.me, 0);
      if (!total) {
        actions.removeAttribute(SLIDING_ATTR);
        return;
      }
      let before = 0;
      const anims = [];
      for (const x of sized) {
        const span = x.ms + x.w + x.me;
        // 閉じた姿: 右の余白を負にして、このアイコンの場所を 0 にする。見える部分も無し
        const shut = { marginInlineEnd: `${x.me - span}px`, clipPath: `inset(0 ${x.w}px 0 0)` };
        const full = { marginInlineEnd: `${x.me}px`, clipPath: 'inset(0 0 0 0)' };
        // 並び全体の中で、このアイコンが受け持つ時間の区間
        const start = open ? before / total : (total - before - span) / total;
        anims.push(x.n.animate(open ? [shut, full] : [full, shut], {
          duration: (SLIDE_MS * span) / total,
          delay: SLIDE_MS * start,
          easing: 'linear',
          fill: 'both',
        }));
        before += span;
      }
      Promise.all(anims.map((a) => a.finished)).then(() => {
        if (token !== slideToken) return; // 途中で次の開け閉めが始まった
        actions.removeAttribute(SLIDING_ATTR);
        for (const a of anims) a.cancel();
      }, () => {
        // 途中で取り消された(次の開け閉めが後片付けする)
      });
    } catch (ex) {
      console.error(LOG, 'スライドを動かせませんでした', ex);
      actions.removeAttribute(SLIDING_ATTR);
    }
  }

  function createButton() {
    const actions = actionsBox();
    if (!actions) throw new Error('アドレスバーの #page-action-buttons が見つかりません');
    button = doc.createXULElement('hbox');
    button.id = BUTTON_ID;
    button.className = 'urlbar-page-action';
    button.setAttribute('role', 'button');
    button.hidden = true;
    button.appendChild(doc.createElementNS(HTML_NS, 'span')).className = 'floorp-drawer-icon';
    // アドレスバーにフォーカスが移らないように mousedown を止め、click で開け閉めする
    button.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      try {
        setOpen(!isOpen);
      } catch (ex) {
        console.error(LOG, '開け閉めできませんでした', ex);
      }
    });
    actions.appendChild(button);
    setOpen(false);
  }

  // ---- 並び ----

  // 列ごとに、並びに入っているアイコンだけを並びの順に入れ替え、入っていないもの(あとから増えたアイコン)は
  // 元の位置のままにする。まとめたアイコンは STASHED_ORDER_BASE から(「<」のすぐ左)
  function applyOrder() {
    const order = readList(ORDER_PREF);
    for (const stashed of [false, true]) {
      const items = groupItems(stashed);
      const listed = items.filter((n) => order.includes(n.id))
        .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const base = stashed ? STASHED_ORDER_BASE : 0;
      items.map((n) => (order.includes(n.id) ? listed.shift() : n))
        .forEach((n, i) => { n.style.order = String(base + i + 1); });
    }
  }

  // ---- ドラッグで並べ替え ----

  let drag = null;

  function onDragMouseDown(e) {
    if (e.button !== 0 || isCustomizing() || drag) return;
    try {
      const item = iconFrom(e.target);
      if (!item) return;
      // popup 属性でパネルを開くアイコン(Floorp の QR コード・アプリのインストールなど)は、押した瞬間に開いて
      // ドラッグの邪魔になるので、押したときには開かせず、ドラッグしなかったときだけ離したときに開く
      const popupOwner = e.target.closest('[popup]');
      const popupId = popupOwner && item.contains(popupOwner) ? popupOwner.getAttribute('popup') : null;
      if (popupId) e.preventDefault();
      drag = { item, stashed: item.hasAttribute(STASHED_ATTR), startX: e.screenX, started: false, before: null, popupId, popupOwner };
      win.addEventListener('mousemove', onDragMove, true);
      win.addEventListener('mouseup', onDragUp, true);
      win.addEventListener('keydown', onDragKey, true);
    } catch (ex) {
      console.error(LOG, 'ドラッグを始められませんでした', ex);
      drag = null;
    }
  }

  function onDragMove(e) {
    if (!drag) return;
    try {
      if (!drag.started) {
        if (Math.abs(e.screenX - drag.startX) < DRAG_THRESHOLD) return;
        drag.started = true;
        drag.before = visualItems(drag.stashed).map((n) => n.id);
        drag.item.setAttribute(DRAGGING_ATTR, 'true');
        doc.documentElement.setAttribute(DRAGGING_ATTR, 'true');
      }
      e.preventDefault();
      // マウスの位置より左に中心があるアイコンの数 = 差し込む位置(同じ列の、見えているアイコンで数える)
      const full = visualItems(drag.stashed).filter((n) => n !== drag.item);
      const visible = full.filter((n) => !n.hidden && n.getBoundingClientRect().width > 0);
      const index = visible.filter((n) => {
        const r = n.getBoundingClientRect();
        return r.left + r.width / 2 < e.clientX;
      }).length;
      if (index === 0) {
        full.splice(visible.length ? full.indexOf(visible[0]) : 0, 0, drag.item);
      } else {
        full.splice(full.indexOf(visible[index - 1]) + 1, 0, drag.item);
      }
      const base = drag.stashed ? STASHED_ORDER_BASE : 0;
      full.forEach((n, i) => { n.style.order = String(base + i + 1); });
      if (drag.stashed) updateButton();
    } catch (ex) {
      console.error(LOG, 'ドラッグ中の並べ替えに失敗しました', ex);
    }
  }

  function endDrag() {
    win.removeEventListener('mousemove', onDragMove, true);
    win.removeEventListener('mouseup', onDragUp, true);
    win.removeEventListener('keydown', onDragKey, true);
    const d = drag;
    drag = null;
    if (d && d.started) {
      d.item.removeAttribute(DRAGGING_ATTR);
      doc.documentElement.removeAttribute(DRAGGING_ATTR);
      // ドラッグのあとの click でアイコンが押されないようにする
      const swallowClick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      win.addEventListener('click', swallowClick, { capture: true, once: true });
      win.setTimeout(() => win.removeEventListener('click', swallowClick, true), 0);
    }
    return d;
  }

  function onDragUp(e) {
    if (e.button !== 0) return;
    const d = endDrag();
    if (!d) return;
    if (!d.started) {
      // ドラッグしなかった: 押したときに止めたパネルをここで開く(ふつうのクリックと同じ結果)
      if (d.popupId) {
        try {
          const popup = doc.getElementById(d.popupId);
          if (popup && popup.state === 'closed') popup.openPopup(d.popupOwner, '', 0, 0, false, false, e);
        } catch (ex) {
          console.error(LOG, 'パネルを開けませんでした', d.popupId, ex);
        }
      }
      return;
    }
    try {
      // この列のアイコンの並びを保存する(もう 1 つの列の分はそのまま残す)
      const ids = visualItems(d.stashed).map((n) => n.id);
      writeList(ORDER_PREF, readList(ORDER_PREF).filter((id) => !ids.includes(id)).concat(ids));
    } catch (ex) {
      console.error(LOG, '並びを保存できませんでした', ex);
    }
  }

  // Esc でドラッグをやめて元の並びに戻す
  function onDragKey(e) {
    if (e.key !== 'Escape' || !drag || !drag.started) return;
    e.preventDefault();
    e.stopPropagation();
    const d = endDrag();
    const base = d.stashed ? STASHED_ORDER_BASE : 0;
    d.before.forEach((id, i) => {
      const n = doc.getElementById(id);
      if (n) n.style.order = String(base + i + 1);
    });
    updateButton();
  }

  // ---- 右クリックメニュー ----

  let contextIcon = null;

  function setLabel(item, icon) {
    item.setAttribute('label', icon.hasAttribute(STASHED_ATTR) ? L('アイコンを表示', 'Show icon') : L('アイコンを非表示', 'Hide icon'));
  }

  // 拡張機能のボタン(toolbar-context-menu)・拡張機能のページアクション(pageActionContextMenu)の右クリックメニュー
  function addMenuItem(popupId) {
    const popup = doc.getElementById(popupId);
    if (!popup || popup.querySelector(`:scope > .${MENU_CLASS}`)) return null;
    const item = doc.createXULElement('menuitem');
    item.className = MENU_CLASS;
    item.hidden = true;
    item.addEventListener('command', onMenuCommand);
    const sep = doc.createXULElement('menuseparator');
    sep.className = MENU_SEP_CLASS;
    sep.hidden = true;
    popup.insertBefore(sep, popup.firstChild);
    popup.insertBefore(item, sep);
    popup.addEventListener('popupshowing', onPopupShowing);
    return popup;
  }

  function onPopupShowing(event) {
    const popup = event.currentTarget;
    if (event.target !== popup) return;
    const item = popup.querySelector(`:scope > .${MENU_CLASS}`);
    const sep = popup.querySelector(`:scope > .${MENU_SEP_CLASS}`);
    if (!item || !sep) return;
    try {
      const icon = popup.triggerNode && iconFrom(popup.triggerNode);
      item.hidden = sep.hidden = !icon;
      if (!icon) return;
      contextIcon = icon;
      setLabel(item, icon);
    } catch (ex) {
      item.hidden = sep.hidden = true;
      console.error(LOG, 'メニューの準備に失敗しました', ex);
    }
  }

  // 拡張機能以外のアイコン(☆・共有・ほかのスクリプトのアイコンなど)は、ブラウザ本体が右クリックメニューを
  // 出さない(本体の処理が popupshowing を preventDefault する)ので、このスクリプトのメニューを出す
  let ownMenu = null;
  function onContextMenu(e) {
    try {
      const icon = iconFrom(e.target);
      if (!icon || icon.classList.contains('unified-extensions-item')) return;
      const action = win.BrowserPageActions && win.BrowserPageActions.actionForNode(e.target);
      if (action && action.extensionID) return;
      e.preventDefault();
      e.stopPropagation();
      if (!ownMenu) {
        ownMenu = doc.createXULElement('menupopup');
        ownMenu.id = CONTEXT_ID;
        const item = doc.createXULElement('menuitem');
        item.className = MENU_CLASS;
        item.addEventListener('command', onMenuCommand);
        ownMenu.appendChild(item);
        doc.getElementById('mainPopupSet').appendChild(ownMenu);
      }
      contextIcon = icon;
      setLabel(ownMenu.firstChild, icon);
      ownMenu.openPopupAtScreen(e.screenX, e.screenY, true, e);
    } catch (ex) {
      console.error(LOG, '右クリックメニューを開けませんでした', ex);
    }
  }

  function onMenuCommand() {
    const icon = contextIcon;
    contextIcon = null;
    if (!icon || !icon.id) return;
    try {
      const ids = readList(PREF);
      writeList(PREF, ids.includes(icon.id) ? ids.filter((id) => id !== icon.id) : ids.concat(icon.id));
    } catch (ex) {
      console.error(LOG, '切り替えに失敗しました', ex);
    }
  }

  // ---- 監視 ----

  // アイコンはあとから足されたり、作り直されたりする(ほかのスクリプト・Floorp・拡張機能のボタン)ので、
  // 置き場所の子の増減を見張る。アイコンの hidden の変化(ページによって出たり消えたりするもの)も見る
  const observer = new win.MutationObserver((mutations) => {
    if (applying) return;
    let needApply = false;
    let needButton = false;
    for (const m of mutations) {
      // アイコンの増減(アドレスバーの右端と拡張機能の箱の直下)だけを見る。アイコンの中の変化は関係ない
      if (m.type === 'childList' && (m.target.id === 'page-action-buttons' || m.target.id === UEB_BOX_ID)) {
        needApply = true;
      }
      // 「<」自身の hidden(updateButton が書く)は見ない
      if (m.type === 'attributes' && m.target !== button && isIconParent(m.target.parentNode)) needButton = true;
    }
    if (needApply) schedule();
    else if (needButton) updateButton();
  });

  function observeParents() {
    const actions = actionsBox();
    if (actions) {
      observer.observe(actions, { childList: true, attributes: true, attributeFilter: ['hidden'], subtree: true });
    }
  }

  const prefObserver = { observe: schedule };

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
      const popups = ['pageActionContextMenu', 'toolbar-context-menu'].map(addMenuItem).filter(Boolean);
      // アドレスバーの右端の、拡張機能以外のアイコンの右クリック
      actionsBox().addEventListener('contextmenu', onContextMenu, true);
      // ドラッグで並べ替え(アイコン自身の mousedown より先に見るため capture)
      actionsBox().addEventListener('mousedown', onDragMouseDown, true);
      observeParents();
      Services.prefs.addObserver(PREF, prefObserver);
      Services.prefs.addObserver(ORDER_PREF, prefObserver);
      win.addEventListener('aftercustomization', schedule);
      apply();
      win.addEventListener('unload', () => {
        try {
          observer.disconnect();
          Services.prefs.removeObserver(PREF, prefObserver);
          Services.prefs.removeObserver(ORDER_PREF, prefObserver);
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
