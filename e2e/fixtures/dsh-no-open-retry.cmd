@echo off
setlocal
set "fixture_dir=%~dp0"

if "%~1"=="--version" (
  echo 0.1.0-rc.7
  exit /b 0
)

if not "%~1"=="web" (
  >&2 echo expected web command
  exit /b 2
)

shift
set "fixture_host=127.0.0.1"
set "fixture_port="

:parse
if "%~1"=="" goto parsed
if "%~1"=="--no-open" (
  >&2 echo error: unknown option '--no-open'
  exit /b 1
)
if "%~1"=="--host" (
  set "fixture_host=%~2"
  shift
  shift
  goto parse
)
if "%~1"=="--port" (
  set "fixture_port=%~2"
  shift
  shift
  goto parse
)
shift
goto parse

:parsed
if "%fixture_port%"=="" (
  >&2 echo missing --port
  exit /b 2
)

python "%fixture_dir%dsh-runtime-host.py" "%fixture_host%" "%fixture_port%"
