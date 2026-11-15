// ==UserScript==
// @name            DownloadManagerPlus
// @description     ダウンロードの一覧を自前で記録して(閲覧履歴を消しても残る)、ツールバーのボタンのパネルと専用のウィンドウで見る・操作する
// @include         main
// @version         1.3.1
// ==/UserScript==

// userChrome.js ローダーがブラウザウィンドウごとにウィンドウのスコープで読み込む。
// 専用のウィンドウ(タイトル「ダウンロード」)は、ブラウザに入っている空のウィンドウ
// (chrome://extensions/content/dummy.xhtml)を開き、このスクリプトをそのウィンドウにも読み込ませて
// 画面を組み立てる(IS_MANAGER で切り替え)。ウィンドウごとに自分のスコープで動くので、どれかのウィンドウを
// 閉じても、ほかのウィンドウの処理は死なない。
//
// 記録: ブラウザ本体はダウンロードを、途中のものは downloads.json、終わったものは閲覧履歴(places.sqlite)に
// 残すので、閲覧履歴を消すと消える。このスクリプトはプロファイルの downloadmanagerplus.json に自前で記録し、
// 一覧はそこから作る。書き込むのは「最初のブラウザウィンドウ」1 つだけ(PRIMARY)。ほかのウィンドウからの
// 削除などは、通知(REQUEST_TOPIC)で頼む。書いたら CHANGED_TOPIC で知らせ、ほかのウィンドウは読み直す。

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

  const LOG = '[DownloadManagerPlus]';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MANAGER_TITLE = L('ダウンロード', 'Downloads');
  // このウィンドウでは、Firefox の customElements.js がメニューの部品(menupopup など)をわざと用意しない
  // (拡張機能の裏のページ用のため)。XUL のメニューは state が open になっても大きさ 0 で何も出ないので、
  // 専用のウィンドウの右クリックメニューは HTML で自前に描く(showHtmlMenu)
  const MANAGER_URL = 'chrome://extensions/content/dummy.xhtml';
  const MANAGER_NAME = 'dmp-manager';
  const IS_MANAGER = win.location.href === MANAGER_URL && win.name === MANAGER_NAME;
  // 専用のウィンドウにも読み込ませるための、このスクリプトの URL。ローダーは
  // resource://userchromejs/<名前>?<ファイルの更新時刻> で読む。? 以下を落とすと、スクリプトのキャッシュ
  // (startupCache)に残った古い版が読まれることがあるので、? 以下も付けたまま使う
  const SCRIPT_URL = (() => {
    try {
      const f = Components.stack.filename.split(' -> ').pop();
      if (/^(resource|chrome):/.test(f)) return f.includes('?') ? f : `${f}?${Date.now()}`;
    } catch (ex) {
      console.error(LOG, 'スクリプトの URL が分かりません。既定の場所を使います', ex);
    }
    return `resource://userchromejs/DownloadManagerPlus.uc.js?${Date.now()}`;
  })();
  const WIDGET_ID = 'dmp-button';
  const PANEL_ID = 'dmp-panel';
  const CONTEXT_ID = 'dmp-context';
  const STYLE_ID = 'dmp-style';
  const PREF = 'userChromeJS.downloadManagerPlus.';
  const CHANGED_TOPIC = 'dmp-store-changed';
  const REQUEST_TOPIC = 'dmp-store-request';

  const doc = win.document;
  const { Downloads } = ChromeUtils.importESModule('resource://gre/modules/Downloads.sys.mjs');
  const { DownloadHistory } = ChromeUtils.importESModule('resource://gre/modules/DownloadHistory.sys.mjs');
  const { DownloadPaths } = ChromeUtils.importESModule('resource://gre/modules/DownloadPaths.sys.mjs');
  const { FileUtils } = ChromeUtils.importESModule('resource://gre/modules/FileUtils.sys.mjs');
  const STORE_PATH = PathUtils.join(PathUtils.profileDir, 'downloadmanagerplus.json');
  const instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // ---- 記録 ----

  // record: { id, url, referrer, name, path, size, mime, start, end, state, error }
  // state: running(ダウンロード中) / paused(一時停止) / done(完了) / failed(失敗) / canceled(中止)
  const store = { records: [], byId: new Map() };
  // いまブラウザ本体が持っているダウンロード(id → Download)。進み具合や操作に使う
  const live = new Map();
  // ファイルがあるか(path → true/false)。一覧を出すときに調べ直す
  const exists = new Map();

  function reindex() {
    store.byId = new Map(store.records.map((r) => [r.id, r]));
  }

  async function loadStore() {
    try {
      if (await IOUtils.exists(STORE_PATH)) {
        const data = await IOUtils.readJSON(STORE_PATH);
        store.records = Array.isArray(data.records) ? data.records : [];
      } else {
        store.records = [];
      }
    } catch (ex) {
      console.error(LOG, '記録を読めませんでした。空の一覧から始めます', ex);
      store.records = [];
    }
    reindex();
  }

  let saveTimer = 0;
  function scheduleSave() {
    win.clearTimeout(saveTimer);
    saveTimer = win.setTimeout(saveNow, 600);
  }

  async function saveNow() {
    win.clearTimeout(saveTimer);
    try {
      await IOUtils.writeJSON(STORE_PATH, { version: 1, records: store.records }, { tmpPath: STORE_PATH + '.tmp' });
      Services.obs.notifyObservers(null, CHANGED_TOPIC, instanceId);
    } catch (ex) {
      console.error(LOG, '記録を保存できませんでした', ex);
    }
  }

  // 書き込むのは最初のブラウザウィンドウだけ(どのウィンドウも同じダウンロードの知らせを受けるので、二重に書かないため)
  function isPrimary() {
    if (IS_MANAGER) {
      // ブラウザウィンドウが 1 つも無いときだけ、専用のウィンドウが自分で書く
      return !Services.wm.getMostRecentWindow('navigator:browser');
    }
    const first = Services.wm.getEnumerator('navigator:browser').getNext();
    return first === win;
  }

  // 記録の id: ダウンロード元の URL と保存先。開始時刻は始まってから決まるので入れない
  // (入れると、追加の知らせと開始後の知らせで id が変わり、同じダウンロードが 2 件になった)
  function keyOf(d) {
    return `${d.source.url}|${d.target.path || ''}`;
  }

  function stateOf(d) {
    if (d.succeeded) return 'done';
    if (!d.stopped) return 'running';
    if (d.error) return 'failed';
    if (d.canceled && d.hasPartialData) return 'paused';
    if (d.canceled) return 'canceled';
    return 'failed';
  }

  function referrerOf(d) {
    try {
      const ri = d.source.referrerInfo;
      if (ri && ri.originalReferrer) return ri.originalReferrer.spec;
      if (d.source.referrer) return String(d.source.referrer);
    } catch (ex) {
      console.error(LOG, 'ダウンロードしたページの URL を読めませんでした', ex);
    }
    return '';
  }

  function recordFrom(d, prev) {
    const path = d.target.path || (prev && prev.path) || '';
    const state = stateOf(d);
    return {
      id: keyOf(d),
      url: d.source.url,
      referrer: referrerOf(d) || (prev && prev.referrer) || '',
      name: path ? PathUtils.filename(path) : (prev && prev.name) || d.source.url.split('/').pop(),
      path,
      size: d.totalBytes || d.currentBytes || (prev && prev.size) || 0,
      mime: d.contentType || (prev && prev.mime) || '',
      start: d.startTime ? new Date(d.startTime).getTime() : (prev && prev.start) || Date.now(),
      end: state === 'done' || state === 'failed' || state === 'canceled' ? (prev && prev.end) || Date.now() : 0,
      state,
      error: d.error ? String(d.error.message || d.error.result || L('エラー', 'Error')) : '',
    };
  }

  // 記録を足す・更新する(PRIMARY だけ)。保存が要る変化があったら true
  function upsert(d) {
    const id = keyOf(d);
    const prev = store.byId.get(id);
    const rec = recordFrom(d, prev);
    if (prev) {
      const changed = prev.state !== rec.state || prev.size !== rec.size || prev.path !== rec.path;
      if (!changed) return false;
      Object.assign(prev, rec);
    } else {
      store.records.push(rec);
      store.byId.set(id, rec);
    }
    return true;
  }

  function removeRecords(ids) {
    const set = new Set(ids);
    store.records = store.records.filter((r) => !set.has(r.id));
    reindex();
  }

  // ---- ブラウザ本体のダウンロードを見張る ----

  // 完了を一度見たダウンロード(id)。初めから完了していたものは光らせない
  const doneSeen = new Set();

  const view = {
    onDownloadAdded(d) {
      try {
        if (d.source.isPrivate) return; // プライベートのダウンロードは記録しない
        live.set(keyOf(d), d);
        if (d.succeeded) doneSeen.add(keyOf(d));
        if (isPrimary() && upsert(d)) scheduleSave();
        scheduleRender();
      } catch (ex) {
        console.error(LOG, 'ダウンロードの追加を処理できませんでした', ex);
      }
    },
    onDownloadChanged(d) {
      try {
        if (d.source.isPrivate) return;
        const id = keyOf(d);
        live.set(id, d);
        if (d.succeeded && !doneSeen.has(id)) {
          doneSeen.add(id);
          if (!IS_MANAGER) flashDone();
        }
        if (isPrimary() && upsert(d)) scheduleSave();
        scheduleRender(id);
      } catch (ex) {
        console.error(LOG, 'ダウンロードの変化を処理できませんでした', ex);
      }
    },
    onDownloadRemoved(d) {
      // 本体の一覧から消えても(閲覧履歴を消したときなど)、こちらの記録は残す
      try {
        live.delete(keyOf(d));
        scheduleRender();
      } catch (ex) {
        console.error(LOG, 'ダウンロードの削除を処理できませんでした', ex);
      }
    },
  };

  // 最初に 1 回だけ、本体に残っているダウンロード履歴を取り込む
  async function importOnce() {
    if (Services.prefs.getBoolPref(PREF + 'imported', false)) return;
    try {
      const list = await DownloadHistory.getList({ type: Downloads.PUBLIC });
      const all = await list.getAll();
      let n = 0;
      for (const d of all) {
        if (d.source.isPrivate) continue;
        if (upsert(d)) n++;
      }
      Services.prefs.setBoolPref(PREF + 'imported', true);
      if (n) await saveNow();
      console.log(LOG, `本体のダウンロード履歴を ${n} 件取り込みました`);
    } catch (ex) {
      console.error(LOG, '本体のダウンロード履歴を取り込めませんでした', ex);
    }
  }

  // ほかのウィンドウからの頼み(削除)を、PRIMARY が受けて書く
  const requestObserver = {
    observe(subject, topic, data) {
      if (topic !== REQUEST_TOPIC || !isPrimary()) return;
      try {
        const req = JSON.parse(data);
        if (req.op === 'remove' && Array.isArray(req.ids)) {
          removeRecords(req.ids);
          saveNow();
        }
      } catch (ex) {
        console.error(LOG, 'ほかのウィンドウからの頼みを処理できませんでした', ex);
      }
    },
  };

  const changedObserver = {
    observe(subject, topic, data) {
      if (topic !== CHANGED_TOPIC || data === instanceId) return;
      // ほかのウィンドウが書いた(またはファイルを削除した)ので読み直す。PRIMARY は自分の記録が正しいので、
      // ファイルがあるかだけ調べ直す
      if (isPrimary()) {
        refreshExists(store.records);
        return;
      }
      loadStore().then(() => {
        scheduleRender();
        refreshExists(store.records);
      }, (ex) => console.error(LOG, '読み直しに失敗しました', ex));
    },
  };

  // 一覧から消す。ダウンロード中・一時停止中のものは中止して、途中のデータも消す。保存したファイルは消さない
  async function removeFromList(ids) {
    for (const id of ids) {
      const d = live.get(id);
      if (d && !d.succeeded) {
        try {
          if (!d.stopped) await d.cancel();
          await d.removePartialData();
        } catch (ex) {
          console.error(LOG, 'ダウンロードを中止できませんでした', ex);
        }
      }
    }
    if (isPrimary()) {
      removeRecords(ids);
      await saveNow();
    } else {
      // 自分の表示はすぐ消し、書き込みは PRIMARY に頼む
      removeRecords(ids);
      Services.obs.notifyObservers(null, REQUEST_TOPIC, JSON.stringify({ op: 'remove', ids }));
    }
    scheduleRender();
  }

  // 保存したファイルを削除する(完了していてファイルがあるものだけ)。一覧には残し、「ファイルが無い」と出す。
  // Firefox 本体の「削除」と同じく、ごみ箱には入れずに消す(Firefox からごみ箱へ移す手段が無いため)
  async function deleteFiles(recs) {
    const targets = recs.filter((r) => r.path && currentState(r) === 'done' && exists.get(r.path) !== false);
    if (!targets.length) return;
    const one = targets.length === 1;
    const msg = L(
      `${one ? `「${targets[0].name}」` : `${targets.length} 個のファイル`}を削除します。\nごみ箱には入らず、元に戻せません。`,
      `Delete ${one ? `"${targets[0].name}"` : `${targets.length} files`}?\nThey won't go to the Recycle Bin and can't be restored.`);
    if (!Services.prompt.confirm(win, L('ファイルを削除', 'Delete File'), msg)) return;
    for (const r of targets) {
      try {
        await IOUtils.remove(r.path, { ignoreAbsent: true });
        exists.set(r.path, false);
      } catch (ex) {
        console.error(LOG, 'ファイルを削除できませんでした', r.path, ex);
      }
    }
    // 記録は変わらないが、ほかのウィンドウにもファイルがあるかを調べ直してもらう
    Services.obs.notifyObservers(null, CHANGED_TOPIC, instanceId);
    scheduleRender();
  }

  // まとめて一覧から消す。mode: all(ダウンロード中・一時停止中のものは残す) / done(完了したものだけ)
  async function clearList(mode) {
    const recs = store.records.filter((r) => {
      const st = currentState(r);
      return mode === 'done' ? st === 'done' : st !== 'running' && st !== 'paused';
    });
    if (!recs.length) return;
    const msg = mode === 'done'
      ? L(`完了した ${recs.length} 件を一覧から消します。\n保存したファイルは消えません。`,
        `Remove ${recs.length} completed downloads from the list?\nThe saved files are kept.`)
      : L(`${recs.length} 件を一覧から消します。\n保存したファイルは消えません。ダウンロード中のものは残します。`,
        `Remove ${recs.length} downloads from the list?\nThe saved files are kept, and active downloads stay.`);
    if (!Services.prompt.confirm(win, mode === 'done' ? L('完了したものを消す', 'Clear Completed') : L('すべて削除', 'Clear All'), msg)) return;
    await removeFromList(recs.map((r) => r.id));
  }

  // ---- 操作 ----

  function browserWindow() {
    return IS_MANAGER ? Services.wm.getMostRecentWindow('navigator:browser') : win;
  }

  function fileOf(rec) {
    try {
      return rec.path ? new FileUtils.File(rec.path) : null;
    } catch (ex) {
      console.error(LOG, 'ファイルの場所が正しくありません', rec.path, ex);
      return null;
    }
  }

  const actions = {
    pauseResume(rec) {
      const d = live.get(rec.id);
      if (!d) return;
      (d.stopped ? d.start() : d.cancel()).catch((ex) => console.error(LOG, '一時停止・再開に失敗しました', ex));
    },
    cancel(rec) {
      const d = live.get(rec.id);
      if (!d) return;
      d.cancel()
        .then(() => d.removePartialData())
        .catch((ex) => console.error(LOG, '中止に失敗しました', ex));
    },
    // 失敗・中止したものをやり直す。本体がまだ持っていればそのまま再開、持っていなければ同じ URL で新しく落とす
    async retry(rec) {
      const d = live.get(rec.id);
      if (d) {
        d.start().catch((ex) => console.error(LOG, 'やり直しに失敗しました', ex));
        return;
      }
      try {
        // 古い記録を先に外す。新しいダウンロードは保存先が同じになることが多く、そのときは id も同じになるので、
        // あとで外すと新しいほうの記録まで消して中止してしまう
        await removeFromList([rec.id]);
        const file = fileOf(rec) || new FileUtils.File(PathUtils.join(await Downloads.getPreferredDownloadsDirectory(), rec.name));
        const target = DownloadPaths.createNiceUniqueFile(file);
        const source = { url: rec.url };
        if (rec.referrer) {
          // ブラウザウィンドウには ReferrerInfo のコンストラクターがある(専用のウィンドウには無いので借りる)
          const bw = browserWindow();
          const RI = (bw && bw.ReferrerInfo) ||
            Components.Constructor('@mozilla.org/referrer-info;1', 'nsIReferrerInfo', 'init');
          source.referrerInfo = new RI(Ci.nsIReferrerInfo.EMPTY, true, Services.io.newURI(rec.referrer));
        }
        // 途中のデータを残すには、始める前に tryToKeepPartialData と作業用ファイル(.part)の場所を付ける
        // (どちらかが無いと、止めたときに途中のデータが消え、一時停止が中止と同じになる)
        const dl = await Downloads.createDownload({
          source,
          target: { path: target.path, partFilePath: target.path + '.part' },
          tryToKeepPartialData: true,
        });
        const list = await Downloads.getList(Downloads.PUBLIC);
        await list.add(dl);
        dl.start().catch((ex) => console.error(LOG, 'やり直しのダウンロードに失敗しました', ex));
      } catch (ex) {
        console.error(LOG, 'やり直しのダウンロードを始められませんでした', ex);
      }
    },
    open(rec) {
      const f = fileOf(rec);
      if (!f || !f.exists()) return;
      try {
        f.launch();
      } catch (ex) {
        console.error(LOG, 'ファイルを開けませんでした', ex);
      }
    },
    reveal(rec) {
      const f = fileOf(rec);
      if (!f) return;
      try {
        if (f.exists()) f.reveal();
        else if (f.parent && f.parent.exists()) f.parent.launch();
      } catch (ex) {
        console.error(LOG, 'フォルダを開けませんでした', ex);
      }
    },
    copyUrl(rec) {
      try {
        Cc['@mozilla.org/widget/clipboardhelper;1'].getService(Ci.nsIClipboardHelper).copyString(rec.url);
      } catch (ex) {
        console.error(LOG, 'URL をコピーできませんでした', ex);
      }
    },
    openPage(rec) {
      const bw = browserWindow();
      if (!bw || !rec.referrer) return;
      try {
        bw.openTrustedLinkIn(rec.referrer, 'tab');
        bw.focus();
      } catch (ex) {
        console.error(LOG, 'ページを開けませんでした', ex);
      }
    },
    remove(rec) {
      removeFromList([rec.id]);
    },
    deleteFile(rec) {
      deleteFiles([rec]);
    },
  };

  // ---- 表示の部品 ----

  function fmtSize(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  }

  function countText(n) {
    return L(`${n} 件`, `${n} ${n === 1 ? 'item' : 'items'}`);
  }

  function fmtTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86400000);
    if (diff === 0) return L(`今日 ${hm}`, `Today ${hm}`);
    if (diff === 1) return L(`昨日 ${hm}`, `Yesterday ${hm}`);
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function fmtDuration(sec) {
    if (!isFinite(sec) || sec < 0) return '';
    if (sec < 60) return L(`${Math.ceil(sec)} 秒`, `${Math.ceil(sec)} s`);
    if (sec < 3600) return L(`${Math.ceil(sec / 60)} 分`, `${Math.ceil(sec / 60)} min`);
    return L(`${Math.floor(sec / 3600)} 時間 ${Math.ceil((sec % 3600) / 60)} 分`, `${Math.floor(sec / 3600)} h ${Math.ceil((sec % 3600) / 60)} min`);
  }

  function siteOf(rec) {
    for (const u of [rec.referrer, rec.url]) {
      try {
        if (u) return Services.io.newURI(u).host;
      } catch (ex) {
        // data: など host の無い URL は次の候補へ
      }
    }
    return '';
  }

  // 一覧に出す並び: 新しい順
  function sortedRecords() {
    return store.records.slice().sort((a, b) => (b.start || 0) - (a.start || 0));
  }

  // いまの状態(本体が持っていれば本体の値)
  function currentState(rec) {
    const d = live.get(rec.id);
    return d ? stateOf(d) : rec.state === 'running' ? 'failed' : rec.state;
  }

  // 1 行目の下の説明
  function describe(rec) {
    const d = live.get(rec.id);
    const state = currentState(rec);
    const site = siteOf(rec);
    const parts = [];
    if (state === 'running' && d) {
      if (d.speed > 0) {
        parts.push(L(`${fmtSize(d.speed)}/秒`, `${fmtSize(d.speed)}/s`));
        if (d.hasProgress && d.totalBytes) parts.push(L(`残り ${fmtDuration((d.totalBytes - d.currentBytes) / d.speed)}`, `${fmtDuration((d.totalBytes - d.currentBytes) / d.speed)} left`));
      }
      parts.push(d.hasProgress && d.totalBytes ? `${fmtSize(d.currentBytes)} / ${fmtSize(d.totalBytes)}` : fmtSize(d.currentBytes));
    } else if (state === 'paused') {
      parts.push(L('一時停止中', 'Paused'));
      if (d) parts.push(d.totalBytes ? `${fmtSize(d.currentBytes)} / ${fmtSize(d.totalBytes)}` : fmtSize(d.currentBytes));
    } else if (state === 'done') {
      if (exists.get(rec.path) === false) parts.push(L('ファイルが無い', 'File missing'));
      else parts.push(L('完了', 'Done'));
      if (rec.size) parts.push(fmtSize(rec.size));
    } else if (state === 'canceled') {
      parts.push(L('中止', 'Canceled'));
    } else {
      parts.push(rec.error ? L(`失敗(${rec.error})`, `Failed (${rec.error})`) : L('失敗', 'Failed'));
    }
    if (site) parts.push(site);
    if (state !== 'running' && state !== 'paused') parts.push(fmtTime(rec.end || rec.start));
    return parts.filter(Boolean).join(' · ');
  }

  function progressOf(rec) {
    const d = live.get(rec.id);
    if (!d || !d.hasProgress) return -1;
    return Math.max(0, Math.min(100, d.progress));
  }

  // ファイルがあるかを調べ直す(完了したものだけ)。変わったら表示を直す
  async function refreshExists(recs) {
    let changed = false;
    await Promise.all(recs.filter((r) => r.path && currentState(r) === 'done').map(async (r) => {
      try {
        const e = await IOUtils.exists(r.path);
        if (exists.get(r.path) !== e) {
          exists.set(r.path, e);
          changed = true;
        }
      } catch (ex) {
        console.error(LOG, 'ファイルがあるかを調べられませんでした', r.path, ex);
      }
    }));
    if (changed) scheduleRender();
  }

  function h(tag, cls, text) {
    const e = doc.createElementNS(HTML_NS, tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // 右クリックメニュー(パネルと専用のウィンドウで共通)
  let contextRec = null;
  const CONTEXT_ITEMS = [
    ['open', L('ファイルを開く', 'Open File')],
    ['reveal', L('フォルダを開く', 'Open Folder')],
    ['-'],
    ['copyUrl', L('ダウンロード元の URL をコピー', 'Copy Download Link')],
    ['openPage', L('ダウンロードしたページを開く', 'Go to Download Page')],
    ['-'],
    ['retry', L('やり直す', 'Retry')],
    ['remove', L('一覧から消す', 'Remove from List')],
    ['deleteFile', L('ファイルを削除', 'Delete File')],
  ];

  // その項目を今は使えないか
  function contextDisabled(act, rec) {
    const st = currentState(rec);
    if (act === 'open' || act === 'deleteFile') return st !== 'done' || exists.get(rec.path) === false;
    if (act === 'openPage') return !rec.referrer;
    if (act === 'retry') return !(st === 'failed' || st === 'canceled');
    return false;
  }

  function getContextMenu() {
    let m = doc.getElementById(CONTEXT_ID);
    if (m) return m;
    m = doc.createXULElement('menupopup');
    m.id = CONTEXT_ID;
    for (const [act, label] of CONTEXT_ITEMS) {
      if (act === '-') {
        m.appendChild(doc.createXULElement('menuseparator'));
        continue;
      }
      const mi = doc.createXULElement('menuitem');
      mi.setAttribute('label', label);
      mi.dataset.act = act;
      mi.addEventListener('command', () => {
        if (contextRec) actions[act](contextRec);
      });
      m.appendChild(mi);
    }
    m.addEventListener('popupshowing', () => {
      if (!contextRec) return;
      for (const mi of m.querySelectorAll('menuitem')) mi.disabled = contextDisabled(mi.dataset.act, contextRec);
    });
    doc.getElementById('mainPopupSet').appendChild(m);
    return m;
  }

  // 専用のウィンドウの右クリックメニュー(HTML で描く。XUL のメニューはこのウィンドウでは出ないため)
  function closeHtmlMenu() {
    const m = doc.querySelector('.dmp-hmenu');
    if (m) m.remove();
  }

  function showHtmlMenu(e, rec) {
    closeHtmlMenu();
    const m = h('div', 'dmp-hmenu');
    m.setAttribute('role', 'menu');
    for (const [act, label] of CONTEXT_ITEMS) {
      if (act === '-') {
        m.appendChild(h('div', 'dmp-hmenu-sep'));
        continue;
      }
      const it = h('div', 'dmp-hmenu-item', label);
      it.setAttribute('role', 'menuitem');
      it.dataset.act = act;
      if (contextDisabled(act, rec)) {
        it.setAttribute('aria-disabled', 'true');
      } else {
        it.addEventListener('click', (ev) => {
          ev.stopPropagation();
          closeHtmlMenu();
          try {
            actions[act](rec);
          } catch (ex) {
            console.error(LOG, '右クリックメニューの操作に失敗しました', act, ex);
          }
        });
      }
      m.appendChild(it);
    }
    doc.querySelector('.dmp-wrap').appendChild(m);
    // マウスの位置に出す。はみ出すなら左・上へずらす
    const W = win.innerWidth;
    const H = win.innerHeight;
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(e.clientX, W - r.width - 4))}px`;
    m.style.top = `${Math.max(4, e.clientY + r.height > H - 4 ? e.clientY - r.height : e.clientY)}px`;
  }

  function showContext(e, rec) {
    e.preventDefault();
    e.stopPropagation();
    contextRec = rec;
    if (IS_MANAGER) showHtmlMenu(e, rec);
    else getContextMenu().openPopupAtScreen(e.screenX, e.screenY, true, e);
  }

  // ボタンのアイコン。専用のウィンドウは CSP(default-src 'none')で画像を読めないので、CSS の画像ではなく
  // SVG の要素を直接置く
  const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const ICONS = {
    'dmp-pause': [['rect', { x: 4, y: 3, width: 2.6, height: 10, rx: 1, fill: 'currentColor' }],
      ['rect', { x: 9.4, y: 3, width: 2.6, height: 10, rx: 1, fill: 'currentColor' }]],
    'dmp-play': [['path', { d: 'M5 3.2v9.6a.6.6 0 0 0 .9.5l7.6-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z', fill: 'currentColor' }]],
    'dmp-cancel': [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7', ...STROKE, 'stroke-width': '1.6' }]],
    'dmp-remove': [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7', ...STROKE, 'stroke-width': '1.6' }]],
    'dmp-folder': [['path', { d: 'M1.75 4.25c0-.55.45-1 1-1h3.4l1.5 1.6h5.6c.55 0 1 .45 1 1v6.4c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z', ...STROKE }]],
    'dmp-retry': [['path', { d: 'M13.25 8A5.25 5.25 0 1 1 11.7 4.3', ...STROKE }], ['path', { d: 'M12.25 1.75v3h-3', ...STROKE }]],
    'dmp-clear': [['path', { d: 'M2.75 4.25h10.5M6.25 4.25v-1.5h3.5v1.5M4.25 4.25l.6 9h6.3l.6-9', ...STROKE }]],
    'dmp-side': [['rect', { x: 2, y: 2.75, width: 12, height: 10.5, rx: 1.5, ...STROKE }], ['path', { d: 'M10 2.75v10.5', ...STROKE }]],
    'dmp-manager': [['path', { d: 'M9.25 2.75h4v4M13.25 2.75 7.75 8.25M11.25 9.5v3.75h-8.5v-8.5h3.75', ...STROKE }]],
  };

  function svgIcon(cls) {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    for (const [tag, attrs] of ICONS[cls] || []) {
      const e = doc.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      svg.appendChild(e);
    }
    return svg;
  }

  function iconBtn(cls, tip, fn) {
    const b = h('div', `dmp-ib ${cls}`);
    b.appendChild(svgIcon(cls));
    b.setAttribute('role', 'button');
    b.setAttribute('title', tip);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  // 行の右のボタン(状態で変わる)
  function actionButtons(rec) {
    const st = currentState(rec);
    const box = h('div', 'dmp-acts');
    if (st === 'running' || st === 'paused') {
      // 一時停止は、途中のデータを残せるダウンロードだけ(ブラウザ本体のダウンロードは残せる。残せないものを
      // 止めると中止と同じになる)
      const d = live.get(rec.id);
      if (st === 'paused' || (d && d.tryToKeepPartialData && d.target.partFilePath)) {
        box.append(iconBtn(st === 'running' ? 'dmp-pause' : 'dmp-play', st === 'running' ? L('一時停止', 'Pause') : L('再開', 'Resume'),
          () => actions.pauseResume(rec)));
      }
      box.append(iconBtn('dmp-cancel', L('中止', 'Cancel'), () => actions.cancel(rec)));
    } else if (st === 'done') {
      box.append(iconBtn('dmp-folder', L('フォルダを開く', 'Open Folder'), () => actions.reveal(rec)));
    } else {
      box.append(iconBtn('dmp-retry', L('やり直す', 'Retry'), () => actions.retry(rec)));
    }
    return box;
  }

  // ---- パネル(ブラウザウィンドウ) ----

  const PANEL_CSS = `
    #${WIDGET_ID} {
      list-style-image: url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="context-fill" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5v8M4.5 6.5 8 10l3.5-3.5"/><path d="M2 12.5h12M2 14.5h12" stroke-width="1.2"/></svg>')}");
    }
    /* ダウンロード中: ボタンの背景に、下から水が溜まるように進み具合を描く(--dmp-level は 0〜100%) */
    #${WIDGET_ID} > .toolbarbutton-icon {
      background-image: linear-gradient(
        color-mix(in srgb, var(--toolbarbutton-icon-fill-attention, AccentColor) 45%, transparent),
        color-mix(in srgb, var(--toolbarbutton-icon-fill-attention, AccentColor) 45%, transparent));
      background-repeat: no-repeat;
      background-position: bottom;
      background-size: 100% var(--dmp-level, 0%);
      transition: background-size 0.3s linear;
    }
    /* 終わったとき: 1 回はねて光る */
    #${WIDGET_ID}[dmp-done] > .toolbarbutton-icon {
      animation: dmp-pop 0.7s ease-out, dmp-glow 0.9s ease-out;
    }
    @keyframes dmp-pop {
      0% { transform: scale(1); }
      30% { transform: scale(1.25); }
      60% { transform: scale(0.95); }
      100% { transform: scale(1); }
    }
    @keyframes dmp-glow {
      0% { background-color: transparent; }
      25% { background-color: color-mix(in srgb, var(--toolbarbutton-icon-fill-attention, AccentColor) 55%, transparent); }
      100% { background-color: transparent; }
    }
    @media (prefers-reduced-motion: reduce) {
      #${WIDGET_ID} > .toolbarbutton-icon { transition: none; }
      #${WIDGET_ID}[dmp-done] > .toolbarbutton-icon { animation: none; }
    }
    #${PANEL_ID} {
      --panel-padding: 0;
    }
    #${PANEL_ID} .dmp-inner {
      width: 440px;
      padding: 6px;
    }
    #${PANEL_ID} .dmp-list {
      max-height: 460px;
      overflow-y: auto;
    }
    #${PANEL_ID} .dmp-empty {
      padding: 20px;
      text-align: center;
      opacity: 0.6;
    }
    .dmp-row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      border-radius: 6px;
    }
    .dmp-row:hover {
      background-color: color-mix(in srgb, currentColor 8%, transparent);
    }
    .dmp-icon {
      width: 28px;
      height: 28px;
      flex: none;
    }
    .dmp-mid {
      flex: 1;
      min-width: 0;
    }
    .dmp-name {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dmp-row[data-missing] .dmp-name {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .dmp-sub {
      font-size: 0.88em;
      opacity: 0.7;
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dmp-row[data-state="failed"] .dmp-sub {
      color: var(--text-color-error, #e22850);
      opacity: 1;
    }
    .dmp-bar {
      height: 4px;
      border-radius: 2px;
      margin-top: 6px;
      background-color: color-mix(in srgb, currentColor 15%, transparent);
      overflow: hidden;
    }
    .dmp-bar > div {
      height: 100%;
      background-color: var(--focus-outline-color, AccentColor);
    }
    .dmp-row[data-state="paused"] .dmp-bar > div {
      background-color: color-mix(in srgb, currentColor 45%, transparent);
    }
    .dmp-bar[data-unknown] > div {
      width: 30% !important;
      animation: dmp-slide 1.2s ease-in-out infinite alternate;
    }
    @keyframes dmp-slide {
      from { margin-left: 0; }
      to { margin-left: 70%; }
    }
    .dmp-acts {
      display: flex;
      gap: 2px;
      flex: none;
    }
    .dmp-ib {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      flex: none;
      border-radius: 6px;
      cursor: pointer;
      opacity: 0.6;
    }
    .dmp-ib:hover {
      opacity: 1;
      background-color: color-mix(in srgb, currentColor 10%, transparent);
    }
    .dmp-foot {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 4px 2px 0 8px;
      margin-top: 4px;
      border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent);
      font-size: 0.9em;
    }
    .dmp-foot > .dmp-count {
      flex: 1;
      opacity: 0.65;
    }
  `;

  function iconUrl(rec) {
    // OS のファイルの種類のアイコン。ファイルがあればそのファイル、無ければ拡張子から
    try {
      if (rec.path && exists.get(rec.path) !== false) {
        return `moz-icon://${Services.io.newFileURI(new FileUtils.File(rec.path)).spec}?size=32`;
      }
    } catch (ex) {
      // 場所が読めないときは拡張子で
    }
    const ext = (rec.name.match(/\.[^.]+$/) || ['.bin'])[0];
    return `moz-icon://${encodeURIComponent(ext)}?size=32`;
  }

  // 行を作る。updateRow で中身を差し替えられるように、部品を data に持たせる
  function buildRow(rec, withIcon) {
    const row = h('div', 'dmp-row');
    row.dataset.id = rec.id;
    if (withIcon) {
      const img = doc.createElementNS(HTML_NS, 'img');
      img.className = 'dmp-icon';
      img.alt = '';
      img.src = iconUrl(rec);
      row.appendChild(img);
    }
    const mid = h('div', 'dmp-mid');
    mid.append(h('div', 'dmp-name', rec.name), h('div', 'dmp-sub'));
    row.append(mid, h('div', 'dmp-acts'), iconBtn('dmp-remove', L('一覧から消す', 'Remove from List'), () => actions.remove(rec)));
    row.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      if (currentState(rec) === 'done') actions.open(rec);
    });
    row.addEventListener('contextmenu', (e) => showContext(e, rec));
    updateRow(row, rec);
    return row;
  }

  function updateRow(row, rec) {
    const st = currentState(rec);
    row.dataset.state = st;
    row.toggleAttribute('data-missing', st === 'done' && exists.get(rec.path) === false);
    row.querySelector('.dmp-sub').textContent = describe(rec);
    const mid = row.querySelector('.dmp-mid');
    let bar = mid.querySelector('.dmp-bar');
    if (st === 'running' || st === 'paused') {
      if (!bar) {
        bar = h('div', 'dmp-bar');
        bar.appendChild(h('div'));
        mid.appendChild(bar);
      }
      const p = progressOf(rec);
      bar.toggleAttribute('data-unknown', p < 0 && st === 'running');
      bar.firstChild.style.width = `${p < 0 ? 0 : p}%`;
    } else if (bar) {
      bar.remove();
    }
    const acts = row.querySelector('.dmp-acts');
    const fresh = actionButtons(rec);
    // ボタンの種類が変わったときだけ差し替える(押している最中に消えないように)
    const sig = (box) => [...box.children].map((c) => c.className).join(',');
    if (sig(acts) !== sig(fresh)) acts.replaceWith(fresh);
  }

  function getPanel() {
    let panel = doc.getElementById(PANEL_ID);
    if (panel) return panel;
    panel = doc.createXULElement('panel');
    panel.id = PANEL_ID;
    panel.setAttribute('type', 'arrow');
    panel.setAttribute('role', 'dialog');
    const inner = h('div', 'dmp-inner');
    panel.appendChild(inner);
    panel.addEventListener('popuphidden', (e) => {
      if (e.target !== panel) return;
      const b = doc.getElementById(WIDGET_ID);
      if (b) b.removeAttribute('open');
    });
    doc.getElementById('mainPopupSet').appendChild(panel);
    return panel;
  }

  function renderPanel() {
    const panel = getPanel();
    const inner = panel.firstElementChild;
    const recs = sortedRecords();
    let list = inner.querySelector('.dmp-list');
    const scroll = list ? list.scrollTop : 0;
    // 行の並びが同じなら中身だけ直す(マウスの位置やスクロールを保つ)
    if (list) {
      const ids = [...list.querySelectorAll('.dmp-row')].map((r) => r.dataset.id);
      if (ids.length === recs.length && ids.every((id, i) => id === recs[i].id)) {
        for (const row of list.querySelectorAll('.dmp-row')) updateRow(row, store.byId.get(row.dataset.id));
        inner.querySelector('.dmp-count').textContent = countText(recs.length);
        return;
      }
    }
    inner.textContent = '';
    list = h('div', 'dmp-list');
    if (!recs.length) list.appendChild(h('div', 'dmp-empty', L('ダウンロードはまだありません', 'No downloads yet')));
    for (const rec of recs) list.appendChild(buildRow(rec, true));
    const foot = h('div', 'dmp-foot');
    foot.append(h('div', 'dmp-count', countText(recs.length)),
      iconBtn('dmp-clear', L('すべて削除', 'Clear All'), () => {
        panel.hidePopup();
        clearList('all');
      }),
      iconBtn('dmp-manager', MANAGER_TITLE, () => {
        panel.hidePopup();
        openManager();
      }));
    inner.append(list, foot);
    list.scrollTop = scroll;
  }

  function togglePanel(anchor) {
    try {
      const panel = getPanel();
      if (panel.state === 'open' || panel.state === 'showing') {
        panel.hidePopup();
        return;
      }
      renderPanel();
      refreshExists(store.records);
      anchor.setAttribute('open', 'true');
      panel.openPopup(anchor, 'bottomright topright', 0, 0, false, false);
    } catch (ex) {
      console.error(LOG, 'パネルを開けませんでした', ex);
    }
  }

  // ダウンロード中のもの全部を合わせた進み具合(0〜100)。大きさが分かるものが無ければ -1
  function totalProgress() {
    let cur = 0;
    let total = 0;
    for (const d of live.values()) {
      if (d.stopped || !d.hasProgress || !d.totalBytes) continue;
      cur += d.currentBytes;
      total += d.totalBytes;
    }
    return total ? Math.min(100, (cur / total) * 100) : -1;
  }

  let doneTimer = 0;
  function updateButton() {
    const b = doc.getElementById(WIDGET_ID);
    if (!b) return;
    const active = [...live.values()].some((d) => !d.stopped);
    if (b.hasAttribute('dmp-active') !== active) b.toggleAttribute('dmp-active', active);
    // 完了の動きの間は満タンのまま。終わってから水位を戻す
    if (doneTimer) return;
    const p = active ? totalProgress() : -1;
    b.style.setProperty('--dmp-level', `${p < 0 ? 0 : p.toFixed(1)}%`);
  }

  // 完了したとき: 水位を満タンにして、はねて光る動きを 1 回。そのあと水位を今の進み具合に戻す
  function flashDone() {
    const b = doc.getElementById(WIDGET_ID);
    if (!b) return;
    win.clearTimeout(doneTimer);
    b.style.setProperty('--dmp-level', '100%');
    b.removeAttribute('dmp-done');
    // 属性を付け直してアニメーションを最初から
    b.getBoundingClientRect();
    b.setAttribute('dmp-done', 'true');
    doneTimer = win.setTimeout(() => {
      doneTimer = 0;
      b.removeAttribute('dmp-done');
      updateButton();
    }, 900);
  }

  // ---- 専用のウィンドウ ----

  function openManager() {
    try {
      for (const w of Services.wm.getEnumerator(null)) {
        if (w.name === MANAGER_NAME && !w.closed) {
          w.focus();
          return;
        }
      }
      const mw = Services.ww.openWindow(null, MANAGER_URL, MANAGER_NAME,
        'chrome,resizable,centerscreen,dialog=no,width=960,height=640', null);
      mw.addEventListener('load', () => {
        try {
          Services.scriptloader.loadSubScript(SCRIPT_URL, mw, 'UTF-8');
        } catch (ex) {
          console.error(LOG, '専用のウィンドウにスクリプトを読み込めませんでした', SCRIPT_URL, ex);
        }
      }, { once: true });
    } catch (ex) {
      console.error(LOG, '専用のウィンドウを開けませんでした', ex);
    }
  }

  const MANAGER_CSS = `
    :root {
      color-scheme: light dark;
      font: menu;
      font-size: 13px;
      background-color: Canvas;
      color: CanvasText;
    }
    .dmp-wrap {
      display: flex;
      flex-direction: column;
      height: 100vh;
      width: 100vw;
    }
    /* 表の下の段: 左に選んだものへの操作、右にまとめて消すボタン */
    .dmp-mfoot {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      padding: 6px 12px;
      border-top: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    }
    .dmp-top > .dmp-side[data-open] { opacity: 1; color: AccentColor; }
    /* 表と詳しい欄の間の仕切り。左右にドラッグして詳しい欄の幅を変える */
    .dmp-splitter {
      width: 5px;
      flex: none;
      cursor: col-resize;
      margin-right: -3px;
      position: relative;
      z-index: 2;
    }
    .dmp-splitter:hover, .dmp-splitter[data-drag] {
      background-color: color-mix(in srgb, AccentColor 50%, transparent);
    }
    .dmp-splitter[hidden], .dmp-detail[hidden] { display: none; }
    .dmp-top {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
      flex-wrap: wrap;
    }
    .dmp-top input[type="search"] {
      width: 220px;
      padding: 4px 8px;
      font: inherit;
    }
    .dmp-chip {
      padding: 3px 12px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, CanvasText 30%, transparent);
      cursor: pointer;
      opacity: 0.8;
    }
    .dmp-chip[selected] {
      background-color: color-mix(in srgb, AccentColor 25%, transparent);
      border-color: AccentColor;
      opacity: 1;
    }
    .dmp-spacer { flex: 1; }
    .dmp-wrap button { font: inherit; padding: 3px 10px; }
    .dmp-selacts {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dmp-selacts[hidden] { display: none; }
    .dmp-body {
      flex: 1;
      display: flex;
      min-height: 0;
    }
    .dmp-table {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
    }
    .dmp-tr {
      display: grid;
      grid-template-columns: 28px minmax(0, 2.4fr) minmax(0, 1.2fr) 80px 110px minmax(110px, 1.3fr) 84px;
      align-items: center;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
    }
    .dmp-tr > div {
      padding: 4px 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dmp-tr > .dmp-c-acts {
      display: flex;
      justify-content: flex-end;
      padding: 2px 6px;
    }
    .dmp-th {
      position: sticky;
      top: 0;
      z-index: 1;
      background-color: Canvas;
      font-size: 0.9em;
    }
    .dmp-th > div { opacity: 0.7; }
    .dmp-th > .dmp-sort { cursor: pointer; }
    .dmp-th > .dmp-sort:hover { opacity: 1; }
    .dmp-th > .dmp-sort[data-dir] { opacity: 1; }
    .dmp-th > .dmp-sort[data-dir="1"]::after { content: " ▲"; font-size: 0.8em; }
    .dmp-th > .dmp-sort[data-dir="-1"]::after { content: " ▼"; font-size: 0.8em; }
    .dmp-tr.dmp-item { min-height: 34px; }
    .dmp-tr.dmp-item:hover {
      background-color: color-mix(in srgb, CanvasText 6%, transparent);
    }
    .dmp-tr.dmp-item[data-checked] {
      background-color: color-mix(in srgb, AccentColor 14%, transparent);
    }
    .dmp-tr.dmp-item[data-selected] {
      background-color: color-mix(in srgb, AccentColor 26%, transparent);
    }
    .dmp-tr[data-missing] .dmp-c-name {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .dmp-tr[data-state="failed"] .dmp-c-state { color: #e22850; }
    .dmp-muted { opacity: 0.7; }
    .dmp-empty { padding: 30px; text-align: center; opacity: 0.6; }
    /* 右クリックメニュー(HTML) */
    .dmp-hmenu {
      position: fixed;
      z-index: 10;
      min-width: 200px;
      padding: 4px;
      border-radius: 6px;
      background-color: Menu;
      color: MenuText;
      border: 1px solid color-mix(in srgb, MenuText 20%, transparent);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    }
    .dmp-hmenu-item {
      padding: 5px 24px 5px 12px;
      border-radius: 4px;
      cursor: default;
      white-space: nowrap;
    }
    .dmp-hmenu-item:not([aria-disabled]):hover {
      background-color: color-mix(in srgb, MenuText 12%, transparent);
    }
    .dmp-hmenu-item[aria-disabled] { opacity: 0.45; }
    .dmp-hmenu-sep {
      height: 1px;
      margin: 4px 6px;
      background-color: color-mix(in srgb, MenuText 20%, transparent);
    }
    /* 右の詳しい欄 */
    .dmp-detail {
      flex: none;
      box-sizing: border-box;
      overflow-y: auto;
      padding: 12px 14px;
      border-left: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    }
    .dmp-d-name {
      font-size: 1.15em;
      font-weight: 600;
      word-break: break-all;
    }
    .dmp-detail[data-missing] .dmp-d-name { text-decoration: line-through; opacity: 0.6; }
    .dmp-d-state { margin-top: 4px; opacity: 0.75; }
    .dmp-detail[data-state="failed"] .dmp-d-state { color: #e22850; opacity: 1; }
    .dmp-d-btns { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 4px; }
    .dmp-d-field { margin-top: 12px; }
    .dmp-d-label { font-size: 0.88em; display: flex; align-items: center; gap: 8px; }
    .dmp-d-label > span:first-child { opacity: 0.65; margin-right: auto; }
    .dmp-d-link { cursor: pointer; color: LinkText; }
    .dmp-d-link:hover { text-decoration: underline; }
    .dmp-d-value { margin-top: 2px; word-break: break-all; user-select: text; }
  `;

  const FILTERS = [
    ['all', L('すべて', 'All')],
    ['active', L('ダウンロード中', 'Downloading')],
    ['done', L('完了', 'Done')],
    ['failed', L('失敗', 'Failed')],
    ['missing', L('ファイルが無い', 'File missing')],
  ];

  // 並べ替えられる列 [key, 見出し]
  const COLUMNS = [
    ['name', L('ファイル', 'File')],
    ['site', L('サイト', 'Site')],
    ['size', L('大きさ', 'Size')],
    ['start', L('日時', 'Date')],
    ['state', L('状態', 'Status')],
  ];
  const STATE_ORDER = { running: 0, paused: 1, failed: 2, canceled: 3, done: 4 };

  const mgr = { filter: 'all', query: '', checked: new Set(), selected: null, sortKey: 'start', sortDir: -1 };

  function matchFilter(rec) {
    const st = currentState(rec);
    switch (mgr.filter) {
      case 'active': return st === 'running' || st === 'paused';
      case 'done': return st === 'done' && exists.get(rec.path) !== false;
      case 'failed': return st === 'failed' || st === 'canceled';
      case 'missing': return st === 'done' && exists.get(rec.path) === false;
      default: return true;
    }
  }

  function matchQuery(rec) {
    if (!mgr.query) return true;
    const q = mgr.query.toLowerCase();
    return [rec.name, rec.url, rec.referrer, siteOf(rec)].some((s) => (s || '').toLowerCase().includes(q));
  }

  function sizeOf(rec) {
    return rec.size || (live.get(rec.id) || {}).totalBytes || 0;
  }

  function sortValue(rec, key) {
    switch (key) {
      case 'name': return (rec.name || '').toLowerCase();
      case 'site': return siteOf(rec).toLowerCase();
      case 'size': return sizeOf(rec);
      case 'state': {
        // ファイルが無いものは完了の後ろ
        const st = currentState(rec);
        return (STATE_ORDER[st] ?? 9) * 2 + (st === 'done' && exists.get(rec.path) === false ? 1 : 0);
      }
      default: return rec.start || 0;
    }
  }

  function managerRecords() {
    const recs = store.records.filter((r) => matchFilter(r) && matchQuery(r));
    const { sortKey: k, sortDir: dir } = mgr;
    return recs.sort((a, b) => {
      const x = sortValue(a, k);
      const y = sortValue(b, k);
      const c = (typeof x === 'string' ? x.localeCompare(y, 'ja') : x - y) * dir;
      // 同じ値なら新しい順
      return c || (b.start || 0) - (a.start || 0);
    });
  }

  function managerStateText(rec) {
    const st = currentState(rec);
    const d = live.get(rec.id);
    if (st === 'running') {
      const p = progressOf(rec);
      return L(`ダウンロード中${p >= 0 ? ` ${Math.round(p)}%` : ''}${d && d.speed > 0 ? ` · ${fmtSize(d.speed)}/秒` : ''}`,
        `Downloading${p >= 0 ? ` ${Math.round(p)}%` : ''}${d && d.speed > 0 ? ` · ${fmtSize(d.speed)}/s` : ''}`);
    }
    if (st === 'paused') return L('一時停止中', 'Paused');
    if (st === 'done') return exists.get(rec.path) === false ? L('ファイルが無い', 'File missing') : L('完了', 'Done');
    if (st === 'canceled') return L('中止', 'Canceled');
    return rec.error ? L(`失敗(${rec.error})`, `Failed (${rec.error})`) : L('失敗', 'Failed');
  }

  function fmtFull(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function copyText(text) {
    try {
      Cc['@mozilla.org/widget/clipboardhelper;1'].getService(Ci.nsIClipboardHelper).copyString(text);
    } catch (ex) {
      console.error(LOG, 'コピーできませんでした', ex);
    }
  }

  function textBtn(label, fn) {
    const b = h('button', null, label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });
    return b;
  }

  function buildManager() {
    // ウィンドウのタイトル(タイトルバーとタスクバーに出る)。dummy.xhtml の <window> は XUL の名前空間が無い
    // ただの XML の要素なので、title 属性や document.title では変わらない。ウィンドウ本体に直接付ける
    try {
      win.docShell.treeOwner.QueryInterface(Ci.nsIBaseWindow).title = MANAGER_TITLE;
    } catch (ex) {
      console.error(LOG, '専用のウィンドウのタイトルを付けられませんでした', ex);
    }
    try {
      win.windowUtils.loadSheetUsingURIString('data:text/css,' + encodeURIComponent(MANAGER_CSS), win.windowUtils.AUTHOR_SHEET);
      win.windowUtils.loadSheetUsingURIString('data:text/css,' + encodeURIComponent(PANEL_CSS), win.windowUtils.AUTHOR_SHEET);
    } catch (ex) {
      console.error(LOG, '専用のウィンドウの見た目を読み込めませんでした', ex);
    }
    const wrap = h('div', 'dmp-wrap');

    // チェックで選んだものへの操作(選んでいるときだけ出す。表の下の段の左)
    const sel = h('div', 'dmp-selacts');
    sel.hidden = true;
    sel.append(h('span', 'dmp-selcount dmp-muted'),
      textBtn(L('一覧から消す', 'Remove from List'), () => {
        const ids = [...mgr.checked];
        mgr.checked.clear();
        if (ids.length) removeFromList(ids);
      }),
      textBtn(L('ファイルを削除', 'Delete File'), () => {
        deleteFiles([...mgr.checked].map((id) => store.byId.get(id)).filter(Boolean));
      }));
    const foot = h('div', 'dmp-mfoot');
    foot.append(sel, h('div', 'dmp-spacer'),
      textBtn(L('完了したものを消す', 'Clear Completed'), () => clearList('done')),
      textBtn(L('すべて削除', 'Clear All'), () => clearList('all')));

    const top = h('div', 'dmp-top');
    const search = h('input');
    search.type = 'search';
    search.placeholder = L('ファイル名・サイト・URL で探す', 'Search name, site, or URL');
    search.addEventListener('input', () => {
      mgr.query = search.value.trim();
      renderManager();
    });
    top.appendChild(search);
    for (const [k, label] of FILTERS) {
      const c = h('div', 'dmp-chip', label);
      c.dataset.filter = k;
      if (k === mgr.filter) c.setAttribute('selected', 'true');
      c.addEventListener('click', () => {
        mgr.filter = k;
        for (const x of top.querySelectorAll('.dmp-chip')) x.toggleAttribute('selected', x === c);
        renderManager();
      });
      top.appendChild(c);
    }
    top.append(h('div', 'dmp-spacer'), iconBtn('dmp-side', '', () => setDetailOpen(!detailOpen())));

    const body = h('div', 'dmp-body');
    const table = h('div', 'dmp-table');
    table.append(buildHeader(), h('div', 'dmp-rows'));
    const splitter = h('div', 'dmp-splitter');
    const detail = h('div', 'dmp-detail');
    body.append(table, splitter, detail);
    wrap.append(top, body, foot);
    doc.documentElement.appendChild(wrap);
    setupSplitter(splitter, detail);
    setDetailOpen(detailOpen());
    renderManager();
    refreshExists(store.records);
    // 右クリックメニューは、ほかの所を押す・Esc・ウィンドウから離れる・スクロールで閉じる
    win.addEventListener('mousedown', (e) => {
      if (!e.target.closest || !e.target.closest('.dmp-hmenu')) closeHtmlMenu();
    }, true);
    win.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeHtmlMenu();
    }, true);
    win.addEventListener('blur', closeHtmlMenu);
    win.addEventListener('resize', closeHtmlMenu);
    doc.addEventListener('scroll', closeHtmlMenu, true);
    // ほかのアプリでファイルを消したときのために、ウィンドウに戻ったら調べ直す
    win.addEventListener('focus', () => refreshExists(store.records));
    search.focus();
  }

  // 詳しい欄の開閉と幅(設定に残し、次に開いたときも同じにする)
  const DETAIL_MIN = 200;
  function detailOpen() {
    return Services.prefs.getBoolPref(PREF + 'detailOpen', true);
  }
  function detailWidth() {
    return Services.prefs.getIntPref(PREF + 'detailWidth', 300);
  }
  // 表の幅を 300px は残す。ただし開いた直後はウィンドウの大きさがまだ決まっていない(innerWidth が小さい)ことが
  // あり、そのまま詰めると保存した幅より狭くなったので、そのときは詰めない
  function clampDetail(px) {
    const max = win.innerWidth >= 600 ? win.innerWidth - 300 : Infinity;
    return Math.round(Math.max(DETAIL_MIN, Math.min(px, max)));
  }

  function setDetailOpen(open) {
    try {
      Services.prefs.setBoolPref(PREF + 'detailOpen', open);
    } catch (ex) {
      console.error(LOG, '詳しい欄の開閉を保存できませんでした', ex);
    }
    const detail = doc.querySelector('.dmp-detail');
    detail.hidden = !open;
    doc.querySelector('.dmp-splitter').hidden = !open;
    detail.style.width = `${clampDetail(detailWidth())}px`;
    const b = doc.querySelector('.dmp-top > .dmp-side');
    b.toggleAttribute('data-open', open);
    b.setAttribute('title', open ? L('詳しい欄を閉じる', 'Hide details') : L('詳しい欄を開く', 'Show details'));
  }

  function setupSplitter(splitter, detail) {
    splitter.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = detail.getBoundingClientRect().width;
      // 仕切りの外へマウスが出ても追えるよう、動きはウィンドウで受ける(取り込めればポインターも取り込む)
      try {
        splitter.setPointerCapture(e.pointerId);
      } catch (ex) {
        // 取り込めなくてもウィンドウで受けるので続ける
      }
      splitter.dataset.drag = 'true';
      const move = (ev) => {
        // 仕切りを左へ動かすと詳しい欄が広がる
        detail.style.width = `${clampDetail(startW - (ev.clientX - startX))}px`;
      };
      const up = () => {
        win.removeEventListener('pointermove', move, true);
        delete splitter.dataset.drag;
        try {
          Services.prefs.setIntPref(PREF + 'detailWidth', Math.round(detail.getBoundingClientRect().width));
        } catch (ex) {
          console.error(LOG, '詳しい欄の幅を保存できませんでした', ex);
        }
      };
      win.addEventListener('pointermove', move, true);
      win.addEventListener('pointerup', up, { capture: true, once: true });
    });
    // ウィンドウを狭めたときに、表が潰れないよう詰める
    win.addEventListener('resize', () => {
      if (!detail.hidden) detail.style.width = `${clampDetail(detailWidth())}px`;
    });
  }

  function buildHeader() {
    const head = h('div', 'dmp-tr dmp-th');
    const all = h('input', 'dmp-all');
    all.type = 'checkbox';
    all.addEventListener('change', () => {
      for (const r of managerRecords()) {
        if (all.checked) mgr.checked.add(r.id);
        else mgr.checked.delete(r.id);
      }
      renderManager();
    });
    const c0 = h('div');
    c0.appendChild(all);
    head.appendChild(c0);
    for (const [key, label] of COLUMNS) {
      const c = h('div', 'dmp-sort', label);
      c.dataset.key = key;
      c.addEventListener('click', () => {
        // 同じ列なら向きを変える。新しい列は、日時・大きさは大きい順、ほかは小さい順から
        if (mgr.sortKey === key) {
          mgr.sortDir = -mgr.sortDir;
        } else {
          mgr.sortKey = key;
          mgr.sortDir = key === 'start' || key === 'size' ? -1 : 1;
        }
        renderManager();
      });
      head.appendChild(c);
    }
    head.appendChild(h('div'));
    return head;
  }

  function buildTr(rec) {
    const tr = h('div', 'dmp-tr dmp-item');
    tr.dataset.id = rec.id;
    const cb = h('input', 'dmp-cb');
    cb.type = 'checkbox';
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => {
      if (cb.checked) mgr.checked.add(rec.id);
      else mgr.checked.delete(rec.id);
      renderManager();
    });
    const cc = h('div');
    cc.appendChild(cb);
    const acts = h('div', 'dmp-c-acts');
    acts.append(h('div', 'dmp-acts'), iconBtn('dmp-remove', L('一覧から消す', 'Remove from List'), () => actions.remove(rec)));
    tr.append(cc, h('div', 'dmp-c-name'), h('div', 'dmp-muted dmp-c-site'), h('div', 'dmp-muted dmp-c-size'),
      h('div', 'dmp-muted dmp-c-date'), h('div', 'dmp-c-state'), acts);
    tr.addEventListener('click', () => {
      mgr.selected = rec.id;
      renderManager();
    });
    tr.addEventListener('dblclick', () => {
      if (currentState(rec) === 'done') actions.open(rec);
    });
    tr.addEventListener('contextmenu', (e) => {
      mgr.selected = rec.id;
      renderManager();
      showContext(e, rec);
    });
    updateTr(tr, rec);
    return tr;
  }

  function updateTr(tr, rec) {
    const st = currentState(rec);
    tr.dataset.state = st;
    tr.toggleAttribute('data-missing', st === 'done' && exists.get(rec.path) === false);
    tr.toggleAttribute('data-checked', mgr.checked.has(rec.id));
    tr.toggleAttribute('data-selected', mgr.selected === rec.id);
    tr.querySelector('.dmp-cb').checked = mgr.checked.has(rec.id);
    tr.querySelector('.dmp-c-name').textContent = rec.name;
    tr.querySelector('.dmp-c-site').textContent = siteOf(rec);
    tr.querySelector('.dmp-c-size').textContent = fmtSize(sizeOf(rec));
    tr.querySelector('.dmp-c-date').textContent = fmtTime(rec.start);
    tr.querySelector('.dmp-c-state').textContent = managerStateText(rec);
    // ボタンの種類が変わったときだけ差し替える(押している最中に消えないように)
    const box = tr.querySelector('.dmp-acts');
    const fresh = actionButtons(rec);
    const sig = (b) => [...b.children].map((c) => c.className).join(',');
    if (sig(box) !== sig(fresh)) box.replaceWith(fresh);
  }

  function renderManager() {
    const table = doc.querySelector('.dmp-table');
    if (!table) return;
    // 一覧から消えたものの選択は外す
    for (const id of [...mgr.checked]) if (!store.byId.has(id)) mgr.checked.delete(id);
    if (mgr.selected && !store.byId.has(mgr.selected)) mgr.selected = null;
    const recs = managerRecords();

    // 見出し: 全部選ぶのチェックと、並べ替えの印
    const all = table.querySelector('.dmp-all');
    all.checked = recs.length > 0 && recs.every((r) => mgr.checked.has(r.id));
    for (const c of table.querySelectorAll('.dmp-sort')) {
      if (c.dataset.key === mgr.sortKey) c.dataset.dir = String(mgr.sortDir);
      else delete c.dataset.dir;
    }

    // 行: 並びが同じなら中身だけ直す(マウスの位置とスクロールを保つ)
    const rows = table.querySelector('.dmp-rows');
    const ids = [...rows.querySelectorAll('.dmp-item')].map((r) => r.dataset.id);
    if (rows.firstChild && ids.length === recs.length && ids.every((id, i) => id === recs[i].id)) {
      for (const tr of rows.querySelectorAll('.dmp-item')) updateTr(tr, store.byId.get(tr.dataset.id));
    } else {
      rows.textContent = '';
      if (!recs.length) rows.appendChild(h('div', 'dmp-empty', L('当てはまるダウンロードはありません', 'No matching downloads')));
      for (const rec of recs) rows.appendChild(buildTr(rec));
    }

    const sel = doc.querySelector('.dmp-selacts');
    sel.hidden = mgr.checked.size === 0;
    sel.querySelector('.dmp-selcount').textContent = L(`${mgr.checked.size} 件を選択`, `${mgr.checked.size} selected`);
    renderDetail();
  }

  // 右の詳しい欄。中身の組み立ては、選んだものや状態が変わったときだけ(ボタンを押している最中に作り直さない)
  function renderDetail() {
    const box = doc.querySelector('.dmp-detail');
    const rec = mgr.selected && store.byId.get(mgr.selected);
    if (!rec) {
      if (box.dataset.sig !== '') {
        box.dataset.sig = '';
        box.removeAttribute('data-state');
        box.removeAttribute('data-missing');
        box.textContent = '';
      }
      return;
    }
    const st = currentState(rec);
    const missing = st === 'done' && exists.get(rec.path) === false;
    box.dataset.state = st;
    box.toggleAttribute('data-missing', missing);
    const sig = [rec.id, st, missing, rec.path, rec.end].join('|');
    if (box.dataset.sig === sig) {
      // 状態の文字と大きさだけ直す
      box.querySelector('.dmp-d-state').textContent = managerStateText(rec);
      const sz = box.querySelector('.dmp-d-size');
      if (sz) sz.textContent = fmtSize(sizeOf(rec)) || L('不明', 'Unknown');
      return;
    }
    box.dataset.sig = sig;
    box.textContent = '';
    box.append(h('div', 'dmp-d-name', rec.name), h('div', 'dmp-d-state', managerStateText(rec)));

    const btns = h('div', 'dmp-d-btns');
    const d = live.get(rec.id);
    if (st === 'running' || st === 'paused') {
      if (st === 'paused' || (d && d.tryToKeepPartialData && d.target.partFilePath)) {
        btns.appendChild(textBtn(st === 'running' ? L('一時停止', 'Pause') : L('再開', 'Resume'), () => actions.pauseResume(rec)));
      }
      btns.appendChild(textBtn(L('中止', 'Cancel'), () => actions.cancel(rec)));
    } else if (st === 'done' && !missing) {
      btns.append(textBtn(L('ファイルを開く', 'Open File'), () => actions.open(rec)), textBtn(L('フォルダを開く', 'Open Folder'), () => actions.reveal(rec)),
        textBtn(L('ファイルを削除', 'Delete File'), () => actions.deleteFile(rec)));
    } else if (st === 'failed' || st === 'canceled') {
      btns.appendChild(textBtn(L('やり直す', 'Retry'), () => actions.retry(rec)));
    }
    btns.appendChild(textBtn(L('一覧から消す', 'Remove from List'), () => actions.remove(rec)));
    box.appendChild(btns);

    // 項目 1 つ。links: [[文字, 押したとき], ...](コピー・開く)
    const field = (label, value, links = [], cls = '') => {
      if (!value) return;
      const f = h('div', 'dmp-d-field');
      const l = h('div', 'dmp-d-label');
      l.appendChild(h('span', null, label));
      for (const [text, fn] of links) {
        const a = h('span', 'dmp-d-link', text);
        a.addEventListener('click', fn);
        l.appendChild(a);
      }
      f.append(l, h('div', `dmp-d-value ${cls}`, value));
      box.appendChild(f);
    };
    field(L('大きさ', 'Size'), fmtSize(sizeOf(rec)) || L('不明', 'Unknown'), [], 'dmp-d-size');
    field(L('始めた日時', 'Started'), fmtFull(rec.start));
    field(L('終わった日時', 'Finished'), fmtFull(rec.end));
    field(L('ダウンロード元', 'Download link'), rec.url, [[L('コピー', 'Copy'), () => copyText(rec.url)]]);
    field(L('ダウンロードしたページ', 'Download page'), rec.referrer, [[L('開く', 'Open'), () => actions.openPage(rec)], [L('コピー', 'Copy'), () => copyText(rec.referrer)]]);
    field(L('保存先', 'Saved to'), rec.path, [[L('コピー', 'Copy'), () => copyText(rec.path)]]);
  }

  // ---- 表示の更新(変化がまとめて来ても 1 回にする) ----

  let renderTimer = 0;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = win.setTimeout(() => {
      renderTimer = 0;
      try {
        if (IS_MANAGER) {
          renderManager();
        } else {
          updateButton();
          const panel = doc.getElementById(PANEL_ID);
          if (panel && panel.state === 'open') renderPanel();
        }
      } catch (ex) {
        console.error(LOG, '表示を更新できませんでした', ex);
      }
    }, 300);
  }

  // ---- ボタン(全ウィンドウで 1 回だけ登録) ----

  function ensureWidget() {
    const CUI = win.CustomizableUI;
    const w = CUI.getWidget(WIDGET_ID);
    if (w && w.provider === CUI.PROVIDER_API) return;
    // 登録をサンドボックスの中で行う(どこかのウィンドウの関数を渡すと、そのウィンドウを閉じたあと死んだ参照になる)
    const sb = Components.utils.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(), {
      sandboxName: 'DownloadManagerPlus widget',
    });
    sb.CustomizableUI = CUI;
    sb.WIDGET_ID = WIDGET_ID;
    sb.WIDGET_LABEL = L('ダウンロードの一覧', 'Download List');
    Components.utils.evalInSandbox(`
      CustomizableUI.createWidget({
        id: WIDGET_ID,
        type: 'button',
        label: WIDGET_LABEL,
        tooltiptext: WIDGET_LABEL,
        removable: true,
        onCommand(event) {
          const node = event.target;
          const w = node.ownerDocument.defaultView;
          if (w.FloorpDMP) w.FloorpDMP.togglePanel(node);
        },
      });
    `, sb);
    // 初回だけ、ツールバーのダウンロードのボタンの隣に置く
    if (!Services.prefs.getBoolPref(PREF + 'placed', false)) {
      Services.prefs.setBoolPref(PREF + 'placed', true);
      try {
        const dl = CUI.getPlacementOfWidget('downloads-button');
        if (dl) CUI.addWidgetToArea(WIDGET_ID, dl.area, dl.position + 1);
        else CUI.addWidgetToArea(WIDGET_ID, CUI.AREA_NAVBAR);
      } catch (ex) {
        console.error(LOG, 'ボタンをツールバーに置けませんでした', ex);
      }
    }
  }

  // ---- 初期化 ----

  async function initCommon() {
    await loadStore();
    Services.obs.addObserver(changedObserver, CHANGED_TOPIC);
    Services.obs.addObserver(requestObserver, REQUEST_TOPIC);
    const list = await Downloads.getList(Downloads.ALL);
    await list.addView(view);
    win.addEventListener('unload', () => {
      try {
        list.removeView(view);
        Services.obs.removeObserver(changedObserver, CHANGED_TOPIC);
        Services.obs.removeObserver(requestObserver, REQUEST_TOPIC);
        if (saveTimer && isPrimaryAtUnload) saveNow();
      } catch (ex) {
        console.error(LOG, '後片付けに失敗しました', ex);
      }
    }, { once: true });
  }
  let isPrimaryAtUnload = false;
  win.addEventListener('beforeunload', () => {
    isPrimaryAtUnload = isPrimary();
  });

  async function initBrowser() {
    if (!doc.getElementById(STYLE_ID)) {
      const style = h('style');
      style.id = STYLE_ID;
      style.textContent = PANEL_CSS;
      doc.documentElement.appendChild(style);
    }
    win.FloorpDMP = { togglePanel, openManager };
    ensureWidget();
    await initCommon();
    if (isPrimary()) await importOnce();
    updateButton();
  }

  async function initManager() {
    await initCommon();
    buildManager();
  }

  const run = (fn) => fn().catch((ex) => console.error(LOG, '初期化に失敗しました', ex));
  if (IS_MANAGER) {
    run(initManager);
  } else if (win.gBrowserInit && win.gBrowserInit.delayedStartupFinished) {
    run(initBrowser);
  } else {
    const obs = (subject, topic) => {
      if (subject === win) {
        Services.obs.removeObserver(obs, topic);
        run(initBrowser);
      }
    };
    Services.obs.addObserver(obs, 'browser-delayed-startup-finished');
  }
})(window);
