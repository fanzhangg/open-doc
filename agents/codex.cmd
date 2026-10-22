@echo off
rem Runs a buddy on Codex (docs/agent-config.md): the prompt on stdin, the
rem doc's copy in the working folder, the reply on stdout. Yours to change.
rem It reads the project without --add-dir, which would make it writable.
rem The model is Settings > Agents' if set (codex.json), else Codex's own.
set "MODEL="
if defined PONJO_SETTING_MODEL set MODEL=-m "%PONJO_SETTING_MODEL%"
set "REPLY=%TEMP%\ponjo-reply-%RANDOM%.txt"
call codex exec --sandbox workspace-write --skip-git-repo-check %MODEL% --output-last-message "%REPLY%" - 1>&2
set "STATUS=%errorlevel%"
type "%REPLY%" 2>nul
del "%REPLY%" 2>nul
exit /b %STATUS%
