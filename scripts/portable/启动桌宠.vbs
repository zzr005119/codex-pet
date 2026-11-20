Option Explicit
Dim shell, filesystem, root, stopFile
Set shell = CreateObject("WScript.Shell")
Set filesystem = CreateObject("Scripting.FileSystemObject")
root = filesystem.GetParentFolderName(WScript.ScriptFullName)
If Not filesystem.FileExists(root & "\bridge\runtime\node.exe") Or _
    Not filesystem.FileExists(root & "\app\resources\app.asar") Then
    MsgBox "Extract the entire ZIP before launching Codex Pet.", vbExclamation, "Codex Pet"
    WScript.Quit 1
End If
stopFile = root & "\data\stop-bridge"
If filesystem.FileExists(stopFile) Then filesystem.DeleteFile stopFile, True
shell.CurrentDirectory = root
shell.Environment("Process")("DSH_PET_PORTABLE") = "1"
shell.Run """bridge\runtime\node.exe"" ""bridge\watch.mjs""", 0, False
