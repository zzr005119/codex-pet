Option Explicit
Dim filesystem, root, flag
Set filesystem = CreateObject("Scripting.FileSystemObject")
root = filesystem.GetParentFolderName(WScript.ScriptFullName)
If Not filesystem.FolderExists(root & "\data") Then WScript.Quit 0
Set flag = filesystem.CreateTextFile(root & "\data\stop-bridge", True)
flag.WriteLine "stop"
flag.Close
