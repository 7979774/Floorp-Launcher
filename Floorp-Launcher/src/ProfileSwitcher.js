// Floorp-Launcher's profile-switcher toolbar button + menu.
// ↑ 1 行目は必ずコメントにすること: このファイルは autoconfig ファイル
//   (general.config.filename)としても読まれ、autoconfig は 1 行目を読み飛ばす。
//
// 読まれ方は 2 通り(末尾の「autoconfig として読まれたとき」も参照):
//   1. 起動時に autoconfig として 1 回。onemen 氏の config.js(userChrome.js
//      ローダーの入口)を読み込み、各ブラウザウィンドウにこのファイルを読ませる
//      準備をする。config.js 自体には何も足さない(Firefox Scripts Updater が
//      config.js をハッシュ照合するため。Program.cs の WriteAutoconfigFiles 参照)。
//   2. ブラウザウィンドウごとに loadSubScript で 1 回。プロファイルボタンを出す。
//
// This is a genuine .js file (embedded into Floorp-Launcher.exe as a
// manifest resource by Build.bat, and written as-is into each app dir
// by WriteAutoconfigFiles in Program.cs; editing it needs a Build.bat run) -
// NOT embedded as a C# string, and deliberately NOT run directly in the
// autoconfig sandbox either. Both of those choices trace back to the same root
// cause, confirmed by testing:
//
// config.js runs inside a throwaway autoconfig sandbox that gets torn
// down shortly after startup finishes evaluating it. Anything that runs
// *synchronously* during that initial evaluation (tagging the window
// title, building the toolbar button and its icon) works fine - but a
// closure meant to be invoked *later*, in response to a real event (the
// toolbar button's onCommand), silently failed: no exception anywhere,
// not even from our own logging code, because the whole closure -
// including everything it captured (Services/Cc/Ci, this very object)
// - had already become a dead cross-compartment reference by the time
// of the click.
//
// Fix: the autoconfig pass only runs the small loader at the bottom of
// this file, which loadSubScript()s *this* file straight into each
// browser window's own long-lived global scope instead, so every
// closure this file creates - including onCommand - lives as long as
// that window does, not as long as the config.js sandbox does.
//
// Separately (and the reason to always dispatch a *real* 'command'
// event when testing this manually via Marionette, never .click()/
// .doCommand()): menu/menuitem icons in this Gecko build are set via
// the --menuitem-icon CSS custom property, not list-style-image -
// list-style-image only works on the plain <toolbarbutton> the button
// itself is built from.

// 画面に出す文字の言葉。ブラウザーの言語が日本語なら日本語、それ以外は英語(コンソールに出すメッセージは
// そのまま)。ウィンドウごとに読み込まれるので、何度宣言されても困らない function にしている
function floorpLauncherL(ja, en) {
  try {
    return Services.locale.appLocaleAsBCP47.toLowerCase().startsWith('ja') ? ja : en;
  } catch (e) {
    return ja;
  }
}

