@echo off
rem Install Adrift on Windows (see install.ps1 for options, or: install.cmd -Help).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
