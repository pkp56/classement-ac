@echo off
REM ============================================================
REM  GDSP - live timing : demarrage de l'agent (serveur CM / AC)
REM  Double-clique ce fichier. A laisser ouvert pendant la session.
REM ============================================================
setlocal

REM --- 1. Le site qui recoit les donnees ----------------------
set SITE_URL=https://classement-ac-1.onrender.com

REM --- 2. Le jeton : la MEME valeur que LIVE_PUSH_TOKEN sur Render
set PUSH_TOKEN=change-moi

REM --- 3. Mode A : serveur lance par Content Manager sur CE PC --
REM     (lit directement l'UDP d'acServer, donnees completes)
REM     Mettre REM devant la ligne set WATCH_URL=... ci-dessous
REM     si tu veux suivre un serveur distant a la place.
set WATCH_URL=

REM --- Verifications avant de lancer ---------------------------
if "%PUSH_TOKEN%"=="change-moi" (
  echo.
  echo [ERREUR] Ouvre ce fichier avec le Bloc-notes et remplace "change-moi"
  echo          par le jeton defini dans Render ^(variable LIVE_PUSH_TOKEN^).
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERREUR] Node.js n'est pas installe.
  echo          Telecharge la version LTS sur https://nodejs.org puis relance.
  echo.
  pause
  exit /b 1
)

REM Le dossier de l'agent = dossier parent de ce .bat
cd /d "%~dp0\..\.."

echo.
echo Lancement de l'agent GDSP live timing...
echo   site : %SITE_URL%
echo   Ctrl+C pour arreter.
echo.
node tools\live-timing\agent.js

echo.
echo Agent termine. Appuie sur une touche pour fermer.
pause >nul
