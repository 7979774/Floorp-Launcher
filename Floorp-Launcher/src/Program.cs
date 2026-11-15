using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace FloorpLauncher
{
    /// <summary>
    /// Full-featured launcher for Floorp Portable, replacing floorp-portable.exe
    /// (Portapps). Portapps rewrites app\defaults\pref\config-prefs.js and
    /// app\portapps.cfg with a fixed template on every launch, which breaks
    /// the Firefox Scripts / userChrome.js (fx-autoconfig) install method
    /// (general.config / config.js). This launcher lives in the same
    /// self-contained folder as app\ and data\, so nothing else fights it.
    ///
    /// config.js / config-prefs.js are written byte-identical to onemen's
    /// fx-folder (so Firefox Scripts Updater sees them as up to date); the
    /// launcher's own code goes through autoconfig-floorp-launcher.js +
    /// floorp-launcher-profile-ui.js instead (see WriteAutoconfigFiles).
    ///
    /// Features:
    ///   - config.js / config-prefs.js (Firefox Scripts / userChrome.js loader)
    ///   - portable-safety environment variables (no crash reports/telemetry
    ///     leaking onto the host system)
    ///   - policies.json (disable Floorp's own auto-update / default-browser nag)
    ///   - update check + real update from the official portable .7z
    ///     (Floorp-Portable-v2, checksum + signature verified, no installer),
    ///     with startupCache clearing afterwards (required per Tab Mix Plus docs)
    ///   - addonStartup.json.lz4 path fix-up if this folder is moved
    ///   - single-instance guard, optional multiple-instances mode
    ///   - optional cleanup of AppData/registry traces on exit
    ///   - "Floorp-Launcher.exe --set-default-browser": registers this
    ///     launcher as a default-browser candidate (HKCU only, no admin
    ///     rights needed) and opens Windows' own Default Apps picker.
    ///     Windows never lets an app silently flip the actual default -
    ///     the user's own click there is always required - so this is a
    ///     manually-triggered opt-in, never done as a side effect of a
    ///     normal launch.
    /// </summary>
    internal static class Program
    {
        // 画面に出す文字の言葉。Windows の表示言語が日本語なら日本語、それ以外は英語
        private static readonly bool UiJa =
            System.Globalization.CultureInfo.CurrentUICulture.TwoLetterISOLanguageName == "ja";

        private static string L(string ja, string en)
        {
            return UiJa ? ja : en;
        }

        private const string BrowserProgId = "FloorpPortableHTML";
        // http / https 用の ProgID。"URL Protocol" を持つ URL 用の ProgID でないと、Windows の
        // 「既定のアプリ」で http / https を選べない
        private const string BrowserUrlProgId = "FloorpPortableURL";
        private const string BrowserRegName = "FloorpPortable";
        // Firefox などと同じ StartMenuInternet の下に登録する(ここに無いと「既定のアプリ」の一覧に出ないことがある)
        private const string BrowserClientKey = @"Software\Clients\StartMenuInternet\" + BrowserRegName;
        // 前の版が使っていた Capabilities の場所(解除と登録し直しのときに片付ける)
        private const string LegacyCapabilitiesKey = @"Software\FloorpPortable";
        // 既定のブラウザの候補として Windows に見せる名前(登録のキーの名前 FloorpPortable などは、前に登録したものを
        // 解除できるように変えない)
        private const string BrowserDisplayName = "Floorp-Launcher";

        private static string BrowserDescription()
        {
            return L("Floorp-Launcher 経由で Floorp を起動", "Starts Floorp through Floorp-Launcher");
        }

        [STAThread]
        private static void Main(string[] args)
        {
            string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

            if (args.Length > 0 && string.Equals(args[0], "--set-default-browser", StringComparison.OrdinalIgnoreCase))
            {
                RegisterAsDefaultBrowserCandidate(root, Path.Combine(root, "app"));
                return;
            }

            if (args.Length > 0 && string.Equals(args[0], "--remove-default-browser", StringComparison.OrdinalIgnoreCase))
            {
                UnregisterAsDefaultBrowserCandidate();
                return;
            }

            LauncherConfig cfg = LauncherConfig.Load(Path.Combine(root, "floorp-launcher.json"));

            // 終了時の cleanup で消してよいのは「今回の起動で新しくできた」痕跡だけ。
            // 起動前からあるもの(通常インストール版Floorpのプロファイル等)は残す。
            List<string> tracesBeforeLaunch = cfg.Cleanup ? ExistingTraceDirs() : null;

            // Normally the profile to launch comes from floorp-launcher.json,
            // but the in-browser toolbar profile switcher (see config.js)
            // calls back into this same exe with an explicit name instead -
            // everything else about the launch (update check, config.js
            // rewrite, single-instance-per-profile guard, shortcut cleanup)
            // stays identical either way.
            string targetProfileName = cfg.Profile;
            if (args.Length > 1 && string.Equals(args[0], "--launch-profile", StringComparison.OrdinalIgnoreCase))
            {
                targetProfileName = args[1];
                args = new string[0];
            }

            string appDir = Path.Combine(root, "app");
            string dataDir = Path.Combine(root, "data");
            string floorpExe = Path.Combine(appDir, "floorp.exe");
            string profileDir = GetOrCreateProfileDir(dataDir, targetProfileName);
            if (profileDir == null)
            {
                return;
            }

            // 起動中のMutexはプロファイル単位なので、別プロファイルのランチャーは
            // 同時に走る。app\ の新規インストール・差し替え・設定書き込みは
            // 共有資源(app\, data\update-staging)を触るため、フォルダ単位で直列化する。
            using (Mutex updateLock = AcquireUpdateLock(root))
            {
                try
                {
                    if (!File.Exists(floorpExe))
                    {
                        if (!TryBootstrapInstall(root, appDir))
                        {
                            return;
                        }
                    }

                    Directory.CreateDirectory(profileDir);

                    // Update check runs first: it may replace the whole appDir with a
                    // freshly installed one, so our own autoconfig files/
                    // policies.json must be (re)written afterwards, not before.
                    // リンクやファイルを開くための起動(引数あり)では更新を確かめない。リンクを押すたびに
                    // 更新の確認が出たり、起動中の Floorp の app\ を差し替えようとしたりしないように
                    if (cfg.CheckForUpdates && args.Length == 0)
                    {
                        CheckForUpdates(root, appDir, profileDir);
                    }

                    WriteAutoconfigFiles(appDir);
                    WritePolicies(appDir, dataDir);
                }
                finally
                {
                    updateLock.ReleaseMutex();
                }
            }
            SetEnvironment(dataDir);
            FixAddonStartupPaths(root, profileDir);

            bool createdNew;
            // Scoped by profileDir, not just root - launching a DIFFERENT
            // profile must never collide with an already-running one (each
            // profile has its own parent.lock and is perfectly safe to run
            // side by side). Only launching the SAME profile a second time
            // should hit the branch below.
            string mutexName = MutexNameFor("FloorpLauncher_", root + "|" + profileDir);
            using (var mutex = new Mutex(true, mutexName, out createdNew))
            {
                if (!createdNew && !cfg.MultipleInstances && args.Length > 0)
                {
                    // リンク(URL)やファイルを開くために起動されたとき(既定のブラウザとして)は、選択画面を出さずに
                    // 起動中の Floorp に渡す。同じプロファイルを --no-remote なしで起動すると、Floorp は起動中の
                    // ウィンドウにそれを開かせてすぐ終わる
                    ForwardToRunningInstance(floorpExe, profileDir, args);
                    return;
                }
                if (!createdNew && !cfg.MultipleInstances)
                {
                    // This exact profile is already running. Rather than
                    // just refusing, offer a picker so the user can launch
                    // a DIFFERENT profile in a new window instead - no
                    // separate command/switch needed, "double-click again"
                    // is the trigger.
                    ShowProfilePickerAndLaunch(root, dataDir, appDir, targetProfileName);
                    return;
                }

                string arguments = "--profile " + QuoteArgument(profileDir);
                if (cfg.MultipleInstances)
                {
                    arguments += " --no-remote";
                }

                // Windows hands us the clicked URL (or a file path) as a
                // plain argument when this launcher is registered as the
                // default browser (see RegisterAsDefaultBrowserCandidate) -
                // forward it to floorp.exe untouched.
                // URLは外部(リンク元)が自由に決められる値なので、引数境界を
                // 壊されないよう必ず QuoteArgument で正しくエスケープする。
                foreach (string extraArg in args)
                {
                    arguments += " " + QuoteArgument(extraArg);
                }

                var psi = new ProcessStartInfo
                {
                    FileName = floorpExe,
                    Arguments = arguments,
                    UseShellExecute = false,
                };

                using (Process.Start(psi)) { }

                // Firefox/Gecko re-execs itself on Windows, so the process
                // handle above exits almost immediately even though the real
                // browser keeps running as a different PID. Track the
                // profile's own lock file instead.
                WaitForProfileUnlock(profileDir);

                if (createdNew)
                {
                    mutex.ReleaseMutex();
                }
            }

            // Every launch, after Floorp has actually closed again: remove
            // any Desktop/Start Menu shortcut that points at OUR floorp.exe.
            // Confirmed by testing (both via this launcher and via the
            // official floorp-portable.exe wrapper) that Floorp itself
            // creates a "Floorp Private Browsing" Start Menu shortcut the
            // first time it runs against a given profile - this is NOT tied
            // to a fresh install/update (e.g. it also fires the first time
            // an already-installed app is launched against a brand new
            // profile name), so this can no longer be gated on that. It's a
            // cheap, idempotent scan - a no-op when nothing matches - and
            // never touches a shortcut pointing anywhere else (e.g. a
            // different Floorp install).
            RemoveStrayShortcuts(appDir);

            if (cfg.Cleanup)
            {
                RunCleanup(tracesBeforeLaunch);
            }
        }

        /// <summary>
        /// 起動中のプロファイルへ URL・ファイルを渡す(新しいウィンドウやタブで開かせる)。
        /// 終わるのを待たない(Floorp は渡し終えたらすぐ終わる)。
        /// </summary>
        private static void ForwardToRunningInstance(string floorpExe, string profileDir, string[] args)
        {
            try
            {
                string arguments = "--profile " + QuoteArgument(profileDir);
                // URL は外部が決める値なので、引数の区切りを壊されないよう必ず QuoteArgument で囲む
                foreach (string extraArg in args)
                {
                    arguments += " " + QuoteArgument(extraArg);
                }
                var psi = new ProcessStartInfo
                {
                    FileName = floorpExe,
                    Arguments = arguments,
                    UseShellExecute = false,
                };
                using (Process.Start(psi)) { }
            }
            catch (Exception ex)
            {
                MessageBox.Show(L("起動中の Floorp で開けませんでした。\n\n", "Couldn't open it in the running Floorp.\n\n") + ex.Message,
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        /// <summary>
        /// Shown instead of the plain "already running" message when the
        /// SAME profile is launched a second time. Lets the user pick a
        /// different (or brand new) profile and open it in its own window -
        /// each profile has its own parent.lock, so this is always safe
        /// regardless of what else is currently running. No separate
        /// command-line switch or config flag needed: "double-click the
        /// launcher again while it's already open" is the trigger.
        ///
        /// Mirrors the same launch/wait/cleanup lifecycle as the main
        /// Main() flow (WaitForProfileUnlock + RemoveStrayShortcuts), so a
        /// profile picked here that happens to be brand new still gets its
        /// stray Start Menu shortcut cleaned up automatically.
        /// </summary>
        private static void ShowProfilePickerAndLaunch(string root, string dataDir, string appDir, string runningProfileName)
        {
            ProfileMap map = ProfileMap.Load(Path.Combine(dataDir, "profiles.json"));
            var names = new List<string>(map.Keys);
            names.Sort(StringComparer.OrdinalIgnoreCase);

            string chosenName = null;
            PickerTheme theme = PickerTheme.Detect();

            // One shared left/right inset for every row (title, subtitle,
            // cards, new-profile box, buttons) so their edges all line up -
            // nothing gets its own hand-picked margin.
            const int margin = 16;
            const int formWidth = 300;
            int contentWidth = formWidth - margin * 2;

            // Cards panel height caps at maxVisibleCards and scrolls beyond
            // that. The native scrollbar is hidden (ShowScrollBar) and
            // replaced with a thin custom-drawn line - AutoScroll still
            // does the actual scrolling (wheel, keys, drag), only its
            // default visual chrome is swapped out.
            const int cardHeight = 40;
            const int cardSpacing = 6;
            const int maxVisibleCards = 4;
            const int scrollGutter = 8;
            int totalCardsHeight = names.Count > 0 ? names.Count * (cardHeight + cardSpacing) - cardSpacing : 0;
            int maxCardsHeight = maxVisibleCards * (cardHeight + cardSpacing) - cardSpacing;
            int cardsPanelHeight = Math.Min(totalCardsHeight, maxCardsHeight);
            bool needsScroll = totalCardsHeight > maxCardsHeight;
            int rowWidth = contentWidth - (needsScroll ? scrollGutter : 0);

            using (var form = new PickerForm())
            {
                form.Width = formWidth;
                form.BackColor = theme.Background;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.Text = L("Floorp Launcher - プロファイル選択", "Floorp Launcher - Choose Profile");
                form.Icon = LoadAppIcon();

                var header = new Panel();
                header.SetBounds(0, 0, form.Width, 30);
                header.BackColor = theme.Background;
                form.DragArea = header;

                var closeButton = new Label();
                closeButton.Text = "✕";
                closeButton.ForeColor = theme.TextSecondary;
                closeButton.BackColor = Color.Transparent;
                closeButton.Font = new Font("Segoe UI", 9.5F);
                closeButton.TextAlign = ContentAlignment.MiddleCenter;
                closeButton.SetBounds(form.Width - margin - 20, 5, 20, 20);
                closeButton.Cursor = Cursors.Hand;
                closeButton.Click += (s, e) => { form.Close(); };

                var titleLabel = new Label();
                titleLabel.Text = L("プロファイルを選択", "Choose a profile");
                titleLabel.ForeColor = theme.TextPrimary;
                titleLabel.BackColor = Color.Transparent;
                titleLabel.Font = new Font("Yu Gothic UI", 10F, FontStyle.Bold);
                titleLabel.SetBounds(margin, 8, contentWidth - 24, 20);

                var subtitleLabel = new Label();
                subtitleLabel.Text = L("別のプロファイルを新しいウィンドウで開きます", "Opens another profile in a new window");
                subtitleLabel.ForeColor = theme.TextSecondary;
                subtitleLabel.BackColor = Color.Transparent;
                subtitleLabel.Font = new Font("Yu Gothic UI", 8F);
                subtitleLabel.SetBounds(margin, 32, contentWidth, 16);

                var cardsPanel = new Panel();
                cardsPanel.SetBounds(margin, 56, contentWidth, cardsPanelHeight);
                cardsPanel.BackColor = theme.Background;
                // Scrolling is done by hand (below) rather than via
                // Panel.AutoScroll - AutoScroll's native gray scrollbar
                // resisted every attempt to hide or restyle it (it kept
                // reasserting itself, and even added a spurious horizontal
                // bar), so cards are just repositioned directly instead.
                // Win32 clips child controls to their parent's bounds
                // automatically, so no explicit clipping is needed for
                // cards scrolled outside the panel's rectangle.

                string selectedName = null;
                var cards = new List<ProfileCard>();

                int y = 0;
                foreach (string name in names)
                {
                    bool isRunning = string.Equals(name, runningProfileName, StringComparison.Ordinal);
                    var card = new ProfileCard();
                    card.ProfileName = name;
                    card.IsRunning = isRunning;
                    card.SubtitleText = isRunning ? L("起動中", "Running") : null;
                    card.Theme = theme;
                    card.SetBounds(0, y, rowWidth, cardHeight);
                    if (!isRunning)
                    {
                        card.Click += (s, e) =>
                        {
                            var clicked = (ProfileCard)s;
                            // Moves focus off the new-name box (if it had
                            // it), which fires its own Leave handler and
                            // restores the placeholder - the two states
                            // are meant to be mutually exclusive.
                            clicked.Focus();
                            selectedName = clicked.ProfileName;
                            foreach (var c in cards) c.IsSelected = (c == clicked);
                            cardsPanel.Invalidate(true);
                        };
                    }
                    cards.Add(card);
                    cardsPanel.Controls.Add(card);
                    y += cardHeight + cardSpacing;
                }
                // Deliberately no default selection - the user has to
                // actually pick something (or type a new name) before
                // "起動" does anything, rather than silently launching
                // whichever card happened to be first.

                if (needsScroll)
                {
                    int maxScroll = totalCardsHeight - cardsPanelHeight;
                    int thumbHeight = Math.Max(24, cardsPanelHeight * cardsPanelHeight / totalCardsHeight);
                    int scrollOffset = 0;

                    var scrollThumb = new Panel();
                    scrollThumb.BackColor = theme.BorderStrong;

                    Action updateThumb = () =>
                    {
                        int thumbY = cardsPanel.Top + (int)((cardsPanelHeight - thumbHeight) *
                            (scrollOffset / (float)maxScroll));
                        scrollThumb.SetBounds(cardsPanel.Right + 2, thumbY, 3, thumbHeight);
                        scrollThumb.BringToFront();
                    };

                    MouseEventHandler onWheel = (s, e) =>
                    {
                        scrollOffset = Math.Max(0, Math.Min(maxScroll, scrollOffset - e.Delta / 3));
                        for (int i = 0; i < cards.Count; i++)
                        {
                            cards[i].Top = i * (cardHeight + cardSpacing) - scrollOffset;
                        }
                        updateThumb();
                    };
                    cardsPanel.MouseWheel += onWheel;
                    foreach (var c in cards) c.MouseWheel += onWheel;

                    form.Controls.Add(scrollThumb);
                    form.Shown += (s, e) => updateThumb();
                }

                int newCardY = 56 + cardsPanelHeight + 8;
                var newCard = new Panel();
                newCard.SetBounds(margin, newCardY, rowWidth, cardHeight);
                newCard.BackColor = theme.Background;
                newCard.Paint += (s, e) =>
                {
                    var rect = new Rectangle(0, 0, newCard.Width - 1, newCard.Height - 1);
                    using (var pen = new Pen(theme.BorderStrong) { DashStyle = DashStyle.Dash })
                    {
                        e.Graphics.DrawRectangle(pen, rect);
                    }
                    TextRenderer.DrawText(e.Graphics, "+", new Font("Yu Gothic UI", 10F), new Rectangle(0, 0, 28, newCard.Height),
                        theme.TextSecondary, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
                };

                // Plain WinForms TextBox has no built-in placeholder-text
                // support. The native EM_SETCUEBANNER message would do it,
                // but that requires the ComCtl32 v6 activation context
                // (an app manifest this bare csc.exe build doesn't have) -
                // confirmed by testing that without it the message just
                // silently fails, and forcing Application.EnableVisualStyles()
                // to get v6 crashed outright (AccessViolationException) when
                // combined with a raw SendMessage this early. Simulating the
                // placeholder in plain managed code instead: dimmed text
                // that clears on focus and comes back if left empty.
                string newNamePlaceholder = L("新しいプロファイル名", "New profile name");
                var newNameBox = new TextBox();
                newNameBox.BorderStyle = BorderStyle.None;
                newNameBox.Font = new Font("Yu Gothic UI", 9F);
                newNameBox.BackColor = theme.Background;
                newNameBox.SetBounds(30, (cardHeight - 18) / 2, rowWidth - 40, 18);
                newNameBox.Text = newNamePlaceholder;
                newNameBox.ForeColor = theme.TextSecondary;
                newNameBox.Enter += (s, e) =>
                {
                    if (newNameBox.Text == newNamePlaceholder && newNameBox.ForeColor == theme.TextSecondary)
                    {
                        newNameBox.Text = "";
                        newNameBox.ForeColor = theme.TextPrimary;
                    }
                    // Focusing this box always cancels any card selection -
                    // the two are meant to be mutually exclusive, not just
                    // whichever one happened to change last.
                    selectedName = null;
                    foreach (var c in cards) c.IsSelected = false;
                    cardsPanel.Invalidate(true);
                };
                newNameBox.Leave += (s, e) =>
                {
                    if (newNameBox.Text.Length == 0)
                    {
                        newNameBox.Text = newNamePlaceholder;
                        newNameBox.ForeColor = theme.TextSecondary;
                    }
                };
                newNameBox.TextChanged += (s, e) =>
                {
                    if (newNameBox.Text.Length > 0 && newNameBox.ForeColor != theme.TextSecondary)
                    {
                        selectedName = null;
                        foreach (var c in cards) c.IsSelected = false;
                        cardsPanel.Invalidate(true);
                    }
                };
                newCard.Controls.Add(newNameBox);

                int buttonBarY = newCardY + cardHeight + 10;
                form.Height = buttonBarY + 52;

                var buttonBar = new Panel();
                buttonBar.SetBounds(0, buttonBarY, form.Width, 52);
                buttonBar.BackColor = theme.Background;
                buttonBar.Paint += (s, e) =>
                {
                    using (var pen = new Pen(theme.Border))
                    {
                        e.Graphics.DrawLine(pen, 0, 0, buttonBar.Width, 0);
                    }
                };

                var cancelButton = new RoundedButton();
                cancelButton.Text = L("キャンセル", "Cancel");
                cancelButton.Font = new Font("Yu Gothic UI", 9F);
                cancelButton.BackColor = theme.Background;
                cancelButton.ForeColor = theme.TextPrimary;
                cancelButton.BorderColor = theme.BorderStrong;
                cancelButton.Click += (s, e) => { form.Close(); };

                var launchButton = new RoundedButton();
                launchButton.Text = L("起動", "Launch");
                launchButton.Font = new Font("Yu Gothic UI", 9F, FontStyle.Bold);
                launchButton.BackColor = theme.AccentFill;
                launchButton.ForeColor = theme.OnAccent;

                // Same width/height for both, derived from the shared
                // margin/gap so they can never drift apart - the second
                // button's X comes from the form's right edge, not a
                // separately hand-picked number.
                const int actionBtnGap = 10;
                const int actionBtnHeight = 32;
                int actionBtnWidth = (contentWidth - actionBtnGap) / 2;
                cancelButton.SetBounds(margin, 10, actionBtnWidth, actionBtnHeight);
                launchButton.SetBounds(form.Width - margin - actionBtnWidth, 10, actionBtnWidth, actionBtnHeight);
                launchButton.Click += (s, e) =>
                {
                    bool isPlaceholder = newNameBox.Text == newNamePlaceholder && newNameBox.ForeColor == theme.TextSecondary;
                    string typed = isPlaceholder ? "" : newNameBox.Text.Trim();
                    string name = typed.Length > 0 ? typed : selectedName;
                    if (string.IsNullOrEmpty(name))
                    {
                        return;
                    }
                    // 新規入力名はフォルダ名に使われるため、ここで弾いて
                    // フォームを閉じずに入力し直してもらう。
                    string invalidReason;
                    if (typed.Length > 0 && !IsSafePathComponent(typed, out invalidReason))
                    {
                        MessageBox.Show(
                            L("プロファイル名「" + typed + "」は使用できません。\n\n", "The profile name \"" + typed + "\" can't be used.\n\n") + invalidReason,
                            "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                    chosenName = name;
                    form.Close();
                };

                buttonBar.Controls.Add(cancelButton);
                buttonBar.Controls.Add(launchButton);

                form.Controls.Add(cardsPanel);
                form.Controls.Add(newCard);
                form.Controls.Add(buttonBar);
                form.Controls.Add(subtitleLabel);
                form.Controls.Add(titleLabel);
                form.Controls.Add(closeButton);
                form.Controls.Add(header);
                header.SendToBack();

                // Without this, newNameBox - the first focusable control -
                // grabs focus the instant the form is shown, which fires
                // its Enter handler immediately and wipes the placeholder
                // text before it's ever visible (confirmed by testing:
                // the caret was left blinking in an apparently-empty box).
                form.ActiveControl = cancelButton;

                Application.Run(form);
            }

            if (chosenName == null)
            {
                return;
            }

            string profileDir = GetOrCreateProfileDir(dataDir, chosenName);
            if (profileDir == null)
            {
                // Error (ambiguous or invalid profile) already shown by GetOrCreateProfileDir.
                return;
            }

            Directory.CreateDirectory(profileDir);
            FixAddonStartupPaths(root, profileDir);

            string floorpExe = Path.Combine(appDir, "floorp.exe");
            var psi = new ProcessStartInfo
            {
                FileName = floorpExe,
                Arguments = "--profile " + QuoteArgument(profileDir),
                UseShellExecute = false,
            };

            using (Process.Start(psi)) { }

            WaitForProfileUnlock(profileDir);
            RemoveStrayShortcuts(appDir);
        }

        /// <summary>
        /// Colors for the profile picker, switched once at open time based
        /// on the system's light/dark app theme (read directly from the
        /// registry - no WinForms "visual styles" support this on its own).
        /// </summary>
        private sealed class PickerTheme
        {
            public Color Background;
            public Color TextPrimary;
            public Color TextSecondary;
            public Color Border;
            public Color BorderStrong;
            public Color CardHoverFill;
            public Color AccentBg;
            public Color AccentBorder;
            public Color AccentText;
            public Color AccentFill;
            public Color OnAccent;

            public static PickerTheme Detect()
            {
                bool dark = IsSystemDarkMode();
                var t = new PickerTheme();
                if (dark)
                {
                    t.Background = Color.FromArgb(32, 32, 32);
                    t.TextPrimary = Color.FromArgb(240, 240, 240);
                    t.TextSecondary = Color.FromArgb(170, 170, 170);
                    t.Border = Color.FromArgb(55, 55, 55);
                    t.BorderStrong = Color.FromArgb(80, 80, 80);
                    t.CardHoverFill = Color.FromArgb(45, 45, 45);
                    t.AccentBg = Color.FromArgb(12, 42, 69);
                    t.AccentBorder = Color.FromArgb(55, 138, 221);
                    t.AccentText = Color.FromArgb(181, 212, 244);
                    t.AccentFill = Color.FromArgb(55, 138, 221);
                    t.OnAccent = Color.White;
                }
                else
                {
                    t.Background = Color.White;
                    t.TextPrimary = Color.FromArgb(30, 30, 28);
                    t.TextSecondary = Color.FromArgb(107, 106, 102);
                    t.Border = Color.FromArgb(224, 222, 214);
                    t.BorderStrong = Color.FromArgb(180, 178, 169);
                    t.CardHoverFill = Color.FromArgb(245, 244, 239);
                    t.AccentBg = Color.FromArgb(230, 241, 251);
                    t.AccentBorder = Color.FromArgb(133, 183, 235);
                    t.AccentText = Color.FromArgb(12, 68, 124);
                    t.AccentFill = Color.FromArgb(24, 95, 165);
                    t.OnAccent = Color.White;
                }
                return t;
            }

            private static bool IsSystemDarkMode()
            {
                try
                {
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(
                        @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    {
                        object val = key != null ? key.GetValue("AppsUseLightTheme") : null;
                        if (val is int) return (int)val == 0;
                    }
                }
                catch
                {
                    // Best-effort only: default to light theme.
                }
                return false;
            }
        }

        /// <summary>
        /// Borderless host form for the picker. FormBorderStyle.None (needed
        /// for rounded corners via a Region - a bordered/native-chrome
        /// window can't be rounded) means Windows no longer provides
        /// dragging or a drop shadow for free, so both are added back by
        /// hand: WM_NCHITTEST reports HTCAPTION over DragArea so Windows'
        /// own drag handling still works, and CS_DROPSHADOW restores the
        /// native-looking soft shadow.
        /// </summary>
        private sealed class PickerForm : Form
        {
            private const int WM_NCHITTEST = 0x0084;
            private const int HTCLIENT = 1;
            private const int HTCAPTION = 2;
            private const int CS_DROPSHADOW = 0x00020000;

            public Control DragArea;

            public PickerForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                MaximizeBox = false;
                MinimizeBox = false;
                ShowInTaskbar = true;
                KeyPreview = true;
                KeyDown += (s, e) =>
                {
                    if (e.KeyCode == Keys.Escape) Close();
                };
            }

            protected override CreateParams CreateParams
            {
                get
                {
                    CreateParams cp = base.CreateParams;
                    cp.ClassStyle |= CS_DROPSHADOW;
                    return cp;
                }
            }

            protected override void WndProc(ref Message m)
            {
                base.WndProc(ref m);
                if (m.Msg == WM_NCHITTEST && (int)m.Result == HTCLIENT && DragArea != null)
                {
                    // Decoding the packed x/y out of lParam is unreliable on
                    // x64 (IntPtr.ToInt32 can overflow) - WM_NCHITTEST always
                    // reflects the current cursor position anyway, so just
                    // read that directly instead.
                    Point client = PointToClient(Cursor.Position);
                    if (DragArea.Bounds.Contains(client))
                    {
                        m.Result = (IntPtr)HTCAPTION;
                    }
                }
            }
        }

        /// <summary>
        /// One profile entry in the picker: a rounded "card" with a
        /// circular initials avatar, drawn entirely by hand (plain WinForms
        /// controls have no such style built in, and this project has no
        /// UI library dependency to add one).
        /// </summary>
        private sealed class ProfileCard : Panel
        {
            public string ProfileName;
            public string SubtitleText;
            public bool IsRunning;
            public bool IsSelected;
            public PickerTheme Theme;
            private bool _hover;

            public ProfileCard()
            {
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                    ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw |
                    ControlStyles.Selectable, true);
                // Selectable + TabStop so clicking a card actually moves
                // keyboard focus here (and so away from the new-name box,
                // which is what makes its own Leave handler restore the
                // placeholder correctly).
                TabStop = true;
                Cursor = Cursors.Hand;
            }

            protected override void OnMouseEnter(EventArgs e)
            {
                _hover = true;
                Invalidate();
                base.OnMouseEnter(e);
            }

            protected override void OnMouseLeave(EventArgs e)
            {
                _hover = false;
                Invalidate();
                base.OnMouseLeave(e);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                var rect = new Rectangle(0, 0, Width - 1, Height - 1);

                Color fill = IsRunning ? Theme.AccentBg : (_hover ? Theme.CardHoverFill : Theme.Background);
                Color border = (IsRunning || IsSelected) ? Theme.AccentBorder : Theme.Border;

                using (var b = new SolidBrush(fill)) g.FillRectangle(b, rect);
                using (var p = new Pen(border)) g.DrawRectangle(p, rect);

                // No per-profile icon support exists (there's nothing real
                // to show - just an auto-generated placeholder), so this is
                // plain text only: name, plus an inline "起動中" tag for the
                // one that's already running.
                const int textX = 12;
                Color titleColor = IsRunning ? Theme.AccentText : Theme.TextPrimary;
                using (var nameFont = new Font("Yu Gothic UI", 9F, FontStyle.Bold))
                {
                    using (var b = new SolidBrush(titleColor))
                    {
                        g.DrawString(ProfileName, nameFont, b, textX, (Height - nameFont.Height) / 2f);
                    }
                    if (!string.IsNullOrEmpty(SubtitleText))
                    {
                        SizeF nameSize = g.MeasureString(ProfileName, nameFont);
                        using (var f = new Font("Yu Gothic UI", 8F))
                        using (var b = new SolidBrush(Theme.AccentText))
                        {
                            g.DrawString(SubtitleText, f, b, textX + nameSize.Width + 8, (Height - f.Height) / 2f);
                        }
                    }
                }
            }
        }

        /// <summary>
        /// A flat, flat-colored Button - plain rectangle, no native 3D
        /// chrome. FlatStyle.Flat alone still draws a faint default border,
        /// so painting is still done by hand to get a clean single-color
        /// fill with an optional hairline border.
        /// </summary>
        private sealed class RoundedButton : Button
        {
            public Color BorderColor = Color.Transparent;

            public RoundedButton()
            {
                FlatStyle = FlatStyle.Flat;
                FlatAppearance.BorderSize = 0;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint |
                    ControlStyles.OptimizedDoubleBuffer, true);
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                Graphics g = e.Graphics;
                var rect = new Rectangle(0, 0, Width - 1, Height - 1);
                using (var b = new SolidBrush(BackColor)) g.FillRectangle(b, rect);
                if (BorderColor != Color.Transparent)
                {
                    using (var p = new Pen(BorderColor)) g.DrawRectangle(p, rect);
                }
                TextRenderer.DrawText(g, Text, Font, ClientRectangle, ForeColor,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
            }
        }

        /// <summary>
        /// The picker window's taskbar icon otherwise falls back to the
        /// generic WinForms icon, not this launcher's own - reuse the icon
        /// already embedded in Floorp-Launcher.exe itself (via /win32icon
        /// at build time) instead of shipping a second copy of it.
        /// </summary>
        private static Icon LoadAppIcon()
        {
            try
            {
                return Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
                return null;
            }
        }

        private static void WaitForProfileUnlock(string profileDir)
        {
            string lockPath = Path.Combine(profileDir, "parent.lock");
            Thread.Sleep(5000);

            while (true)
            {
                if (!File.Exists(lockPath)) return;

                try
                {
                    using (File.Open(lockPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    {
                        return;
                    }
                }
                catch (IOException)
                {
                    // Still locked by the running browser process(es).
                }

                Thread.Sleep(2000);
            }
        }

        /// <summary>
        /// Real Firefox/Floorp profile folders are named
        /// "&lt;random 8-char salt&gt;.&lt;profile name&gt;" (e.g.
        /// "4lno6cr5.default"). Real Firefox never rediscovers a profile by
        /// scanning for that pattern - it keeps an explicit name-&gt;path
        /// mapping in profiles.ini and always resolves through that. We do
        /// the same with data\profiles.json instead of directory-scanning,
        /// so two folders that happen to share a "*.&lt;name&gt;" suffix can
        /// never be ambiguous - only the mapping decides.
        /// </summary>
        private static string GetOrCreateProfileDir(string dataDir, string profileName)
        {
            string dir = ResolveOrCreateProfileDir(dataDir, profileName);
            if (dir != null)
            {
                // A small marker inside the profile itself, readable from
                // chrome-privileged JS (config.js, the toolbar profile
                // switcher) without it having to reverse-engineer the
                // salted folder name back to this friendly one.
                try
                {
                    File.WriteAllText(Path.Combine(dir, "profile-name.txt"), profileName, new UTF8Encoding(false));
                }
                catch
                {
                    // Best-effort only: the switcher just won't show a
                    // friendly label for this profile if this fails.
                }
            }
            return dir;
        }

        private static string ResolveOrCreateProfileDir(string dataDir, string profileName)
        {
            string profileRoot = Path.Combine(dataDir, "profile");
            Directory.CreateDirectory(profileRoot);

            string mapPath = Path.Combine(dataDir, "profiles.json");
            var map = ProfileMap.Load(mapPath);

            string invalidReason;
            string mappedFolder;
            if (map.TryGetValue(profileName, out mappedFolder))
            {
                // profiles.json は手編集もされ得るので、対応先フォルダ名も
                // data\profile\ 直下の1要素であることを確認してから使う。
                if (!IsSafePathComponent(mappedFolder, out invalidReason))
                {
                    MessageBox.Show(
                        L("data\\profiles.json の「" + profileName + "」に対応するフォルダ名「" + mappedFolder + "」が不正です。\n\n",
                          "The folder name \"" + mappedFolder + "\" for \"" + profileName + "\" in data\\profiles.json is invalid.\n\n") + invalidReason,
                        L("Floorp Launcher - プロファイル設定エラー", "Floorp Launcher - Profile Settings Error"),
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return null;
                }
                string mappedDir = Path.Combine(profileRoot, mappedFolder);
                if (Directory.Exists(mappedDir))
                {
                    return mappedDir;
                }
                // Mapping points at a folder that no longer exists (deleted
                // by hand) - fall through and treat this name as unmapped.
            }

            // ここから先は名前そのものがパスの一部になる。"..\x" や絶対パスを
            // 許すと data\profile\ の外の既存フォルダを Directory.Move して
            // しまうため、パス要素として安全な名前以外は拒否する。
            if (!IsSafePathComponent(profileName, out invalidReason))
            {
                MessageBox.Show(
                    L("プロファイル名「" + profileName + "」は使用できません。\n\n", "The profile name \"" + profileName + "\" can't be used.\n\n") + invalidReason,
                    L("Floorp Launcher - プロファイル名エラー", "Floorp Launcher - Profile Name Error"),
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return null;
            }

            string suffix = "." + profileName;

            // Adopt a pre-existing folder for this name into the mapping,
            // so upgrading from the old scan-based logic doesn't strand
            // data that's already there. Only auto-adopt when there is
            // exactly one candidate - if there are several (the exact
            // ambiguity this mapping exists to prevent), don't guess.
            string bareDir = Path.Combine(profileRoot, profileName);
            if (Directory.Exists(bareDir))
            {
                // Old-style bare-named folder (from before salted names
                // existed) - migrate by renaming, then adopt.
                string migratedName = GenerateProfileSalt() + suffix;
                Directory.Move(bareDir, Path.Combine(profileRoot, migratedName));
                map[profileName] = migratedName;
                map.Save(mapPath);
                return Path.Combine(profileRoot, migratedName);
            }

            string saltedNamePattern = "^[a-z0-9]{8}" + Regex.Escape(suffix) + "$";
            string[] candidates = Array.FindAll(Directory.GetDirectories(profileRoot),
                d => Regex.IsMatch(Path.GetFileName(d), saltedNamePattern, RegexOptions.IgnoreCase));
            if (candidates.Length == 1)
            {
                string adoptedName = Path.GetFileName(candidates[0]);
                map[profileName] = adoptedName;
                map.Save(mapPath);
                return candidates[0];
            }

            if (candidates.Length > 1)
            {
                // Ambiguous: several folders could be "profileName" and none
                // is registered yet. Don't guess and don't silently create
                // an unrelated empty profile - stop and let the user decide
                // by editing data\profiles.json themselves.
                MessageBox.Show(
                    L("\"" + profileName + "\" という名前に対応するフォルダが複数見つかりました:\n\n",
                      "Several folders match the name \"" + profileName + "\":\n\n") +
                    string.Join("\n", Array.ConvertAll(candidates, Path.GetFileName)) +
                    L("\n\ndata\\profiles.json に\n{\"" + profileName + "\": \"<使うフォルダ名>\"}\nを追記してから、もう一度起動してください。",
                      "\n\nAdd\n{\"" + profileName + "\": \"<folder to use>\"}\nto data\\profiles.json and start again."),
                    L("Floorp Launcher - プロファイルが曖昧です", "Floorp Launcher - Ambiguous Profile"),
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return null;
            }

            string newName = GenerateProfileSalt() + suffix;
            string newDir = Path.Combine(profileRoot, newName);
            Directory.CreateDirectory(newDir);
            map[profileName] = newName;
            map.Save(mapPath);
            return newDir;
        }

        private static string GenerateProfileSalt()
        {
            const string chars = "abcdefghijklmnopqrstuvwxyz0123456789";
            var rnd = new Random();
            var sb = new StringBuilder(8);
            for (int i = 0; i < 8; i++)
            {
                sb.Append(chars[rnd.Next(chars.Length)]);
            }
            return sb.ToString();
        }

        /// <summary>
        /// Fixed-length kernel object name derived from a path (case-insensitive).
        /// </summary>
        internal static string MutexNameFor(string prefix, string pathKey)
        {
            // Mutex名は260文字まで。パスをそのまま埋め込むと、深い場所に置いたとき
            // ArgumentException で起動直後に落ちるため、ハッシュで固定長にする。
            using (var sha = System.Security.Cryptography.SHA256.Create())
            {
                byte[] hash = sha.ComputeHash(Encoding.UTF8.GetBytes(pathKey.ToUpperInvariant()));
                return prefix + BitConverter.ToString(hash).Replace("-", "");
            }
        }

        /// <summary>
        /// Blocks until this launcher folder's install/update lock is owned
        /// by the calling thread. The caller must ReleaseMutex() it.
        /// </summary>
        internal static Mutex AcquireUpdateLock(string root)
        {
            var mutex = new Mutex(false, MutexNameFor("FloorpLauncher_Update_", root));
            try
            {
                mutex.WaitOne();
            }
            catch (AbandonedMutexException)
            {
                // 前の保持者が異常終了しただけで、所有権はこちらに移っている。
            }
            return mutex;
        }

        private static readonly Regex ReservedDeviceName = new Regex(
            @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$", RegexOptions.IgnoreCase);

        /// <summary>
        /// True if <paramref name="name"/> is safe to use as exactly one
        /// folder-name component directly under data\profile\.
        /// </summary>
        internal static bool IsSafePathComponent(string name, out string reason)
        {
            reason = null;
            if (string.IsNullOrEmpty(name) || name.Trim().Length == 0)
            {
                reason = L("名前が空です。", "The name is empty.");
                return false;
            }
            if (name != name.Trim())
            {
                reason = L("先頭・末尾に空白は使えません。", "Leading or trailing spaces aren't allowed.");
                return false;
            }
            if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            {
                reason = L("次の文字は使えません: \\ / : * ? \" < > | (および制御文字)", "These characters aren't allowed: \\ / : * ? \" < > | (and control characters)");
                return false;
            }
            // Windowsは末尾のピリオドを黙って削るため "." ".." "..." などが
            // 親や自分自身のフォルダを指してしまう。末尾ピリオドは一律禁止。
            if (name.EndsWith("."))
            {
                reason = L("末尾にピリオドは使えません。", "A trailing period isn't allowed.");
                return false;
            }
            if (ReservedDeviceName.IsMatch(name))
            {
                reason = L("Windowsの予約名(CON, NUL, COM1 など)は使えません。", "Windows reserved names (CON, NUL, COM1, ...) aren't allowed.");
                return false;
            }
            return true;
        }

        /// <summary>
        /// Quotes one argument so that the Microsoft C runtime /
        /// CommandLineToArgvW parsing used by floorp.exe recovers it exactly.
        /// </summary>
        internal static string QuoteArgument(string arg)
        {
            // バックスラッシュは「直後が " のときだけ」特別扱いされる。
            // " の直前と閉じクォートの直前のバックスラッシュ列を2倍にしないと、
            // 閉じクォートがエスケープ扱いになり引数境界を乗っ取られる。
            var sb = new StringBuilder(arg.Length + 2);
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                }
                else
                {
                    sb.Append('\\', backslashes);
                }
                sb.Append(c);
                backslashes = 0;
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        // ---- autoconfig (config.js / config-prefs.js) ----
        //
        // config.js と defaults\pref\config-prefs.js は onemen 氏の fx-folder.zip と
        // 1 バイトも違わない内容で置く。Firefox Scripts Updater はこの 2 ファイルを
        // まとめてハッシュ照合するので、1 文字でも足すと「config.js: Update Available」が
        // 出っぱなしになり、Update を押すとランチャーの処理が消える、という罠になる。
        //
        // ランチャー自身の処理は別ファイルに分ける:
        //   defaults\pref\autoconfig-floorp-launcher.js
        //       general.config.filename を floorp-launcher-profile-ui.js に向け替える
        //   floorp-launcher-profile-ui.js (= src\ProfileSwitcher.js)
        //       autoconfig として読まれたとき config.js を読み込み、各ウィンドウに
        //       自分自身を読み込ませてプロファイルボタンを出す
        // こうすると Updater で config.js を新しい版にしても、それがそのまま読まれる。

        /// <summary>onemen/firefox-scripts の fx-folder\config.js (2026-08-21 版) そのまま。</summary>
        private const string FxFolderConfigJs =
            "// skip 1st line\n" +
            "lockPref('xpinstall.signatures.required', false);\n" +
            "lockPref('extensions.install_origins.enabled', false);\n" +
            "\n" +
            "// Waterfox already bundles the legacy-extension BootstrapLoader (the old\n" +
            "// userChromeJS bootstrapping code), so loading ours would double-register it\n" +
            "// and may break legacy extensions.  Detect Waterfox and skip ONLY the BootstrapLoader\n" +
            "// load; userChrome.js and the updater still load normally (Waterfox users who\n" +
            "// install these files want the user-scripts and the auto-updater).\n" +
            "const isWaterfox = /waterfox/i.test(Services.appinfo.name);\n" +
            "\n" +
            "try {\n" +
            "  const cmanifest = Services.dirsvc.get('UChrm', Ci.nsIFile);\n" +
            "  cmanifest.append('utils');\n" +
            "  cmanifest.append('chrome.manifest');\n" +
            "  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(cmanifest);\n" +
            "\n" +
            "  if (!isWaterfox) {\n" +
            "    Services.scriptloader.loadSubScript('chrome://userchromejs/content/BootstrapLoader.js');\n" +
            "  }\n" +
            "} catch (ex) {}\n" +
            "\n" +
            "try {\n" +
            "  Services.scriptloader.loadSubScript('chrome://userchromejs/content/userChrome.js');\n" +
            "} catch (ex) {}\n";

        /// <summary>onemen/firefox-scripts の fx-folder\defaults\pref\config-prefs.js そのまま。</summary>
        private const string FxFolderConfigPrefsJs =
            "pref(\"general.config.obscure_value\", 0);\n" +
            "pref(\"general.config.filename\", \"config.js\");\n" +
            "pref(\"general.config.sandbox_enabled\", false);\n";

        /// <summary>
        /// 古い版のランチャーが書いた config-prefs.js(これだけは上書きしてよい)。
        /// </summary>
        private const string LegacyLauncherConfigPrefsJs =
            "//\r\n" +
            "pref(\"general.config.filename\", \"config.js\");\r\n" +
            "pref(\"general.config.obscure_value\", 0);\r\n" +
            "pref(\"general.config.sandbox_enabled\", false);\r\n";

        private const string ProfileUiFileName = "floorp-launcher-profile-ui.js";

        private static void WriteAutoconfigFiles(string appDir)
        {
            string prefDir = Path.Combine(appDir, "defaults", "pref");
            Directory.CreateDirectory(prefDir);

            // config.js / config-prefs.js は「無いとき」と「古いランチャーが書いたもの」の
            // ときだけ書く。Updater で入れた新しい版を、次の起動で古い版に戻さないため。
            string configJs = Path.Combine(appDir, "config.js");
            if (!File.Exists(configJs) || File.ReadAllText(configJs).Contains("floorp-launcher"))
            {
                File.WriteAllText(configJs, FxFolderConfigJs, new UTF8Encoding(false));
            }
            string configPrefsJs = Path.Combine(prefDir, "config-prefs.js");
            if (!File.Exists(configPrefsJs) || File.ReadAllText(configPrefsJs) == LegacyLauncherConfigPrefsJs)
            {
                File.WriteAllText(configPrefsJs, FxFolderConfigPrefsJs, new UTF8Encoding(false));
            }

            // defaults\pref の *.js は名前の逆アルファベット順に読まれ、後に読んだものが勝つ
            // (Floorp 12.21 で実測: "floorp-…" だと config-prefs.js に負け、"autoconfig-…" だと勝つ)。
            // config-prefs.js より後に読ませるため、名前は "config" より前に来るものにすること。
            string content =
                "// Floorp-Launcher: autoconfig の読み込み先を floorp-launcher-profile-ui.js に切り替える。\r\n" +
                "// config.js はそこから読み込まれる。ファイル名を変えるときは config-prefs.js より\r\n" +
                "// 後に読まれる(名前が \"config\" より前に来る)ようにすること。\r\n" +
                "pref(\"general.config.filename\", \"" + ProfileUiFileName + "\");\r\n" +
                "pref(\"general.config.obscure_value\", 0);\r\n" +
                "pref(\"general.config.sandbox_enabled\", false);\r\n";
            File.WriteAllText(Path.Combine(prefDir, "autoconfig-floorp-launcher.js"), content, new UTF8Encoding(false));

            // プロファイルボタン本体は src\ProfileSwitcher.js を exe に埋め込んだもの
            // (Build.bat の /resource)。毎回書き出すので、exe を入れ替えればすぐ反映され、
            // appDir が更新で入れ替わっても消えない。exe の横に古い ProfileSwitcher.js が
            // 残っていても読まない。
            string dest = Path.Combine(appDir, ProfileUiFileName);
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(ProfileSwitcherResourceName))
            {
                if (resource == null)
                {
                    throw new InvalidOperationException(
                        L("Floorp-Launcher.exe に " + ProfileSwitcherResourceName + " が埋め込まれていません。Build.bat でビルドし直してください。",
                          ProfileSwitcherResourceName + " is not embedded in Floorp-Launcher.exe. Rebuild it with Build.bat."));
                }
                using (FileStream output = File.Create(dest))
                {
                    resource.CopyTo(output);
                }
            }
        }

        private const string ProfileSwitcherResourceName = "ProfileSwitcher.js";

        private static void WritePolicies(string appDir, string dataDir)
        {
            // Custom, user-editable overrides: data\policies.json (merged,
            // never overwritten by us).
            string customPath = Path.Combine(dataDir, "policies.json");
            string policies;
            if (File.Exists(customPath))
            {
                policies = File.ReadAllText(customPath);
            }
            else
            {
                policies =
                    "{\r\n" +
                    "  \"policies\": {\r\n" +
                    "    \"DisableAppUpdate\": true,\r\n" +
                    "    \"DontCheckDefaultBrowser\": true\r\n" +
                    "  }\r\n" +
                    "}\r\n";
            }

            string distDir = Path.Combine(appDir, "distribution");
            Directory.CreateDirectory(distDir);
            File.WriteAllText(Path.Combine(distDir, "policies.json"), policies, new UTF8Encoding(false));
        }

        private static void SetEnvironment(string dataDir)
        {
            string crashDir = Path.Combine(dataDir, "crashreporter");
            string pluginsDir = Path.Combine(dataDir, "plugins");
            Directory.CreateDirectory(crashDir);
            Directory.CreateDirectory(pluginsDir);

            Environment.SetEnvironmentVariable("MOZ_CRASHREPORTER", "0");
            Environment.SetEnvironmentVariable("MOZ_CRASHREPORTER_DATA_DIRECTORY", crashDir);
            Environment.SetEnvironmentVariable("MOZ_CRASHREPORTER_DISABLE", "1");
            Environment.SetEnvironmentVariable("MOZ_CRASHREPORTER_NO_REPORT", "1");
            Environment.SetEnvironmentVariable("MOZ_DATA_REPORTING", "0");
            Environment.SetEnvironmentVariable("MOZ_MAINTENANCE_SERVICE", "0");
            Environment.SetEnvironmentVariable("MOZ_PLUGIN_PATH", pluginsDir);
            Environment.SetEnvironmentVariable("MOZ_UPDATER", "0");
        }

        /// <summary>
        /// addonStartup.json.lz4 records absolute filesystem paths for each
        /// installed extension. If this folder is moved (different drive
        /// letter or parent path), those stale paths make extensions
        /// silently fail to load. We remember, per profile, the root path it
        /// was last launched from; if it changed, rewrite every occurrence
        /// of the old root inside that profile's addonStartup.json.lz4.
        /// </summary>
        internal static void FixAddonStartupPaths(string root, string profileDir)
        {
            try
            {
                // 記録が全体で1つだと、移動後に最初に起動したプロファイルの時点で
                // 新しい場所に上書きされ、他のプロファイルが永久に直らない。
                // そのためプロファイルごとに持つ。旧形式の data\last-root.txt は
                // まだ自分の記録を持たないプロファイルの初期値としてだけ使う(更新しない)。
                string profileMarker = Path.Combine(profileDir, "floorp-launcher-last-root.txt");
                string legacyMarker = Path.Combine(root, "data", "last-root.txt");
                string lastRoot = File.Exists(profileMarker) ? File.ReadAllText(profileMarker).Trim()
                    : File.Exists(legacyMarker) ? File.ReadAllText(legacyMarker).Trim()
                    : null;

                if (!string.IsNullOrEmpty(lastRoot) && !string.Equals(lastRoot, root, StringComparison.OrdinalIgnoreCase))
                {
                    string addonStartupPath = Path.Combine(profileDir, "addonStartup.json.lz4");
                    if (File.Exists(addonStartupPath))
                    {
                        byte[] raw = File.ReadAllBytes(addonStartupPath);
                        string json;
                        if (MozLz4.TryDecode(raw, out json))
                        {
                            string fixedJson = RewriteRootInJson(json, lastRoot, root);
                            if (fixedJson != json)
                            {
                                File.WriteAllBytes(addonStartupPath, MozLz4.Encode(fixedJson));
                            }
                        }
                    }
                }

                File.WriteAllText(profileMarker, root, new UTF8Encoding(false));
            }
            catch
            {
                // Best-effort only: never block startup over this.
            }
        }

        /// <summary>
        /// Replaces the JSON-escaped <paramref name="oldRoot"/> with
        /// <paramref name="newRoot"/>, but only where it is a whole path
        /// prefix (followed by a separator or the end of the string value).
        /// </summary>
        internal static string RewriteRootInJson(string json, string oldRoot, string newRoot)
        {
            string oldEsc = oldRoot.TrimEnd('\\').Replace("\\", "\\\\");
            string newEsc = newRoot.TrimEnd('\\').Replace("\\", "\\\\");
            // JSON内では \ が \\ になる。直後が \\(区切り)か "(値の終端)のときだけ置換し、
            // "D:\Floorp" が "D:\Floorp-Other\..." の先頭に誤一致しないようにする。
            return Regex.Replace(json, Regex.Escape(oldEsc) + @"(?=\\\\|"")",
                newEsc.Replace("$", "$$"), RegexOptions.IgnoreCase);
        }

        // 公式インストーラーはサイレント実行でも HKCU にアンインストール情報や既定ブラウザ
        // 候補を書き込み、しかも作業用フォルダのパスを指したまま残る。Floorp 公式組織の
        // Floorp-Portable-v2 が本体の全リリースをポータブル版 .7z として数時間以内に
        // 公開しているので、そちらを展開するだけにしてホストへの書き込みを無くす。
        private const string PortableReleaseApi = "https://api.github.com/repos/Floorp-Projects/Floorp-Portable-v2/releases/latest";
        private const string PortableArchiveName = "floorp-windows-x86_64.portable.7z";
        private const string ChecksumsAssetName = "checksums.txt";

        /// <summary>
        /// Queries the latest Floorp-Portable-v2 release for its version and
        /// the download URLs of the portable .7z and its checksums.txt.
        /// Each asset's own "browser_download_url" is the first one that
        /// appears after its "name" field in the GitHub API response - we
        /// don't brace-match the surrounding object because "uploader"
        /// nests another {} between the two fields.
        /// </summary>
        private static bool GetLatestPortableRelease(out string latestVersion, out string archiveUrl, out string checksumsUrl)
        {
            latestVersion = null;
            archiveUrl = null;
            checksumsUrl = null;

            string body = HttpGetString(PortableReleaseApi);

            Match tagMatch = Regex.Match(body, "\"tag_name\"\\s*:\\s*\"v?([\\d.]+)\"");
            if (!tagMatch.Success) return false;
            latestVersion = tagMatch.Groups[1].Value;

            archiveUrl = FindAssetUrl(body, PortableArchiveName);
            checksumsUrl = FindAssetUrl(body, ChecksumsAssetName);
            return archiveUrl != null && checksumsUrl != null;
        }

        private static string FindAssetUrl(string releaseJson, string assetName)
        {
            Match nameMatch = Regex.Match(releaseJson, "\"name\"\\s*:\\s*\"" + Regex.Escape(assetName) + "\"");
            if (!nameMatch.Success) return null;
            Match urlMatch = Regex.Match(releaseJson.Substring(nameMatch.Index),
                "\"browser_download_url\"\\s*:\\s*\"([^\"]+)\"");
            return urlMatch.Success ? urlMatch.Groups[1].Value : null;
        }

        private static string HttpGetString(string url)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.UserAgent = "Floorp-Custom-Launcher";
            req.Timeout = 30000;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(resp.GetResponseStream()))
            {
                return reader.ReadToEnd();
            }
        }

        /// <summary>
        /// app\ (and therefore app\floorp.exe) doesn't exist yet. Ask before
        /// doing anything, then download + verify + extract the portable
        /// release into a staging folder and only move it into place as
        /// appDir once it is complete, so an interrupted install never leaves
        /// a half-written appDir behind.
        /// </summary>
        private static bool TryBootstrapInstall(string root, string appDir)
        {
            string latestVersion, archiveUrl, checksumsUrl;
            try
            {
                if (!GetLatestPortableRelease(out latestVersion, out archiveUrl, out checksumsUrl))
                {
                    MessageBox.Show(L("最新リリースを取得できませんでした。", "Couldn't get the latest release."), "Floorp Launcher",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return false;
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(L("最新リリースの確認に失敗しました。\n\n", "Couldn't check for the latest release.\n\n") + ex.Message,
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }

            DialogResult confirm = MessageBox.Show(
                string.Format(L("Floorp {0} をインストールしますか?(約120MB)", "Install Floorp {0}? (about 120 MB)"), latestVersion),
                L("Floorp Launcher - セットアップ", "Floorp Launcher - Setup"),
                MessageBoxButtons.YesNo, MessageBoxIcon.Question);

            if (confirm != DialogResult.Yes) return false;

            string stagingDir = Path.Combine(root, "data", "update-staging");
            string tmpArchive = Path.Combine(Path.GetTempPath(), "floorp-portable-" + Guid.NewGuid().ToString("N") + ".7z");
            try
            {
                if (!DownloadWithProgress(archiveUrl, tmpArchive))
                {
                    MessageBox.Show(L("ダウンロードに失敗しました。", "The download failed."), "Floorp Launcher",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return false;
                }

                // 既存の app\ を消す前に検証・展開を済ませる(偽物や壊れた物なら何も壊さずに止める)。
                string stagedApp = StageVerifiedPortable(tmpArchive, checksumsUrl, stagingDir);

                if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
                Directory.Move(stagedApp, appDir);
                return true;
            }
            catch (Exception ex)
            {
                MessageBox.Show(L("インストールに失敗しました。\n\n", "The installation failed.\n\n") + ex.Message, "Floorp Launcher",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            finally
            {
                try { File.Delete(tmpArchive); } catch { }
                try { if (Directory.Exists(stagingDir)) Directory.Delete(stagingDir, true); } catch { }
            }
        }

        /// <returns>true if an update was actually downloaded and applied.</returns>
        private static bool CheckForUpdates(string root, string appDir, string profileDir)
        {
            try
            {
                string appIniPath = Path.Combine(appDir, "application.ini");
                if (!File.Exists(appIniPath)) return false;

                string appIni = File.ReadAllText(appIniPath);
                Match verMatch = Regex.Match(appIni, @"^Version=([\d.]+)", RegexOptions.Multiline);
                if (!verMatch.Success) return false;
                string currentVersion = verMatch.Groups[1].Value.Split('@')[0];

                string latestVersion, archiveUrl, checksumsUrl;
                if (!GetLatestPortableRelease(out latestVersion, out archiveUrl, out checksumsUrl)) return false;

                if (!IsNewer(latestVersion, currentVersion)) return false;

                DialogResult result = MessageBox.Show(
                    string.Format(L("Floorp {0} が利用可能です。更新しますか?(約120MB)", "Floorp {0} is available. Update now? (about 120 MB)"), latestVersion),
                    L("Floorp Launcher - アップデート", "Floorp Launcher - Update"),
                    MessageBoxButtons.YesNo, MessageBoxIcon.Information);

                if (result != DialogResult.Yes) return false;

                return ApplyUpdate(root, appDir, profileDir, archiveUrl, checksumsUrl, latestVersion);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    L("アップデート確認に失敗しました。\n\n", "Couldn't check for updates.\n\n") + ex.Message,
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
        }

        /// <summary>
        /// Downloads the portable release, verifies it and extracts it into a
        /// scratch staging folder. The existing appDir is only swapped out
        /// once the staged copy has passed every check, with an automatic
        /// rollback if moving it into place fails.
        /// </summary>
        /// <returns>true if the update was applied successfully.</returns>
        private static bool ApplyUpdate(string root, string appDir, string profileDir, string archiveUrl, string checksumsUrl, string latestVersion)
        {
            string stagingDir = Path.Combine(root, "data", "update-staging");
            string tmpArchive = Path.Combine(Path.GetTempPath(), "floorp-portable-" + Guid.NewGuid().ToString("N") + ".7z");
            try
            {
                if (!DownloadWithProgress(archiveUrl, tmpArchive))
                {
                    MessageBox.Show(L("ダウンロードに失敗しました。", "The download failed."),
                        "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return false;
                }

                string stagedApp = StageVerifiedPortable(tmpArchive, checksumsUrl, stagingDir);
                SwapAppDir(appDir, stagedApp);

                // The Tab Mix Plus docs explicitly warn that the profile's
                // startup cache is NOT cleared by a Firefox/Floorp update on
                // its own, and that stale cached chrome can then break
                // userChrome.js/Tab Mix Plus. Clear it here so every update
                // behaves like using the "Clear startup cache..." button.
                ClearStartupCache(profileDir);

                MessageBox.Show(string.Format(L("Floorp {0} にアップデートしました。", "Updated to Floorp {0}."), latestVersion),
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return true;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    L("インストールに失敗しました。\n\n", "The installation failed.\n\n") + ex.Message,
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            finally
            {
                try { File.Delete(tmpArchive); } catch { }
                try { if (Directory.Exists(stagingDir)) Directory.Delete(stagingDir, true); } catch { }
            }
        }

        /// <summary>
        /// Verifies the downloaded archive against the release's checksums.txt,
        /// extracts it into a fresh <paramref name="stagingDir"/>, verifies the
        /// extracted binaries' signatures, and returns the staged app folder.
        /// Throws with a user-facing message on any failure.
        /// </summary>
        private static string StageVerifiedPortable(string archivePath, string checksumsUrl, string stagingDir)
        {
            string expected = ParseChecksum(HttpGetString(checksumsUrl), PortableArchiveName);
            if (expected == null)
            {
                throw new InvalidDataException(L(ChecksumsAssetName + " に " + PortableArchiveName + " の記載がありません。",
                    PortableArchiveName + " is not listed in " + ChecksumsAssetName + "."));
            }
            string actual = Sha256Hex(archivePath);
            if (!string.Equals(expected, actual, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException(
                    L("ダウンロードしたファイルのチェックサムが公開値と一致しません(破損または改ざんの可能性)。\n公開値: ",
                      "The downloaded file's checksum doesn't match the published value (it may be corrupted or tampered with).\nPublished: ") +
                    expected + L("\n実際: ", "\nActual: ") + actual);
            }

            if (Directory.Exists(stagingDir)) Directory.Delete(stagingDir, true);
            Directory.CreateDirectory(stagingDir);
            ExtractWithSystemTar(archivePath, stagingDir);

            string stagedApp = Path.Combine(stagingDir, "app");
            string reason;
            if (!VerifyPortableBinaries(stagedApp, out reason))
            {
                throw new InvalidDataException(
                    L("展開したファイルが公式のものと確認できなかったため、中止しました。\n",
                      "Stopped because the extracted files couldn't be verified as official.\n") + reason +
                    L("\n\n公式サイトから手動で更新してください。", "\n\nPlease update manually from the official site."));
            }
            return stagedApp;
        }

        /// <summary>
        /// Looks up <paramref name="fileName"/> in sha256sum-style text
        /// ("&lt;64 hex&gt;  &lt;name&gt;" per line). Returns lowercase hex, or null.
        /// </summary>
        internal static string ParseChecksum(string checksumsText, string fileName)
        {
            foreach (string line in checksumsText.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
            {
                // バイナリモードの sha256sum は名前の前に * が付く。
                Match m = Regex.Match(line.Trim(), @"^([0-9a-fA-F]{64})\s+\*?(.+)$");
                if (m.Success && string.Equals(m.Groups[2].Value.Trim(), fileName, StringComparison.Ordinal))
                {
                    return m.Groups[1].Value.ToLowerInvariant();
                }
            }
            return null;
        }

        internal static string Sha256Hex(string path)
        {
            using (var sha = SHA256.Create())
            using (var fs = File.OpenRead(path))
            {
                return BitConverter.ToString(sha.ComputeHash(fs)).Replace("-", "").ToLowerInvariant();
            }
        }

        internal static void ExtractWithSystemTar(string archivePath, string destDir)
        {
            // PATH 上の別の tar(Git や scoop のもの等)を拾わないよう System32 のものを直接使う。
            // Windows 標準の tar(bsdtar)は既定で絶対パスや ".." を含むエントリを展開しない。
            string tar = Path.Combine(Environment.SystemDirectory, "tar.exe");
            if (!File.Exists(tar))
            {
                throw new FileNotFoundException(L("Windows 標準の tar.exe が見つかりません: ", "Windows' built-in tar.exe was not found: ") + tar);
            }
            var psi = new ProcessStartInfo
            {
                FileName = tar,
                Arguments = "-xf " + QuoteArgument(archivePath) + " -C " + QuoteArgument(destDir),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
            };
            using (var proc = Process.Start(psi))
            {
                // stderr を読み切らないとパイプが詰まって終わらないことがあるので並行して読む。
                var stderr = proc.StandardError.ReadToEndAsync();
                if (!proc.WaitForExit(5 * 60 * 1000))
                {
                    try { proc.Kill(); } catch { }
                    throw new TimeoutException(L("7z の展開がタイムアウトしました。", "Extracting the 7z archive timed out."));
                }
                if (proc.ExitCode != 0)
                {
                    throw new IOException(
                        L("7z の展開に失敗しました(tar 終了コード " + proc.ExitCode + ")。この Windows の tar.exe が 7z 形式に対応していない可能性があります。\n",
                          "Extracting the 7z archive failed (tar exit code " + proc.ExitCode + "). This Windows' tar.exe may not support the 7z format.\n") +
                        stderr.Result.Trim());
                }
            }
        }

        // Floorp の公式ビルドは SignPath Foundation(OSS向け署名サービス)で署名されている。
        // 証明書は期限で差し替わるため拇印固定はせず、署名者の組織名で判定する。
        private const string ExpectedSignerOrganization = "SignPath Foundation";
        // floorp.exe は xul.dll(ブラウザ本体)を読み込むだけの起動役なので、本体側も必須にする。
        private static readonly string[] RequiredSignPathBinaries = { "floorp.exe", "xul.dll", "mozglue.dll" };
        // 同梱の Windows App SDK 系 DLL は Microsoft 署名。
        private static readonly string[] AllowedSignerOrganizations = { ExpectedSignerOrganization, "Microsoft Corporation" };
        private const int TRUST_E_NOSIGNATURE = unchecked((int)0x800B0100);

        /// <summary>
        /// Checks an extracted app folder: the core binaries must carry a
        /// valid SignPath signature, floorp.exe must be the "Floorp" product,
        /// and every other exe/dll that is signed at all must be validly
        /// signed by a known publisher.
        /// </summary>
        internal static bool VerifyPortableBinaries(string appDir, out string reason)
        {
            reason = null;
            try
            {
                foreach (string name in RequiredSignPathBinaries)
                {
                    string path = Path.Combine(appDir, name);
                    if (!File.Exists(path))
                    {
                        reason = L(name + " が見つかりません。", name + " was not found.");
                        return false;
                    }
                    string org;
                    int trust = CheckSignature(path, out org);
                    if (trust != 0)
                    {
                        reason = string.Format(L("{0}: デジタル署名が無効または無し (WinVerifyTrust: 0x{1:X8})。", "{0}: the digital signature is invalid or missing (WinVerifyTrust: 0x{1:X8})."), name, trust);
                        return false;
                    }
                    if (org != ExpectedSignerOrganization)
                    {
                        reason = name + L(": 署名者が想定と異なります: ", ": unexpected signer: ") + org;
                        return false;
                    }
                }

                string product = FileVersionInfo.GetVersionInfo(Path.Combine(appDir, "floorp.exe")).ProductName;
                if (product != "Floorp")
                {
                    reason = L("floorp.exe の製品名が想定と異なります: ", "Unexpected product name for floorp.exe: ") + (product ?? L("(なし)", "(none)"));
                    return false;
                }

                // 公式ビルド自体に署名なしの DLL(onnxruntime.dll 等)が含まれるので署名なしは
                // 許容する(中身は 7z 全体のチェックサムで担保)。署名があるなら有効かつ既知の発行元に限る。
                foreach (string path in Directory.GetFiles(appDir, "*", SearchOption.AllDirectories))
                {
                    string ext = Path.GetExtension(path).ToLowerInvariant();
                    if (ext != ".exe" && ext != ".dll") continue;

                    string org;
                    int trust = CheckSignature(path, out org);
                    if (trust == TRUST_E_NOSIGNATURE) continue;

                    string rel = path.Substring(appDir.Length).TrimStart('\\');
                    if (trust != 0)
                    {
                        reason = string.Format(L("{0}: デジタル署名が無効です (WinVerifyTrust: 0x{1:X8})。", "{0}: the digital signature is invalid (WinVerifyTrust: 0x{1:X8})."), rel, trust);
                        return false;
                    }
                    if (Array.IndexOf(AllowedSignerOrganizations, org) < 0)
                    {
                        reason = rel + L(": 想定外の署名者です: ", ": unexpected signer: ") + org;
                        return false;
                    }
                }
                return true;
            }
            catch (Exception ex)
            {
                reason = L("署名の確認中にエラーが発生しました: ", "An error occurred while checking signatures: ") + ex.Message;
                return false;
            }
        }

        /// <returns>The WinVerifyTrust result (0 = valid). When valid,
        /// <paramref name="organization"/> is the signer certificate's O= value.</returns>
        private static int CheckSignature(string path, out string organization)
        {
            organization = null;
            int trust = WinTrust.VerifyEmbeddedSignature(path);
            if (trust != 0) return trust;

            // WinVerifyTrust で改ざんなしを確認した後なので、取り出す証明書は信頼できる。
            using (var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path)))
            {
                Match m = Regex.Match(cert.Subject, @"(?:^|,\s*)O=(?:""([^""]*)""|([^,]*))");
                organization = m.Success ? (m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value.Trim()) : "";
            }
            return 0;
        }

        private static class WinTrust
        {
            private static readonly Guid GenericVerifyV2 = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

            private const uint WTD_UI_NONE = 2;
            private const uint WTD_REVOKE_WHOLECHAIN = 1;
            private const uint WTD_CHOICE_FILE = 1;
            private const uint WTD_STATEACTION_VERIFY = 1;
            private const uint WTD_STATEACTION_CLOSE = 2;
            private const uint WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT = 0x80;

            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
            private struct WINTRUST_FILE_INFO
            {
                public uint cbStruct;
                public string pcwszFilePath;
                public IntPtr hFile;
                public IntPtr pgKnownSubject;
            }

            [StructLayout(LayoutKind.Sequential)]
            private struct WINTRUST_DATA
            {
                public uint cbStruct;
                public IntPtr pPolicyCallbackData;
                public IntPtr pSIPClientData;
                public uint dwUIChoice;
                public uint fdwRevocationChecks;
                public uint dwUnionChoice;
                public IntPtr pFile;
                public uint dwStateAction;
                public IntPtr hWVTStateData;
                public IntPtr pwszURLReference;
                public uint dwProvFlags;
                public uint dwUIContext;
                public IntPtr pSignatureSettings;
            }

            [DllImport("wintrust.dll", CharSet = CharSet.Unicode)]
            private static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid pgActionID, ref WINTRUST_DATA pWVTData);

            /// <returns>0 if trusted, otherwise the WinVerifyTrust HRESULT.</returns>
            public static int VerifyEmbeddedSignature(string path)
            {
                var fileInfo = new WINTRUST_FILE_INFO
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)),
                    pcwszFilePath = path,
                };
                IntPtr pFile = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
                try
                {
                    Marshal.StructureToPtr(fileInfo, pFile, false);
                    var data = new WINTRUST_DATA
                    {
                        cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)),
                        dwUIChoice = WTD_UI_NONE,
                        fdwRevocationChecks = WTD_REVOKE_WHOLECHAIN,
                        dwUnionChoice = WTD_CHOICE_FILE,
                        pFile = pFile,
                        dwStateAction = WTD_STATEACTION_VERIFY,
                        dwProvFlags = WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
                    };
                    int result = WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
                    // VERIFY で確保された状態データは CLOSE で必ず解放する。
                    data.dwStateAction = WTD_STATEACTION_CLOSE;
                    WinVerifyTrust(IntPtr.Zero, GenericVerifyV2, ref data);
                    return result;
                }
                finally
                {
                    Marshal.DestroyStructure(pFile, typeof(WINTRUST_FILE_INFO));
                    Marshal.FreeHGlobal(pFile);
                }
            }
        }

        /// <summary>
        /// Swaps appDir for the freshly staged install. The old appDir is
        /// briefly renamed aside so the swap can be rolled back if moving
        /// the new one into place fails; once the swap has actually
        /// succeeded, the old version is deleted.
        /// </summary>
        private static void SwapAppDir(string appDir, string stagingDir)
        {
            string backupDir = appDir + ".backup-" + DateTime.Now.ToString("yyyyMMdd-HHmmss");
            if (Directory.Exists(backupDir)) Directory.Delete(backupDir, true);

            Directory.Move(appDir, backupDir);
            try
            {
                Directory.Move(stagingDir, appDir);
            }
            catch
            {
                if (Directory.Exists(appDir)) Directory.Delete(appDir, true);
                Directory.Move(backupDir, appDir);
                throw;
            }

            Directory.Delete(backupDir, true);
        }

        private static void ClearStartupCache(string profileDir)
        {
            try
            {
                string startupCacheDir = Path.Combine(profileDir, "startupCache");
                if (Directory.Exists(startupCacheDir))
                {
                    Directory.Delete(startupCacheDir, true);
                }
            }
            catch
            {
                // Best-effort: it will just get rebuilt/retried on next launch anyway.
            }
        }

        private static bool DownloadWithProgress(string url, string destPath)
        {
            bool success = false;

            using (var form = new Form())
            using (var progressBar = new ProgressBar())
            using (var label = new Label())
            using (var wc = new WebClient())
            {
                form.Text = "Floorp Launcher";
                form.Width = 420;
                form.Height = 130;
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MaximizeBox = false;
                form.MinimizeBox = false;
                form.ControlBox = false;
                form.StartPosition = FormStartPosition.CenterScreen;

                label.Text = L("ダウンロード中...", "Downloading...");
                label.AutoSize = true;
                label.Top = 15;
                label.Left = 15;

                progressBar.Top = 45;
                progressBar.Left = 15;
                progressBar.Width = 375;
                progressBar.Minimum = 0;
                progressBar.Maximum = 100;

                form.Controls.Add(label);
                form.Controls.Add(progressBar);

                wc.DownloadProgressChanged += (s, e) =>
                {
                    progressBar.Value = Math.Min(100, Math.Max(0, e.ProgressPercentage));
                    label.Text = string.Format(
                        L("ダウンロード中... {0}%  ({1} MB / {2} MB)", "Downloading... {0}%  ({1} MB / {2} MB)"),
                        e.ProgressPercentage,
                        e.BytesReceived / 1048576,
                        e.TotalBytesToReceive / 1048576);
                };
                wc.DownloadFileCompleted += (s, e) =>
                {
                    success = e.Error == null && !e.Cancelled;
                    form.Close();
                };
                form.Shown += (s, e) =>
                {
                    try
                    {
                        wc.DownloadFileAsync(new Uri(url), destPath);
                    }
                    catch
                    {
                        success = false;
                        form.Close();
                    }
                };

                Application.Run(form);
            }

            return success;
        }

        private static bool IsNewer(string latest, string current)
        {
            try
            {
                var l = Array.ConvertAll(latest.Split('.'), int.Parse);
                var c = Array.ConvertAll(current.Split('.'), int.Parse);
                int len = Math.Max(l.Length, c.Length);
                for (int i = 0; i < len; i++)
                {
                    int lv = i < l.Length ? l[i] : 0;
                    int cv = i < c.Length ? c[i] : 0;
                    if (lv != cv) return lv > cv;
                }
                return false;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>
        /// Deletes any .lnk (Desktop, Start Menu, Common Start Menu) whose
        /// target is inside appDir. Confirmed on a real machine that Floorp's
        /// own first run against a profile adds/refreshes a Start Menu entry
        /// (e.g. "Floorp Private Browsing") by itself, independently of how
        /// appDir was installed. This only ever touches a shortcut whose
        /// target matches our own floorp.exe exactly - a shortcut pointing
        /// at any other Floorp install (e.g. the user's regular browser)
        /// is left alone.
        /// </summary>
        private static void RemoveStrayShortcuts(string appDir)
        {
            // Match anything inside our own app\ (floorp.exe,
            // private_browsing.exe, ...) - confirmed on a real machine that
            // Floorp creates a separate "Private Browsing" shortcut
            // pointing at private_browsing.exe, not just a plain
            // Floorp.lnk pointing at floorp.exe.
            string ourAppDirNormalized = Path.GetFullPath(appDir).TrimEnd('\\') + "\\";

            string[] searchDirs =
            {
                Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), "Programs"),
            };

            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) return;

            object shell = null;
            try
            {
                shell = Activator.CreateInstance(shellType);

                foreach (string dir in searchDirs)
                {
                    if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;

                    // Directory.GetFiles(..., AllDirectories) aborts the
                    // ENTIRE scan if any single subfolder along the way is
                    // inaccessible (confirmed on a real machine: an
                    // UnauthorizedAccessException on one Start Menu
                    // subfolder silently prevented Floorp.lnk - which sits
                    // right at the top level - from ever being checked).
                    // Walk manually instead so one bad subfolder is skipped
                    // rather than losing the whole scan.
                    foreach (string lnk in EnumerateFilesResilient(dir, "*.lnk"))
                    {
                        try
                        {
                            object shortcut = shellType.InvokeMember("CreateShortcut",
                                BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
                            object targetObj = shortcut.GetType().InvokeMember("TargetPath",
                                BindingFlags.GetProperty, null, shortcut, null);
                            string target = targetObj as string;

                            if (target != null &&
                                Path.GetFullPath(target).StartsWith(ourAppDirNormalized, StringComparison.OrdinalIgnoreCase))
                            {
                                File.Delete(lnk);
                            }
                        }
                        catch
                        {
                            // Unreadable/locked shortcut - leave it alone rather than guess.
                        }
                    }
                }
            }
            catch
            {
                // Best-effort only: never block startup over this.
            }
            finally
            {
                if (shell != null) Marshal.ReleaseComObject(shell);
            }
        }

        /// <summary>
        /// Like Directory.GetFiles(dir, pattern, AllDirectories), but a
        /// subfolder that throws (e.g. access denied) is skipped instead of
        /// aborting the whole enumeration.
        /// </summary>
        private static System.Collections.Generic.IEnumerable<string> EnumerateFilesResilient(string dir, string pattern)
        {
            string[] files;
            try
            {
                files = Directory.GetFiles(dir, pattern);
            }
            catch
            {
                yield break;
            }
            foreach (string f in files) yield return f;

            string[] subDirs;
            try
            {
                subDirs = Directory.GetDirectories(dir);
            }
            catch
            {
                yield break;
            }
            foreach (string sub in subDirs)
            {
                foreach (string f in EnumerateFilesResilient(sub, pattern)) yield return f;
            }
        }

        private static List<string> TraceDirs()
        {
            var dirs = new List<string>();
            Action<string, string[]> add = (envVar, parts) =>
            {
                // 環境変数が空だと相対パス "Floorp" になり、カレントフォルダ直下を
                // 消してしまうため、絶対パスが得られるものだけを対象にする。
                string baseDir = Environment.GetEnvironmentVariable(envVar);
                if (string.IsNullOrEmpty(baseDir) || !Path.IsPathRooted(baseDir)) return;
                string[] all = new string[parts.Length + 1];
                all[0] = baseDir;
                Array.Copy(parts, 0, all, 1, parts.Length);
                dirs.Add(Path.Combine(all));
            };
            add("APPDATA", new[] { "Floorp" });
            add("LOCALAPPDATA", new[] { "Floorp" });
            add("USERPROFILE", new[] { "AppData", "LocalLow", "Floorp" });
            add("USERPROFILE", new[] { "AppData", "Roaming", "Floorp" });
            return dirs;
        }

        internal static List<string> ExistingTraceDirs()
        {
            var existing = new List<string>();
            foreach (string dir in TraceDirs())
            {
                if (Directory.Exists(dir)) existing.Add(Path.GetFullPath(dir).TrimEnd('\\'));
            }
            return existing;
        }

        /// <summary>
        /// Deletes only the trace folders that did not exist yet when this
        /// launch started (<paramref name="existedBefore"/>), so an installed
        /// (non-portable) Floorp's own data under the same names is never touched.
        /// </summary>
        internal static void RunCleanup(List<string> existedBefore)
        {
            foreach (string dir in TraceDirs())
            {
                try
                {
                    string full = Path.GetFullPath(dir).TrimEnd('\\');
                    if (existedBefore.Exists(d => string.Equals(d, full, StringComparison.OrdinalIgnoreCase)))
                    {
                        continue;
                    }
                    if (Directory.Exists(full))
                    {
                        Directory.Delete(full, true);
                    }
                }
                catch
                {
                    // Best-effort: files may be locked briefly after the browser exits.
                }
            }
        }

        /// <summary>
        /// Registers this launcher as a candidate default browser under
        /// HKEY_CURRENT_USER (no admin rights required), using the same
        /// Capabilities / RegisteredApplications convention real Firefox
        /// uses for its own "Make Default Browser" button. The registered
        /// open command points at Floorp-Launcher.exe itself (not
        /// floorp.exe directly), so links opened by Windows still go
        /// through our --profile / config.js / policies.json setup.
        ///
        /// This only makes the launcher SHOW UP as a choice in Windows'
        /// own "Default apps" settings - it deliberately does not, and
        /// cannot, select it. Since Windows 10, the UserChoice registry
        /// key that actually decides the default is hash-protected
        /// specifically so no application (even an elevated one) can
        /// silently flip it; only the user's own click in that UI can.
        /// Only ever invoked explicitly via
        /// "Floorp-Launcher.exe --set-default-browser" - never as a side
        /// effect of a normal launch.
        /// </summary>
        private static void RegisterAsDefaultBrowserCandidate(string root, string appDir)
        {
            try
            {
                string launcherExe = Path.Combine(root, "Floorp-Launcher.exe");
                string iconPath = Path.Combine(appDir, "floorp.exe") + ",0";
                string openCommand = "\"" + launcherExe + "\" \"%1\"";

                // 前の版の登録(Capabilities の場所が違う)を先に片付ける
                DeleteRegistryKeyIfExists(Registry.CurrentUser, LegacyCapabilitiesKey);

                // .html などのファイル用
                WriteBrowserProgId(BrowserProgId, "Floorp-Launcher Document", false, iconPath, openCommand);
                // http / https 用
                WriteBrowserProgId(BrowserUrlProgId, "Floorp-Launcher URL", true, iconPath, openCommand);

                using (RegistryKey clientKey = Registry.CurrentUser.CreateSubKey(BrowserClientKey))
                {
                    clientKey.SetValue("", BrowserDisplayName);
                    using (RegistryKey iconKey = clientKey.CreateSubKey("DefaultIcon"))
                    {
                        iconKey.SetValue("", iconPath);
                    }
                    using (RegistryKey cmdKey = clientKey.CreateSubKey(@"shell\open\command"))
                    {
                        cmdKey.SetValue("", "\"" + launcherExe + "\"");
                    }

                    using (RegistryKey capKey = clientKey.CreateSubKey("Capabilities"))
                    {
                        capKey.SetValue("ApplicationName", BrowserDisplayName);
                        capKey.SetValue("ApplicationDescription", BrowserDescription());
                        capKey.SetValue("ApplicationIcon", iconPath);

                        using (RegistryKey urlAssoc = capKey.CreateSubKey("URLAssociations"))
                        {
                            urlAssoc.SetValue("http", BrowserUrlProgId);
                            urlAssoc.SetValue("https", BrowserUrlProgId);
                        }
                        using (RegistryKey fileAssoc = capKey.CreateSubKey("FileAssociations"))
                        {
                            fileAssoc.SetValue(".htm", BrowserProgId);
                            fileAssoc.SetValue(".html", BrowserProgId);
                            fileAssoc.SetValue(".shtml", BrowserProgId);
                            fileAssoc.SetValue(".xht", BrowserProgId);
                            fileAssoc.SetValue(".xhtml", BrowserProgId);
                        }
                        using (RegistryKey startMenu = capKey.CreateSubKey("StartMenu"))
                        {
                            startMenu.SetValue("StartMenuInternet", BrowserRegName);
                        }
                    }
                }

                using (RegistryKey regAppsKey = Registry.CurrentUser.CreateSubKey(@"Software\RegisteredApplications"))
                {
                    regAppsKey.SetValue(BrowserRegName, BrowserClientKey + @"\Capabilities");
                }

                // 関連付けが変わったことを Explorer などに知らせる(しないと反映が遅れることがある)
                NotifyAssociationChanged();

                MessageBox.Show(
                    L("既定のブラウザの候補として登録しました。\n\n" +
                      "続けて Windows の「既定のアプリ」設定を開きます。\n" +
                      "一覧から \"Floorp-Launcher\" を選んでください。\n\n" +
                      "(Windowsの仕様上、最終的な選択は必ずご自身の操作が必要です。" +
                      "アプリが自動で選択することはできません。)\n\n" +
                      "このフォルダを別の場所に移動した場合は、このコマンドを" +
                      "もう一度実行して登録し直してください。",
                      "Registered as a default browser candidate.\n\n" +
                      "Windows' \"Default apps\" settings will open next.\n" +
                      "Choose \"Floorp-Launcher\" from the list.\n\n" +
                      "(Windows requires you to make the final choice yourself; " +
                      "apps can't select it automatically.)\n\n" +
                      "If you move this folder, run this command again to re-register."),
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Information);

                Process.Start(new ProcessStartInfo
                {
                    FileName = "ms-settings:defaultapps",
                    UseShellExecute = true,
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    L("既定のブラウザ候補への登録に失敗しました。\n\n", "Couldn't register as a default browser candidate.\n\n") + ex.Message,
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>
        /// Undoes exactly what RegisterAsDefaultBrowserCandidate wrote:
        /// the two ProgID keys, the StartMenuInternet key (plus the
        /// Capabilities key older versions wrote), and our one value under
        /// RegisteredApplications (only that value - the key itself is
        /// shared with other applications' registrations, so it is never
        /// deleted wholesale). Only ever invoked explicitly via
        /// "Floorp-Launcher.exe --remove-default-browser".
        ///
        /// If Floorp Portable is currently the actual selected default,
        /// Windows is left pointing at a ProgID that no longer resolves.
        /// We cannot fix that up for the user - selecting a replacement
        /// default is subject to the same UserChoice protection as
        /// selecting this one was, so it always requires the user's own
        /// click in Settings, never an app.
        /// </summary>
        private static void UnregisterAsDefaultBrowserCandidate()
        {
            try
            {
                DeleteRegistryKeyIfExists(Registry.CurrentUser, @"Software\Classes\" + BrowserProgId);
                DeleteRegistryKeyIfExists(Registry.CurrentUser, @"Software\Classes\" + BrowserUrlProgId);
                DeleteRegistryKeyIfExists(Registry.CurrentUser, BrowserClientKey);
                DeleteRegistryKeyIfExists(Registry.CurrentUser, LegacyCapabilitiesKey);

                using (RegistryKey regAppsKey = Registry.CurrentUser.OpenSubKey(@"Software\RegisteredApplications", writable: true))
                {
                    if (regAppsKey != null && regAppsKey.GetValue(BrowserRegName) != null)
                    {
                        regAppsKey.DeleteValue(BrowserRegName, false);
                    }
                }

                NotifyAssociationChanged();

                MessageBox.Show(
                    L("既定のブラウザ候補の登録を解除しました。\n\n" +
                      "もし現在この Floorp-Launcher が実際に既定として選ばれていた" +
                      "場合、Windows側は無効な登録を指したままになります。" +
                      "「既定のアプリ」設定から別のブラウザを選び直してください" +
                      "(これも仕様上、アプリ側からは代わりに選び直せません)。",
                      "Removed the default browser candidate registration.\n\n" +
                      "If Floorp-Launcher is currently the default browser, " +
                      "Windows will keep pointing at the removed registration. " +
                      "Choose another browser in the \"Default apps\" settings " +
                      "(apps can't do this for you either)."),
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    L("既定のブラウザ候補の登録解除に失敗しました。\n\n", "Couldn't remove the default browser candidate registration.\n\n") + ex.Message,
                    "Floorp Launcher", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        /// <summary>
        /// ブラウザ用の ProgID を 1 つ書く。isUrl のときは http / https 用("URL Protocol" 付き)。
        /// Application サブキーは Windows の「アプリを選ぶ」画面に出る名前のため。無いと開く exe
        /// (Floorp-Launcher.exe。製品名が空)やアイコンの floorp.exe から取り、「Floorp」と出て見分けられなくなる
        /// </summary>
        private static void WriteBrowserProgId(string progId, string friendlyName, bool isUrl, string iconPath, string openCommand)
        {
            using (RegistryKey progIdKey = Registry.CurrentUser.CreateSubKey(@"Software\Classes\" + progId))
            {
                progIdKey.SetValue("", friendlyName);
                if (isUrl)
                {
                    progIdKey.SetValue("URL Protocol", "");
                    // FTA_Show: Firefox の URL 用 ProgID と同じ
                    progIdKey.SetValue("EditFlags", 2, RegistryValueKind.DWord);
                }
                using (RegistryKey iconKey = progIdKey.CreateSubKey("DefaultIcon"))
                {
                    iconKey.SetValue("", iconPath);
                }
                using (RegistryKey appKey = progIdKey.CreateSubKey("Application"))
                {
                    appKey.SetValue("ApplicationName", BrowserDisplayName);
                    appKey.SetValue("ApplicationDescription", BrowserDescription());
                    appKey.SetValue("ApplicationIcon", iconPath);
                    appKey.SetValue("ApplicationCompany", BrowserDisplayName);
                }
                using (RegistryKey cmdKey = progIdKey.CreateSubKey(@"shell\open\command"))
                {
                    cmdKey.SetValue("", openCommand);
                }
            }
        }

        [DllImport("shell32.dll")]
        private static extern void SHChangeNotify(int wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);

        private static void NotifyAssociationChanged()
        {
            try
            {
                // SHCNE_ASSOCCHANGED / SHCNF_FLUSH
                SHChangeNotify(0x08000000, 0x1000, IntPtr.Zero, IntPtr.Zero);
            }
            catch (Exception ex)
            {
                // 通知できなくても登録自体は済んでいる(反映が遅れるだけ)
                Debug.WriteLine("[Floorp-Launcher] SHChangeNotify に失敗: " + ex.Message);
            }
        }

        private static void DeleteRegistryKeyIfExists(RegistryKey baseKey, string subKeyPath)
        {
            using (RegistryKey key = baseKey.OpenSubKey(subKeyPath))
            {
                if (key != null)
                {
                    baseKey.DeleteSubKeyTree(subKeyPath);
                }
            }
        }
    }
}
