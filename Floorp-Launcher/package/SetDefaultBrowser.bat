@echo off
rem Registers Floorp-Launcher as a default browser candidate,
rem then opens Windows "Default apps" settings.
rem Windows requires you to make the final choice yourself.
"%~dp0Floorp-Launcher.exe" --set-default-browser
