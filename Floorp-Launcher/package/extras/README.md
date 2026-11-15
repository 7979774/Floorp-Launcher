# extras

[English](README.en.md)

userChrome.js を使うためのファイル。使わないなら無視してよい。

```
extras\
├── tabmixplus\     Floorp 12.21 で動くように直した Tab Mix Plus
└── userscripts\    userChrome.js 用のスクリプト
```

## 1. ローダーを入れる(最初に 1 回)

- ≡ メニューのいちばん上 → プロファイルの一覧 → 「</>」
- 「Firefox Scripts Updater」のタブが出たら、更新してよい

## 2. スクリプトを入れる

- 使うスクリプトを、プロファイルの `chrome\` フォルダ(`utils\` があるところ)に入れて再起動
- プロファイルのフォルダは `data\profile\` の中
- 各スクリプトの説明は GitHub の `userscripts/README.md`

## Tab Mix Plus

- `tabmixplus\` の XPI を、プロファイルの `extensions\` フォルダに
  `{dc572301-7619-498c-a57d-39143191b318}.xpi` という名前で入れる → 再起動 → `about:addons` で有効にする
- 公式の Tab Mix Plus が Floorp 12.21 に対応したら、[公式版](https://github.com/onemen/TabMixPlus/releases)に戻す

## Tab Groups を使うとき

- `about:config` で `floorp.workspaces.enabled` を `false` にする(Floorp のワークスペースとぶつかる)
