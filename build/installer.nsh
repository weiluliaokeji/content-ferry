; ContentFerry NSIS installer hooks
;
; This file is referenced by `build.nsis.include` in package.json.
; Keep the file ASCII-only to avoid NSIS encoding issues with non-ASCII paths.

!macro customInstall
  ; After install completes, remind the user that ContentFerry will guide them
  ; through the data directory choice on first launch.
  DetailPrint "ContentFerry installed. The first launch will let you choose where to store your content."
!macroend

!macro customUnInstall
  ; The uninstaller must NOT remove the user's data directory, because content
  ; is the user's only authoritative copy. We surface a hint instead of
  ; auto-opening the folder, in case the path was relocated manually.
  DetailPrint "ContentFerry removed. Your content data was kept on disk; rerun the installer or delete it manually if you no longer need it."
!macroend
