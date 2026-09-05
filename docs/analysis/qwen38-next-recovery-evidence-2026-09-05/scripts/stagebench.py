import ctypes, mmap, numpy as np, torch
from multiprocessing import shared_memory
dll = ctypes.CDLL("C:/Users/denys/Documents/GitHub/SiftKit/.scratch-qwen38-replay/stagebench.dll")
dll.stage_bench.restype = ctypes.c_double
dll.stage_bench.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_int, ctypes.c_size_t, ctypes.c_size_t, ctypes.c_int, ctypes.c_int]
SRC = 4 << 30
arena = mmap.mmap(-1, SRC)
a = np.frombuffer(arena, dtype = np.uint8); a[::4096] = 1
src = a.ctypes.data
MAT = 819200; EXPERTS = 24; DST = EXPERTS * 3 * MAT
d_plain = np.zeros(DST + 4096, dtype = np.uint8)
shm = shared_memory.SharedMemory(create = True, size = DST + 4096)
d_shm = np.frombuffer(shm.buf, dtype = np.uint8); d_shm[:] = 0
shm2 = shared_memory.SharedMemory(create = True, size = DST + 4096)
d_pin = np.frombuffer(shm2.buf, dtype = np.uint8); d_pin[:] = 0
assert int(torch.cuda.cudart().cudaHostRegister(d_pin.ctypes.data, DST + 4096, 3)) == 0
for name, d in (("malloc", d_plain), ("shm", d_shm), ("shm+pinned", d_pin)):
    for chunk in (1024, MAT):
        for th in (1, 8):
            gbs = dll.stage_bench(src, SRC, d.ctypes.data, EXPERTS, MAT, chunk, th, 20)
            print(f"dst={name:11s} chunk={chunk:7d} threads={th}: {gbs:6.1f} GB/s", flush = True)
torch.cuda.cudart().cudaHostUnregister(d_pin.ctypes.data)
