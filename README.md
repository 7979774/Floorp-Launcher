# Floorp-Launcher とスクリプト集

[English](README.en.md)

Floorp のポータブル版で userChrome.js を使うための一式。自分用。

非公式。Floorp・Mozilla とは無関係(Floorp は Floorp の開発者の登録商標、Firefox は Mozilla Foundation の商標)。

## 中身

- [`Floorp-Launcher/`](Floorp-Launcher/) … Floorp を起動するランチャー。公式の `floorp-portable.exe` の代わり
- [`userscripts/`](userscripts/) … userChrome.js 用のスクリプト
- [`patches/`](patches/) … 新しい Floorp で動かすための修正

## 使い方

1. [Releases](../../releases) の zip を好きな場所に展開
2. `Floorp-Launcher.exe` を起動(初回は Floorp 本体を自動でダウンロード)
3. userChrome.js を使うなら、展開したフォルダの `extras\README.md`

- 詳しくは [`Floorp-Launcher/package/README.md`](Floorp-Launcher/package/README.md)
- 公式のポータブル版は起動のたびに userChrome.js 用のファイルを消すので、その代わりに作った
- Windows 11 + Floorp 12.21 で使用中。Floorp の更新で動かなくなることあり

## ビルド

- `Floorp-Launcher\Build.bat` → `Floorp-Launcher\dist\`
- 必要なもの: .NET Framework 4.x(Windows 10 / 11 に最初から入っている)

## ライセンス

[MPL-2.0](LICENSE)。無保証。

## サードパーティコード

- [Floorp](https://github.com/Floorp-Projects/Floorp)(MPL-2.0) … 公式の [Floorp Portable v2](https://github.com/Floorp-Projects/Floorp-Portable-v2) をダウンロードして起動。本体は含まない
- [onemen/firefox-scripts](https://github.com/onemen/firefox-scripts)(MPL-2.0。元は [xiaoxiaoflood/firefox-scripts](https://github.com/xiaoxiaoflood/firefox-scripts)) … userChrome.js のローダー。`config.js` と `config-prefs.js` をランチャーに埋め込んでいる
- `patches/` の修正は元のソフトのライセンスに従う
