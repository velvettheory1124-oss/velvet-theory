@echo off
title VELVET/THEORY - local server
cd /d "%~dp0"

echo.
echo   ==========================================
echo    VELVET/THEORY - starting local server
echo   ==========================================
echo.
echo   Opening the portfolio in your browser...
echo.
echo   Edit with the Arrange button, then press Publish
echo   in the editor bar to send it to the live site.
echo.
echo   Keep this black window OPEN while you work.
echo   Close it (or press Ctrl+C) when you are done.
echo.

rem give the server a moment, then open the browser
start "" /b cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8765/V2-PORTFOLIO.html"

rem serves this folder AND makes the Publish button work. 127.0.0.1 only.
python local-server.py --port 8765

rem if python exited immediately something is wrong - keep the window up so the error is readable
if errorlevel 1 (
  echo.
  echo   Server stopped unexpectedly. Error above.
  pause
)
