# Floorp-Launcher

[日本語](README.md)

A launcher for the portable edition of Floorp. Use it instead of the official `floorp-portable.exe`. Your userChrome.js files don't get deleted.

## Usage

- Put the folder anywhere and run `Floorp-Launcher.exe`
- The first run downloads Floorp itself into `app\`
- You can move the whole folder
- Back up `data\` (profiles) only

```
Floorp-Launcher\
├── Floorp-Launcher.exe
├── floorp-launcher.sample.json   settings sample
├── SetDefaultBrowser.bat          to make it the default browser
├── RemoveDefaultBrowser.bat       to stop being the default browser
├── extras\                        files for userChrome.js
├── app\                           Floorp itself (created on first run)
└── data\                          profiles
```

## Updates

- On start, asks if a new version is available → "Yes" swaps it in automatically
- If it fails, the current version stays

## Profiles

- Top of the ≡ menu → profile list
- Create, duplicate, rename, set an icon, reorder, make default, open in another window
- For a toolbar button, add "Profiles" in Customize
- Run `Floorp-Launcher.exe` again while Floorp is open → choose which profile to start

## Settings (optional)

- Copy `floorp-launcher.sample.json` and rename it to `floorp-launcher.json`

```json
{
  "profile": "default",
  "checkForUpdates": true,
  "cleanup": false,
  "multipleInstances": false
}
```

- `profile` … name of the profile to start
- `checkForUpdates` … `false` to skip the update check
- `cleanup` … `true` to delete folders Floorp created on the PC (`%APPDATA%\Floorp` etc.) on exit (ones that existed before are kept)
- `multipleInstances` … allow starting the same profile twice. Unstable, keep `false`

## Default browser

- Run `SetDefaultBrowser.bat` → in "Default apps", choose "Floorp-Launcher"
- After moving the folder, run `SetDefaultBrowser.bat` again
- To stop: `RemoveDefaultBrowser.bat` → choose another browser in "Default apps"

## Removing

- If it's the default browser, run `RemoveDefaultBrowser.bat` first
- Then delete the folder

## userChrome.js

- `extras\README.en.md`

## Troubleshooting

- "Several folders match the name" → `data\profile\` has two folders with the same name.
  Write the one to use in `data\profiles.json` (e.g. `{ "default": "abcd1234.default" }`)
- Download or update fails → check the network and start again
