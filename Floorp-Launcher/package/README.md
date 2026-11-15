# Floorp-Launcher

[English](README.en.md)

Floorp のポータブル版を起動するランチャー。公式の `floorp-portable.exe` の代わりに使う。userChrome.js 用のファイルが消えない。

## 使い方

- フォルダを好きな場所に置いて `Floorp-Launcher.exe` を起動
- 初回は Floorp 本体を自動でダウンロードして `app\` に入れる
- フォルダごと移動しても使える
- バックアップは `data\`(プロファイル)だけでよい

```
Floorp-Launcher\
├── Floorp-Launcher.exe
├── floorp-launcher.sample.json   設定の見本
├── SetDefaultBrowser.bat          既定のブラウザにするとき
├── RemoveDefaultBrowser.bat       既定のブラウザをやめるとき
├── extras\                        userChrome.js 用のファイル
├── app\                           Floorp 本体(初回に作られる)
└── data\                          プロファイル
```

## 更新

- 起動したときに新しい版があれば聞いてくる → 「はい」で自動で入れ替え
- 失敗しても今の版のまま

## プロファイル

- ≡ メニューのいちばん上 → プロファイルの一覧
- 作る・複製・名前の変更・アイコン・並び替え・既定にする・別のウィンドウで起動
- ツールバーに置くなら、カスタマイズで「プロファイル」を置く
- Floorp を開いたままもう一度 `Floorp-Launcher.exe` → 起動するプロファイルを選ぶ画面

## 設定(任意)

- `floorp-launcher.sample.json` をコピーして `floorp-launcher.json` に名前を変える

```json
{
  "profile": "default",
  "checkForUpdates": true,
  "cleanup": false,
  "multipleInstances": false
}
```

- `profile` … 起動するプロファイルの名前
- `checkForUpdates` … `false` で更新の確認をしない
- `cleanup` … `true` で、終了時に Floorp がパソコンに作ったフォルダ(`%APPDATA%\Floorp` など)を消す(前からあったものは消さない)
- `multipleInstances` … 同じプロファイルを 2 つ起動できるようにする。不安定なので `false` のまま推奨

## 既定のブラウザ

- `SetDefaultBrowser.bat` を実行 → 開いた「既定のアプリ」で「Floorp-Launcher」を選ぶ
- フォルダを移動したら、もう一度 `SetDefaultBrowser.bat`
- やめるとき: `RemoveDefaultBrowser.bat` → 「既定のアプリ」で別のブラウザを選ぶ

## 削除

- 既定のブラウザにしていたら、先に `RemoveDefaultBrowser.bat`
- あとはフォルダごと削除

## userChrome.js

- `extras\README.md`

## うまく動かないとき

- 「〜という名前に対応するフォルダが複数見つかりました」→ `data\profile\` に同じ名前のフォルダが 2 つある。
  `data\profiles.json` に使う方を書く(例: `{ "default": "abcd1234.default" }`)
- ダウンロード・更新に失敗 → ネットワークを確認して起動し直す
