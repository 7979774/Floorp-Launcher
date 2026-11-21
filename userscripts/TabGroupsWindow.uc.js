// ==UserScript==
// @name            TabGroupsWindow
// @description     Tab Groups のグループを一時的に別ウィンドウで開き、そのウィンドウを閉じるときにグループを元のウィンドウへ戻す
// @include         main
// @version         1.3.2
// ==/UserScript==

// 必要なもの: Tab Groups (tabgroups@quicksaver) 2.2.0 以降(ItemMove.moveGroup を使う)
// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。

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

  const Cu = Components.utils;
  const LOG = '[TabGroupsWindow]';
  // このスクリプトが開いた「グループ用ウィンドウ」の目印。SessionStore に保存されるので再起動後も残る
  const WINDOW_KEY = 'floorp-tgw-group-window';
  // 開く前にグループがあった位置(前後のグループの id と slot)。閉じて戻すときに同じ位置へ入れる。
  // SessionStore に保存するので再起動後も残る
  const POSITION_KEY = 'floorp-tgw-position';
  // ウィンドウの名札(再起動しても変わらない)。グループ用ウィンドウには、開いた元のウィンドウの名札を
  // POSITION_KEY の originId に入れておき、再起動のあとでも元のウィンドウに戻せるようにする
  // (ウィンドウの参照は再起動で消える。グループの id はウィンドウごとに 1, 2, 3… と振られるので、
  // 別のウィンドウの同じ id のグループを目印にすると、関係ない位置に入ってしまう)
  const WINDOW_ID_KEY = 'floorp-tgw-window-id';
  // グループ用ウィンドウの位置・大きさ。{ byKey: { 目印: {x,y,w,h,max} }, byName: { 名前: … } }。
  // 目印(GROUP_KEY)で探し、無ければ名前で探す
  const BOUNDS_PREF = 'userChromeJS.tabGroupsWindow.bounds';
  // グループの目印。グループのタブに SessionStore のタブの値として付ける
  const GROUP_KEY = 'floorp-tgw-group-key';
  const TAB_MENU_ID = 'floorp-tgw-context-tab';
  const GROUP_MENU_ID = 'floorp-tgw-context-group';
  const TIMEOUT_MS = 15000;

  let opening = false;
  let returning = false;
  let passThrough = false;
  let tabMenuTarget = null;
  let groupMenuTarget = null;

  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));

  async function waitFor(check, what) {
    const end = Date.now() + TIMEOUT_MS;
    for (;;) {
      try {
        const value = check();
        if (value) {
          return value;
        }
      } catch (ex) {
        // 初期化途中のオブジェクトに触れて例外になることがあるので、成功するまで待つ
      }
      if (Date.now() > end) {
        throw new Error(`${what} がタイムアウトしました`);
      }
      await sleep(100);
    }
  }

  function tabViewOf(w) {
    const tabGroups = w && !w.closed && Cu.waiveXrays(w).tabGroups;
    return tabGroups ? tabGroups.TabView : null;
  }

  // TabView(グループ一覧)のフレームは遅延初期化なので、初期化を待ってからフレーム側の tabGroups を返す
  async function frameOf(w) {
    const tabView = await waitFor(() => {
      const tv = tabViewOf(w);
      return tv && typeof tv._initFrame === 'function' && tv;
    }, 'Tab Groups の読み込み');
    let timer = 0;
    try {
      await Promise.race([
        new Promise(resolve => tabView._initFrame(resolve)),
        new Promise((resolve, reject) => {
          timer = win.setTimeout(() => reject(new Error('TabView の初期化がタイムアウトしました')), TIMEOUT_MS);
        }),
      ]);
    } finally {
      win.clearTimeout(timer);
    }
    const frame = tabView._window && Cu.waiveXrays(tabView._window).tabGroups;
    if (!frame || !frame.GroupItems) {
      throw new Error('TabView のフレームが見つかりません');
    }
    return frame;
  }

  // 初期化済みのフレームだけを同期的に返す(メニュー表示時に使う)
  function readyFrameOf(w) {
    const tabView = tabViewOf(w);
    const frame = tabView && tabView._window && Cu.waiveXrays(tabView._window).tabGroups;
    return frame && frame.GroupItems ? frame : null;
  }

  // 閉じた直後(元に戻せる状態)のグループは hidden になっているので除く
  function liveGroups(frame) {
    return [...frame.GroupItems].filter(group => !group.hidden && !group._uninited);
  }

  function moveGroupFn(frame) {
    const itemMove = frame.ItemMove;
    if (!itemMove || typeof itemMove.moveGroup !== 'function') {
      throw new Error('この版の Tab Groups はグループのウィンドウ間移動に対応していません(2.2.0 以降が必要)');
    }
    // moveGroup は移動先ウィンドウのフレームで呼ぶ必要がある。slot を渡すとその位置に入り、
    // それ以降のグループが 1 つずつ後ろへずれる(渡さなければいちばん後ろ)
    return (group, slot) => itemMove.moveGroup(group, slot ? { slot } : null, null);
  }

  // グループの並び(slot の小さい順)
  function groupsInOrder(frame) {
    return liveGroups(frame).sort((a, b) => (a.slot || 0) - (b.slot || 0));
  }

  function isPrivate(w) {
    return win.PrivateBrowsingUtils.isWindowPrivate(w);
  }

  // ウィンドウの名札。まだ無ければ作って SessionStore に保存する
  function windowIdOf(w) {
    try {
      let id = w.SessionStore.getCustomWindowValue(w, WINDOW_ID_KEY);
      if (!id) {
        id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        w.SessionStore.setCustomWindowValue(w, WINDOW_ID_KEY, id);
      }
      return id;
    } catch (ex) {
      console.error(LOG, 'ウィンドウの名札を読めませんでした', ex);
      return null;
    }
  }

  // 名札を作らずに読むだけ
  function peekWindowId(w) {
    try {
      return w.SessionStore.getCustomWindowValue(w, WINDOW_ID_KEY) || null;
    } catch (ex) {
      return null;
    }
  }

  function isGroupWindow(w) {
    try {
      return w.SessionStore.getCustomWindowValue(w, WINDOW_KEY) === '1';
    } catch (ex) {
      console.error(LOG, 'ウィンドウの目印を読めませんでした', ex);
      return false;
    }
  }

  // ---- グループの目印(タブに付ける) ----
  // グループの id はウィンドウを移ると変わるので、グループのタブに変わらない目印を付けて見分ける。
  // 目印は SessionStore のタブの値なので、タブと一緒にウィンドウを移り、再起動しても残る

  function tabKey(tab) {
    try {
      return win.SessionStore.getCustomTabValue(tab, GROUP_KEY) || '';
    } catch (ex) {
      return '';
    }
  }

  function setTabKey(tab, key) {
    try {
      win.SessionStore.setCustomTabValue(tab, GROUP_KEY, key);
    } catch (ex) {
      console.error(LOG, 'タブに目印を付けられませんでした', ex);
    }
  }

  function groupTabs(group) {
    return group.children.map(item => item.tab).filter(tab => tab && tab.isConnected && !tab.closing);
  }

  // グループのタブでいちばん多い目印(タブを別のグループから移すと違う目印が混ざるので多数決にする)
  function groupKeyOf(group, except = null) {
    const count = new Map();
    for (const tab of groupTabs(group)) {
      const key = tab === except ? '' : tabKey(tab);
      if (key) {
        count.set(key, (count.get(key) || 0) + 1);
      }
    }
    let best = '';
    let max = 0;
    for (const [key, n] of count) {
      if (n > max) {
        best = key;
        max = n;
      }
    }
    return best;
  }

  // グループの目印を決めて(無ければ作って)、グループのタブ全部に付ける
  function ensureGroupKey(group) {
    const key = groupKeyOf(group) || win.crypto.randomUUID();
    for (const tab of groupTabs(group)) {
      if (tabKey(tab) !== key) {
        setTabKey(tab, key);
      }
    }
    return key;
  }

  // タブが入っているグループの目印を、そのタブにも付ける(新しいタブ・別のグループから移ってきたタブ)
  function syncTabKey(tab) {
    try {
      const item = tab && !tab.pinned && Cu.waiveXrays(tab)._tabViewTabItem;
      const group = item && item.parent;
      if (!group) {
        return false;
      }
      const key = groupKeyOf(group, tab);
      if (key && tabKey(tab) !== key) {
        setTabKey(tab, key);
      }
      return true;
    } catch (ex) {
      console.error(LOG, 'タブの目印を合わせられませんでした', ex);
      return true;
    }
  }

  // 新しいタブはグループに入るまで少しかかるので、入るまで待ってから合わせる
  function onTabOpen(event) {
    const tab = event.target;
    let tries = 0;
    const tick = () => {
      if (!tab.isConnected || tab.closing || syncTabKey(tab) || ++tries > 20) {
        return;
      }
      win.setTimeout(tick, 250);
    };
    win.setTimeout(tick, 250);
  }

  // タブバー(gBrowser の準備より先に DOM にある)。TabOpen / TabSelect はここまで上がってくる
  function tabStrip() {
    return win.document.getElementById('tabbrowser-tabs');
  }

  function onTabSelect(event) {
    syncTabKey(event.target);
  }

  // ---- ウィンドウの位置・大きさ ----

  function readAllBounds() {
    try {
      const raw = Services.prefs.getStringPref(BOUNDS_PREF, '');
      const all = raw ? JSON.parse(raw) : {};
      return {
        byKey: (all && all.byKey) || {},
        byName: (all && all.byName) || {},
      };
    } catch (ex) {
      console.error(LOG, 'ウィンドウの位置の記録を読めませんでした', ex);
      return { byKey: {}, byName: {} };
    }
  }

  // 閉じる前のこのウィンドウの位置・大きさを、開いたグループの目印(と名前)で覚える
  function saveBounds() {
    try {
      const frame = readyFrameOf(win);
      const position = savedPosition();
      if (!frame || !position || position.groupId == null) {
        return;
      }
      const group = liveGroups(frame).find(g => g.id === position.groupId);
      if (!group) {
        return;
      }
      const key = ensureGroupKey(group);
      const title = group.getTitle().trim();
      const all = readAllBounds();
      const prev = all.byKey[key] || (title && all.byName[title]) || null;
      const max = win.windowState === win.STATE_MAXIMIZED;
      // 最大化中の座標は元に戻したときの大きさではないので、前に覚えた大きさを残して「最大化」だけ記録する
      const bounds = max && prev
        ? { ...prev, max: true }
        : { x: win.screenX, y: win.screenY, w: win.outerWidth, h: win.outerHeight, max };
      all.byKey[key] = bounds;
      // 名前は目印が無いとき(タブを全部入れ替えたときなど)の予備
      if (title) {
        all.byName[title] = bounds;
      }
      Services.prefs.setStringPref(BOUNDS_PREF, JSON.stringify(all));
    } catch (ex) {
      console.error(LOG, 'ウィンドウの位置を覚えられませんでした', ex);
    }
  }

  // 覚えた位置・大きさがあれば新しいウィンドウに当てる。画面の外になるときは使わない
  function applyBounds(newWin, key, title) {
    try {
      const all = readAllBounds();
      const b = (key && all.byKey[key]) || (title && all.byName[title.trim()]) || null;
      if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) {
        return;
      }
      const screen = Cc['@mozilla.org/gfx/screenmanager;1']
        .getService(Ci.nsIScreenManager)
        .screenForRect(b.x, b.y, b.w, b.h);
      const ax = {}, ay = {}, aw = {}, ah = {};
      screen.GetAvailRectDisplayPix(ax, ay, aw, ah);
      // ウィンドウの上の部分(タイトルバーのあたり)が画面に入っているときだけ使う
      const visible = b.x + b.w > ax.value + 50 && b.x < ax.value + aw.value - 50 &&
        b.y >= ay.value - 10 && b.y < ay.value + ah.value - 50;
      if (!visible) {
        console.log(LOG, `グループ「${title}」の覚えた位置が画面の外なので使いません`);
        return;
      }
      newWin.resizeTo(b.w, b.h);
      newWin.moveTo(b.x, b.y);
      if (b.max) {
        newWin.maximize();
      }
    } catch (ex) {
      console.error(LOG, 'ウィンドウの位置を戻せませんでした', ex);
    }
  }

  function waitForDelayedStartup(w) {
    if (w.gBrowserInit && w.gBrowserInit.delayedStartupFinished) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const observer = subject => {
        if (subject === w) {
          Services.obs.removeObserver(observer, 'browser-delayed-startup-finished');
          resolve();
        }
      };
      Services.obs.addObserver(observer, 'browser-delayed-startup-finished');
    });
  }

  // Tab Groups が予約した「一覧にフォーカスを戻す」タイマーを取り消す(無ければ何もしない)
  function cancelOverviewRefocus(frame) {
    try {
      if (frame && frame.Timers && typeof frame.Timers.cancel === 'function') {
        frame.Timers.cancel('focusTabView');
      } else {
        console.warn(LOG, 'Tab Groups のタイマーが見つからないので、一覧へのフォーカスの戻しを取り消せません');
      }
    } catch (ex) {
      console.error(LOG, '一覧へのフォーカスの戻しを取り消せませんでした', ex);
    }
  }

  async function openGroupInNewWindow(group) {
    if (opening) {
      return false;
    }
    opening = true;
    let newWin = null;
    let moved = false;
    try {
      const sourceFrame = await frameOf(win);
      group = Cu.waiveXrays(group);
      if (!group || group._uninited || !liveGroups(sourceFrame).some(g => g.id === group.id)) {
        throw new Error('対象のグループが見つかりません');
      }
      if (liveGroups(sourceFrame).length < 2) {
        // グループが1つだけなら、今のウィンドウがすでに「そのグループだけのウィンドウ」
        console.log(LOG, 'このウィンドウのグループは1つだけなので何もしません');
        return false;
      }

      // 移す前にグループのタブ全部へ目印を付ける(タブと一緒に新しいウィンドウへ移る)
      const groupKey = ensureGroupKey(group);
      newWin = win.OpenBrowserWindow({ private: isPrivate(win) });
      await waitForDelayedStartup(newWin);
      applyBounds(newWin, groupKey, group.getTitle());
      const targetFrame = await frameOf(newWin);
      const moveGroup = moveGroupFn(targetFrame);
      // 新しいウィンドウの最初のタブ(ホーム)が Tab Groups のグループに入るまで待つ
      await waitFor(() => [...newWin.gBrowser.tabs].every(tab => {
        const item = Cu.waiveXrays(tab)._tabViewTabItem;
        return tab.pinned || (item && item.parent);
      }), '新しいウィンドウの準備');

      const initialTabs = [...newWin.gBrowser.tabs].filter(tab => !tab.pinned);
      const initialGroupIds = new Set(liveGroups(targetFrame).map(g => g.id));
      // 元のウィンドウでの位置(前後のグループ)を、移す前に控える
      const order = groupsInOrder(sourceFrame);
      const at = order.findIndex(g => g.id === group.id);
      const position = {
        originId: windowIdOf(win),
        prevId: at > 0 ? order[at - 1].id : null,
        nextId: at >= 0 && at < order.length - 1 ? order[at + 1].id : null,
        slot: group.slot || null,
      };
      if (!moveGroup(group)) {
        throw new Error('グループを移動できませんでした');
      }
      moved = true;

      const newGroup = liveGroups(targetFrame).find(g => !initialGroupIds.has(g.id));
      if (!newGroup) {
        throw new Error('移動したグループが新しいウィンドウに見つかりません');
      }
      // 移したグループを表示してから、最初からあったタブと空になったグループを片付ける
      targetFrame.GroupItems.updateActiveGroupItemAndTabBar(newGroup);
      const activeItem = newGroup.getActiveTab() || newGroup.children[0];
      if (activeItem) {
        newWin.gBrowser.selectedTab = activeItem.tab;
      }
      for (const tab of initialTabs) {
        if (tab.isConnected && !tab.closing) {
          newWin.gBrowser.removeTab(tab, { animate: false });
        }
      }
      for (const g of liveGroups(targetFrame)) {
        if (initialGroupIds.has(g.id) && !g.children.length) {
          g.close({ immediately: true });
        }
      }

      newWin.SessionStore.setCustomWindowValue(newWin, WINDOW_KEY, '1');
      try {
        position.groupId = newGroup.id;
        newWin.SessionStore.setCustomWindowValue(newWin, POSITION_KEY, JSON.stringify(position));
      } catch (ex) {
        console.error(LOG, '元の位置を保存できませんでした(閉じたときはいちばん後ろに戻ります)', ex);
      }
      newWin.__floorpTgwOrigin = Cu.getWeakReference(win);
      // 元のウィンドウで一覧(TabView)を開いていると、タブが抜けたときに Tab Groups が
      // 「一覧にフォーカスを戻す」処理(UI.focusTabView、0ms 後のタイマー)を予約する。
      // そのまま動くと、新しいウィンドウを前面に出した直後に元のウィンドウがアクティブに戻るので取り消す
      cancelOverviewRefocus(sourceFrame);
      // 準備の途中で元のウィンドウが前に戻ることがあるので、最後に新しいウィンドウを前面に出す
      if (newWin.windowState === newWin.STATE_MINIMIZED) {
        newWin.restore();
      }
      newWin.focus();
      console.log(LOG, `グループ「${newGroup.getTitle()}」を新しいウィンドウで開きました`);
      return true;
    } catch (ex) {
      console.error(LOG, 'グループを新しいウィンドウで開けませんでした', ex);
      // 移動前に失敗したときは、開いただけの空のウィンドウを閉じる(移動後なら閉じるとタブが失われるので残す)
      if (newWin && !moved && !newWin.closed) {
        newWin.close();
      }
      return false;
    } finally {
      opening = false;
    }
  }

  // グループを戻す先: 開いた元のウィンドウ → 他の通常ウィンドウ → 他のグループ用ウィンドウ の順
  function returnTargets() {
    const ref = win.__floorpTgwOrigin;
    let origin = ref && ref.get ? ref.get() : null;
    const position = savedPosition();
    let ordered;
    try {
      // 最近使った順(ブラウザウィンドウのグローバルにある BrowserWindowTracker)
      ordered = [...win.BrowserWindowTracker.orderedWindows];
    } catch (ex) {
      console.warn(LOG, 'ウィンドウの使用順を取得できなかったため、開いた順で選びます', ex);
      ordered = [...Services.wm.getEnumerator('navigator:browser')];
    }
    const candidates = ordered.filter(w => w !== win && !w.closed && !w.closing
      && isPrivate(w) === isPrivate(win) && tabViewOf(w));
    // 再起動のあとは参照が無いので、名札で元のウィンドウを探す
    if ((!origin || origin.closed) && position && position.originId) {
      origin = candidates.find(w => peekWindowId(w) === position.originId) || null;
    }
    const rank = w => (w === origin ? 0 : isGroupWindow(w) ? 2 : 1);
    return candidates.sort((a, b) => rank(a) - rank(b));
  }

  // 開く前に控えた位置を読む
  function savedPosition() {
    try {
      const raw = win.SessionStore.getCustomWindowValue(win, POSITION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (ex) {
      console.error(LOG, '元の位置を読めませんでした(いちばん後ろに戻します)', ex);
      return null;
    }
  }

  // 戻す先での slot。前にあったグループの次、それが無ければ後ろにあったグループの位置。
  // どちらも無い(ほかのウィンドウへ戻すときなど)なら null(いちばん後ろ)
  function returnSlot(targetFrame, position) {
    if (!position) {
      return null;
    }
    const groups = liveGroups(targetFrame);
    const prev = position.prevId != null && groups.find(g => g.id === position.prevId);
    if (prev) {
      return (prev.slot || 0) + 1;
    }
    const next = position.nextId != null && groups.find(g => g.id === position.nextId);
    if (next) {
      return next.slot || null;
    }
    return null;
  }

  async function returnGroups(target) {
    const sourceFrame = await frameOf(win);
    const targetFrame = await frameOf(target);
    const moveGroup = moveGroupFn(targetFrame);
    const groups = groupsInOrder(sourceFrame).filter(group => group.children.length);
    if (!groups.length) {
      return 0;
    }
    // 開いたグループを先頭に、このウィンドウで増やしたグループはその後ろに続けて戻す
    let position = savedPosition();
    // 前後のグループの id は元のウィンドウでしか意味が無いので、ほかのウィンドウへ戻すときは使わない
    // (名札が無い古い版で開いたものは、確かめられないので使う)
    if (position && position.originId && peekWindowId(target) !== position.originId) {
      position = { groupId: position.groupId };
    }
    if (position && position.groupId != null) {
      const main = groups.findIndex(g => g.id === position.groupId);
      if (main > 0) {
        groups.unshift(groups.splice(main, 1)[0]);
      }
    }
    let slot = returnSlot(targetFrame, position);
    // Tab Groups 2.5.0 の moveGroup は、移動元に他のグループが無いと代わりに表示するグループ探しで例外になる。
    // 先に新しいタブだけの空グループを作って表示しておき、全グループを移せるようにする(このウィンドウはこの後閉じる)
    const placeholder = sourceFrame.GroupItems.newGroup();
    placeholder.newTab();
    sourceFrame.GroupItems.updateActiveGroupItemAndTabBar(placeholder);
    const placeholderItem = placeholder.getActiveTab() || placeholder.children[0];
    if (placeholderItem) {
      win.gBrowser.selectedTab = placeholderItem.tab;
    }
    let failed = 0;
    for (const group of groups) {
      if (!moveGroup(group, slot)) {
        failed++;
        console.warn(LOG, `グループ「${group.getTitle()}」を戻せませんでした`);
      } else if (slot) {
        slot++;
      }
    }
    // moveGroup は移動先のタブバーを更新しないため、戻したタブが表示中のグループに混ざって見える。表示し直す
    if (typeof targetFrame.GroupItems._updateTabBar === 'function') {
      targetFrame.GroupItems._updateTabBar();
    }
    return failed;
  }

  // ウィンドウを閉じる操作を横取りしたら true。グループを戻し終えてから本来の閉じる処理をやり直す
  function interceptClose(closeAgain) {
    if (passThrough) {
      return false;
    }
    if (returning) {
      // 戻している最中にもう一度閉じようとしても無視する
      return true;
    }
    if (!isGroupWindow(win)) {
      return false;
    }
    const target = returnTargets()[0];
    if (!target) {
      // 最後のウィンドウなら終了扱い。グループはセッションに残るので何もしない
      return false;
    }
    returning = true;
    // グループを戻す前(ウィンドウがまだそのままの位置にあるうち)に位置・大きさを覚える
    saveBounds();
    (async () => {
      try {
        const failed = await returnGroups(target);
        if (failed) {
          console.warn(LOG, `${failed} 個のグループを戻せなかったため、通常どおり閉じます(最近閉じたウィンドウから復元できます)`);
        }
      } catch (ex) {
        console.error(LOG, 'グループを戻せなかったため、通常どおり閉じます', ex);
      } finally {
        returning = false;
      }
      if (win.closed) {
        return;
      }
      // 本来の確認処理(タブを閉じる警告・beforeunload)を通してから閉じる
      passThrough = true;
      try {
        if (closeAgain()) {
          win.close();
        }
      } catch (ex) {
        console.error(LOG, 'ウィンドウを閉じられませんでした', ex);
      } finally {
        passThrough = false;
      }
    })();
    return true;
  }

  function installCloseHooks() {
    // ×ボタンは window.onclose、Ctrl+Shift+W やメニューは WindowIsClosing() を通るので両方を包む
    const prevIsClosing = win.WindowIsClosing;
    if (typeof prevIsClosing === 'function') {
      win.WindowIsClosing = function (event) {
        if (interceptClose(() => prevIsClosing.call(win))) {
          return false;
        }
        return prevIsClosing.apply(this, arguments);
      };
    } else {
      console.warn(LOG, 'WindowIsClosing が見つからないため、Ctrl+Shift+W で閉じたときはグループを戻せません');
    }
    const prevOnClose = win.onclose;
    if (typeof prevOnClose === 'function') {
      win.onclose = function (event) {
        if (interceptClose(() => prevOnClose.call(win))) {
          return false;
        }
        return prevOnClose.apply(this, arguments);
      };
    } else {
      console.warn(LOG, 'window.onclose が見つからないため、×ボタンで閉じたときはグループを戻せません');
    }
  }

  function createMenuItem(id, label, onCommand) {
    const item = win.document.createXULElement('menuitem');
    item.id = id;
    item.setAttribute('label', label);
    item.addEventListener('command', () => {
      onCommand().catch(ex => console.error(LOG, 'メニューの処理に失敗しました', ex));
    });
    return item;
  }

  function setDisabled(item, disabled) {
    item.toggleAttribute('disabled', disabled);
  }

  function onTabContextMenu(popup) {
    let item = win.document.getElementById(TAB_MENU_ID);
    if (!item) {
      item = createMenuItem(TAB_MENU_ID, L('このグループを新しいウィンドウで開く', 'Open This Group in New Window'), async () => {
        const tab = tabMenuTarget;
        tabMenuTarget = null;
        if (!tab || !tab.isConnected) {
          return;
        }
        await frameOf(win);
        const tabItem = Cu.waiveXrays(tab)._tabViewTabItem;
        if (!tabItem || !tabItem.parent) {
          console.warn(LOG, 'このタブはどのグループにも入っていません');
          return;
        }
        await openGroupInNewWindow(tabItem.parent);
      });
      const moveToGroup = win.document.getElementById('tabGroups-context_tabViewMenu');
      const anchor = moveToGroup ? moveToGroup.nextSibling : win.document.getElementById('context_openTabInWindow');
      popup.insertBefore(item, anchor && anchor.parentNode === popup ? anchor : null);
    }
    const tab = win.TabContextMenu && win.TabContextMenu.contextTab;
    tabMenuTarget = tab || null;
    item.hidden = !tab || tab.pinned || !tabViewOf(win);
    // フレーム未初期化ならグループ数が分からないので有効のままにし、実行時に判定する
    const frame = readyFrameOf(win);
    setDisabled(item, !!frame && liveGroups(frame).length < 2);
  }

  function onGroupContextMenu(popup, tabView) {
    let item = win.document.getElementById(GROUP_MENU_ID);
    if (!item) {
      item = createMenuItem(GROUP_MENU_ID, L('新しいウィンドウで開く', 'Open in New Window'), async () => {
        // メニューを閉じると Tab Groups 側の _anchorItem が消えるので、表示時に控えたものを使う
        const group = groupMenuTarget;
        groupMenuTarget = null;
        if (group) {
          await openGroupInNewWindow(group);
        }
      });
      popup.appendChild(item);
    }
    groupMenuTarget = popup._anchorItem || Cu.waiveXrays(tabView.groupContextMenu)._anchorItem || null;
    const frame = readyFrameOf(win);
    setDisabled(item, !groupMenuTarget || (!!frame && liveGroups(frame).length < 2));
  }

  // シングルビュー上部のグループのサムネイル(.groupSelector)は、Tab Groups の右クリック処理が
  // グループとして扱わない(要素に _item ではなく groupItem が付いている)ので、メニューが出ない。
  // グループの枠と同じグループのメニューを開く(「新しいウィンドウで開く」は onGroupContextMenu で入る)
  function onFrameContextMenu(event) {
    try {
      // メニューキー(button 0)は Tab Groups が選択中の項目で処理するので触らない
      if (event.button !== 2) {
        return;
      }
      const tabView = tabViewOf(win);
      if (!tabView || !tabView._window) {
        return;
      }
      const target = event.target;
      // ownerGlobal(内側のウィンドウ)と _window(WindowProxy)は一致しないので文書で比べる
      if (!target || target.ownerDocument !== tabView._window.document) {
        return;
      }
      const selector = typeof target.closest === 'function' ? target.closest('.groupSelector') : null;
      // 閉じた直後(元に戻せる状態)のグループは、サムネイルが「元に戻す」ボタンになっている
      if (!selector || selector.classList.contains('closedGroup')) {
        return;
      }
      const group = Cu.waiveXrays(selector).groupItem;
      if (!group || group.hidden || group._uninited) {
        return;
      }
      // 検索中・グループのオプション表示中は、Tab Groups もグループのメニューを出さない
      const frame = readyFrameOf(win);
      if (!frame || (frame.Search && frame.Search.inSearch) ||
          (frame.GroupOptionsUI && frame.GroupOptionsUI.activeOptions)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      tabView.openGroupContextMenu(event, group);
    } catch (ex) {
      console.error(LOG, 'サムネイルのメニューを開けませんでした', ex);
    }
  }

  function onPopupShowing(event) {
    const popup = event.target;
    try {
      if (popup.id === 'tabContextMenu') {
        onTabContextMenu(popup);
        return;
      }
      const tabView = tabViewOf(win);
      if (tabView && popup.id === tabView.kGroupContextMenu) {
        onGroupContextMenu(popup, tabView);
      }
    } catch (ex) {
      console.error(LOG, 'メニューの準備に失敗しました', ex);
    }
  }

  try {
    win.addEventListener('popupshowing', onPopupShowing);
    // TabView のフレーム(親プロセスの iframe)のイベントはウィンドウのルートまで届く。
    // フレームは後から作られるので、フレーム自体ではなくルートで待つ
    win.windowRoot.addEventListener('contextmenu', onFrameContextMenu, true);
    // グループに入ってきたタブにも、そのグループの目印を付ける
    tabStrip()?.addEventListener('TabOpen', onTabOpen);
    tabStrip()?.addEventListener('TabSelect', onTabSelect);
    win.addEventListener('unload', () => {
      try {
        tabStrip()?.removeEventListener('TabOpen', onTabOpen);
        tabStrip()?.removeEventListener('TabSelect', onTabSelect);
        win.windowRoot.removeEventListener('contextmenu', onFrameContextMenu, true);
      } catch (ex) {
        console.error(LOG, '右クリックの監視を解除できませんでした', ex);
      }
    }, { once: true });
    if (win.document.readyState === 'complete') {
      installCloseHooks();
    } else {
      win.addEventListener('load', installCloseHooks, { once: true });
    }
    // ほかのスクリプトや動作確認から呼べる入口
    win.FloorpTabGroupsWindow = {
      openGroupInNewWindow,
      isGroupWindow: () => isGroupWindow(win),
      state: () => ({ opening, returning, passThrough, targets: returnTargets().length }),
    };
  } catch (ex) {
    console.error(LOG, '初期化に失敗しました', ex);
  }
})(window);
