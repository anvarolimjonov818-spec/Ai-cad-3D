@echo off
title AI-CAD 3D Server
echo ========================================================
echo     AI-CAD 3D (PRO 2.0) Server ishga tushirilmoqda...
echo     Manzil: http://localhost:8000
echo ========================================================
echo.
if exist ".venv\Scripts\python.exe" (
    .venv\Scripts\python.exe backend/main.py
) else (
    python backend/main.py
)
pause
