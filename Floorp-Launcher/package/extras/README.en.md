# extras

[日本語](README.md)

Files for using userChrome.js. Ignore them if you don't need it.

```
extras\
├── tabmixplus\     Tab Mix Plus fixed for Floorp 12.21
└── userscripts\    scripts for userChrome.js
```

## 1. Install the loader (once)

- Top of the ≡ menu → profile list → "</>"
- If a "Firefox Scripts Updater" tab opens, it's fine to update

## 2. Add scripts

- Put the scripts you want in the profile's `chrome\` folder (where `utils\` is) and restart
- Profile folders are in `data\profile\`
- What each script does: `userscripts/README.en.md` on GitHub

## Tab Mix Plus

- Put the XPI from `tabmixplus\` in the profile's `extensions\` folder,
  named `{dc572301-7619-498c-a57d-39143191b318}.xpi` → restart → enable it in `about:addons`
- When the official Tab Mix Plus supports Floorp 12.21, switch back to the [official version](https://github.com/onemen/TabMixPlus/releases)

## When using Tab Groups

- Set `floorp.workspaces.enabled` to `false` in `about:config` (it conflicts with Floorp's workspaces)
