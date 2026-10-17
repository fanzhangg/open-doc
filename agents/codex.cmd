@echo off
rem Runs a buddy on Codex (docs/agent-config.md): the prompt on stdin, the
rem doc's copy in the working folder, the reply on stdout. Yours to change.
set "ADD="
if defined OPENDOC_PROJECT set ADD=--add-dir "%OPENDOC_PROJECT%"
set "REPLY=%TEMP%\opendoc-reply-%RANDOM%.txt"
call codex exec --full-auto --skip-git-repo-check %ADD% --output-last-message "%REPLY%" - 1>&2
set "STATUS=%errorlevel%"
type "%REPLY%" 2>nul
del "%REPLY%" 2>nul
exit /b %STATUS%
