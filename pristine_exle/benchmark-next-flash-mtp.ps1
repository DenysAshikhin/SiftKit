$env:EXL3_LOAD_ARENA = '1'
$env:PYTHONPATH = "$PSScriptRoot\exllamav3"

git -C "$PSScriptRoot\exllamav3" fetch origin dev; git -C "$PSScriptRoot\exllamav3" switch --detach origin/dev
git -C "$PSScriptRoot\tabbyAPI" fetch origin main; git -C "$PSScriptRoot\tabbyAPI" switch --detach origin/main

& 'C:\envs\rl313-turbo\Scripts\python.exe' "$env:PYTHONPATH\eval\spec_decode.py" --model_dir 'D:\personal\models\elx3\td_flash-next_4.05bpw_h6_ng6' --moe_cpu_split 410 --moe_cpu_threads 12 --autosplit_max_batch_size 1 --mtp --dynamic_draft --chunk_size 2048 -ngr

#& 'C:\envs\rl313-turbo\Scripts\python.exe' "$env:PYTHONPATH\eval\spec_decode.py" --model_dir 'D:\personal\models\elx3\3.8_27b_4.9bpw' --mtp --dynamic_draft

