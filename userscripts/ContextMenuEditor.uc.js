// ==UserScript==
// @name            ContextMenuEditor
// @description     ページとタブの右クリックメニューを、メニューの上で直接編集する(項目を隠す・並べ替える・グループ(サブメニュー)にまとめる・区切りを置く)
// @include         main
// @version         1.0.4
// ==/UserScript==

// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
//
// しくみ: ページの右クリックメニューは 1 つの menupopup に全部の項目が入っていて、右クリックのたびに
// ブラウザ本体(nsContextMenu)が場面(リンク・画像・選んだ文字など)に合わせて項目の hidden を付け外しする。
// このスクリプトは本体の popupshowing の処理のあとに動き(本体のリスナーのほうが先に登録されている)、
//   1. 保存した並びのとおりに項目の要素を並べ直し、グループ(menu + menupopup)の中へ移す
//   2. 隠す項目に印(ATTR_HIDDEN)を付けて CSS で消す(本体の hidden には触らない)
//   3. 出る項目が無いグループと、続いたり端に来たりした区切りに印を付けて消す
// 本体は項目を id で探す(getElementById)ので、要素がグループの中へ移っても出し分けは効く。
// 編集の画面には、いま右クリックした場面で本体が出している項目だけを並べる。保存する並びには、
// その場面で出ていない項目も、前の並びのまま入る。

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

  const LOG = '[ContextMenuEditor]';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const PREF = 'userChromeJS.contextMenuEditor.';
  const STYLE_ID = 'cme-style';
  const PANEL_ID = 'cme-editor';
  const EDIT_ID_SUFFIX = '-cme-edit';
  const ATTR_HIDDEN = 'cme-hidden'; // 利用者が隠した
  const ATTR_COLLAPSED = 'cme-collapsed'; // 余分な区切り
  const ATTR_EMPTY = 'cme-empty'; // 出る項目が無いグループ
  const GROUP_PREFIX = 'cme-group-';
  const SEP_PREFIX = 'cme-sep-';

  // 編集できるメニュー
  const MENUS = {
    contentAreaContextMenu: { name: L('ページの右クリックメニュー', 'Page context menu') },
    tabContextMenu: { name: L('タブの右クリックメニュー', 'Tab context menu') },
  };

  // 名前(label)を持たない項目の呼び名
  const FRIENDLY = {
    'context-navigation': L('戻る・進む・再読み込み・ブックマーク(アイコンの列)', 'Back, Forward, Reload, Bookmark (icon row)'),
  };

  const doc = win.document;


  const CSS = `
    menupopup [${ATTR_HIDDEN}],
    menupopup [${ATTR_COLLAPSED}],
    menupopup [${ATTR_EMPTY}] {
      display: none !important;
    }
    /* 編集の入口: いちばん下の細い行の真ん中に、引き出しの取っ手のような短い横線だけを置く。
       Floorp のデザイン Lepton は項目の左に padding-inline-start: var(--menu-background-padding-default) !important
       (チェック用の空き)を付けていて、こちらの !important では上書きできないので、その変数を 0 にして左右をそろえる */
    menupopup > menuitem.cme-edit {
      --menu-background-padding-default: 0px;
      min-height: 0 !important;
      padding-block: 1px !important;
      padding-inline: 0 !important;
      justify-content: center;
    }
    /* 項目の中に要素を入れても、menuitem が描き直すときに消されるので、線は ::after で描く */
    menupopup > menuitem.cme-edit > * {
      display: none !important;
    }
    menupopup > menuitem.cme-edit::after {
      content: "";
      width: 16px;
      height: 12px;
      flex: none;
      background-color: currentColor;
      opacity: 0.45;
      mask: url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 12"><path d="M3 6h10" stroke="black" stroke-width="2" stroke-linecap="round"/></svg>')}") center / 16px 12px no-repeat;
    }
    menupopup > menuitem.cme-edit[_moz-menuactive]::after {
      opacity: 0.9;
    }

    /* ---- 編集の画面 ---- */
    #${PANEL_ID} {
      --panel-padding: 0;
    }
    #${PANEL_ID} .cme-inner {
      min-width: 300px;
      max-width: 440px;
      padding: 6px;
    }
    #${PANEL_ID} .cme-title {
      margin: 0 0 4px;
      padding: 2px 6px;
      font-size: 0.9em;
      opacity: 0.7;
    }
    #${PANEL_ID} .cme-list {
      max-height: 60vh;
      overflow-y: auto;
    }
    #${PANEL_ID} .cme-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 26px;
      padding: 2px 6px;
      border-radius: 4px;
      user-select: none;
    }
    #${PANEL_ID} .cme-row:hover {
      background-color: color-mix(in srgb, currentColor 8%, transparent);
    }
    #${PANEL_ID} .cme-row[data-hidden] .cme-sepline {
      opacity: 0.35;
    }
    #${PANEL_ID} .cme-row[data-hidden] .cme-label {
      opacity: 0.45;
      text-decoration: line-through;
    }
    #${PANEL_ID} .cme-grip,
    #${PANEL_ID} .cme-btn {
      width: 16px;
      height: 16px;
      flex: none;
      background-color: currentColor;
      opacity: 0.55;
    }
    #${PANEL_ID} .cme-grip {
      cursor: grab;
      mask: url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><g fill="black"><circle cx="6" cy="4" r="1.2"/><circle cx="10" cy="4" r="1.2"/><circle cx="6" cy="8" r="1.2"/><circle cx="10" cy="8" r="1.2"/><circle cx="6" cy="12" r="1.2"/><circle cx="10" cy="12" r="1.2"/></g></svg>')}") center / 16px 16px no-repeat;
    }
    #${PANEL_ID} .cme-btn {
      cursor: pointer;
      mask-position: center;
      mask-size: 16px 16px;
      mask-repeat: no-repeat;
    }
    #${PANEL_ID} .cme-btn:hover {
      opacity: 1;
    }
    #${PANEL_ID} .cme-eye {
      mask-image: url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.4"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>')}");
    }
    #${PANEL_ID} .cme-row[data-hidden] .cme-eye {
      mask-image: url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.4"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><path d="M2.5 13.5l11-11"/></svg>')}");
    }
    #${PANEL_ID} .cme-x {
      mask-image: url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>')}");
    }
    #${PANEL_ID} .cme-trash {
      mask-image: url("chrome://global/skin/icons/delete.svg");
    }
    #${PANEL_ID} .cme-folder {
      width: 16px;
      height: 16px;
      flex: none;
      background-color: currentColor;
      opacity: 0.7;
      mask: url("chrome://global/skin/icons/folder.svg") center / 16px 16px no-repeat;
    }
    #${PANEL_ID} .cme-label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${PANEL_ID} .cme-sepline {
      flex: 1;
      border-top: 1px dashed color-mix(in srgb, currentColor 45%, transparent);
    }
    #${PANEL_ID} .cme-group {
      margin: 2px 0;
      border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
      border-radius: 6px;
      padding: 2px;
    }
    #${PANEL_ID} .cme-group > .cme-children {
      padding-inline-start: 14px;
    }
    #${PANEL_ID} .cme-name {
      flex: 1;
      min-width: 0;
      font: inherit;
      color: inherit;
      background: transparent;
      border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
      border-radius: 4px;
      padding: 1px 6px;
    }
    #${PANEL_ID} .cme-empty-hint {
      padding: 4px 8px;
      font-size: 0.9em;
      opacity: 0.55;
    }
    #${PANEL_ID} [data-drop="before"] {
      box-shadow: inset 0 2px 0 var(--focus-outline-color, AccentColor);
    }
    #${PANEL_ID} [data-drop="after"] {
      box-shadow: inset 0 -2px 0 var(--focus-outline-color, AccentColor);
    }
    #${PANEL_ID} [data-drop="into"] {
      background-color: color-mix(in srgb, var(--focus-outline-color, AccentColor) 22%, transparent);
    }
    #${PANEL_ID} .cme-row[data-dragging] {
      opacity: 0.4;
    }
    #${PANEL_ID} .cme-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 2px 0;
      margin-top: 4px;
      border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    }
    #${PANEL_ID} .cme-bar > .cme-spacer {
      flex: 1;
    }
    #${PANEL_ID} .cme-bar > button {
      font: inherit;
      padding: 3px 10px;
      margin: 0;
    }
  `;

  // ---- 設定 ----

  // 保存の形: { order: [項目の id | { sep: id } | { group: id, label, items: [項目の id | { sep: id }] }], hidden: [id] }
  function loadConfig(menuId) {
    try {
      const raw = Services.prefs.getStringPref(PREF + menuId, '');
      if (!raw) return null;
      const cfg = JSON.parse(raw);
      if (!cfg || !Array.isArray(cfg.order)) throw new Error('order が無い');
      if (!Array.isArray(cfg.hidden)) cfg.hidden = [];
      return cfg;
    } catch (ex) {
      console.error(LOG, `${menuId} の設定を読めませんでした。元の並びで出します`, ex);
      return null;
    }
  }

  function saveConfig(menuId, cfg) {
    try {
      if (cfg) Services.prefs.setStringPref(PREF + menuId, JSON.stringify(cfg));
      else Services.prefs.clearUserPref(PREF + menuId);
    } catch (ex) {
      console.error(LOG, `${menuId} の設定を保存できませんでした`, ex);
    }
  }

  // ---- メニューの並べ直し ----

  // メニューごとの状態: 最初に見た本体の並び(元に戻す・新しく増えた項目の置き場所に使う)と、
  // いま出ている場面で本体が出している項目の id
  const menuState = {};
  // 編集の入口(横線)を押したときのマウスの位置(画面の座標)
  let lastPoint = null;

  function isMenuNode(n) {
    return n.localName === 'menuitem' || n.localName === 'menu' || n.localName === 'menuseparator' ||
      n.localName === 'menugroup';
  }

  function isOurs(n) {
    return n.id && (n.id.startsWith(GROUP_PREFIX) || n.id.startsWith(SEP_PREFIX) || n.id.endsWith(EDIT_ID_SUFFIX));
  }

  // 本体が出しているか(利用者の「隠す」は見ない)
  function nativeShown(n) {
    return !n.hidden && !n.collapsed;
  }

  function editItemOf(popup) {
    return doc.getElementById(popup.id + EDIT_ID_SUFFIX);
  }

  function ensureEditItem(popup) {
    let item = editItemOf(popup);
    if (!item) {
      item = doc.createXULElement('menuitem');
      item.id = popup.id + EDIT_ID_SUFFIX;
      item.className = 'cme-edit';
      item.setAttribute('tooltiptext', L('メニューを編集', 'Edit menu'));
      item.setAttribute('aria-label', L('メニューを編集', 'Edit menu'));
      // 押した位置を覚える(編集の画面をそこに開く)
      item.addEventListener('mouseup', (e) => {
        lastPoint = { x: e.screenX, y: e.screenY, t: Date.now() };
      });
      item.addEventListener('command', () => onEditCommand(popup));
    }
    // いつもいちばん下
    if (item.parentNode !== popup || item !== popup.lastElementChild) popup.appendChild(item);
    return item;
  }

  function sepElement(id) {
    let s = doc.getElementById(id);
    if (!s) {
      s = doc.createXULElement('menuseparator');
      s.id = id;
    }
    return s;
  }

  function groupElement(id, label) {
    let g = doc.getElementById(id);
    if (!g) {
      g = doc.createXULElement('menu');
      g.id = id;
      g.appendChild(doc.createXULElement('menupopup'));
    }
    g.setAttribute('label', label || L('グループ', 'Group'));
    return g;
  }

  // 並びを要素に当てはめる
  function applyOrder(popup, cfg) {
    const st = menuState[popup.id];
    const placed = new Set();
    const used = new Set();
    let ref = null; // 直前に置いた要素(新しく増えた項目を、本体の並びで前にある項目の後ろに置くため)
    const put = (container, node) => {
      container.appendChild(node);
      placed.add(node.id);
    };
    // 1. 並びのとおりに置く(id の無いものは飛ばす)
    for (const e of cfg.order) {
      if (typeof e === 'string') {
        const n = doc.getElementById(e);
        if (n && popup.contains(n) && !isOurs(n)) put(popup, n);
      } else if (e && e.sep) {
        put(popup, sepElement(e.sep));
        used.add(e.sep);
      } else if (e && e.group) {
        const g = groupElement(e.group, e.label);
        put(popup, g);
        used.add(e.group);
        const gp = g.firstElementChild;
        for (const c of e.items || []) {
          if (typeof c === 'string') {
            const n = doc.getElementById(c);
            if (n && popup.contains(n)) put(gp, n);
          } else if (c && c.sep) {
            put(gp, sepElement(c.sep));
            used.add(c.sep);
          }
        }
      }
    }
    // 2. 並びに無い項目(あとから増えたもの): 本体の最初の並びで前にあった項目の後ろへ。分からなければいちばん下へ
    const leftovers = [...popup.querySelectorAll('menuitem, menu, menuseparator, menugroup')]
      .filter((n) => n.id && !placed.has(n.id) && !isOurs(n) && isTopLevelCandidate(popup, n));
    for (const n of leftovers) {
      const k = st.nativeOrder.indexOf(n.id);
      ref = null;
      for (let i = k - 1; i >= 0 && k >= 0; i--) {
        const p = doc.getElementById(st.nativeOrder[i]);
        if (p && placed.has(p.id)) {
          ref = p;
          break;
        }
      }
      if (ref) ref.after(n);
      else popup.appendChild(n);
      placed.add(n.id);
    }
    // 3. 並びから消えた自前のグループ・区切りを外す
    for (const n of [...popup.querySelectorAll(`[id^="${GROUP_PREFIX}"], [id^="${SEP_PREFIX}"]`)]) {
      if (!used.has(n.id)) {
        // グループの中に本体の項目が残っていたら外へ出してから消す
        if (n.localName === 'menu') for (const c of [...n.firstElementChild.children]) popup.appendChild(c);
        n.remove();
      }
    }
  }

  // 並べ直しの対象になる要素か(メニューの直下か、自前のグループの中にある本体の要素)
  function isTopLevelCandidate(popup, n) {
    if (n.parentNode === popup) return true;
    const gp = n.parentNode;
    return gp && gp.parentNode && gp.parentNode.id && gp.parentNode.id.startsWith(GROUP_PREFIX) &&
      gp.parentNode.parentNode === popup;
  }

  // 元の並びに戻す(設定を消したとき)
  function restoreNative(popup) {
    const st = menuState[popup.id];
    for (const g of [...popup.querySelectorAll(`[id^="${GROUP_PREFIX}"]`)]) {
      for (const c of [...g.firstElementChild.children]) popup.appendChild(c);
      g.remove();
    }
    for (const s of [...popup.querySelectorAll(`[id^="${SEP_PREFIX}"]`)]) s.remove();
    let prev = null;
    for (const id of st.nativeOrder) {
      const n = doc.getElementById(id);
      if (!n || !popup.contains(n)) continue;
      if (prev) prev.after(n);
      else popup.prepend(n);
      prev = n;
    }
    for (const n of popup.querySelectorAll(`[${ATTR_HIDDEN}]`)) n.removeAttribute(ATTR_HIDDEN);
  }

  // 出る項目が無いグループと、余分な区切りを消す
  function tidy(container) {
    const visible = (n) => isMenuNode(n) && nativeShown(n) && !n.hasAttribute(ATTR_HIDDEN) && !n.hasAttribute(ATTR_EMPTY);
    // グループを先に(中身で出すかが決まる)
    for (const g of container.children) {
      if (g.id && g.id.startsWith(GROUP_PREFIX)) {
        tidy(g.firstElementChild);
        const any = [...g.firstElementChild.children].some((c) => visible(c) && c.localName !== 'menuseparator');
        g.toggleAttribute(ATTR_EMPTY, !any);
      }
    }
    let lastWasSep = true; // 先頭の区切りは消す
    let lastSep = null;
    for (const n of container.children) {
      if (n.classList.contains('cme-edit')) continue;
      n.removeAttribute(ATTR_COLLAPSED);
      if (!visible(n)) continue;
      if (n.localName === 'menuseparator') {
        if (lastWasSep) n.setAttribute(ATTR_COLLAPSED, 'true');
        else {
          lastWasSep = true;
          lastSep = n;
        }
      } else {
        lastWasSep = false;
        lastSep = null;
      }
    }
    // 最後の区切りは消す
    if (lastSep) lastSep.setAttribute(ATTR_COLLAPSED, 'true');
  }

  // id の無い項目(拡張機能や Floorp があとから足すものの一部)には、名前から作った id を付ける。
  // 名前が同じなら次に起動したときも同じ id になるので、並びと「隠す」を保存できる
  function ensureIds(popup) {
    for (const n of popup.querySelectorAll('menuitem, menu, menuseparator, menugroup')) {
      if (n.id || !isTopLevelCandidate(popup, n)) continue;
      const label = n.getAttribute('label') || n.textContent.trim();
      if (!label) continue;
      let h = 0;
      for (const ch of label) h = (h * 31 + ch.codePointAt(0)) >>> 0;
      const id = `cme-l-${h.toString(36)}`;
      if (!doc.getElementById(id)) n.id = id;
    }
  }

  // ウィンドウで受ける(popupshowing は泡立つ)。メニュー自身に付いた本体・Floorp のリスナーが全部終わってから動く
  // (メニューに付けると、あとから登録された Floorp のリスナーが、こちらのあとで項目を足したり隠したりする)
  function onPopupShowing(e) {
    const popup = e.target;
    if (!popup || !MENUS[popup.id] || !menuState[popup.id]) return;
    if (e.defaultPrevented) return; // 開くのをやめたメニュー
    try {
      ensureIds(popup);
      const cfg = loadConfig(popup.id);
      const st = menuState[popup.id];
      if (cfg) {
        applyOrder(popup, cfg);
        st.customized = true;
        const hidden = new Set(cfg.hidden);
        for (const n of popup.querySelectorAll('menuitem, menu, menuseparator, menugroup')) {
          if (!n.id || n.classList.contains('cme-edit')) continue;
          const want = hidden.has(n.id);
          if (n.hasAttribute(ATTR_HIDDEN) !== want) n.toggleAttribute(ATTR_HIDDEN, want);
        }
      } else if (st.customized) {
        restoreNative(popup);
        st.customized = false;
      }
      ensureEditItem(popup);
      tidy(popup);
    } catch (ex) {
      console.error(LOG, 'メニューを並べ直せませんでした', ex);
    }
  }

  // Floorp は、メニューが開いたあとにも項目を隠したり足したりする(「ページ全体を翻訳」は開いたあとに末尾へ
  // 足される)。開いたあとにもう一度整え、開いている間に項目が増えたら、編集の入口をいちばん下へ戻して
  // 区切りを整え直す
  const openObservers = new Map();

  function retidy(popup) {
    try {
      ensureEditItem(popup);
      tidy(popup);
    } catch (ex) {
      console.error(LOG, '区切りを整えられませんでした', ex);
    }
  }

  function onPopupShown(e) {
    const popup = e.target;
    if (!popup || !MENUS[popup.id] || !menuState[popup.id]) return;
    retidy(popup);
    if (openObservers.has(popup.id)) return;
    const mo = new win.MutationObserver(() => {
      // 自分で編集の入口を動かしたときの知らせは、もういちばん下なので何もしない
      const item = editItemOf(popup);
      if (item && item === popup.lastElementChild) return;
      retidy(popup);
    });
    mo.observe(popup, { childList: true });
    openObservers.set(popup.id, mo);
  }

  function onPopupHidden(e) {
    const popup = e.target;
    if (!popup || !openObservers.has(popup.id)) return;
    openObservers.get(popup.id).disconnect();
    openObservers.delete(popup.id);
  }

  // 編集の画面に並べる「この場面で実際に出ている項目」(編集の入口を押したとき、メニューが開いている間に調べる)。
  // 本体の hidden のほかに、Floorp などの CSS で消えているものや、余分で消した区切りも除く。
  // 利用者が隠したものは、本体が出しているなら並べる(出し直せるように)
  function collectShown(popup) {
    const ids = new Set();
    for (const n of popup.querySelectorAll('menuitem, menu, menuseparator, menugroup')) {
      if (!n.id || isOurs(n) || !isTopLevelCandidate(popup, n)) continue;
      const shown = n.hasAttribute(ATTR_HIDDEN) ? nativeShown(n) : win.getComputedStyle(n).display !== 'none';
      if (shown) ids.add(n.id);
    }
    return ids;
  }

  // ---- 編集の画面 ----

  // 編集用の木: いまの要素の並び(並べ直しのあと)から作る。{ kind: 'item'|'sep'|'group', id, label, hidden, children }
  function treeFromDom(popup) {
    const st = menuState[popup.id];
    const node = (n) => {
      if (n.id.startsWith(GROUP_PREFIX)) {
        return { kind: 'group', id: n.id, label: n.getAttribute('label') || L('グループ', 'Group'),
          children: [...n.firstElementChild.children].filter((c) => c.id && isMenuNode(c)).map(node) };
      }
      if (n.localName === 'menuseparator') {
        return { kind: 'sep', id: n.id, ours: n.id.startsWith(SEP_PREFIX), hidden: n.hasAttribute(ATTR_HIDDEN),
          shown: n.id.startsWith(SEP_PREFIX) || st.shownIds.has(n.id) };
      }
      return { kind: 'item', id: n.id, label: labelOf(n), hidden: n.hasAttribute(ATTR_HIDDEN), shown: st.shownIds.has(n.id) };
    };
    return [...popup.children].filter((c) => c.id && isMenuNode(c) && !c.classList.contains('cme-edit')).map(node);
  }

  function labelOf(n) {
    return FRIENDLY[n.id] || n.getAttribute('label') || n.getAttribute('aria-label') ||
      n.getAttribute('tooltiptext') || n.textContent.trim() || n.id;
  }

  function configFromTree(tree) {
    const hidden = [];
    const conv = (e) => {
      if (e.kind === 'group') return { group: e.id, label: e.label, items: e.children.map(conv) };
      if (e.kind === 'sep' && e.ours) return { sep: e.id };
      if (e.hidden) hidden.push(e.id);
      return e.id;
    };
    return { order: tree.map(conv), hidden };
  }

  // 編集中の状態
  const ed = { popup: null, tree: null, drag: null };

  function getPanel() {
    let panel = doc.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = doc.createXULElement('panel');
    panel.id = PANEL_ID;
    panel.setAttribute('type', 'arrow');
    panel.setAttribute('role', 'dialog');
    const inner = doc.createElementNS(HTML_NS, 'div');
    inner.className = 'cme-inner';
    panel.appendChild(inner);
    panel.addEventListener('popuphidden', (e) => {
      if (e.target === panel) endDrag();
    });
    doc.getElementById('mainPopupSet').appendChild(panel);
    return panel;
  }

  function onEditCommand(popup) {
    try {
      // 開く位置: 編集の入口を押したときのマウスの位置。command の時点ではメニューがもう閉じていて、
      // メニューの位置(getOuterScreenRect)は 0 になる
      let pt = lastPoint && Date.now() - lastPoint.t < 2000 ? lastPoint : null;
      if (!pt) {
        // キーボードで選んだときなど: ウィンドウの真ん中あたり
        pt = { x: win.mozInnerScreenX + win.innerWidth / 2 - 160, y: win.mozInnerScreenY + 80 };
      }
      const r = { left: pt.x, top: pt.y };
      menuState[popup.id].shownIds = collectShown(popup);
      ed.popup = popup;
      ed.tree = treeFromDom(popup);
      ed.nextId = Date.now();
      const panel = getPanel();
      render();
      // メニューが閉じきってから開く(閉じる処理とぶつからないように)
      win.setTimeout(() => panel.openPopupAtScreen(Math.round(r.left), Math.round(r.top), false), 0);
    } catch (ex) {
      console.error(LOG, '編集の画面を開けませんでした', ex);
    }
  }

  function el(tag, cls, text) {
    const e = doc.createElementNS(HTML_NS, tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function iconBtn(cls, tip, onClick) {
    const b = el('div', `cme-btn ${cls}`);
    b.setAttribute('role', 'button');
    b.setAttribute('title', tip);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  // 編集の画面に出すか: この場面で本体が出している項目・区切り、自前の区切り、グループ
  function displayed(e) {
    if (e.kind === 'group') return true;
    return e.shown;
  }

  function render() {
    const panel = getPanel();
    const inner = panel.firstElementChild;
    inner.textContent = '';
    inner.appendChild(el('div', 'cme-title', L(`${MENUS[ed.popup.id].name}を編集`, `Edit ${MENUS[ed.popup.id].name.toLowerCase()}`)));
    const list = el('div', 'cme-list');
    const addRows = (arr, container) => {
      for (const e of arr) {
        if (!displayed(e)) continue;
        container.appendChild(rowFor(e, arr));
      }
    };
    addRows(ed.tree, list);
    inner.appendChild(list);
    const bar = el('div', 'cme-bar');
    const btn = (label, fn) => {
      const b = el('button', null, label);
      b.addEventListener('click', fn);
      return b;
    };
    bar.append(
      btn(L('グループを足す', 'Add group'), () => {
        ed.tree.push({ kind: 'group', id: GROUP_PREFIX + ed.nextId++, label: L('新しいグループ', 'New group'), children: [] });
        render();
      }),
      btn(L('区切りを足す', 'Add separator'), () => {
        ed.tree.push({ kind: 'sep', id: SEP_PREFIX + ed.nextId++, ours: true, shown: true });
        render();
      }),
      el('div', 'cme-spacer'),
      btn(L('元に戻す', 'Reset'), () => {
        // 設定を消して、本体の並びに戻す
        saveConfig(ed.popup.id, null);
        panel.hidePopup();
      }),
      btn(L('完了', 'Done'), () => {
        saveConfig(ed.popup.id, configFromTree(ed.tree));
        panel.hidePopup();
      }));
    inner.appendChild(bar);
  }

  function rowFor(e, arr) {
    if (e.kind === 'group') {
      const box = el('div', 'cme-group');
      const head = el('div', 'cme-row');
      head.dataset.kind = 'group';
      const name = el('input', 'cme-name');
      name.value = e.label;
      name.setAttribute('aria-label', L('グループの名前', 'Group name'));
      name.addEventListener('input', () => {
        e.label = name.value;
      });
      name.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') name.blur();
      });
      head.append(grip(e, arr, head), el('div', 'cme-folder'), name,
        iconBtn('cme-trash', L('グループを消す(中の項目は外に出る)', 'Delete group (items move out)'), () => {
          const i = arr.indexOf(e);
          arr.splice(i, 1, ...e.children);
          render();
        }));
      bindDrop(head, e, arr, true);
      const kids = el('div', 'cme-children');
      let any = false;
      for (const c of e.children) {
        if (!displayed(c)) continue;
        kids.appendChild(rowFor(c, e.children));
        any = true;
      }
      if (!any) {
        const hint = el('div', 'cme-empty-hint', L('ここへ項目をドラッグ', 'Drag items here'));
        bindDrop(hint, null, e.children, false, true);
        kids.appendChild(hint);
      }
      box.append(head, kids);
      return box;
    }
    const row = el('div', 'cme-row');
    if (e.kind === 'sep') {
      // 自前の区切りは × で消す。本体の区切りは消せないので、目で隠す・出す
      row.append(grip(e, arr, row), el('div', 'cme-sepline'), e.ours
        ? iconBtn('cme-x', L('区切りを消す', 'Remove separator'), () => {
          arr.splice(arr.indexOf(e), 1);
          render();
        })
        : iconBtn('cme-eye', e.hidden ? L('出す', 'Show') : L('隠す', 'Hide'), () => {
          e.hidden = !e.hidden;
          render();
        }));
      if (e.hidden) row.dataset.hidden = 'true';
    } else {
      const label = el('div', 'cme-label', e.label);
      label.title = e.label;
      row.append(grip(e, arr, row), label,
        iconBtn('cme-eye', e.hidden ? L('出す', 'Show') : L('隠す', 'Hide'), () => {
          e.hidden = !e.hidden;
          render();
        }));
      if (e.hidden) row.dataset.hidden = 'true';
    }
    bindDrop(row, e, arr, false);
    return row;
  }

  // ---- ドラッグで並べ替え ----

  function grip(e, arr, row) {
    const g = el('div', 'cme-grip');
    g.setAttribute('title', L('ドラッグで並べ替え', 'Drag to reorder'));
    g.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      ed.drag = { e, arr, row, target: null };
      row.dataset.dragging = 'true';
      win.addEventListener('mouseup', onDragEnd, true);
      win.addEventListener('keydown', onDragKey, true);
    });
    return g;
  }

  // 落とし先: row の上半分 = 前、下半分 = 後ろ。グループの見出しの下半分 = グループの中(先頭)
  function bindDrop(target, e, arr, isGroupHead, isEmptyHint) {
    target.addEventListener('mousemove', (ev) => {
      if (!ed.drag) return;
      ev.stopPropagation();
      clearDrop();
      if (e === ed.drag.e) return;
      // グループはグループの中へ入れられない
      const draggingGroup = ed.drag.e.kind === 'group';
      let where;
      if (isEmptyHint) {
        if (draggingGroup) return;
        where = 'into';
      } else {
        const r = target.getBoundingClientRect();
        const lower = ev.clientY > r.top + r.height / 2;
        if (isGroupHead && lower && !draggingGroup) where = 'into';
        else where = lower ? 'after' : 'before';
        if (draggingGroup && !ed.tree.includes(e)) return;
      }
      target.dataset.drop = where;
      ed.drag.target = { e, arr, where, isGroupHead };
    });
  }

  function clearDrop() {
    const panel = doc.getElementById(PANEL_ID);
    if (!panel) return;
    for (const n of panel.querySelectorAll('[data-drop]')) delete n.dataset.drop;
  }

  function onDragEnd() {
    const d = ed.drag;
    endDrag();
    if (!d || !d.target) return;
    const { e: te, arr: tarr, where, isGroupHead } = d.target;
    const from = d.arr.indexOf(d.e);
    if (from < 0) return;
    d.arr.splice(from, 1);
    if (where === 'into') {
      // グループの見出しへ落としたらグループの先頭、空のグループの案内へ落としたらその中
      const dest = isGroupHead ? te.children : tarr;
      dest.unshift(d.e);
    } else {
      let i = tarr.indexOf(te);
      if (i < 0) i = tarr.length;
      tarr.splice(where === 'after' ? i + 1 : i, 0, d.e);
    }
    render();
  }

  function onDragKey(ev) {
    if (ev.key !== 'Escape' || !ed.drag) return;
    ev.preventDefault();
    ev.stopPropagation();
    endDrag();
  }

  // ドラッグの後片付け(onDragEnd は呼ぶ前に ed.drag を読んでおく)
  function endDrag() {
    win.removeEventListener('mouseup', onDragEnd, true);
    win.removeEventListener('keydown', onDragKey, true);
    if (ed.drag && ed.drag.row) delete ed.drag.row.dataset.dragging;
    clearDrop();
    ed.drag = null;
  }

  // ---- 初期化 ----

  function init() {
    if (!doc.getElementById(STYLE_ID)) {
      const style = doc.createElementNS(HTML_NS, 'style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      doc.documentElement.appendChild(style);
    }
    for (const id of Object.keys(MENUS)) {
      const popup = doc.getElementById(id);
      if (!popup) {
        console.error(LOG, `${id} が見つかりません`);
        continue;
      }
      // 本体の最初の並び(id のある要素だけ)
      menuState[id] = {
        nativeOrder: [...popup.children].filter((n) => n.id && isMenuNode(n)).map((n) => n.id),
        customized: false,
        shownIds: new Set(),
      };
    }
    win.addEventListener('popupshowing', onPopupShowing);
    win.addEventListener('popupshown', onPopupShown);
    win.addEventListener('popuphidden', onPopupHidden);
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
