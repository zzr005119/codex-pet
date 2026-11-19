Option Explicit
Dim filesystem, root, flag
Set filesystem = CreateObject("Scripting.FileSystemObject")
root = filesystem.GetParentFolderName(filesystem.GetParentFolderName(WScript.ScriptFullName))
Set flag = filesystem.CreateTextFile(root & "\data\stop-bridge", True)
flag.WriteLine "stop"
flag.Close
