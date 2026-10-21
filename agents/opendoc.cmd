@echo off
rem Runs a buddy on the OpenDoc agent (docs/opendoc-agent.md): opendoc.mjs,
rem next to this script, on your own node. Yours to change.
node "%~dp0opendoc.mjs"
exit /b %errorlevel%
