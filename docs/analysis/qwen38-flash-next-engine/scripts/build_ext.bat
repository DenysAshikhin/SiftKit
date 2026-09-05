@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d C:\Users\denys\Documents\GitHub\SiftKit\pristine_exle\exllamav3
set CUDA_HOME=D:\personal\models\elx3\.tmp\turbo-match\cuda-13.2.2-build\toolkit
set CUDA_PATH=D:\personal\models\elx3\.tmp\turbo-match\cuda-13.2.2-build\toolkit
set PATH=D:\personal\models\elx3\.tmp\turbo-match\cuda-13.2.2-build\toolkit\bin;C:\envs\rl313-turbo\Scripts;%PATH%
set TORCH_CUDA_ARCH_LIST=8.9
set MAX_JOBS=12
set DISTUTILS_USE_SDK=1
set PYTHONDONTWRITEBYTECODE=1
C:\envs\rl313-turbo\Scripts\python.exe setup.py build_ext --inplace
echo BUILD_EXIT %ERRORLEVEL%
