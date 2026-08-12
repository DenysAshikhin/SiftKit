; Uninstall removes the sign-in startup registration (spec §6: no orphaned Run entries).
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SiftKitAssistant"
!macroend
