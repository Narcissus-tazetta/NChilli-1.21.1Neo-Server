@echo off
REM Forge requires a configured set of both JVM and program arguments.
REM Add custom JVM arguments to the user_jvm_args.txt
REM Add custom program arguments {such as nogui} to this file in the next line before the %* or
REM  pass them to this script directly
@REM "C:\Program Files\Java\graalvm-jdk-21.0.8+12.1\bin\java.exe" @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.209/win_args.txt %*
bun run .\run.ts
pause
