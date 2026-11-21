# Floorp-Launcher and scripts

[日本語](README.md)

A kit for using userChrome.js with the portable edition of Floorp. Made for my own use.

Unofficial. Not affiliated with Floorp or Mozilla (Floorp is a registered trademark of the Floorp developers, Firefox is a trademark of the Mozilla Foundation).

## Contents

- [`Floorp-Launcher/`](Floorp-Launcher/) … a launcher for Floorp. Use it instead of the official `floorp-portable.exe`
- [`userscripts/`](userscripts/) … scripts for userChrome.js
- [`userstyles/`](userstyles/) … CSS for the browser UI
- [`patches/`](patches/) … fixes for running on newer Floorp

## Usage

1. Extract the zip from [Releases](../../releases) anywhere
2. Run `Floorp-Launcher.exe` (the first run downloads Floorp itself)
3. For userChrome.js, see `extras\README.en.md` in the extracted folder

- Details: [`Floorp-Launcher/package/README.en.md`](Floorp-Launcher/package/README.en.md)
- The official portable edition deletes userChrome.js files on every start, so I made this instead
- Used on Windows 11 + Floorp 12.21. Floorp updates may break things

## Build

- `Floorp-Launcher\Build.bat` → `Floorp-Launcher\dist\`
- Needs: .NET Framework 4.x (built into Windows 10 / 11)

## License

[MPL-2.0](LICENSE). No warranty.

## Third-party code

- [Floorp](https://github.com/Floorp-Projects/Floorp) (MPL-2.0) … downloads and starts the official [Floorp Portable v2](https://github.com/Floorp-Projects/Floorp-Portable-v2). Floorp itself is not included
- [onemen/firefox-scripts](https://github.com/onemen/firefox-scripts) (MPL-2.0, originally [xiaoxiaoflood/firefox-scripts](https://github.com/xiaoxiaoflood/firefox-scripts)) … the userChrome.js loader. Its `config.js` and `config-prefs.js` are embedded in the launcher
- The fixes in `patches/` follow the license of the original software
