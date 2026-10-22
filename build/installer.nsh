; Windows installer hooks (electron-builder's customInstall / customUnInstall).
;
; Ponjo registers as one of the apps that can open .md and .markdown files
; ("Open with" and "Choose another app"), and adds New > Markdown Document to
; Explorer's right-click menu. It never makes itself the default app: the user
; picks that in Windows. Uninstalling removes only what was added here.

!define PONJO_PROGID "Ponjo.md"
!define PONJO_MARK "Ponjo"

!macro ponjoRegisterType EXT
  WriteRegNone SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PONJO_PROGID}"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro ponjoUnregisterType EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PONJO_PROGID}"
!macroend

!macro customInstall
  ; The file type Ponjo opens docs as.
  WriteRegStr SHCTX "Software\Classes\${PONJO_PROGID}" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\${PONJO_PROGID}\DefaultIcon" "" '"$INSTDIR\resources\app\build\document.ico",0'
  WriteRegStr SHCTX "Software\Classes\${PONJO_PROGID}\shell\open\command" "" '"$appExe" "%1"'

  ; The app itself, as Windows lists it in "Open with".
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'

  !insertmacro ponjoRegisterType "md"
  !insertmacro ponjoRegisterType "markdown"

  ; New > Markdown Document creates an empty .md. Only if no other app has
  ; added a New entry for .md; ours is marked so uninstalling removes only it.
  ClearErrors
  EnumRegValue $0 SHCTX "Software\Classes\.md\ShellNew" 0
  ${If} ${Errors}
    WriteRegStr SHCTX "Software\Classes\.md\ShellNew" "NullFile" ""
    WriteRegStr SHCTX "Software\Classes\.md\ShellNew" "${PONJO_MARK}" "1"
  ${EndIf}

  ; Tell Explorer the file types changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro ponjoUnregisterType "md"
  !insertmacro ponjoUnregisterType "markdown"
  DeleteRegKey SHCTX "Software\Classes\${PONJO_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"

  ClearErrors
  ReadRegStr $0 SHCTX "Software\Classes\.md\ShellNew" "${PONJO_MARK}"
  ${IfNot} ${Errors}
  ${AndIf} $0 == "1"
    DeleteRegKey SHCTX "Software\Classes\.md\ShellNew"
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
