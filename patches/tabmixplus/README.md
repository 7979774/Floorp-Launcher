# Tab Mix Plus の修正

[English](README.en.md)

- [Tab Mix Plus](https://github.com/onemen/TabMixPlus) 1.49.0 は、Floorp 12.21 だと最初のウィンドウでほとんどの機能が動かない。それを直すパッチ
- 公式版で直ったら不要
- ライセンス: MPL-2.0(Tab Mix Plus と同じ)。直した XPI を配るときは、このパッチも一緒に公開する

## 直した XPI の作り方

```powershell
python -I build_patched_xpi.py <tab_mix_plus-x.y.z.xpi>
```

- `dist\` に `…-floorp-fix.xpi` ができる
- 入れ方は Floorp-Launcher の `extras\README.md`
- 署名のない XPI なので、Floorp-Launcher で起動した Floorp でしか入らない
