# userChrome.js loader fix

[日本語](README.md)

- Fixes scripts only working in the first window on Floorp 11. Not needed on Floorp 12
- Target: the profile's `chrome\utils\userChrome.js` (the loader from [onemen/firefox-scripts](https://github.com/onemen/firefox-scripts))
- After applying it, use "Clear startup cache" in `about:support` and restart
- License: MPL-2.0 (same as the loader)
