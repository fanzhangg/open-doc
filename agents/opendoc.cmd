@echo off
rem Runs a buddy on the OpenDoc agent (docs/opendoc-agent.md): opendoc.mjs,
rem next to this script, on your own node. Yours to change.
where node >nul 2>nul
if errorlevel 1 (
  echo The OpenDoc agent runs on Node.js: install it from https://nodejs.org, with node on PATH. 1>&2
  exit /b 1
)
node "%~dp0opendoc.mjs"
exit /b %errorlevel%