var FloorpLauncherProfileUI = {
  readTextFile(file) {
    if (!file.exists()) return null;
    const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
    stream.init(file, -1, 0, 0);
    const cstream = Cc['@mozilla.org/intl/converter-input-stream;1'].createInstance(Ci.nsIConverterInputStream);
    cstream.init(stream, 'UTF-8', 0, 0);
    const out = {};
    cstream.readString(-1, out);
    cstream.close();
    return out.value;
  },
  getProfileName() {
    try {
      const f = Services.dirsvc.get('ProfD', Ci.nsIFile);
      f.append('profile-name.txt');
      const text = this.readTextFile(f);
      return text ? text.trim() : null;
    } catch (e) { return null; }
  },
  getLauncherRoot() {
    // Profile lives at <root>\data\profile\<salt>.<name> -
    // three parents back up to <root>.
    return Services.dirsvc.get('ProfD', Ci.nsIFile).parent.parent.parent;
  },
  getProfilesMap() {
    try {
      const f = this.getLauncherRoot();
      f.append('data');
      f.append('profiles.json');
      const text = this.readTextFile(f);
      return text ? JSON.parse(text) : {};
    } catch (e) { return {}; }
  },
  tagTitle(win) {
    const name = this.getProfileName();
    if (!name) return;
    const titleEl = win.document.querySelector('title');
    if (!titleEl) return;
    const suffix = ' - ' + name;
    // Persistent per-window state so this can be called a SECOND time
    // (right after renaming the currently-running profile - see the
    // isCurrent branch in applyProfileRename) without stacking a new
    // ' - <name>' tail on top of the old one every time the page's own
    // title changes afterward: apply() always strips whatever suffix
    // it last applied before appending the current one.
    let state = win.__floorpLauncherTitleTag;
    if (!state) {
      state = {};
      win.__floorpLauncherTitleTag = state;
      state.apply = () => {
        if (titleEl.textContent.endsWith(state.suffix)) return;
        if (state.applied && titleEl.textContent.endsWith(state.applied)) {
          titleEl.textContent = titleEl.textContent.slice(0, -state.applied.length);
        }
        titleEl.textContent = titleEl.textContent + state.suffix;
        state.applied = state.suffix;
      };
      new win.MutationObserver(state.apply).observe(titleEl, { childList: true });
    }
    state.suffix = suffix;
    state.apply();
  },
  addToolbarButton(win) {
    const { CustomizableUI } = ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs');
    const id = 'floorp-launcher-profile-switcher';
    const self = this;
    try {
      CustomizableUI.createWidget({
        id,
        type: 'button',
        label: floorpLauncherL('プロファイル', 'Profiles'),
        tooltiptext: floorpLauncherL('プロファイルを切り替え', 'Switch profile'),
        // defaultArea を付けない = 最初はパレット(「ツールバーをカスタマイズ」の中)。
        // プロファイルの切り替えはアプリケーションメニュー(≡)のいちばん上から行う(addAppMenu)
        onCommand(event) {
          try {
            self.showMenu(event);
          } catch (e) {
            self.logError('showMenu', e);
          }
        },
        onCreated(node) {
          // The toolbar button itself shows the *current*
          // profile's own avatar (photo/emoji/fallback letter),
          // not a generic icon - this is a real <toolbarbutton>,
          // which (unlike <menu>/<menuitem>, see showMenu) does
          // still use plain list-style-image, confirmed by
          // testing.
          const win = node.ownerDocument.defaultView;
          const doc = node.ownerDocument;
          // Two independent, explicit knobs, on purpose:
          //   BUTTON_WIDTH/BUTTON_HEIGHT - fixed to match a native
          //     toolbarbutton exactly (measured against #reload-button:
          //     32x40, this theme's standard nav-bar button footprint),
          //     regardless of icon size.
          //   ICON_SIZE - the avatar's visible size, centred inside a
          //     native-sized (HIGHLIGHT_SIZE) icon box by padding.
          // (An earlier version tried reusing the theme's own
          // padding-driven sizing formula so a bigger icon would grow
          // the button to match - that couples the two together, which
          // isn't what's wanted here: the button should stay fixed no
          // matter what ICON_SIZE is set to.)
          // ホバー時の角丸ハイライトはボタン本体ではなく .toolbarbutton-icon の
          // 枠に描かれる(Lepton テーマ。標準ボタンは 30x30・余白 7px)。
          // 枠をアバターと同じ大きさにするとハイライトがアバターの裏に隠れて
          // 標準ボタンと見た目が違ってしまうので、枠は標準と同じ HIGHLIGHT_SIZE
          // にそろえ、余白でアバター(ICON_SIZE)を中央に置く。
          if (!doc.getElementById('floorp-launcher-icon-size-style')) {
            const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
            style.id = 'floorp-launcher-icon-size-style';
            const BUTTON_WIDTH = 32;
            const BUTTON_HEIGHT = 40;
            const HIGHLIGHT_SIZE = 30;
            const ICON_SIZE = 24;
            const ICON_PADDING = (HIGHLIGHT_SIZE - ICON_SIZE) / 2;
            // ツールバーの上に置かれたときだけにする。カスタマイズ画面のパレット(項目の幅が広い)でも
            // 幅 32px に固定すると、アイコンが名前の左に寄ってしまう
            style.textContent =
              'toolbar #floorp-launcher-profile-switcher { width: ' + BUTTON_WIDTH + 'px; height: ' + BUTTON_HEIGHT + 'px; }' +
              'toolbar #floorp-launcher-profile-switcher > .toolbarbutton-icon { box-sizing: border-box; width: ' + HIGHLIGHT_SIZE + 'px; height: ' + HIGHLIGHT_SIZE + 'px; padding: ' + ICON_PADDING + 'px; }';
            doc.documentElement.appendChild(style);
          }
          const name = self.getProfileName() || '?';
          // 48, not 16 - confirmed by testing that this button's
          // actual rendered .toolbarbutton-icon box is 32x32 (this
          // theme's default toolbar density), while a native
          // built-in button like the app menu renders its icon at
          // 16x16 - those fill their own (smaller) box edge-to-
          // edge, but our 16x16 source sat centered inside the
          // larger 32x32 box with unfilled padding around it,
          // reading as noticeably smaller than its neighbors.
          // Rendering oversized and letting Gecko scale down keeps
          // this correct (and crisp on HiDPI) across toolbar
          // density settings, without needing to introspect the
          // box size at run time.
          self.renderAvatar(win, name, self.getCurrentProfileDir(), 48, (dataUri) => {
            node.style.listStyleImage = 'url("' + dataUri + '")';
          });
        },
      });
    } catch (e) {
      // Already registered from an earlier run of an older
      // version of this script (e.g. before the icon/position
      // fix below existed) - CustomizableUI throws rather than
      // no-op for a duplicate id, confirmed by testing. That's
      // fine: fall through and (re)apply the placement below
      // regardless, so a stale prior registration self-heals
      // instead of getting stuck forever.
    }
    // 以前の版はボタンをナビゲーションツールバーの先頭に自動で置いていた。プロファイルの切り替えを
    // アプリケーションメニューへ移したので、そのころに置かれたボタンは 1 回だけパレットへ戻す。
    // 戻したあとに自分で置き直したものは触らない(印の pref を立てておく)
    const MIGRATED_PREF = 'floorp-launcher.profileButton.movedToPalette';
    try {
      if (!Services.prefs.getBoolPref(MIGRATED_PREF, false)) {
        Services.prefs.setBoolPref(MIGRATED_PREF, true);
        if (CustomizableUI.getPlacementOfWidget(id)) {
          CustomizableUI.removeWidgetFromArea(id);
        }
      }
    } catch (e) {
      this.logError('moveButtonToPalette', e);
    }
  },
  // anchor: パネルを出す基準の要素(省略時は押されたボタン)。アプリケーションメニューの
  // 「プロファイルを管理…」からは ≡ ボタンを渡す
  showMenu(event, anchor) {
    const anchorNode = anchor || event.target;
    // event.target.ownerGlobal came back undefined here on
    // this build even for a genuine, listener-confirmed
    // 'command' event on the real button node - confirmed by
    // testing (the actual root cause of the button doing
    // nothing on click). ownerDocument.defaultView is the
    // standard, reliable way to get the window from a node.
    const win = anchorNode.ownerDocument.defaultView;
    const doc = win.document;
    const old = doc.getElementById('floorp-launcher-profile-menu');
    if (old) old.remove();
    // A <panel>, not a <menupopup>. A menupopup is specifically a
    // *menu*: it runs its own keyboard navigation / type-ahead and
    // swallows keystrokes, which made an in-place rename <input>
    // inside it impossible to type into no matter what (confirmed by
    // testing with real OS keystrokes). ignorekeys="true" tells the
    // panel not to handle keys itself either, so they reach whatever
    // is focused inside - this is exactly how Firefox's own editable
    // 'edit bookmark' panel is set up. Nothing is lost by the switch:
    // every row in here is already a custom hbox/label, not a real
    // <menuitem>.
    const popup = doc.createXULElement('panel');
    popup.id = 'floorp-launcher-profile-menu';
    // type="arrow" is what gives the panel its themed chrome
    // (background, border, text color) - a bare <panel> has none of
    // its own and the page showed straight through it, while
    // painting it by hand from --arrowpanel-* / system colors landed
    // on black-on-black; both confirmed by testing. Keeping the
    // themed variant and just trimming its default padding is the
    // combination that actually renders correctly.
    popup.setAttribute('type', 'arrow');
    popup.setAttribute('ignorekeys', 'true');
    // Escape is normally handled by the popup itself; with
    // ignorekeys that's ours to do.
    popup.addEventListener('keydown', (ke) => {
      if (ke.key === 'Escape') {
        ke.preventDefault();
        popup.hidePopup();
      }
    });

    // 中身(一覧と詳細画面)は、アプリケーションメニューのサブビューと共通(buildProfileUI)
    const ui = this.buildProfileUI(win, {
      close: () => popup.hidePopup(),
      onHidden: (fn) => popup.addEventListener('popuphidden', fn),
    });
    popup.appendChild(ui.root);
    // Before the panel is actually on screen everything measures 0,
    // so the initial lock has to wait for popupshown.
    popup.addEventListener('popupshown', ui.onShown, { once: true });
    doc.documentElement.appendChild(popup);
    // after_end anchors the popup's end (right, in LTR) edge to
    // the button's end edge, so it opens toward the bottom-left
    // instead of the default bottom-right (after_start) -
    // requested by the user. Gecko's popup positioning still
    // auto-flips back if there isn't room on that side.
    popup.openPopup(anchorNode, 'after_end');
  },
  // プロファイルの一覧と詳細画面(横にスライドして切り替わる 2 画面)を作って返す。
  // ツールバーのボタンのパネル(showMenu)と、アプリケーションメニューのサブビュー(fillProfilesView)で共通。
  // host.close: 閉じる(パネルを閉じる / アプリケーションメニューを閉じる)
  // host.onHidden(fn): 閉じたときに fn を呼んでもらう(ドラッグの後片付け)
  // host.width: 1 画面の幅(省略時 260px)
  // 戻り値: { root: 入れ物に入れる要素, onShown: 画面に出たあとに呼ぶ(高さを合わせる) }
  buildProfileUI(win, host) {
    const doc = win.document;
    const map = this.getProfilesMap();
    const current = this.getProfileName();
    // floorp-launcher.json の "profile"(ランチャーが起動するプロファイル)
    const defaultName = this.getDefaultProfileName();

    // Windows' own monochrome UI icon font, shipped with Win10/11 -
    // every glyph below is a private-use codepoint in it, verified
    // rendering (not tofu) on this machine. Deliberately not emoji:
    // mixing text symbols (▶ ⧉) with color emoji (🖼 🙂 🗑) looked
    // inconsistent and the picture emoji in particular was nearly
    // illegible at icon size, confirmed by testing. These inherit
    // the theme's text color like proper UI icons do.
    // Written as codepoints, not literal characters: these live in
    // the Unicode private use area, where a stray editor/encoding
    // round-trip could silently mangle them into tofu.
    const ICON_FONT = "font-family:'Segoe MDL2 Assets';";
    const g = (hex) => String.fromCharCode(parseInt(hex, 16));
    const ICON = {
      play: g('E768'),
      photo: g('E91B'),
      emoji: g('E76E'),
      copy: g('E8C8'),
      trash: g('E74D'),
      edit: g('E70F'),
      code: g('E943'),
      home: g('E80F'),
      chevronRight: g('E76C'),
      chevronLeft: g('E76B'),
      add: g('E710'),
      grip: g('E700'),
    };

    // 既定のプロファイルの名前の横に出す「既定」の札
    const makeDefaultBadge = () => {
      const badge = doc.createXULElement('label');
      badge.setAttribute('value', floorpLauncherL('既定', 'Default'));
      badge.setAttribute('tooltiptext', floorpLauncherL('Floorp-Launcher.exe をそのまま起動したときに使われるプロファイル', 'The profile used when Floorp-Launcher.exe starts without options'));
      badge.style.cssText =
        'margin:0;padding:1px 6px;font-size:0.8em;border-radius:8px;flex-shrink:0;' +
        'background-color:color-mix(in srgb, currentColor 15%, transparent);';
      return badge;
    };

    // Two fixed-width 'views' (the profile list, and a per-profile
    // detail screen) sitting side by side inside a clipped track -
    // clicking a profile slides the *whole panel* sideways to reveal
    // its detail/actions screen, requested directly by the user.
    // Being an internal CSS transform within a fixed-width clipping
    // box, this never overflows off a screen edge the way the
    // original native flyout <menu> submenu did (see the other
    // gotchas in this project's memory for that whole saga) - it's
    // also why this needed replacing an earlier vertical accordion-
    // in-place version rather than reusing it as-is.
    const VIEW_WIDTH = host.width || 260;
    const clip = doc.createXULElement('box');
    clip.style.cssText =
      'overflow:hidden;width:' + VIEW_WIDTH + 'px;transition:height 0.2s ease;';
    const track = doc.createXULElement('hbox');
    // align-items:flex-start stops the shorter view from being
    // stretched to the taller one's height. Without it (and without
    // the explicit clip height below) the panel always stood as tall
    // as the *list*, leaving a big empty gap under the detail view's
    // content whenever there were several profiles.
    track.style.cssText =
      'width:' + VIEW_WIDTH * 2 + 'px;align-items:flex-start;transition:transform 0.2s ease;';
    clip.appendChild(track);

    const listView = doc.createXULElement('vbox');
    listView.style.cssText = 'width:' + VIEW_WIDTH + 'px;flex-shrink:0;';
    const detailView = doc.createXULElement('vbox');
    detailView.style.cssText = 'width:' + VIEW_WIDTH + 'px;flex-shrink:0;';
    track.appendChild(listView);
    track.appendChild(detailView);

    // The clip is height-locked to whichever view is showing, so the
    // panel grows/shrinks with it instead of always reserving the
    // taller view's height. Transitioned, so it reads as one motion
    // together with the sideways slide.
    const fitTo = (view) => {
      const h = view.getBoundingClientRect().height;
      if (h) clip.style.height = h + 'px';
    };

    let detailShown = false;
    const showDetailView = () => {
      detailShown = true;
      track.style.transform = 'translateX(-' + VIEW_WIDTH + 'px)';
      fitTo(detailView);
    };
    const showListView = () => {
      detailShown = false;
      track.style.transform = 'translateX(0)';
      fitTo(listView);
    };

    // (Re)builds the detail screen for one profile and slides to it.
    // isCurrent hides actions that don't make sense for the profile
    // this window is actually running as (launching itself; nsIFile
    // .copyTo() throws NS_ERROR_FILE_IS_LOCKED for the active
    // profile's own directory, confirmed by testing, so no
    // duplicate; removing the profile you're using from the list
    // makes little sense either).
    const openDetailFor = (name, dir, isCurrent) => {
      while (detailView.firstChild) {
        detailView.removeChild(detailView.firstChild);
      }
      // Bare back chevron in the corner - no '戻る' text label, the
      // arrow alone carries it (matching the layout the user asked
      // for).
      const backRow = doc.createXULElement('hbox');
      backRow.setAttribute('align', 'center');
      backRow.style.cssText = 'padding:10px 12px 2px;cursor:pointer;';
      const backArrow = doc.createXULElement('label');
      backArrow.setAttribute('value', ICON.chevronLeft);
      backArrow.setAttribute('tooltiptext', floorpLauncherL('戻る', 'Back'));
      backArrow.style.cssText = ICON_FONT + 'margin:0;font-size:0.9em;opacity:0.7;';
      backRow.appendChild(backArrow);
      backRow.addEventListener('click', (e) => {
        e.stopPropagation();
        showListView();
      });
      // アプリケーションメニューの中では、見出しの「<」が戻る役をするので出さない(host.hideBack)
      if (host.hideBack) backRow.hidden = true;
      detailView.appendChild(backRow);

      // Big centred avatar, then the name centred underneath it -
      // a profile 'card', rather than the small avatar-beside-name
      // row this used to be.
      const info = doc.createXULElement('vbox');
      info.style.cssText = 'align-items:center;padding:4px 12px 14px;gap:12px;';
      const img = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
      img.style.cssText = 'width:104px;height:104px;border-radius:50%;object-fit:cover;flex-shrink:0;';
      info.appendChild(img);
      this.renderAvatar(win, name, dir, 208, (dataUri) => {
        img.src = dataUri;
      });

      // Name, with the pencil next to it swapping it for a real
      // in-place <input> - this only works because the container is
      // a <panel ignorekeys="true">; inside the <menupopup> it used
      // to be, keystrokes never reached the input at all.
      const nameArea = doc.createXULElement('hbox');
      nameArea.setAttribute('align', 'center');
      nameArea.style.cssText = 'gap:6px;justify-content:center;';
      const nameLabel = doc.createXULElement('label');
      nameLabel.setAttribute('value', name);
      nameLabel.style.cssText = 'font-weight:700;font-size:1.1em;margin:0;';
      nameArea.appendChild(nameLabel);
      // Renaming the CURRENTLY RUNNING profile is allowed too (unlike
      // launch/duplicate/remove above, which stay isCurrent-gated for
      // real file-lock/self-referential reasons) - it's not file-
      // locked: applyProfileRename only touches data\profiles.json and
      // the profile's own profile-name.txt. The one thing that used to
      // go stale - every already-open window's title bar, tagged from
      // the OLD name at startup and never re-read afterwards - is now
      // re-applied for every open window right after a current-profile
      // rename; see the isCurrent branch in applyProfileRename.
      const editBtn = doc.createXULElement('label');
      editBtn.setAttribute('value', ICON.edit);
      editBtn.setAttribute('tooltiptext', floorpLauncherL('名前を変更', 'Rename'));
      editBtn.style.cssText = ICON_FONT + 'margin:0;font-size:0.9em;opacity:0.75;cursor:pointer;';
      // An invisible copy of the pencil on the other side, so the row
      // is symmetric and the *name alone* ends up centred - centring
      // the name+pencil pair as a unit left the name itself visibly
      // off to the left. Same glyph/font/size, so its width always
      // matches the real pencil's exactly.
      const editSpacer = doc.createXULElement('label');
      editSpacer.setAttribute('value', ICON.edit);
      editSpacer.style.cssText = ICON_FONT + 'margin:0;font-size:0.9em;visibility:hidden;';
      nameArea.insertBefore(editSpacer, nameLabel);
      nameArea.appendChild(editBtn);
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nameInput = doc.createElementNS('http://www.w3.org/1999/xhtml', 'input');
        nameInput.type = 'text';
        nameInput.value = name;
        nameInput.style.cssText =
          'font-weight:700;font-size:1.1em;background:transparent;color:inherit;text-align:center;' +
          'border:1px solid currentColor;border-radius:3px;padding:1px 4px;width:170px;';
        nameArea.replaceChild(nameInput, nameLabel);
        // Hidden in step with the pencil, so the input stays centred
        // the same way the label was.
        editBtn.hidden = true;
        editSpacer.hidden = true;
        // A plain .focus() straight after inserting it doesn't stick
        // reliably here - the panel reclaims focus a tick later,
        // confirmed by testing - so re-assert it on the next turn of
        // the event loop.
        nameInput.focus();
        win.setTimeout(() => {
          nameInput.focus();
          nameInput.select();
        }, 0);

        let settled = false;
        const restore = () => {
          if (settled) return true;
          settled = true;
          nameArea.replaceChild(nameLabel, nameInput);
          editBtn.hidden = false;
          editSpacer.hidden = false;
          return false;
        };
        // Enter・Escape はウィンドウの capture で受ける。アプリケーションメニュー(PanelMultiView)の中では、
        // メニュー自身がパネルの capture でキーを処理して、Escape でメニューごと閉じてしまうため、
        // それより先(ウィンドウ)で受けて止める。編集が終わったら外す
        const onKey = (ke) => {
          if (ke.target !== nameInput) return;
          if (settled) {
            win.removeEventListener('keydown', onKey, true);
            return;
          }
          if (ke.key === 'Enter') {
            ke.preventDefault();
            ke.stopPropagation();
            win.removeEventListener('keydown', onKey, true);
            const newName = nameInput.value.trim();
            if (settled) return;
            if (!newName || newName === name) {
              restore();
              return;
            }
            settled = true;
            host.close();
            this.applyProfileRename(name, dir, newName);
          } else if (ke.key === 'Escape') {
            // Handled here rather than letting it reach the panel's
            // own Escape handler, so the first Escape only cancels
            // the edit instead of closing the whole panel.
            ke.preventDefault();
            ke.stopPropagation();
            win.removeEventListener('keydown', onKey, true);
            restore();
          }
        };
        win.addEventListener('keydown', onKey, true);
        // 編集中にパネル・メニューが閉じられたときも外す
        host.onHidden(() => win.removeEventListener('keydown', onKey, true));
      });
      info.appendChild(nameArea);
      detailView.appendChild(info);

      detailView.appendChild(doc.createXULElement('menuseparator'));

      // Actions as a single row of icon buttons rather than a stack
      // of text links - requested by the user, and it keeps the
      // detail view short enough that it never needs scrolling.
      // Each carries a tooltiptext so the meaning is still
      // discoverable on hover.
      const actionsBox = doc.createXULElement('hbox');
      actionsBox.setAttribute('align', 'center');
      actionsBox.style.cssText = 'padding:6px 12px 10px;gap:4px;justify-content:center;';
      const addAction = (glyph, tip, handler, danger) => {
        const btn = doc.createXULElement('label');
        btn.setAttribute('value', glyph);
        btn.setAttribute('tooltiptext', tip);
        btn.style.cssText =
          ICON_FONT +
          'margin:0;font-size:1.05em;line-height:1;padding:7px 9px;border-radius:4px;cursor:pointer;' +
          (danger ? 'color:#e06c68;' : '');
        // No .text-link class here - its underline/link coloring
        // looks wrong on a bare glyph. A hover background is the
        // affordance instead.
        btn.addEventListener('mouseover', () => {
          btn.style.backgroundColor = 'color-mix(in srgb, currentColor 18%, transparent)';
        });
        btn.addEventListener('mouseout', () => {
          btn.style.backgroundColor = '';
        });
        btn.addEventListener('click', (e) => {
          // A plain <label>, not a real <menuitem> - doesn't trigger
          // XUL's own close-the-whole-menu-hierarchy sequence before
          // running, confirmed by testing that leaving the popup
          // open while the async native file picker tries to take
          // over interfered with it. Close it explicitly first,
          // exactly as a real menuitem click would.
          e.stopPropagation();
          host.close();
          handler();
        });
        actionsBox.appendChild(btn);
      };
      if (!isCurrent) {
        addAction(ICON.play, floorpLauncherL('このプロファイルを起動', 'Launch This Profile'), () => this.launch(name));
      }
      addAction(ICON.photo, floorpLauncherL('画像を設定', 'Set Image'), () => this.setIconForProfile(name, dir));
      addAction(ICON.emoji, floorpLauncherL('絵文字を設定', 'Set Emoji'), () => this.setEmojiForProfile(name, dir));
      // ローダーがまだ無いプロファイルにだけ出す(起動中のプロファイルにも入れられる。再起動で有効になる)
      if (!this.hasLoader(dir)) {
        addAction(ICON.code, floorpLauncherL('userChrome.js ローダーを入れる', 'Install userChrome.js Loader'), () => {
          this.installLoader(name, dir, isCurrent).catch((e) => this.logError('installLoader', e));
        });
      } else if (isCurrent && this.hasScriptManager()) {
        // 使用中のプロファイルで、スクリプトの管理画面(rebuild_userChrome.uc.js の
        // about:userchromejs)が動いているときだけ出す
        addAction(ICON.code, floorpLauncherL('userChrome.js スクリプトの一覧', 'userChrome.js Scripts'), () => this.openScriptManager(doc.defaultView));
      }
      const isDefault = name === defaultName;
      // 既定のプロファイルには出さない(起動中のプロファイルも既定にできる)
      if (!isDefault) {
        addAction(ICON.home, floorpLauncherL('既定のプロファイルにする', 'Make Default'), () => this.setDefaultProfile(name));
      }
      if (!isCurrent) {
        addAction(ICON.copy, floorpLauncherL('複製', 'Duplicate'), () => this.duplicateProfile(name, dir));
        // 既定のプロファイルを一覧から外すと、次の起動でその名前の空のプロファイルが
        // 作られてしまうので出さない(先に別のプロファイルを既定にしてもらう)
        if (!isDefault) {
          addAction(ICON.trash, floorpLauncherL('一覧から削除', 'Remove from List'), () => this.removeProfileFromList(name), true);
        }
      }
      detailView.appendChild(actionsBox);
    };

    // Header row: the currently running profile, shown large - same
    // idea as Firefox's own profile-switcher panel (reference
    // screenshots the user supplied).
    const header = doc.createXULElement('hbox');
    header.setAttribute('align', 'center');
    header.style.cssText = 'padding:10px 12px;gap:10px;cursor:pointer;';
    const headerImg = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
    headerImg.style.cssText = 'width:44px;height:44px;border-radius:50%;object-fit:cover;flex-shrink:0;';
    const headerName = doc.createXULElement('label');
    headerName.setAttribute('value', current || floorpLauncherL('(不明なプロファイル)', '(unknown profile)'));
    headerName.style.cssText = 'flex:1;font-weight:600;font-size:1.05em;margin:0;';
    const headerChevron = doc.createXULElement('label');
    headerChevron.setAttribute('value', ICON.chevronRight);
    headerChevron.style.cssText = ICON_FONT + 'margin:0;font-size:0.8em;opacity:0.6;';
    header.appendChild(headerImg);
    header.appendChild(headerName);
    if (current && current === defaultName) header.appendChild(makeDefaultBadge());
    header.appendChild(headerChevron);
    header.addEventListener('click', (e) => {
      // See addAction above for why this stopPropagation is needed -
      // same reasoning applies to any plain (non-<menuitem>) click
      // target directly inside the popup: without it, Gecko's own
      // rollup-on-click handling closes the whole popup before our
      // own slide-to-detail ever has a visible effect, confirmed by
      // testing.
      e.stopPropagation();
      openDetailFor(current || floorpLauncherL('(不明なプロファイル)', '(unknown profile)'), this.getCurrentProfileDir(), true);
      showDetailView();
    });
    header.addEventListener('mouseenter', () => this.prewarmAvatar(win, this.getCurrentProfileDir(), 208), { once: true });
    listView.appendChild(header);
    this.renderAvatar(win, current || '?', this.getCurrentProfileDir(), 88, (dataUri) => {
      headerImg.src = dataUri;
    });

    listView.appendChild(doc.createXULElement('menuseparator'));

    // The rest of the list is every *other* profile - the current
    // one is already shown (and editable) in the header above,
    // matching the reference screenshots' own 'Other profiles'
    // section.
    //
    // Order comes straight from the key order in data\profiles.json
    // (NOT sorted) - that file is the single source of truth for the
    // user's own arrangement, reordered in place by the drag handling
    // below. Nothing else cares about its key order: the C# side only
    // ever looks profiles up by name.
    const names = Object.keys(map).filter((n) => n !== current);

    // Own container purely so drag math has a clean, gap-free list of
    // sibling rows to index into.
    const rowsBox = doc.createXULElement('vbox');
    listView.appendChild(rowsBox);

    // Rebuilds profiles.json from the current DOM order of rowsBox.
    // The running profile isn't in that list (it's the header), so
    // its slot among the keys is preserved as-is and only the other
    // entries are re-sequenced around it - otherwise merely switching
    // profiles would shuffle the saved order.
    const persistOrder = () => {
      try {
        const live = this.getProfilesMap();
        const allKeys = Object.keys(live);
        const dragged = Array.from(rowsBox.children).map((r) => r._floorpProfileName);
        let i = 0;
        const newKeys = allKeys.map((k) => (k === current ? k : dragged[i++]));
        const next = {};
        for (const k of newKeys) {
          if (k !== undefined && live[k] !== undefined) next[k] = live[k];
        }
        // Never write a map that lost entries (e.g. if the list went
        // stale against the file underneath us).
        if (Object.keys(next).length !== allKeys.length) return;
        this.saveProfilesMap(next);
      } catch (e) {
        this.logError('persistOrder', e);
      }
    };

    let drag = null;
    for (const name of names) {
      const folder = map[name];
      const dir = this.getProfileDir(folder);
      const row = doc.createXULElement('hbox');
      row._floorpProfileName = name;
      row.setAttribute('align', 'center');
      row.style.cssText = 'padding:8px 12px;gap:10px;cursor:pointer;';
      const rowImg = doc.createElementNS('http://www.w3.org/1999/xhtml', 'img');
      rowImg.style.cssText = 'width:26px;height:26px;border-radius:50%;object-fit:cover;flex-shrink:0;';
      const rowLabel = doc.createXULElement('label');
      rowLabel.setAttribute('value', name);
      rowLabel.style.cssText = 'flex:1;margin:0;';
      // Grip (three bars) in place of the old '>' chevron, and it's
      // the *only* thing that starts a drag - grabbing anywhere on
      // the row would fight the row's own click-to-open-detail.
      const grip = doc.createXULElement('label');
      grip.setAttribute('value', ICON.grip);
      grip.setAttribute('tooltiptext', floorpLauncherL('ドラッグして並び替え', 'Drag to reorder'));
      grip.style.cssText =
        ICON_FONT + 'margin:0;font-size:0.85em;opacity:0.5;cursor:grab;padding:2px 2px 2px 6px;';
      row.appendChild(rowImg);
      row.appendChild(rowLabel);
      if (name === defaultName) row.appendChild(makeDefaultBadge());
      row.appendChild(grip);
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        // A drag that ended on this row also produces a click; don't
        // navigate away in that case.
        if (drag && drag.moved) {
          drag = null;
          return;
        }
        drag = null;
        openDetailFor(name, dir, false);
        showDetailView();
      });
      grip.addEventListener('click', (e) => {
        // Grabbing (or merely clicking) the handle should never count
        // as clicking the row itself.
        e.stopPropagation();
        drag = null;
      });
      grip.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        grip.style.cursor = 'grabbing';
        drag = { row, grip, startY: e.screenY, startClientY: e.clientY, moved: false };
      });
      // 詳細画面の大きい画像(208px)を先に描いておき、クリック後すぐ出せるようにする
      row.addEventListener('mouseenter', () => this.prewarmAvatar(win, dir, 208), { once: true });
      rowsBox.appendChild(row);
      this.renderAvatar(win, name, dir, 52, (dataUri) => {
        rowImg.src = dataUri;
      });
    }

    // Drag handling lives on the container, not each row, so the
    // pointer sliding off one row and onto another mid-drag doesn't
    // interrupt it.
    //
    // The dragged row is never re-inserted into the DOM mid-drag -
    // instead it's lifted out visually (transform, following the
    // cursor 1:1, no transition) while the *other* rows slide out of
    // its way with an animated transform (FLIP-style: they're shifted
    // by exactly one row height toward the gap, transitioned smoothly,
    // then the real DOM reorder only happens once on drop). Moving the
    // real row mid-drag was tried first and rejected - re-parenting it
    // via insertBefore on every mousemove changes its own flow
    // position, which fights the translateY that's following the
    // cursor and makes it visibly jump every time it crosses a row.
    rowsBox.addEventListener('mousemove', (e) => {
      if (!drag) return;
      if (!drag.moved) {
        // Small threshold so an ordinary click never registers as a
        // (zero-distance) drag and swallows the navigation.
        if (Math.abs(e.screenY - drag.startY) < 4) return;
        drag.moved = true;
        drag.row.style.position = 'relative';
        drag.row.style.zIndex = '10';
        drag.row.style.transition = 'none';
        drag.row.style.opacity = '0.55';
        // Snapshot the other rows' own (untransformed) positions and
        // the dragged row's original slot among them - both stay
        // fixed for the rest of the drag since none of them actually
        // move in the DOM until drop.
        drag.others = Array.from(rowsBox.children).filter((r) => r !== drag.row);
        drag.rowHeight = drag.row.getBoundingClientRect().height;
        drag.otherTops = drag.others.map((r) => r.getBoundingClientRect().top);
        drag.originalIndex = 0;
        for (const o of drag.others) {
          if (o.compareDocumentPosition(drag.row) & Node.DOCUMENT_POSITION_FOLLOWING) {
            drag.originalIndex++;
          }
        }
        drag.targetIndex = drag.originalIndex;
      }

      // The dragged row follows the cursor directly, 1:1, with no
      // transition - it should feel picked up, not animated.
      drag.row.style.transform = 'translateY(' + (e.clientY - drag.startClientY) + 'px)';

      // Where would it land? Count how many of the (fixed) original
      // slots the cursor has now passed.
      let targetIndex = 0;
      for (let i = 0; i < drag.otherTops.length; i++) {
        const mid = drag.otherTops[i] + drag.rowHeight / 2;
        if (e.clientY > mid) targetIndex = i + 1;
      }
      if (targetIndex === drag.targetIndex) return;
      drag.targetIndex = targetIndex;

      // Slide every row between the old and new target open (or
      // closed) by exactly one row height, animated - this is the
      // visual gap the dragged row is about to drop into.
      drag.others.forEach((o, i) => {
        let shift = 0;
        if (targetIndex <= drag.originalIndex && i >= targetIndex && i < drag.originalIndex) {
          shift = drag.rowHeight;
        } else if (targetIndex > drag.originalIndex && i >= drag.originalIndex && i < targetIndex) {
          shift = -drag.rowHeight;
        }
        o.style.transition = 'transform 0.15s ease';
        o.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      });
    });
    const endDrag = () => {
      if (!drag) return;
      if (drag.grip) drag.grip.style.cursor = 'grab';
      if (drag.moved) {
        const draggedRow = drag.row;
        const others = drag.others || [];
        const insertBeforeNode = drag.targetIndex < others.length ? others[drag.targetIndex] : null;
        // Commit the real DOM order now - every row's transform
        // already shows exactly this layout, so nothing visually
        // jumps except the dragged row itself, which gets an actual
        // short 'settle into place' transition below instead of the
        // instant snap a plain style reset would cause.
        rowsBox.insertBefore(draggedRow, insertBeforeNode);
        for (const o of others) {
          o.style.transition = '';
          o.style.transform = '';
        }
        draggedRow.style.transition = 'transform 0.12s ease, opacity 0.12s ease';
        draggedRow.style.transform = 'translateY(0)';
        draggedRow.style.opacity = '';
        win.setTimeout(() => {
          draggedRow.style.transition = '';
          draggedRow.style.transform = '';
          draggedRow.style.position = '';
          draggedRow.style.zIndex = '';
        }, 140);
        persistOrder();
        // Left set (and cleared by the grip/row click handler) so the
        // click that follows this mouseup doesn't open the detail view.
      } else {
        drag = null;
      }
    };
    rowsBox.addEventListener('mouseup', endDrag);
    host.onHidden(endDrag);

    // Create a new profile - reuses the launcher's own existing
    // 'auto-create if the name is new' behavior (--launch-profile),
    // so this doesn't need to duplicate that logic here.
    // Laid out like a profile row (same padding/gap, an icon where
    // their avatar sits) so it reads as the last entry in the list
    // rather than a stray link tacked on underneath.
    const newProfileRow = doc.createXULElement('hbox');
    newProfileRow.setAttribute('align', 'center');
    newProfileRow.style.cssText = 'padding:8px 12px;gap:10px;cursor:pointer;';
    const newProfileIcon = doc.createXULElement('label');
    newProfileIcon.setAttribute('value', ICON.add);
    newProfileIcon.style.cssText = ICON_FONT + 'margin:0;width:26px;text-align:center;opacity:0.8;';
    const newProfileLabel = doc.createXULElement('label');
    newProfileLabel.setAttribute('value', floorpLauncherL('新しいプロファイル', 'New Profile'));
    newProfileLabel.style.cssText = 'flex:1;margin:0;';
    newProfileRow.appendChild(newProfileIcon);
    newProfileRow.appendChild(newProfileLabel);
    newProfileRow.addEventListener('click', (e) => {
      e.stopPropagation();
      host.close();
      this.createProfile();
    });
    listView.appendChild(newProfileRow);

    return {
      root: clip,
      onShown: () => fitTo(listView),
      // 詳細画面が出ているか / 一覧へ戻す(アプリケーションメニューの見出しの「<」から使う)
      isDetailShown: () => detailShown,
      backToList: showListView,
    };
  },
  // ---- アプリケーションメニュー(≡)のいちばん上のプロファイルの行 ----
  // 同期の行の下に「いま使っているプロファイル(アイコンと名前) >」の行を置き、押すとメニューの中で
  // プロファイルの一覧(サブビュー)に切り替わる。一覧から選ぶと、そのプロファイルで起動する。
  // メニューの中身は開くたびに作り直される場合があるので、ViewShowing のたびに無ければ足し、
  // 名前とアイコンもそのたびに描き直す。
  addAppMenu(win) {
    if (win.__floorpLauncherAppMenuHooked) return;
    win.__floorpLauncherAppMenuHooked = true;
    win.document.addEventListener('ViewShowing', (event) => {
      try {
        const view = event.target;
        // Floorp は appMenu-mainView、Firefox は appMenu-protonMainView
        if (view && (view.id === 'appMenu-mainView' || view.id === 'appMenu-protonMainView')) {
          this.updateAppMenuRow(win, view);
        } else if (view && view.id === 'floorp-launcher-profiles-view') {
          this.fillProfilesView(win, view);
        }
      } catch (e) {
        this.logError('appMenu', e);
      }
    }, true);
  },
  ensureAppMenuStyle(doc) {
    if (doc.getElementById('floorp-launcher-appmenu-style')) return;
    const style = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    style.id = 'floorp-launcher-appmenu-style';
    // アイコンはプロファイルのアバター(丸)。いちばん上の行は大きめにする
    style.textContent =
      '#floorp-launcher-appmenu-profile > .toolbarbutton-icon { width: 24px; height: 24px; border-radius: 50%; }' +
      '#floorp-launcher-appmenu-profile > .toolbarbutton-text { font-weight: 600; }' +
      '';
    doc.documentElement.appendChild(style);
  },
  updateAppMenuRow(win, view) {
    const doc = win.document;
    this.ensureAppMenuStyle(doc);
    let row = doc.getElementById('floorp-launcher-appmenu-profile');
    if (!row) {
      row = doc.createXULElement('toolbarbutton');
      row.id = 'floorp-launcher-appmenu-profile';
      // subviewbutton-nav: 右端に「>」が付き、押すとサブビューへ進む見た目になる
      row.className = 'subviewbutton subviewbutton-iconic subviewbutton-nav';
      row.setAttribute('closemenu', 'none');
      row.setAttribute('tooltiptext', floorpLauncherL('プロファイルを切り替え', 'Switch profile'));
      row.addEventListener('command', () => {
        try {
          this.openProfilesView(win, row);
        } catch (e) {
          this.logError('openProfilesView', e);
        }
      });
      const sep = doc.createXULElement('toolbarseparator');
      sep.id = 'floorp-launcher-appmenu-separator';
      // 同期の行とその下の区切りの間に「区切り・プロファイルの行」を入れる
      const fxaSep = view.querySelector('#appMenu-fxa-separator');
      if (fxaSep && fxaSep.parentNode) {
        fxaSep.before(sep, row);
      } else {
        const body = view.querySelector('.panel-subview-body') || view;
        body.prepend(row, sep);
      }
    }
    const name = this.getProfileName() || floorpLauncherL('(不明なプロファイル)', '(unknown profile)');
    row.setAttribute('label', name);
    this.renderAvatar(win, name, this.getCurrentProfileDir(), 48, (dataUri) => {
      row.style.listStyleImage = 'url("' + dataUri + '")';
    });
  },
  openProfilesView(win, anchor) {
    const doc = win.document;
    const VIEW_ID = 'floorp-launcher-profiles-view';
    if (!doc.getElementById(VIEW_ID)) {
      const view = doc.createXULElement('panelview');
      view.id = VIEW_ID;
      view.className = 'PanelUI-subView';
      // 見出し(「<」で戻るボタン付き)は PanelMultiView が title から作る
      view.setAttribute('title', floorpLauncherL('プロファイル', 'Profiles'));
      const body = doc.createXULElement('vbox');
      body.className = 'panel-subview-body';
      view.appendChild(body);
      const multiView = doc.getElementById('appMenu-multiView');
      (multiView || doc.getElementById('appMenu-viewCache') || doc.documentElement).appendChild(view);
    }
    win.PanelUI.showSubView(VIEW_ID, anchor);
  },
  // サブビューの中身(開くたびに作り直す)。ツールバーのボタンのパネルと同じもの(buildProfileUI)
  fillProfilesView(win, view) {
    const doc = win.document;
    const body = view.querySelector('.panel-subview-body');
    while (body.firstChild) body.removeChild(body.firstChild);
    // 幅はメニューの本体に合わせる(メニューの幅はメインの画面で決まっている)
    const main = doc.getElementById('appMenu-mainView') || doc.getElementById('appMenu-protonMainView');
    const width = main ? Math.round(main.getBoundingClientRect().width) : 0;
    const ui = this.buildProfileUI(win, {
      close: () => {
        try {
          win.PanelUI.hide();
        } catch (e) {
          this.logError('PanelUI.hide', e);
        }
      },
      onHidden: (fn) => view.addEventListener('ViewHiding', fn, { once: true }),
      width: width > 0 ? width : 0,
      hideBack: true,
    });
    body.appendChild(ui.root);
    view.addEventListener('ViewShown', ui.onShown, { once: true });
    // 見出しの「<」: 詳細画面が出ているときは一覧へ戻す(メニューの前の画面へは戻らない)。
    // 一覧のときはいつもどおりメニューへ戻る。見出しは PanelMultiView が作るので、ビューで capture して見る
    view.__floorpLauncherUi = ui;
    if (!view.__floorpLauncherBackHooked) {
      view.__floorpLauncherBackHooked = true;
      view.addEventListener('command', (e) => {
        try {
          const cur = view.__floorpLauncherUi;
          if (e.target.classList && e.target.classList.contains('subviewbutton-back') && cur && cur.isDetailShown()) {
            e.preventDefault();
            e.stopPropagation();
            cur.backToList();
          }
        } catch (ex) {
          this.logError('appMenuBack', ex);
        }
      }, true);
    }
  },
  getProfileDir(folder) {
    const dir = this.getLauncherRoot();
    dir.append('data');
    dir.append('profile');
    dir.append(folder);
    return dir;
  },
  getCurrentProfileDir() {
    return Services.dirsvc.get('ProfD', Ci.nsIFile);
  },
  getProfileIconInfo(dir) {
    // Returns { kind: 'image', url } | { kind: 'emoji', text } |
    // null. No metadata file tracks which icon is 'current' -
    // instead every file named launcher-icon.* in the profile
    // dir is a candidate (an image, or a tiny .emoji text file)
    // and the most recently *set* one wins. This avoids ever
    // having to delete the previous icon file when the user
    // picks a new one (this launcher's project rules forbid
    // deleting anything under a profile's own data directory),
    // at the minor cost of leaving old icon files behind.
    try {
      if (!dir.exists() || !dir.isDirectory()) return null;
      let best = null;
      let bestTime = -1;
      const entries = dir.directoryEntries;
      while (entries.hasMoreElements()) {
        const entry = entries.getNext().QueryInterface(Ci.nsIFile);
        if (entry.isFile() && /^launcher-icon[.-]/i.test(entry.leafName)) {
          // The Date.now() embedded in our own filename (see
          // setIconForProfile/setEmojiForProfile), not
          // lastModifiedTime - confirmed by testing that
          // nsIFile.copyTo() preserves the *source* image's own
          // original modification time on Windows rather than
          // stamping the copy with "now", so an old photo could
          // otherwise lose to a just-set emoji every time even
          // though it was picked more recently. Falls back to
          // lastModifiedTime only for a filename that doesn't
          // carry a parseable timestamp (e.g. a manually dropped
          // launcher-icon.png).
          const m = /^launcher-icon-(\d+)/i.exec(entry.leafName);
          const t = m ? parseInt(m[1], 10) : entry.lastModifiedTime;
          if (t > bestTime) { bestTime = t; best = entry; }
        }
      }
      if (!best) return null;
      if (/\.emoji$/i.test(best.leafName)) {
        const text = this.readTextFile(best);
        return text ? { kind: 'emoji', text: text.trim() } : null;
      }
      // version はアイコン画像の覚えておき(getPhotoAvatar)の見分けに使う。手で置いた
      // launcher-icon.png を同じ名前で差し替えたときも、更新日時が変われば描き直す
      return { kind: 'image', url: Services.io.newFileURI(best).spec, version: best.lastModifiedTime };
    } catch (e) { return null; }
  },
  profileColor(name) {
    // Deterministic hash -> hue, so each profile always gets the
    // same fallback avatar color across launches without having
    // to store it anywhere.
    let h = 0;
    for (let i = 0; i < name.length; i++) { h = (h * 31 + name.charCodeAt(i)) >>> 0; }
    return 'hsl(' + (h % 360) + ', 55%, 45%)';
  },
  drawCenteredGlyph(ctx, text, cx, cy) {
    // textBaseline:'middle' centers on the FONT's declared ascent/
    // descent metrics, which reserve room for descenders (g, y, ...)
    // that a single uppercase initial or most emoji never use - so the
    // glyph visually sits noticeably above center, and worse the
    // larger the icon is rendered (this draws the same 26px list-row
    // avatar, 48px toolbar icon, and 208px detail avatar, all from one
    // size parameter). A flat +1px nudge doesn't scale with that, which
    // is why it looked fine small and off at the bigger sizes -
    // confirmed from a user screenshot of the toolbar button's "M".
    // measureText()'s actualBoundingBox* reports the real rendered
    // glyph's ink extents, so centering on that instead of the font's
    // metrics keeps it visually centered at every size.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(text);
    const ascent = m.actualBoundingBoxAscent || 0;
    const descent = m.actualBoundingBoxDescent || 0;
    ctx.fillText(text, cx, cy + (ascent - descent) / 2);
  },
  renderFallbackAvatar(win, name, size) {
    // A solid-color circle with the profile's first character,
    // in the same spirit as Firefox's own profile avatars - used
    // until/unless the user sets a custom photo or emoji.
    try {
      const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = this.profileColor(name);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold ' + Math.round(size * 0.5) + 'px sans-serif';
      this.drawCenteredGlyph(ctx, (name.charAt(0) || '?').toUpperCase(), size / 2, size / 2);
      return canvas.toDataURL('image/png');
    } catch (e) { return ''; }
  },
  renderEmojiAvatar(win, name, emoji, size) {
    try {
      const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = this.profileColor(name);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = Math.round(size * 0.58) + 'px "Segoe UI Emoji", sans-serif';
      this.drawCenteredGlyph(ctx, emoji, size / 2, size / 2);
      return canvas.toDataURL('image/png');
    } catch (e) { return ''; }
  },
  renderPhotoAvatar(win, fileUrl, size) {
    // Crops/scales an arbitrary user-picked image into the same
    // circular shape as the fallback, so every profile row looks
    // consistent regardless of the source image's own shape.
    return new Promise((resolve) => {
      try {
        const img = new win.Image();
        img.onload = () => {
          try {
            const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.save();
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
            ctx.clip();
            const scale = Math.max(size / img.width, size / img.height);
            const dw = img.width * scale;
            const dh = img.height * scale;
            ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
            ctx.restore();
            resolve(canvas.toDataURL('image/png'));
          } catch (e) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = fileUrl;
      } catch (e) { resolve(null); }
    });
  },
  // 画像アイコンを描いた結果(data URI)を「画像ファイルの URL|更新日時|サイズ」ごとに覚えておく。
  // アイコンを変えると画像ファイル名(launcher-icon-<時刻>)も変わるので、古い画像は出ない。
  AVATAR_CACHE_MAX: 64,
  getPhotoAvatar(win, url, size, version) {
    if (!this._avatarCache) this._avatarCache = new Map();
    if (!this._avatarPending) this._avatarPending = new Map();
    const key = url + '|' + (version || 0) + '|' + size;
    const cached = this._avatarCache.get(key);
    if (cached) return { cached };
    // 同じ画像を同時に何度も描かない(行にマウスを乗せたときの先読みとクリックが重なる)
    let pending = this._avatarPending.get(key);
    if (!pending) {
      pending = this.renderPhotoAvatar(win, url, size).then((dataUri) => {
        this._avatarPending.delete(key);
        // 読めなかったときは覚えない(次に開いたときにもう一度試す)
        if (dataUri) {
          if (this._avatarCache.size >= this.AVATAR_CACHE_MAX) {
            this._avatarCache.delete(this._avatarCache.keys().next().value);
          }
          this._avatarCache.set(key, dataUri);
        }
        return dataUri;
      });
      this._avatarPending.set(key, pending);
    }
    return { pending };
  },
  // 詳細画面を開く前に大きい画像を描いておく(一覧の行にマウスを乗せたとき)
  prewarmAvatar(win, dir, size) {
    try {
      const info = this.getProfileIconInfo(dir);
      if (info && info.kind === 'image') this.getPhotoAvatar(win, info.url, size, info.version);
    } catch (e) {
      this.logError('prewarmAvatar', e);
    }
  },
  renderAvatar(win, name, dir, size, applyFn) {
    // 絵文字と文字のアイコンはすぐ描けるのでそのまま出す。
    // 画像のアイコンは、先に文字のアイコンを出すと画像に替わるまでの一瞬それが見えてしまう
    // (詳細画面を開くたびに目立った)ので、画像ができるまで何も出さず、読めなかったときだけ
    // 文字のアイコンにする。描いたものは覚えておき、2 回目からはすぐ出す。
    const info = this.getProfileIconInfo(dir);
    if (info && info.kind === 'emoji') {
      applyFn(this.renderEmojiAvatar(win, name, info.text, size));
      return;
    }
    if (info && info.kind === 'image') {
      const r = this.getPhotoAvatar(win, info.url, size, info.version);
      if (r.cached) {
        applyFn(r.cached);
        return;
      }
      r.pending.then((dataUri) => {
        if (!dataUri) this.logError('renderAvatar', 'アイコン画像を読めませんでした: ' + info.url);
        applyFn(dataUri || this.renderFallbackAvatar(win, name, size));
      });
      return;
    }
    applyFn(this.renderFallbackAvatar(win, name, size));
  },
  refreshToolbarButtonIcon(win) {
    // The toolbar button's own icon is otherwise only ever drawn once,
    // in onCreated - without this, setting a new icon/emoji for the
    // *current* profile only showed up after restarting Floorp, even
    // though the menu itself already always shows the latest one (it
    // re-renders from scratch on every open). Called after a successful
    // save, only when the profile just edited is the one this window is
    // actually running as.
    try {
      const doc = win.document;
      const node = doc.getElementById('floorp-launcher-profile-switcher');
      if (!node) return;
      const name = this.getProfileName() || '?';
      this.renderAvatar(win, name, this.getCurrentProfileDir(), 48, (dataUri) => {
        node.style.listStyleImage = 'url("' + dataUri + '")';
      });
    } catch (e) { }
  },
  setIconForProfile(name, dir) {
    try {
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const fp = Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker);
      fp.init(win.browsingContext, floorpLauncherL('プロファイル「' + name + '」の画像を選択', 'Choose an image for profile "' + name + '"'), Ci.nsIFilePicker.modeOpen);
      fp.appendFilter(floorpLauncherL('画像ファイル', 'Images'), '*.png; *.jpg; *.jpeg; *.gif; *.svg; *.webp');
      fp.open((result) => {
        if (result !== Ci.nsIFilePicker.returnOK && result !== Ci.nsIFilePicker.returnReplace) return;
        try {
          const src = fp.file;
          const dot = src.leafName.lastIndexOf('.');
          const ext = dot >= 0 ? src.leafName.slice(dot) : '';
          // Timestamped filename - see getProfileIconInfo for why
          // this never overwrites/deletes the previous icon file.
          src.copyTo(dir, 'launcher-icon-' + Date.now() + ext);
          if (dir.equals(this.getCurrentProfileDir())) {
            this.refreshToolbarButtonIcon(win);
          }
        } catch (e) {
          // Reported to the user directly, not just logged - this exact
          // path (setting the *current* profile's own image) was hard
          // to reproduce, so surfacing the real error immediately beats
          // asking the user to go dig up floorp-launcher-debug.log.
          this.logError('setIconForProfile-copy', e);
          try { Services.prompt.alert(win, floorpLauncherL('画像の設定に失敗しました', "Couldn't Set the Image"), String(e)); } catch (e2) { }
        }
      });
    } catch (e) {
      this.logError('setIconForProfile', e);
      try {
        const win2 = Services.wm.getMostRecentWindow('navigator:browser');
        Services.prompt.alert(win2, floorpLauncherL('画像の設定に失敗しました', "Couldn't Set the Image"), String(e));
      } catch (e2) { }
    }
  },
  setEmojiForProfile(name, dir) {
    try {
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const input = { value: '' };
      const ok = Services.prompt.prompt(
        win,
        floorpLauncherL('プロファイル「' + name + '」の絵文字', 'Emoji for profile "' + name + '"'),
        floorpLauncherL('絵文字を1つ入力してください(Windowsは Win+. で絵文字パネルを開けます)', 'Enter one emoji (on Windows, Win+. opens the emoji panel)'),
        input,
        null,
        { value: false }
      );
      if (!ok) return;
      const emoji = (input.value || '').trim();
      if (!emoji) return;
      // Timestamped filename - see getProfileIconInfo for why this
      // never overwrites/deletes any previous icon file.
      const file = dir.clone();
      file.append('launcher-icon-' + Date.now() + '.emoji');
      const foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
      foStream.init(file, 0x02 | 0x08 | 0x20, 0o666, 0);
      const converter = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
      converter.init(foStream, 'UTF-8');
      converter.writeString(emoji);
      converter.close();
      if (dir.equals(this.getCurrentProfileDir())) {
        this.refreshToolbarButtonIcon(win);
      }
    } catch (e) {
      this.logError('setEmojiForProfile', e);
    }
  },
  saveProfilesMap(map) {
    // Mirrors ProfileMap.Save()'s exact format in Program.cs (a flat
    // {"name": "folder"} map, comma-newline separated, no trailing
    // comma) so the C# side's own regex-based reader keeps parsing
    // whatever this writes without needing any format change there.
    const f = this.getLauncherRoot();
    f.append('data');
    f.append('profiles.json');
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const keys = Object.keys(map);
    let text = '{\r\n';
    text += keys.map((k) => '  "' + esc(k) + '": "' + esc(map[k]) + '"').join(',\r\n');
    text += '\r\n}\r\n';
    const foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    foStream.init(f, 0x02 | 0x08 | 0x20, 0o666, 0);
    const converter = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
    converter.init(foStream, 'UTF-8');
    converter.writeString(text);
    converter.close();
  },
  // ---- 既定のプロファイル(floorp-launcher.json の "profile")----
  // ランチャー(LauncherConfig.cs)と同じく "profile" の値だけを正規表現で読む。
  // ファイルが無い・値が空なら "default"(LauncherConfig.Profile の初期値と同じ)。
  getLauncherConfigFile() {
    const f = this.getLauncherRoot();
    f.append('floorp-launcher.json');
    return f;
  },
  getDefaultProfileName() {
    try {
      const text = this.readTextFile(this.getLauncherConfigFile());
      if (text) {
        const m = /"profile"\s*:\s*"([^"]*)"/.exec(text);
        if (m && m[1]) return m[1];
      }
    } catch (e) {
      this.logError('getDefaultProfileName', e);
    }
    return 'default';
  },
  // "profile" の値だけを書き換え、ほかの設定・書き方・コメントはそのまま残す。
  // 失敗したら例外を投げる(呼び出し側で知らせる)。
  writeDefaultProfileName(name) {
    // 検証済みの名前には " と \ が入らないので、JSON の文字列としてそのまま書ける
    const invalid = this.validateProfileName(name);
    if (invalid) throw new Error('使えない名前です: ' + invalid);
    const f = this.getLauncherConfigFile();
    const old = this.readTextFile(f);
    let text;
    if (old === null) {
      text = '{\r\n  "profile": "' + name + '"\r\n}\r\n';
    } else if (/"profile"\s*:\s*"[^"]*"/.test(old)) {
      text = old.replace(/("profile"\s*:\s*)"[^"]*"/, (all, key) => key + '"' + name + '"');
    } else {
      // "profile" が無いときは最初の { の直後に足す。中身が空の {} ならカンマを付けない
      const brace = old.indexOf('{');
      if (brace < 0) throw new Error('floorp-launcher.json の形式が読めません(先頭の { が見つかりません)');
      const rest = old.slice(brace + 1);
      const empty = /^\s*}/.test(rest);
      text = old.slice(0, brace + 1) + '\r\n  "profile": "' + name + '"' + (empty ? '\r\n' : ',') + rest;
    }
    // 途中で失敗しても元のファイルが壊れないよう、safe-file-output-stream で書く
    // (一時ファイルに書いてから finish() で置き換える)
    const fos = Cc['@mozilla.org/network/safe-file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
    fos.init(f, 0x02 | 0x08 | 0x20, 0o666, 0);
    const converter = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
    converter.init(fos, 'UTF-8');
    converter.writeString(text);
    converter.flush();
    fos.QueryInterface(Ci.nsISafeOutputStream).finish();
  },
  setDefaultProfile(name) {
    let win;
    try {
      win = Services.wm.getMostRecentWindow('navigator:browser');
      this.writeDefaultProfileName(name);
      Services.prompt.alert(win, floorpLauncherL('既定のプロファイル', 'Default Profile'),
        floorpLauncherL('既定のプロファイルを「' + name + '」にしました。\n次に Floorp-Launcher.exe から起動したときに使われます。',
          '"' + name + '" is now the default profile.\nIt will be used the next time Floorp-Launcher.exe starts.'));
    } catch (e) {
      this.logError('setDefaultProfile', e);
      try {
        Services.prompt.alert(win, floorpLauncherL('既定のプロファイルを変更できませんでした', "Couldn't Change the Default Profile"),
          floorpLauncherL('floorp-launcher.json に書き込めませんでした。何も変更していません。\n', "Couldn't write floorp-launcher.json. Nothing was changed.\n") + String(e));
      } catch (e2) { }
    }
  },
  // Program.cs の IsSafePathComponent と同じ規則。新規作成時は名前がそのまま
  // フォルダ名の一部になるため、パス区切りや末尾ピリオド("..")を許すと
  // data\profile\ の外を指せてしまう。返り値はエラー理由(問題なければ null)。
  validateProfileName(name) {
    if (!name) return floorpLauncherL('名前が空です。', 'The name is empty.');
    if (name !== name.trim()) return floorpLauncherL('先頭・末尾に空白は使えません。', "Leading or trailing spaces aren't allowed.");
    if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return floorpLauncherL('次の文字は使えません: \\ / : * ? " < > | (および制御文字)', 'These characters aren\'t allowed: \\ / : * ? " < > | (and control characters)');
    if (name.endsWith('.')) return floorpLauncherL('末尾にピリオドは使えません。', "A trailing period isn't allowed.");
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return floorpLauncherL('Windowsの予約名(CON, NUL, COM1 など)は使えません。', "Windows reserved names (CON, NUL, COM1, ...) aren't allowed.");
    return null;
  },
  createProfile() {
    // Deliberately doesn't create the profile directory itself -
    // Floorp-Launcher.exe --launch-profile <name> already creates a
    // fresh profile whenever the name doesn't exist yet (the same
    // path the picker dialog and this switcher's own 'launch' action
    // use), so reuse that instead of a second implementation here.
    let win;
    try {
      win = Services.wm.getMostRecentWindow('navigator:browser');
      const input = { value: '' };
      const ok = Services.prompt.prompt(win, floorpLauncherL('新しいプロファイル', 'New Profile'), floorpLauncherL('プロファイル名を入力してください', 'Enter a profile name'), input, null, { value: false });
      if (!ok) return;
      const name = (input.value || '').trim();
      if (!name) return;
      const invalid = this.validateProfileName(name);
      if (invalid) {
        Services.prompt.alert(win, floorpLauncherL('エラー', 'Error'), floorpLauncherL('このプロファイル名は使用できません。\n', "This profile name can't be used.\n") + invalid);
        return;
      }
      const map = this.getProfilesMap();
      if (map[name]) {
        Services.prompt.alert(win, floorpLauncherL('エラー', 'Error'), floorpLauncherL('その名前のプロファイルは既に存在します', 'A profile with that name already exists'));
        return;
      }
      this.launch(name);
    } catch (e) {
      this.logError('createProfile', e);
    }
  },
  // ---- userChrome.js ローダー(onemen 氏の utils.zip)の導入 ----
  //
  // 入口の config.js はランチャーが書くので、入れるのはプロファイルの
  // chrome\utils\ だけでよい。入手先・検証方法はローダー自身の更新機能
  // (utils\updater\scriptsUpdater.sys.mjs)と同じにしてある:
  //   - hashes.json の utils.hash と、zip 内の各ファイルから計算した
  //     SHA-256(相対パスを大文字小文字を無視して並べ、path + "\n" と中身を順に)を比べる
  //   - 同じホストから取るので、守れるのは壊れた・途中で切れたダウンロードまで。
  //     作者のサイト自体が改ざんされた場合は防げない(更新機能も同じ条件)
  LOADER_HASHES_URL: 'https://onemen.github.io/firefox-scripts/hashes.json',
  LOADER_ZIP_URL: 'https://onemen.github.io/firefox-scripts/utils.zip',

  hasLoader(dir) {
    const f = dir.clone();
    f.append('chrome');
    f.append('utils');
    f.append('userChrome.js');
    return f.exists();
  },

  // userscripts の rebuild_userChrome.uc.js が about:userchromejs を登録していれば true
  hasScriptManager() {
    try {
      return Components.manager.QueryInterface(Ci.nsIComponentRegistrar)
        .isContractIDRegistered('@mozilla.org/network/protocol/about;1?what=userchromejs');
    } catch (e) {
      this.logError('hasScriptManager', e);
      return false;
    }
  },

  // 開いていればそのタブへ、無ければ新しいタブで開く
  openScriptManager(win) {
    try {
      win.switchToTabHavingURI('about:userchromejs', true);
    } catch (e) {
      this.logError('openScriptManager', e);
    }
  },

  // hashes.json と同じ並び順(ASCII の大文字だけを小文字扱いで比べ、同じなら短い方→元のバイト順)
  compareLoaderHashOrder(a, b) {
    const fa = new TextEncoder().encode(a);
    const fb = new TextEncoder().encode(b);
    const len = Math.min(fa.length, fb.length);
    for (let i = 0; i < len; i++) {
      const ca = fa[i] >= 65 && fa[i] <= 90 ? fa[i] + 32 : fa[i];
      const cb = fb[i] >= 65 && fb[i] <= 90 ? fb[i] + 32 : fb[i];
      if (ca !== cb) return ca - cb;
    }
    if (fa.length !== fb.length) return fa.length - fb.length;
    for (let i = 0; i < len; i++) {
      if (fa[i] !== fb[i]) return fa[i] - fb[i];
    }
    return 0;
  },

  readZipEntryBytes(zipReader, entryName) {
    const input = zipReader.getInputStream(entryName);
    try {
      const bin = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
      bin.setInputStream(input);
      const count = input.available();
      const data = new ArrayBuffer(count);
      bin.readArrayBuffer(count, data);
      return new Uint8Array(data);
    } finally {
      input.close();
    }
  },

  // zip の中身を検証して、ファイル名→中身の Map を返す。おかしければ例外
  verifyLoaderZip(zipPath, manifest) {
    const files = manifest.files;
    if (!Array.isArray(files) || !files.length || typeof manifest.hash !== 'string') {
      throw new Error('hashes.json の形式が想定と違います');
    }
    const zipFile = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
    zipFile.initWithPath(zipPath);
    const zipReader = Cc['@mozilla.org/libjar/zip-reader;1'].createInstance(Ci.nsIZipReader);
    zipReader.open(zipFile);
    try {
      const listed = new Set(files);
      const contents = new Map();
      for (const entryName of zipReader.findEntries('*?*')) {
        if (zipReader.getEntry(entryName).isDirectory) continue;
        // 一覧に無いファイル(パスを使った書き込み先の細工を含む)が混ざっていたら受け付けない
        if (!listed.has(entryName)) {
          throw new Error('想定外のファイルが含まれています: ' + entryName);
        }
        contents.set(entryName, this.readZipEntryBytes(zipReader, entryName));
      }
      const hasher = Cc['@mozilla.org/security/hash;1'].createInstance(Ci.nsICryptoHash);
      hasher.init(Ci.nsICryptoHash.SHA256);
      const encoder = new TextEncoder();
      for (const rel of [...files].sort((a, b) => this.compareLoaderHashOrder(a, b))) {
        const pathBytes = encoder.encode(rel + '\n');
        hasher.update(pathBytes, pathBytes.length);
        const bytes = contents.get(rel);
        if (!bytes) {
          throw new Error('必要なファイルがありません: ' + rel);
        }
        hasher.update(bytes, bytes.length);
      }
      const binary = atob(hasher.finish(true));
      let hex = '';
      for (let i = 0; i < binary.length; i++) {
        hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
      }
      if (hex !== manifest.hash.toLowerCase()) {
        throw new Error('ダウンロードしたファイルのハッシュ値が一致しません');
      }
      return contents;
    } finally {
      zipReader.close();
    }
  },

  async installLoader(name, dir, isCurrent) {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    if (this.hasLoader(dir)) {
      Services.prompt.alert(win, floorpLauncherL('userChrome.js ローダー', 'userChrome.js Loader'), floorpLauncherL('「' + name + '」には、すでにローダーが入っています。', '"' + name + '" already has the loader.'));
      return;
    }
    const ok = Services.prompt.confirm(win, floorpLauncherL('userChrome.js ローダーを入れる', 'Install userChrome.js Loader'),
      floorpLauncherL('「' + name + '」に userChrome.js ローダーを入れますか?\n\n' +
        '作者(onemen 氏)のサイトから最新版をダウンロードして、\n' +
        'プロファイルの chrome\\utils\\ に置きます。',
      'Install the userChrome.js loader into "' + name + '"?\n\n' +
        'The latest version is downloaded from the author\'s (onemen) site\n' +
        'and placed in the profile\'s chrome\\utils\\ folder.'));
    if (!ok) return;

    const chromeDir = PathUtils.join(dir.path, 'chrome');
    const utilsDir = PathUtils.join(chromeDir, 'utils');
    const stamp = Date.now();
    const zipPath = PathUtils.join(PathUtils.tempDir, 'floorp-launcher-utils-' + stamp + '.zip');
    // いったん隣の作業用フォルダに展開してから名前を変える(途中で失敗しても utils\ が半端に残らない)
    const stagingDir = PathUtils.join(chromeDir, 'utils.floorp-launcher-' + stamp);
    let loaderDate = '';
    try {
      // 中身のある utils\ は、別の版のローダーかもしれないので上書きしない
      if (await IOUtils.exists(utilsDir)) {
        const children = await IOUtils.getChildren(utilsDir);
        if (children.length) {
          throw new Error('chrome\\utils\\ に別のファイルが入っているため、上書きしませんでした。');
        }
        await IOUtils.remove(utilsDir);
      }

      const hashesRes = await fetch(this.LOADER_HASHES_URL, { cache: 'no-store' });
      if (!hashesRes.ok) throw new Error('hashes.json を取得できませんでした (HTTP ' + hashesRes.status + ')');
      const manifest = (await hashesRes.json()).utils;
      if (!manifest) throw new Error('hashes.json に utils の情報がありません');
      loaderDate = typeof manifest.date === 'string' ? manifest.date : '';

      const zipRes = await fetch(this.LOADER_ZIP_URL, { cache: 'no-store' });
      if (!zipRes.ok) throw new Error('utils.zip を取得できませんでした (HTTP ' + zipRes.status + ')');
      await IOUtils.write(zipPath, new Uint8Array(await zipRes.arrayBuffer()));

      const contents = this.verifyLoaderZip(zipPath, manifest);

      for (const [rel, bytes] of contents) {
        const target = PathUtils.join(stagingDir, ...rel.split('/'));
        await IOUtils.makeDirectory(PathUtils.parent(target), { createAncestors: true, ignoreExisting: true });
        await IOUtils.write(target, bytes);
      }
      await IOUtils.move(stagingDir, utilsDir, { noOverwrite: true });
    } catch (e) {
      this.logError('installLoader', e);
      try { await IOUtils.remove(stagingDir, { recursive: true, ignoreAbsent: true }); } catch (e2) { this.logError('installLoader:cleanup', e2); }
      try { await IOUtils.remove(zipPath, { ignoreAbsent: true }); } catch (e3) { this.logError('installLoader:cleanup', e3); }
      Services.prompt.alert(win, floorpLauncherL('ローダーを入れられませんでした', "Couldn't Install the Loader"),
        String(e && e.message ? e.message : e) + floorpLauncherL('\n\n何も変更していません。手で入れる方法は extras\\README.md を見てください。',
          '\n\nNothing was changed. See extras\\README.md to install it manually.'));
      return;
    }
    try { await IOUtils.remove(zipPath, { ignoreAbsent: true }); } catch (e) { this.logError('installLoader:cleanup', e); }

    if (!isCurrent) {
      Services.prompt.alert(win, floorpLauncherL('userChrome.js ローダー', 'userChrome.js Loader'),
        floorpLauncherL('「' + name + '」にローダーを入れました(' + (loaderDate || '最新版') + ')。\n' +
          '次にこのプロファイルを起動したときから有効になります。\n' +
          '(いま起動中なら、そのウィンドウで Floorp を再起動してください)',
        'Installed the loader into "' + name + '" (' + (loaderDate || 'latest') + ').\n' +
          'It takes effect the next time this profile starts.\n' +
          '(If it is running now, restart Floorp in that window.)'));
      return;
    }
    const restart = Services.prompt.confirm(win, floorpLauncherL('userChrome.js ローダー', 'userChrome.js Loader'),
      floorpLauncherL('ローダーを入れました。有効にするには Floorp の再起動が必要です。\n今すぐ再起動しますか?(開いているタブは元に戻ります)',
        'The loader is installed. Floorp needs a restart to enable it.\nRestart now? (Open tabs will be restored.)'));
    if (restart) this.restartBrowser();
  },

  // Floorp 自身の再起動(メニューの再起動と同じ)。起動オプション・環境変数は引き継がれ、
  // ランチャーは parent.lock を見て待ち続ける
  restartBrowser() {
    try {
      const cancelQuit = Cc['@mozilla.org/supports-PRBool;1'].createInstance(Ci.nsISupportsPRBool);
      Services.obs.notifyObservers(cancelQuit, 'quit-application-requested', 'restart');
      // 「タブを閉じますか?」などで取り消されたら何もしない
      if (cancelQuit.data) return;
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    } catch (e) {
      this.logError('restartBrowser', e);
    }
  },

  applyProfileRename(oldName, dir, newName) {
    // No prompt here - the caller (the inline pencil-edit input next
    // to the profile name in the detail view) already collected
    // newName itself; this just does the actual filesystem/mapping
    // work, so it can also be reused by anything else that ever
    // wants to rename a profile programmatically.
    let win;
    try {
      win = Services.wm.getMostRecentWindow('navigator:browser');
      const invalid = this.validateProfileName(newName);
      if (invalid) {
        Services.prompt.alert(win, floorpLauncherL('エラー', 'Error'), floorpLauncherL('このプロファイル名は使用できません。\n', "This profile name can't be used.\n") + invalid);
        return false;
      }
      const map = this.getProfilesMap();
      if (map[newName]) {
        Services.prompt.alert(win, floorpLauncherL('エラー', 'Error'), floorpLauncherL('その名前は既に使われています', 'That name is already in use'));
        return false;
      }
      const folder = map[oldName];
      if (!folder) return false;
      // Rebuilt key-by-key rather than delete-then-add, because the
      // key order in profiles.json *is* the user's chosen list order
      // now - a plain delete/add would silently move every renamed
      // profile to the bottom of their list.
      const next = {};
      for (const k of Object.keys(map)) {
        if (k === oldName) next[newName] = folder;
        else next[k] = map[k];
      }
      // 既定のプロファイルの名前を変えたら floorp-launcher.json も合わせる。
      // 古い名前のままだと、次の起動でその名前の空のプロファイルが作られてしまう。
      // profiles.json より先に書く(失敗したら名前の変更自体をやめ、食い違いを残さない)
      if (oldName === this.getDefaultProfileName()) {
        try {
          this.writeDefaultProfileName(newName);
        } catch (e) {
          this.logError('applyProfileRename:writeDefaultProfileName', e);
          Services.prompt.alert(win, floorpLauncherL('名前の変更に失敗しました', "Couldn't Rename"),
            floorpLauncherL('このプロファイルは既定のプロファイルですが、floorp-launcher.json に書き込めませんでした。何も変更していません。\n',
              "This is the default profile, but floorp-launcher.json couldn't be written. Nothing was changed.\n") + String(e));
          return false;
        }
      }
      this.saveProfilesMap(next);
      // Keep profile-name.txt (the window-title suffix / getProfileName()
      // source) in sync too - safe to always rewrite, it only ever
      // holds this one plain-text name.
      const marker = dir.clone();
      marker.append('profile-name.txt');
      const foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
      foStream.init(marker, 0x02 | 0x08 | 0x20, 0o666, 0);
      const converter = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
      converter.init(foStream, 'UTF-8');
      converter.writeString(newName);
      converter.close();
      // If the profile we just renamed is the one THIS session is
      // actually running as, every already-open browser window's
      // title bar was tagged from the old name at startup and would
      // otherwise stay stale until the app restarts - re-tag them all
      // right now instead (tagTitle re-reads getProfileName(), which
      // now returns newName since profile-name.txt was just rewritten
      // above).
      if (dir.equals(this.getCurrentProfileDir())) {
        const enumerator = Services.wm.getEnumerator('navigator:browser');
        while (enumerator.hasMoreElements()) {
          const w = enumerator.getNext();
          try {
            this.tagTitle(w);
          } catch (e) {
            this.logError('applyProfileRename:tagTitle', e);
          }
        }
      }
      return true;
    } catch (e) {
      this.logError('applyProfileRename', e);
      try { Services.prompt.alert(win, floorpLauncherL('名前の変更に失敗しました', "Couldn't Rename"), String(e)); } catch (e2) { }
      return false;
    }
  },
  duplicateProfile(name, dir) {
    let win;
    try {
      win = Services.wm.getMostRecentWindow('navigator:browser');
      const input = { value: floorpLauncherL(name + 'のコピー', name + ' copy') };
      const ok = Services.prompt.prompt(win, floorpLauncherL('プロファイルを複製', 'Duplicate Profile'), floorpLauncherL('複製後の名前を入力してください', 'Enter a name for the copy'), input, null, { value: false });
      if (!ok) return;
      const newName = (input.value || '').trim();
      if (!newName) return;
      const invalid = this.validateProfileName(newName);
      if (invalid) {
        Services.prompt.alert(win, floorpLauncherL('エラー', 'Error'), floorpLauncherL('このプロファイル名は使用できません。\n', "This profile name can't be used.\n") + invalid);
        return;
      }
      const map = this.getProfilesMap();
      if (map[newName]) {
        Services.prompt.alert(win, floorpLauncherL('エラー', 'Error'), floorpLauncherL('その名前は既に使われています', 'That name is already in use'));
        return;
      }
      const profileParent = this.getLauncherRoot();
      profileParent.append('data');
      profileParent.append('profile');
      const newFolderName = dir.leafName + '-copy-' + Date.now();
      // nsIFile.copyTo() on a directory recursively copies its whole
      // contents - this is synchronous and can take a noticeable
      // moment (briefly freezing the UI) for a large profile.
      // Duplicating the *currently running* profile isn't perfectly
      // atomic (lock/WAL files may be mid-write at the instant of
      // copy), but Firefox tolerates that the same way it tolerates
      // recovering from a crash.
      dir.copyTo(profileParent, newFolderName);
      map[newName] = newFolderName;
      this.saveProfilesMap(map);
      this.launch(newName);
    } catch (e) {
      this.logError('duplicateProfile', e);
      try { Services.prompt.alert(win, floorpLauncherL('複製に失敗しました', "Couldn't Duplicate"), String(e)); } catch (e2) { }
    }
  },
  removeProfileFromList(name) {
    try {
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const ok = Services.prompt.confirm(
        win,
        floorpLauncherL('一覧から削除', 'Remove from List'),
        floorpLauncherL('プロファイル「' + name + '」を一覧から削除します。\n(実際のプロファイルフォルダとデータは削除されません。)',
          'Remove profile "' + name + '" from the list?\n(The profile folder and its data are not deleted.)')
      );
      if (!ok) return;
      const map = this.getProfilesMap();
      delete map[name];
      this.saveProfilesMap(map);
    } catch (e) {
      this.logError('removeProfileFromList', e);
    }
  },
  launch(name) {
    try {
      const exe = this.getLauncherRoot();
      exe.append('Floorp-Launcher.exe');
      const process = Cc['@mozilla.org/process/util;1'].createInstance(Ci.nsIProcess);
      process.init(exe);
      process.run(false, ['--launch-profile', name], 2);
    } catch (e) { }
  },
  logError(where, e) {
    try {
      const f = Services.dirsvc.get('ProfD', Ci.nsIFile);
      f.append('floorp-launcher-debug.log');
      const foStream = Cc['@mozilla.org/network/file-output-stream;1'].createInstance(Ci.nsIFileOutputStream);
      foStream.init(f, 0x02 | 0x08 | 0x10, 0o666, 0);
      const converter = Cc['@mozilla.org/intl/converter-output-stream;1'].createInstance(Ci.nsIConverterOutputStream);
      converter.init(foStream, 'UTF-8');
      converter.writeString(new Date().toISOString() + ' [' + where + '] ' + String(e) + '\n' + (e && e.stack ? e.stack : '') + '\n');
      converter.close();
    } catch (e2) { }
  },
  init(win) {
    try { this.tagTitle(win); } catch (e) { this.logError('tagTitle', e); }
    try { this.addToolbarButton(win); } catch (e) { this.logError('addToolbarButton', e); }
    try { this.addAppMenu(win); } catch (e) { this.logError('addAppMenu', e); }
  },
};

