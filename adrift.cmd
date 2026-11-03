@echo off
rem Start Adrift on Windows (see scripts\adrift.ps1 for options).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\adrift.ps1" %*
