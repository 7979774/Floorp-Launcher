# Scripts for userChrome.js

[日本語](README.md)

- Install: put the scripts you want in the profile's `chrome\` folder (where `utils\` is) and restart. Needs the loader
- Used on Floorp 12.21

## NavWheelButton.uc.js

Back, Forward, Reload and Stop in one button.

- Takes the place of the Back button
- Scroll the wheel → history appears. Stop to go to that page
- Click → reload (stop while loading)
- Right-click → history list. Gear icon at the top right for settings

## UrlbarIconDrawer.uc.js

Tucks the icons at the right of the address bar behind a "<" button.

- Right-click an icon → "Hide icon"
- Click "<" to show the hidden icons
- Drag to reorder

## UrlbarExtensionButtons.uc.js

Puts extension buttons inside the address bar.

- Right-click a button → "Move to Address Bar" / "Remove from Address Bar"

## UrlbarUpLevel.uc.js

Go up a level in the URL.

- Hold Ctrl and click a separator in the URL → go there
- ↑ button in the address bar → list of upper levels

## SearchWordButtons.uc.js

Find and highlight the search box words on the page.

- Needs a search box in the toolbar
- The "A" button at the right of the box turns highlighting on and off
- Leaving the search box turns the words into buttons. Click for the next match, Shift+click for the previous one

## ContextMenuEditor.uc.js

Edit the page and tab context menus.

- The short line at the bottom of the menu → editor
- Hide, reorder, group into submenus, add separators
- "Done" saves, "Reset" restores the original order

## DownloadManagerPlus.uc.js

A download list that survives clearing history.

- Adds a button next to the Downloads button
- Panel: pause, resume, cancel, retry, open folder. × removes from the list (the file stays)
- Window icon → its own window (search, sort, delete several at once)
- "Delete File" does not use the Recycle Bin

## CookieManager.uc.js

View, edit, delete and export the cookies of the current site.

- Cookie icon in the address bar → panel
- Exported cookies are your logins. Don't share them

## TabGroupsWindow.uc.js

Open a [Tab Groups](https://github.com/117649/Tab-Groups) group in its own window.

- Needs Tab Groups 2.2.0 or later. Set `floorp.workspaces.enabled` to `false` in `about:config`
- Right-click a tab → "Open This Group in New Window"
- Closing that window puts the group back where it was in the original window

## TabGroupsHelptextFix.uc.js

- Fixes the first click sometimes not working in the Tab Groups settings page

## TabMixMultiRow.uc.js

Makes Tab Mix Plus multi-row tabs easier to use.

- Wheel over the tab scroll buttons → moves one row at a time
- Double-click the empty part of the last row → new tab
- Delete the old `TabScrollButtons.uc.js` if you have it

## rebuild_userChrome.uc.js

Script list and on/off switches.

- Open `about:userchromejs` (also "userChrome.js Scripts" in the ≡ menu)
- Changes take effect after a restart
- Don't rename this file
