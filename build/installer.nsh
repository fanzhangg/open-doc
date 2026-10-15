; Windows installer hooks (electron-builder's customInstall / customUnInstall).
;
; OpenDoc registers as one of the apps that can open .md and .markdown files
; ("Open with" and "Choose another app"), and adds New > Markdown Document to
; Explorer's right-click menu. It never makes itself the default app: the user
; picks that in Windows. Uninstalling removes only what was added here.

!define OPENDOC_PROGID "OpenDoc.md"
!define OPENDOC_MARK "OpenDoc"

!macro openDocRegisterType EXT
  WriteRegNone SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${OPENDOC_PROGID}"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".${EXT}" ""
!macroend

!macro openDocUnregisterType EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${OPENDOC_PROGID}"
!macroend

!macro customInstall
  ; The file type OpenDoc opens docs as.
  WriteRegStr SHCTX "Software\Classes\${OPENDOC_PROGID}" "" "Markdown Document"
  WriteRegStr SHCTX "Software\Classes\${OPENDOC_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHCTX "Software\Classes\${OPENDOC_PROGID}\shell\open\command" "" '"$appExe" "%1"'

  ; The app itself, as Windows lists it in "Open with".
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\shell\open\command" "" '"$appExe" "%1"'

  !insertmacro openDocRegisterType "md"
  !insertmacro openDocRegisterType "markdown"

  ; New > Markdown Document creates an empty .md. Only if no other app has
  ; added a New entry for .md; ours is marked so uninstalling removes only it.
  ClearErrors
  EnumRegValue $0 SHCTX "Software\Classes\.md\ShellNew" 0
  ${If} ${Errors}
    WriteRegStr SHCTX "Software\Classes\.md\ShellNew" "NullFile" ""
    WriteRegStr SHCTX "Software\Classes\.md\ShellNew" "${OPENDOC_MARK}" "1"
  ${EndIf}

  ; Tell Explorer the file types changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  !insertmacro openDocUnregisterType "md"
  !insertmacro openDocUnregisterType "markdown"
  DeleteRegKey SHCTX "Software\Classes\${OPENDOC_PROGID}"
  DeleteRegKey SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"

  ClearErrors
  ReadRegStr $0 SHCTX "Software\Classes\.md\ShellNew" "${OPENDOC_MARK}"
  ${IfNot} ${Errors}
  ${AndIf} $0 == "1"
    DeleteRegKey SHCTX "Software\Classes\.md\ShellNew"
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
