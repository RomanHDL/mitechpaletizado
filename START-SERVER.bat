@echo off
title MI-TECH Paletizado - Server
color 0A

echo.
echo  ==========================================
echo   MI-TECH Paletizado - Iniciando sistema
echo  ==========================================
echo.

:: Verificar MySQL
net start MySQL84 2>nul
echo  [OK] MySQL verificado
echo.

:: Abrir dashboard en el navegador automaticamente
echo  Abriendo dashboard en el navegador...
start "" http://localhost:3009/index.html

:: Iniciar servidor + sync automatico
cd /d "%~dp0backend"
echo  API + Sync iniciados en http://localhost:3009
echo  Sync Google Sheets - MySQL cada 30 segundos
echo.
echo  Presiona Ctrl+C para detener
echo  ==========================================
echo.
node server.js

pause