// ---- autoconfig として読まれたとき ----
// autoconfig のグローバルには lockPref があり window が無い。ウィンドウに
// 読み込まれたときは window があるので、ここは何もしない。
if (typeof window === 'undefined' && typeof lockPref === 'function') {
  // Gecko 159 (Floorp 12.21) は file:// からの loadSubScript を拒否する
  // ("Trying to load untrusted URI") ので、app フォルダを resource:// に割り当てて読む。
  try {
    const appDir = Services.dirsvc.get('XREExeF', Ci.nsIFile).parent;
    Services.io.getProtocolHandler('resource').QueryInterface(Ci.nsIResProtocolHandler)
      .setSubstitution('floorp-launcher', Services.io.newFileURI(appDir));

    // onemen 氏の config.js(署名チェック無効化と userChrome.js ローダーの読み込み)。
    // autoconfig 用の関数(lockPref など)が要るので、このグローバル(this)に読み込む。
    const configJs = appDir.clone();
    configJs.append('config.js');
    if (configJs.exists()) {
      try {
        Services.scriptloader.loadSubScript('resource://floorp-launcher/config.js', this, 'UTF-8');
      } catch (e) {
        Components.utils.reportError('[Floorp-Launcher] config.js failed: ' + e);
      }
    }

    // ウィンドウごとに、このファイル自身をそのウィンドウのグローバルに読み込む。
    // autoconfig のグローバルは起動後に捨てられるので、ボタンのクリック処理などを
    // ここで作ると後で動かなくなる(冒頭のコメント参照)。
    const scriptUrl = 'resource://floorp-launcher/floorp-launcher-profile-ui.js';
    const initWhenReady = (win) => {
      const load = () => {
        try {
          Services.scriptloader.loadSubScript(scriptUrl, win, 'UTF-8');
          win.FloorpLauncherProfileUI.init(win);
        } catch (e) {
          Components.utils.reportError('[Floorp-Launcher] profile switcher failed to load: ' + e);
        }
      };
      if (win.document.readyState === 'complete') {
        load();
      } else {
        win.addEventListener('load', load, { once: true });
      }
    };
    // 最初のウィンドウがもう開いている(browser-delayed-startup-finished 済みの)
    // こともあるので、今あるウィンドウにも付ける。
    try {
      for (const win of Services.wm.getEnumerator('navigator:browser')) {
        initWhenReady(win);
      }
    } catch (e) {
      Components.utils.reportError('[Floorp-Launcher] enumerating windows failed: ' + e);
    }
    Services.obs.addObserver({
      observe(win) { initWhenReady(win); },
    }, 'browser-delayed-startup-finished');
  } catch (ex) {
    Components.utils.reportError('[Floorp-Launcher] profile switcher setup failed: ' + ex);
  }
}
