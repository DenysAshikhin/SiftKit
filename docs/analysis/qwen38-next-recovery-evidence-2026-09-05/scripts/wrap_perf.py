# Attribute SharedMemory.__del__ noise: print this (parent) process's finalizer address first
import sys, runpy
import multiprocessing.shared_memory as s
print("parent SharedMemory.__del__ at", hex(id(s.SharedMemory.__del__)), file = sys.stderr, flush = True)
sys.argv = ["perf.py"] + sys.argv[1:]
runpy.run_path("C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3/eval/perf.py", run_name = "__main__")
