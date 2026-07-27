@echo off
:: omniark.cmd - Wrapper to call omniark.ps1 from CMD/prompt
:: Usage: omniark start|stop|restart|status|logs|build|dev|migrate

:: Resolve the real location of this script (follow symlinks)
set "SCRIPT_DIR=%~dp0"

:: Check if omniark.ps1 is in the same directory
if exist "%SCRIPT_DIR%omniark.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%omniark.ps1" %*
    exit /b %ERRORLEVEL%
)

:: Otherwise, check default install location
set "DEFAULT_DIR=%USERPROFILE%\omniark"
if exist "%DEFAULT_DIR%\omniark.ps1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%DEFAULT_DIR%\omniark.ps1" %*
    exit /b %ERRORLEVEL%
)

echo Error: Could not find omniark.ps1
echo Make sure OmniArk is installed.
exit /b 1
