@echo off
setlocal

rem Compiles src\*.cs into dist\Floorp-Launcher.exe (with src\ProfileSwitcher.js
rem embedded as a resource) and copies the files that ship next to the exe
rem (package\*, extras) into dist\. Deploy by copying the contents of dist\.
rem dist\Floorp-Launcher.exe must not be running (it locks the file while
rem running) - close it first if the build fails with a "file in use" error.

set CSC="C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
set DIST=%~dp0dist

if not exist "%DIST%" mkdir "%DIST%"

rem ProfileSwitcher.js is embedded under the fixed name "ProfileSwitcher.js"
rem (Program.ProfileSwitcherResourceName) and written into app\ at startup.
%CSC% /nologo /platform:x64 /target:winexe /win32icon:"%~dp0src\launcher.ico" /out:"%DIST%\Floorp-Launcher.exe" ^
  /resource:"%~dp0src\ProfileSwitcher.js",ProfileSwitcher.js ^
  "%~dp0src\Program.cs" "%~dp0src\LauncherConfig.cs" "%~dp0src\MozLz4.cs" "%~dp0src\ProfileMap.cs"

if %ERRORLEVEL% neq 0 (
  echo.
  echo Build failed - see errors above.
  exit /b %ERRORLEVEL%
)

rem Older builds shipped ProfileSwitcher.js next to the exe; it's unused now.
if exist "%DIST%\ProfileSwitcher.js" del "%DIST%\ProfileSwitcher.js"

rem Only the sample config ships. A real floorp-launcher.json in dist\ would
rem overwrite the user's own settings when dist\ is copied over an install.
if exist "%DIST%\floorp-launcher.json" echo WARNING: dist\floorp-launcher.json exists - remove it so it doesn't overwrite settings on deploy.
copy /y "%~dp0package\floorp-launcher.sample.json" "%DIST%\" >nul || goto :copyfail
copy /y "%~dp0package\SetDefaultBrowser.bat" "%DIST%\" >nul || goto :copyfail
copy /y "%~dp0package\RemoveDefaultBrowser.bat" "%DIST%\" >nul || goto :copyfail
copy /y "%~dp0package\README.md" "%DIST%\" >nul || goto :copyfail
copy /y "%~dp0package\README.en.md" "%DIST%\" >nul || goto :copyfail

rem extras\README.md explains everything under extras\.
if not exist "%DIST%\extras\userscripts" mkdir "%DIST%\extras\userscripts"
copy /y "%~dp0package\extras\README.md" "%DIST%\extras\" >nul || goto :copyfail
copy /y "%~dp0package\extras\README.en.md" "%DIST%\extras\" >nul || goto :copyfail

rem userChrome.js scripts (..\userscripts\*.uc.js).
copy /y "%~dp0..\userscripts\*.uc.js" "%DIST%\extras\userscripts\" >nul || goto :copyfail

rem Patched Tab Mix Plus (built by ..\patches\tabmixplus\build_patched_xpi.py).
rem The .patch files ship alongside it as the source of the modification (MPL 2.0).
set TMP_SRC=%~dp0..\patches\tabmixplus
set TMP_DIST=%DIST%\extras\tabmixplus
if not exist "%TMP_SRC%\dist\*.xpi" (
  echo WARNING: no patched Tab Mix Plus XPI in %TMP_SRC%\dist - run build_patched_xpi.py first.
  goto :done
)
if not exist "%TMP_DIST%" mkdir "%TMP_DIST%"
copy /y "%TMP_SRC%\dist\*.xpi" "%TMP_DIST%\" >nul || goto :copyfail
copy /y "%TMP_SRC%\fix_*.patch" "%TMP_DIST%\" >nul || goto :copyfail

:done

echo.
echo Build OK: %DIST%
exit /b 0

:copyfail
echo.
echo Copying files into dist failed.
exit /b 1
