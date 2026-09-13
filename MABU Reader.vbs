' Launches mabu-open.py with pythonw.exe so no console window appears.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
pythonwPath = "pythonw"
scriptPath = """" & scriptDir & "\mabu-open.py" & """"
shell.Run pythonwPath & " " & scriptPath, 0, False
