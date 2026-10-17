@echo off
rem Runs a buddy on Claude Code (docs/agent-config.md): the prompt on stdin,
rem the doc's copy in the working folder, the reply on stdout. Yours to change.
rem The project is read only: its files are the user's, not the copy.
set "ADD="
if not defined OPENDOC_PROJECT goto run
rem Claude Code matches C:\Users\me as /c/Users/me; //c/... is absolute.
set "P=%OPENDOC_PROJECT:\=/%"
for %%d in (a b c d e f g h i j k l m n o p q r s t u v w x y z) do call set "P=%%P:%%d:=/%%d%%"
set ADD=--add-dir "%OPENDOC_PROJECT%" --disallowedTools "Edit(/%P%/**)"
:run
call claude -p --permission-mode acceptEdits --no-session-persistence %ADD%
exit /b %errorlevel%
