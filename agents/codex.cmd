@echo off
rem Runs a buddy on Codex (docs/agent-config.md): the prompt on stdin, the
rem doc's copy in the working folder, the reply on stdout. Yours to change.
rem It reads the project without --add-dir, which would make it writable.
set "REPLY=%TEMP%\opendoc-reply-%RANDOM%.txt"
call codex exec --sandbox workspace-write --skip-git-repo-check --output-last-message "%REPLY%" - 1>&2
set "STATUS=%errorlevel%"
type "%REPLY%" 2>nul
del "%REPLY%" 2>nul
exit /b %STATUS%
