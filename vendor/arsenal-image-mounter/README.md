# Arsenal Image Mounter command-line tools

`aim_ll.exe` and its `aimapi.dll` from [Arsenal Image Mounter](https://arsenalrecon.com/products/arsenal-image-mounter).
SiftKit runs them to create, grow and remove the RAM disk that holds a preset's TabbyAPI disk cache
(`src/status-server/arsenal-ram-disk-driver.ts`).

The Arsenal Image Mounter driver (`phdskmnt`) must be installed on the machine; these files only drive it.
Every call except the lookup runs as administrator.
