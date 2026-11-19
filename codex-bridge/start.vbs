Option Explicit
Dim shell, root, filesystem, stopFile
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")
root = filesystem.GetParentFolderName(filesystem.GetParentFolderName(WScript.ScriptFullName))
stopFile = root & "\data\stop-bridge"
If filesystem.FileExists(stopFile) Then filesystem.DeleteFile stopFile, True
shell.Run """" & root & "\bridge\runtime\node.exe"" """ & root & "\bridge\watch.mjs""", 0, False
