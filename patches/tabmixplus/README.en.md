# Tab Mix Plus fix

[日本語](README.md)

- [Tab Mix Plus](https://github.com/onemen/TabMixPlus) 1.49.0 barely works in the first window on Floorp 12.21. This patch fixes that
- Not needed once the official version fixes it
- License: MPL-2.0 (same as Tab Mix Plus). If you share the fixed XPI, publish this patch with it

## Making the fixed XPI

```powershell
python -I build_patched_xpi.py <tab_mix_plus-x.y.z.xpi>
```

- Creates `…-floorp-fix.xpi` in `dist\`
- How to install: `extras\README.en.md` of Floorp-Launcher
- The XPI is unsigned, so it only installs in Floorp started by Floorp-Launcher
