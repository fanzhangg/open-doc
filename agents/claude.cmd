@echo off
rem Runs a buddy on Claude Code (docs/agent-config.md): the prompt on stdin,
rem the doc's copy in the working folder, the reply on stdout. Yours to change.
set "ADD="
if defined OPENDOC_PROJECT set ADD=--add-dir "%OPENDOC_PROJECT%"
call claude -p --permission-mode acceptEdits --no-session-persistence %ADD%
exit /b %errorlevel%
