// ==UserScript==
// @name            SearchWordButtons
// @description     ツールバーの検索ボックスの文字を単語ごとのボタンにして、ページ内を単語ごとに検索・色分けして強調表示する
// @include         main
// @version         1.6.3
// ==/UserScript==

// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
// ページ側の処理はフレームスクリプト(下の contentMain)をウィンドウのメッセージマネージャーで
// 全タブに読み込んで行う。強調表示は CSS Custom Highlight API なので、ページの DOM は書き換えない。

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

  const LOG = '[SearchWordButtons]';
  const BOX_ID = 'floorp-swb-box';
  const HL_ID = 'floorp-swb-highlight';
  const CLEAR_ID = 'floorp-swb-clear';
  const STYLE_ID = 'floorp-swb-style';
  // 単語の色(文字色＋同じ色の下線。ページの強調表示とボタンで共通)。単語が多いときは繰り返す。
  // 明るい背景用(濃いめ)と暗い背景用(明るめ)を同じ順番で持ち、背景の明るさで使い分ける
  const PALETTE = {
    light: ['#A86F00', '#0B7F8C', '#B8336A', '#3B7D23', '#C45A00', '#7B3FA6', '#1F5FBF', '#7A7A00'],
    dark: ['#F2C14E', '#5FD3E0', '#F08CB2', '#9AD979', '#FFAB66', '#CFA0F0', '#8DB8FF', '#D8D86A'],
  };
  // 今の場所(橙)。文字色・太めの下線・ごく淡い背景
  const CURRENT = {
    light: { color: '#C2410C', background: 'rgba(255, 150, 50, 0.18)' },
    dark: { color: '#FFA45C', background: 'rgba(255, 150, 50, 0.22)' },
  };
  const COLOR_COUNT = PALETTE.light.length;
  // 強調ボタンのアイコン(「A」と下線)。マスクにして、色は CSS(オフ: 文字色、オン: 橙)で塗る
  const ICON_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<path fill-rule="evenodd" d="M7.1 1.5h1.8l3.8 9.5h-1.7l-.95-2.5H5.95L5 11H3.3zM6.5 7h3L8 3.1z"/>' +
    '<rect x="2" y="12.5" width="12" height="2" rx="1"/></svg>'
  );
  const ICON_ON_COLOR = '#F59E0B';
  // × ボタンのアイコン(検索ボックス自身の消去ボタンの代わり。強調ボタンの右に置くため)
  const CLEAR_ICON_URL = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
    '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="black" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>'
  );
  const MSG = 'floorp-swb:';

  const doc = win.document;
  let input = null;
  let words = [];
  let wordsKey = '';
  let highlight = false;
  const countsByBrowser = new WeakMap();

  // ---------------------------------------------------------------------------
  // ページ側(フレームスクリプト)。文字列にしてから読み込むので、外側の変数は使えない
  function contentMain(PALETTE, CURRENT, MSG) {
    const COLOR_COUNT = PALETTE.light.length;
    const NAME_PREFIX = 'floorp-swb-';
    const CUR_NAME = NAME_PREFIX + 'cur';
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'HEAD', 'TITLE']);
    let words = [];
    let key = '';
    let highlight = false;
    let cursor = null; // 前回見つけた位置 { doc, docIndex, start }
    let observer = null;
    let observedDoc = null;
    let refreshTimer = 0;
    // 文書のウィンドウ → 入れたスタイルの URL(明るい背景用か暗い背景用か)
    const sheetByWindow = new WeakMap();

    function sheetUrlFor(mode) {
      const cur = CURRENT[mode];
      const text = PALETTE[mode].map((c, i) =>
        `::highlight(${NAME_PREFIX}c${i}){color:${c} !important;background-color:transparent !important;` +
        `text-decoration:underline 1.5px ${c} !important;}`
      ).join('') +
        `::highlight(${CUR_NAME}){color:${cur.color} !important;background-color:${cur.background} !important;` +
        `text-decoration:underline 2.5px ${cur.color} !important;}`;
      return 'data:text/css;charset=utf-8,' + encodeURIComponent(text);
    }

    // 背景が暗いページかどうか。背景色が透明なら、文字色が明るいかで判断する
    function parseRgb(value) {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/.exec(value || '');
      if (!m) {
        return null;
      }
      let a = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (m[4] && m[4].endsWith('%')) {
        a /= 100;
      }
      return { r: +m[1], g: +m[2], b: +m[3], a };
    }

    function luminance(c) {
      return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
    }

    function pageMode(d) {
      try {
        const w = d.defaultView;
        for (const el of [d.body, d.documentElement]) {
          if (!el) {
            continue;
          }
          const bg = parseRgb(w.getComputedStyle(el).backgroundColor);
          if (bg && bg.a > 0.5) {
            return luminance(bg) < 0.45 ? 'dark' : 'light';
          }
        }
        const fg = parseRgb(w.getComputedStyle(d.body || d.documentElement).color);
        if (fg) {
          return luminance(fg) > 0.6 ? 'dark' : 'light';
        }
      } catch (ex) {
        logError('ページの明るさを判定できませんでした', ex);
      }
      return 'light';
    }

    function logError(what, ex) {
      try {
        console.error('[SearchWordButtons]', what, ex);
      } catch (e) {
        // ログが出せなくても処理は続ける
      }
    }

    // 上のページと、同じプロセスで触れる iframe の文書を順に集める(別プロセスの iframe は触れない)
    function collectDocs() {
      const out = [];
      const walk = (w) => {
        let d = null;
        try {
          d = w.document;
        } catch (ex) {
          return; // 別オリジン・別プロセス
        }
        if (d && d.body) {
          out.push(d);
        }
        let n = 0;
        try {
          n = w.frames.length;
        } catch (ex) {
          return;
        }
        for (let i = 0; i < n; i++) {
          try {
            walk(w.frames[i]);
          } catch (ex) {
            // 触れないフレームは飛ばす
          }
        }
      };
      walk(content);
      return out;
    }

    // 文書のテキストノードをつないだ文字列と、位置からノードを引く表を作る
    // (タグをまたいだ一致も見つけるため。ブロックの境目で偶然つながる一致も拾うが、許容する)
    function buildIndex(d) {
      const nodes = [];
      const starts = [];
      let text = '';
      const walker = d.createTreeWalker(d.body, 4 /* SHOW_TEXT */, {
        acceptNode(node) {
          for (let p = node.parentNode; p && p !== d.body; p = p.parentNode) {
            if (SKIP_TAGS.has(p.nodeName.toUpperCase())) {
              return 2; // FILTER_REJECT
            }
          }
          return 1; // FILTER_ACCEPT
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const v = n.nodeValue;
        if (!v) {
          continue;
        }
        nodes.push(n);
        starts.push(text.length);
        text += v;
      }
      const lower = text.toLowerCase();
      // 小文字にすると長さが変わる文字があると位置がずれるので、そのときは大文字小文字を区別する
      return { d, nodes, starts, text, hay: lower.length === text.length ? lower : text, folded: lower.length === text.length };
    }

    function nodeAt(index, pos, isEnd) {
      const { starts, nodes } = index;
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        // 終わりの位置はノードの末尾に付ける(次のノードの先頭にしない)
        if (isEnd ? starts[mid] < pos : starts[mid] <= pos) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return { node: nodes[lo], offset: pos - starts[lo] };
    }

    function makeRange(index, start, end) {
      const a = nodeAt(index, start, false);
      const b = nodeAt(index, end, true);
      const r = index.d.createRange();
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
      return r;
    }

    function findAll(index, word) {
      const needle = index.folded ? word.toLowerCase() : word;
      const out = [];
      if (!needle) {
        return out;
      }
      let at = index.hay.indexOf(needle);
      while (at !== -1) {
        out.push(at);
        at = index.hay.indexOf(needle, at + needle.length);
      }
      return out;
    }

    function ensureSheet(d) {
      const w = d.defaultView;
      if (!w) {
        return;
      }
      try {
        // ページの背景に合わせて入れ直す(後からダークモードに切り替わるページもあるため毎回見る)
        const url = sheetUrlFor(pageMode(d));
        const old = sheetByWindow.get(w);
        if (old === url) {
          return;
        }
        if (old) {
          w.windowUtils.removeSheetUsingURIString(old, w.windowUtils.AUTHOR_SHEET);
        }
        w.windowUtils.loadSheetUsingURIString(url, w.windowUtils.AUTHOR_SHEET);
        sheetByWindow.set(w, url);
      } catch (ex) {
        logError('強調表示のスタイルを入れられませんでした', ex);
      }
    }

    function clearNames(d, keepCurrent) {
      try {
        // フレームスクリプトからは Xray 越しで keys() を回せないので、使う名前を直接消す
        const reg = d.defaultView.CSS.highlights;
        for (let i = 0; i < COLOR_COUNT; i++) {
          reg.delete(NAME_PREFIX + 'c' + i);
        }
        if (!keepCurrent) {
          reg.delete(CUR_NAME);
        }
      } catch (ex) {
        logError('強調表示を消せませんでした', ex);
      }
    }

    // 単語ごとの件数を数え、強調表示がオンなら色を付ける
    function refresh() {
      refreshTimer = 0;
      const counts = words.map(() => 0);
      for (const d of collectDocs()) {
        try {
          const index = buildIndex(d);
          const byColor = new Map();
          words.forEach((word, i) => {
            const found = findAll(index, word);
            counts[i] += found.length;
            if (highlight && found.length) {
              const slot = i % COLOR_COUNT;
              const list = byColor.get(slot) || [];
              for (const s of found) {
                list.push(makeRange(index, s, s + word.length));
              }
              byColor.set(slot, list);
            }
          });
          // 強調がオフなら今の場所の印も消す(オンの間は、ページをクリックするまで残す)
          clearNames(d, highlight);
          if (highlight) {
            ensureSheet(d);
            const w = d.defaultView;
            for (const [slot, ranges] of byColor) {
              w.CSS.highlights.set(NAME_PREFIX + 'c' + slot, new w.Highlight(...ranges));
            }
          }
        } catch (ex) {
          logError('ページの検索に失敗しました', ex);
        }
      }
      updateObserver();
      sendAsyncMessage(MSG + 'counts', { key, counts });
    }

    function scheduleRefresh(delay) {
      if (refreshTimer) {
        content.clearTimeout(refreshTimer);
      }
      refreshTimer = content.setTimeout(refresh, delay);
    }

    // 強調表示中は、後から読み込まれた部分にも付くように変化を見張る
    function dropObserver() {
      if (observer) {
        // ページを移ると前のページのオブジェクトは使えなくなる(dead object)ので、そのときは捨てるだけ
        try {
          if (!Components.utils.isDeadWrapper(observer)) {
            observer.disconnect();
          }
        } catch (ex) {
          logError('変化の監視を止められませんでした', ex);
        }
      }
      observer = null;
      observedDoc = null;
    }

    function updateObserver() {
      const d = content.document;
      if (!highlight || !words.length) {
        dropObserver();
        return;
      }
      if (observer && observedDoc === d && !Components.utils.isDeadWrapper(observer)) {
        return;
      }
      dropObserver();
      if (!d || !d.body) {
        return;
      }
      observer = new content.MutationObserver(() => scheduleRefresh(700));
      observer.observe(d.body, { childList: true, subtree: true, characterData: true });
      observedDoc = d;
    }

    function isVisible(range) {
      const node = range.startContainer;
      const el = node.nodeType === 1 ? node : node.parentElement;
      if (!el) {
        return false;
      }
      try {
        if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) {
          return false;
        }
      } catch (ex) {
        // 判定できなければ見えている扱い
      }
      return range.getClientRects().length > 0;
    }

    function find(wordIndex, backward) {
      const word = words[wordIndex];
      if (!word) {
        return { found: false };
      }
      const docs = collectDocs();
      const matches = [];
      docs.forEach((d, docIndex) => {
        try {
          const index = buildIndex(d);
          for (const s of findAll(index, word)) {
            matches.push({ d, docIndex, start: s, index });
          }
        } catch (ex) {
          logError('ページの検索に失敗しました', ex);
        }
      });
      const total = matches.length;
      if (!total) {
        return { found: false, total: 0 };
      }
      let base = null;
      if (cursor && docs.includes(cursor.doc)) {
        base = { docIndex: docs.indexOf(cursor.doc), start: cursor.start };
      }
      const after = m => !base || m.docIndex > base.docIndex || (m.docIndex === base.docIndex && m.start > base.start);
      const before = m => base && (m.docIndex < base.docIndex || (m.docIndex === base.docIndex && m.start < base.start));
      // 見えない場所(折りたたまれたメニューなど)は飛ばす。全部見えなければ見えないものも使う
      const order = backward ? [...matches].reverse() : matches;
      const pick = (cond) => {
        let fallback = null;
        for (const m of order) {
          if (!cond(m)) {
            continue;
          }
          const r = makeRange(m.index, m.start, m.start + word.length);
          if (isVisible(r)) {
            return { m, r };
          }
          fallback = fallback || { m, r };
        }
        return fallback;
      };
      // 端まで行ったら反対の端から(見えるものを優先)
      let hit = pick(backward ? before : after);
      if (!hit || !isVisible(hit.r)) {
        const wrapped = pick(() => true);
        if (wrapped && (!hit || isVisible(wrapped.r))) {
          hit = wrapped;
        }
      }
      if (!hit) {
        return { found: false, total };
      }
      cursor = { doc: hit.m.d, start: hit.m.start };
      const w = hit.m.d.defaultView;
      try {
        for (const d of docs) {
          d.defaultView.CSS.highlights.delete(CUR_NAME);
        }
        ensureSheet(hit.m.d);
        w.CSS.highlights.set(CUR_NAME, new w.Highlight(hit.r));
        // 現在の場所を他の色より上に出す
        w.CSS.highlights.get(CUR_NAME).priority = 1;
        // ページの選択にはしない(選択の色が今の場所の色を隠してしまうため)
        const el = hit.r.startContainer.parentElement;
        if (el) {
          el.scrollIntoView({ block: 'center', inline: 'nearest' });
        }
      } catch (ex) {
        logError('見つけた場所へ移動できませんでした', ex);
      }
      return { found: true, total, current: matches.indexOf(hit.m) + 1 };
    }

    addMessageListener(MSG + 'state', (msg) => {
      try {
        const data = msg.data || {};
        words = Array.isArray(data.words) ? data.words : [];
        key = data.key || '';
        highlight = !!data.highlight;
        if (!words.length) {
          cursor = null;
          for (const d of collectDocs()) {
            clearNames(d, false);
          }
        }
        scheduleRefresh(0);
      } catch (ex) {
        logError('状態の更新に失敗しました', ex);
      }
    });

    addMessageListener(MSG + 'find', (msg) => {
      let result = { found: false };
      try {
        result = find(msg.data.index, !!msg.data.backward);
      } catch (ex) {
        logError('検索に失敗しました', ex);
      }
      sendAsyncMessage(MSG + 'found', Object.assign({ key, index: msg.data.index }, result));
    });

    // 今の場所の印は、ページ(中の iframe も含む)をクリックしたら消す
    function clearCurrent() {
      for (const d of collectDocs()) {
        try {
          d.defaultView.CSS.highlights.delete(CUR_NAME);
        } catch (ex) {
          logError('今の場所の印を消せませんでした', ex);
        }
      }
    }
    addEventListener('mousedown', () => clearCurrent(), true);

    // ページを開き直したら数え直す(強調表示がオンなら付け直す)
    const onLoad = () => {
      if (words.length) {
        cursor = null;
        scheduleRefresh(300);
      }
    };
    addEventListener('DOMContentLoaded', onLoad, true);
    addEventListener('pageshow', onLoad, true);

    sendAsyncMessage(MSG + 'hello', {});
  }

  const FRAME_SCRIPT = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(
    `(${contentMain.toString()})(${JSON.stringify(PALETTE)}, ${JSON.stringify(CURRENT)}, ${JSON.stringify(MSG)});`
  );

  // ---------------------------------------------------------------------------
  // ツールバー側
  // 強調がオンで入力欄にフォーカスが無いとき、入力欄の文字の上に、同じ位置・同じ大きさで単語のボタンを
  // 重ねる(入力欄の文字は透明にする)。ボタンの位置は入力欄の文字の幅を測って決めるので、
  // オン・オフを切り替えても文字の位置は動かない。強調ボタンは入力欄の右に常に同じ場所に置く

  const SEARCHBAR_SELECTOR = '#searchbar-new';
  // 強調ボタンと × を入れる箱(入力欄の右、送信ボタンの左)
  const TOOLS_ID = 'floorp-swb-tools';
  const ACTIVE_ATTR = 'floorp-swb-active';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  let tokens = []; // 入力欄の文字列の中の単語 { text, start, index }(index は words の番号)
  let measureCanvas = null;
  let resizeObserver = null;

  function ensureStyle() {
    if (doc.getElementById(STYLE_ID)) {
      return;
    }
    const style = doc.createElementNS(XHTML_NS, 'style');
    style.id = STYLE_ID;
    style.textContent = `
      ${SEARCHBAR_SELECTOR} .urlbar-input-box {
        position: relative;
      }
      /* ボタンを出している間は入力欄の文字を隠す(同じ位置にボタンの文字が出る)。
         color を透明にすると入力欄の消去ボタン(✕)まで消えるので、文字の塗りだけを透明にする */
      ${SEARCHBAR_SELECTOR}[${ACTIVE_ATTR}] .urlbar-input {
        -webkit-text-fill-color: transparent !important;
      }
      /* 入力欄の文字の部分にだけ重ねる。ボタン以外のところのクリックは入力欄に通す */
      #${BOX_ID} {
        position: absolute;
        top: 0;
        bottom: 0;
        overflow: hidden;
        pointer-events: none;
        z-index: 1;
      }
      #${BOX_ID}[hidden] {
        display: none;
      }
      #${BOX_ID} > .floorp-swb-word {
        position: absolute;
        top: 0;
        height: 100%;
        margin: 0;
        padding: 0;
        white-space: pre;
        font: inherit;
        line-height: inherit;
        pointer-events: auto;
        cursor: pointer;
        border-radius: 3px;
        --floorp-swb-color: var(--floorp-swb-light);
        color: var(--floorp-swb-color);
        text-decoration: underline 1.5px var(--floorp-swb-color);
        text-underline-offset: 3px;
      }
      /* ツールバーが暗いテーマなら明るい方の色 */
      :root[lwtheme-brighttext] #${BOX_ID} > .floorp-swb-word {
        --floorp-swb-color: var(--floorp-swb-dark);
      }
      @media (prefers-color-scheme: dark) {
        :root:not([lwtheme]) #${BOX_ID} > .floorp-swb-word {
          --floorp-swb-color: var(--floorp-swb-dark);
        }
      }
      /* マウスを乗せたときの背景(周りの文字色を薄く混ぜるので、明るいテーマでも暗いテーマでも見える) */
      #${BOX_ID} > .floorp-swb-word:hover,
      #${HL_ID}:hover,
      #${CLEAR_ID}:hover {
        background-color: color-mix(in srgb, currentColor 18%, transparent) !important;
      }
      #${BOX_ID} > .floorp-swb-word:active,
      #${HL_ID}:active,
      #${CLEAR_ID}:active {
        background-color: color-mix(in srgb, currentColor 28%, transparent) !important;
      }
      #${BOX_ID} > .floorp-swb-word[notfound] {
        opacity: 0.5;
        text-decoration: line-through;
      }
      #${TOOLS_ID} {
        display: flex;
        align-items: center;
        margin-inline: 0;
      }
      #${TOOLS_ID}[hidden] {
        display: none;
      }
      /* 検索ボックス自身の消去ボタンは隠し、強調ボタンの右に × を置く(順番をそろえるため) */
      ${SEARCHBAR_SELECTOR} .urlbar-input::-moz-search-clear-button {
        display: none !important;
      }
      /* 強調ボタンと × はアイコンだけ。強調はオフで周りの文字色、オンで橙に点灯。
         検索ボックスの → (検索ボタン)もふくめて 3 つとも 20px の四角(アイコン 12px)にそろえる */
      ${SEARCHBAR_SELECTOR} .urlbar-go-button {
        box-sizing: border-box !important;
        width: 20px !important;
        height: 20px !important;
        min-width: 0 !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 4px !important;
        background-size: 12px 12px !important;
        border-radius: var(--urlbar-icon-border-radius, 4px);
      }
      #${HL_ID},
      #${CLEAR_ID} {
        appearance: none;
        margin: 0;
        padding: 4px !important;
        min-width: 0;
        min-height: 0;
        border-radius: var(--urlbar-icon-border-radius, 4px);
      }
      #${HL_ID} .toolbarbutton-text,
      #${CLEAR_ID} .toolbarbutton-text {
        display: none !important;
      }
      #${HL_ID} .toolbarbutton-icon,
      #${CLEAR_ID} .toolbarbutton-icon {
        display: block !important;
        width: 12px !important;
        height: 12px !important;
        padding: 0 !important;
        list-style-image: none !important;
        background-color: currentColor;
        opacity: 0.75;
        mask: url("${ICON_URL}") center / 12px 12px no-repeat;
      }
      #${CLEAR_ID} .toolbarbutton-icon {
        mask-image: url("${CLEAR_ICON_URL}");
      }
      #${HL_ID}[checked] .toolbarbutton-icon {
        background-color: ${ICON_ON_COLOR};
        opacity: 1;
      }
    `;
    doc.documentElement.appendChild(style);
  }

  function getSearchbar() {
    return doc.querySelector(SEARCHBAR_SELECTOR);
  }

  function findInput() {
    const sb = getSearchbar();
    return sb ? sb.querySelector('.urlbar-input') : null;
  }

  // 空白(全角も)で区切る。"…" で囲んだ部分は 1 語(ボタンの文字は入力どおり引用符付き)。
  // 大文字小文字だけ違う重複は同じ単語(同じ色・同じ検索)として扱う
  function parseTokens(value) {
    const outTokens = [];
    const outWords = [];
    const indexByKey = new Map();
    const text = String(value || '');
    const re = /"([^"]+)"|[^\s　]+/g;
    let m;
    while ((m = re.exec(text))) {
      const word = (m[1] !== undefined ? m[1] : m[0]).trim();
      if (!word) {
        continue;
      }
      const k = word.toLowerCase();
      let index = indexByKey.get(k);
      if (index === undefined) {
        index = outWords.length;
        indexByKey.set(k, index);
        outWords.push(word);
      }
      outTokens.push({ text: m[0], start: m.index, index });
    }
    return { tokens: outTokens, words: outWords };
  }

  function sendState() {
    try {
      win.messageManager.broadcastAsyncMessage(MSG + 'state', { words, key: wordsKey, highlight });
    } catch (ex) {
      console.error(LOG, 'ページへの送信に失敗しました', ex);
    }
  }

  function getBox() {
    return doc.getElementById(BOX_ID);
  }

  function wordTooltip(word, count) {
    const lines = [L(`「${word}」をページ内で検索(クリックで次、Shift+クリックで前)`, `Find "${word}" on the page (click: next, Shift+click: previous)`)];
    if (typeof count === 'number') {
      lines.push(L(`${count} 件`, `${count} ${count === 1 ? 'match' : 'matches'}`));
    }
    return lines.join('\n');
  }

  function applyCounts(counts) {
    const box = getBox();
    if (!box) {
      return;
    }
    box.querySelectorAll('.floorp-swb-word').forEach((b) => {
      const i = Number(b.getAttribute('data-index'));
      const n = counts && typeof counts[i] === 'number' ? counts[i] : undefined;
      b.setAttribute('tooltiptext', wordTooltip(words[i], n));
      b.toggleAttribute('notfound', n === 0);
    });
  }

  // 入力欄の文字の表示領域(テキストエディターの中身)。取れなければ入力欄そのもの
  function textArea() {
    let root = null;
    try {
      root = input.editor && input.editor.rootElement;
    } catch (ex) {
      root = null;
    }
    return root || input;
  }

  function measure(text, cs) {
    if (!measureCanvas) {
      measureCanvas = doc.createElementNS(XHTML_NS, 'canvas');
    }
    const ctx = measureCanvas.getContext('2d');
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    try {
      ctx.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    } catch (ex) {
      // letterSpacing に対応していなければそのまま
    }
    return ctx.measureText(text).width;
  }

  // ボタンを入力欄の文字と同じ位置に置く(入力欄の横スクロールにも合わせる)
  function layoutChips() {
    const box = getBox();
    if (!box || box.hidden || !input) {
      return;
    }
    try {
      const area = textArea();
      const parentRect = box.parentNode.getBoundingClientRect();
      const areaRect = area.getBoundingClientRect();
      const cs = win.getComputedStyle(input);
      box.style.left = `${areaRect.left - parentRect.left}px`;
      box.style.width = `${areaRect.width}px`;
      box.style.fontFamily = cs.fontFamily;
      box.style.fontSize = cs.fontSize;
      box.style.fontWeight = cs.fontWeight;
      box.style.fontStyle = cs.fontStyle;
      box.style.letterSpacing = cs.letterSpacing;
      box.style.lineHeight = `${areaRect.height}px`;
      const scroll = Math.max(area.scrollLeft || 0, input.scrollLeft || 0);
      const value = input.value;
      box.querySelectorAll('.floorp-swb-word').forEach((b) => {
        const t = tokens[Number(b.getAttribute('data-token'))];
        if (!t) {
          return;
        }
        b.style.left = `${measure(value.slice(0, t.start), cs) - scroll}px`;
        b.style.width = `${measure(t.text, cs)}px`;
      });
    } catch (ex) {
      console.error(LOG, 'ボタンの位置を合わせられませんでした', ex);
    }
  }

  // 強調ボタンは単語があれば出す(場所は変わらない)。単語のボタンは強調がオンで、入力欄にフォーカスが
  // 無いときだけ
  function updateVisibility() {
    const box = getBox();
    const sb = getSearchbar();
    const tools = doc.getElementById(TOOLS_ID);
    if (tools) {
      tools.hidden = !input || words.length === 0;
    }
    const show = !!box && !!input && highlight && words.length > 0 && doc.activeElement !== input;
    if (box) {
      box.hidden = !show;
    }
    if (sb) {
      sb.toggleAttribute(ACTIVE_ATTR, show);
    }
    if (show) {
      layoutChips();
    }
  }

  function onChipMouseDown(event) {
    if (event.button !== 0) {
      return;
    }
    // 入力欄にフォーカスを移さない・検索ボックスの候補の一覧を開かない
    event.preventDefault();
    event.stopPropagation();
  }

  function onChipClick(event) {
    event.stopPropagation();
    if (event.button !== 0) {
      return;
    }
    try {
      const i = Number(event.currentTarget.getAttribute('data-index'));
      win.gBrowser.selectedBrowser.messageManager.sendAsyncMessage(MSG + 'find', { index: i, backward: !!event.shiftKey });
    } catch (ex) {
      console.error(LOG, '検索の指示を送れませんでした', ex);
    }
  }

  function rebuildButtons() {
    const box = getBox();
    if (!box) {
      return;
    }
    box.replaceChildren();
    tokens.forEach((t, k) => {
      const b = doc.createXULElement('label');
      b.classList.add('floorp-swb-word');
      b.textContent = t.text;
      b.setAttribute('data-index', String(t.index));
      b.setAttribute('data-token', String(k));
      b.setAttribute('tooltiptext', wordTooltip(words[t.index]));
      b.style.setProperty('--floorp-swb-light', PALETTE.light[t.index % COLOR_COUNT]);
      b.style.setProperty('--floorp-swb-dark', PALETTE.dark[t.index % COLOR_COUNT]);
      b.addEventListener('mousedown', onChipMouseDown);
      b.addEventListener('click', onChipClick);
      box.appendChild(b);
    });
    applyCounts(countsByBrowser.get(win.gBrowser.selectedBrowser));
    updateVisibility();
  }

  function updateFromInput() {
    const parsed = parseTokens(input ? input.value : '');
    const key = JSON.stringify(parsed.words);
    const tokensKey = JSON.stringify(parsed.tokens);
    const wordsChanged = key !== wordsKey;
    if (wordsChanged || tokensKey !== JSON.stringify(tokens)) {
      tokens = parsed.tokens;
      if (wordsChanged) {
        words = parsed.words;
        wordsKey = key;
      }
      rebuildButtons();
      if (wordsChanged) {
        sendState();
      }
    }
    updateVisibility();
  }

  function clearSearch() {
    if (input) {
      input.value = '';
      // 検索ボックス側の状態(候補など)も合わせる
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
    }
    updateFromInput();
  }

  // 縦のホイールで入力欄を横にスクロールし、ボタンも合わせて動かす
  function onBoxWheel(event) {
    if (!input || !event.deltaY) {
      return;
    }
    const area = textArea();
    if (area.scrollWidth <= area.clientWidth && input.scrollWidth <= input.clientWidth) {
      return;
    }
    event.preventDefault();
    const step = event.deltaMode === 0 ? event.deltaY : event.deltaY * 40;
    area.scrollLeft += step;
    if (area !== input) {
      input.scrollLeft += step;
    }
    layoutChips();
  }

  function ensureBox() {
    const sb = getSearchbar();
    const inputBox = sb ? sb.querySelector('.urlbar-input-box') : null;
    let box = getBox();
    if (!inputBox) {
      box?.remove();
      doc.getElementById(TOOLS_ID)?.remove();
      return null;
    }
    if (!box) {
      box = doc.createXULElement('box');
      box.id = BOX_ID;
      box.hidden = true;
      box.addEventListener('wheel', onBoxWheel, { passive: false });
    }
    if (box.parentNode !== inputBox) {
      inputBox.appendChild(box);
    }
    let tools = doc.getElementById(TOOLS_ID);
    if (!tools) {
      tools = doc.createXULElement('hbox');
      tools.id = TOOLS_ID;
      tools.hidden = true;
      const hl = doc.createXULElement('toolbarbutton');
      hl.id = HL_ID;
      hl.setAttribute('label', L('強調表示', 'Highlight'));
      hl.setAttribute('tooltiptext', L('ページ内の単語を強調表示(もう一度押すと消す)', 'Highlight the words on the page (press again to clear)'));
      hl.addEventListener('command', () => {
        try {
          highlight = !highlight;
          hl.toggleAttribute('checked', highlight);
          sendState();
          updateVisibility();
        } catch (ex) {
          console.error(LOG, '強調表示の切り替えに失敗しました', ex);
        }
      });
      const clear = doc.createXULElement('toolbarbutton');
      clear.id = CLEAR_ID;
      clear.setAttribute('label', L('消去', 'Clear'));
      clear.setAttribute('tooltiptext', L('検索ボックスを空にする', 'Clear the search box'));
      clear.addEventListener('command', () => {
        try {
          clearSearch();
        } catch (ex) {
          console.error(LOG, '検索ボックスを空にできませんでした', ex);
        }
      });
      tools.append(hl, clear);
      // ボタンを押しても入力欄にフォーカスを移さない・候補の一覧を開かない
      tools.addEventListener('mousedown', (event) => {
        if (event.button === 0) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
      tools.addEventListener('click', event => event.stopPropagation());
    }
    doc.getElementById(HL_ID)?.toggleAttribute('checked', highlight);
    if (tools.previousSibling !== inputBox || tools.parentNode !== inputBox.parentNode) {
      inputBox.after(tools);
    }
    // 検索ボックスの幅が変わったら位置を合わせ直す
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
    resizeObserver = new win.ResizeObserver(() => layoutChips());
    resizeObserver.observe(inputBox);
    rebuildButtons();
    return box;
  }

  const onInput = () => updateFromInput();
  // フォーカスの出入りのたびに表示を切り替える(blur の時点では activeElement が変わっていないことがある)
  const onFocusChange = () => win.setTimeout(updateFromInput, 0);

  function hookInput() {
    const next = findInput();
    if (next === input) {
      return;
    }
    if (input) {
      input.removeEventListener('input', onInput);
      input.removeEventListener('change', onInput);
      input.removeEventListener('focus', onFocusChange);
      input.removeEventListener('blur', onFocusChange);
    }
    input = next;
    if (input) {
      input.addEventListener('input', onInput);
      input.addEventListener('change', onInput);
      input.addEventListener('focus', onFocusChange);
      input.addEventListener('blur', onFocusChange);
    }
    updateFromInput();
  }

  function setup() {
    try {
      ensureStyle();
      hookInput();
      ensureBox();
      updateFromInput();
    } catch (ex) {
      console.error(LOG, '検索ボックスの準備に失敗しました', ex);
    }
  }

  // ツールバーのカスタマイズ中は外しておき、終わったら(検索ボックスが作り直されていても)付け直す
  function onBeforeCustomization() {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    getBox()?.remove();
    doc.getElementById(TOOLS_ID)?.remove();
    getSearchbar()?.removeAttribute(ACTIVE_ATTR);
  }

  function onAfterCustomization() {
    setup();
  }

  const messageHandlers = {
    hello(msg) {
      try {
        msg.target.messageManager.sendAsyncMessage(MSG + 'state', { words, key: wordsKey, highlight });
      } catch (ex) {
        console.error(LOG, '新しいタブへの送信に失敗しました', ex);
      }
    },
    counts(msg) {
      if (!msg.data || msg.data.key !== wordsKey) {
        return;
      }
      countsByBrowser.set(msg.target, msg.data.counts);
      if (msg.target === win.gBrowser.selectedBrowser) {
        applyCounts(msg.data.counts);
      }
    },
    found(msg) {
      if (!msg.data || msg.data.key !== wordsKey || msg.target !== win.gBrowser.selectedBrowser) {
        return;
      }
      // 同じ単語が入力欄に何度か出てくると、ボタンも複数ある
      const chips = getBox()?.querySelectorAll(`.floorp-swb-word[data-index="${msg.data.index}"]`) || [];
      if (!chips.length) {
        return;
      }
      if (typeof msg.data.total === 'number') {
        const counts = (countsByBrowser.get(msg.target) || []).slice();
        counts[msg.data.index] = msg.data.total;
        countsByBrowser.set(msg.target, counts);
        applyCounts(counts);
      }
      if (msg.data.found) {
        const tip = wordTooltip(words[msg.data.index], msg.data.total) + L(`(${msg.data.current} 件目)`, ` (match ${msg.data.current})`);
        chips.forEach(b => b.setAttribute('tooltiptext', tip));
      }
    },
  };

  const listener = {
    receiveMessage(msg) {
      try {
        const name = msg.name.slice(MSG.length);
        if (messageHandlers[name]) {
          messageHandlers[name](msg);
        }
      } catch (ex) {
        console.error(LOG, 'ページからのメッセージの処理に失敗しました', ex);
      }
    },
  };

  function onTabSelect() {
    applyCounts(countsByBrowser.get(win.gBrowser.selectedBrowser));
  }

  function init() {
    try {
      const mm = win.messageManager;
      for (const name of Object.keys(messageHandlers)) {
        mm.addMessageListener(MSG + name, listener);
      }
      // true: 今あるタブと、これから開くタブの両方に読み込む
      mm.loadFrameScript(FRAME_SCRIPT, true);
      setup();
      win.gBrowser.tabContainer.addEventListener('TabSelect', onTabSelect);
      win.addEventListener('beforecustomization', onBeforeCustomization);
      win.addEventListener('aftercustomization', onAfterCustomization);
      win.addEventListener('unload', () => {
        try {
          mm.removeDelayedFrameScript(FRAME_SCRIPT);
          for (const name of Object.keys(messageHandlers)) {
            mm.removeMessageListener(MSG + name, listener);
          }
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
