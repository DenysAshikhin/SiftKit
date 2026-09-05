# Regression harness for the CPU MoE kernel: load one real layer's experts, run
# exl3_moe_cpu_forward on fixed random inputs (decode-shaped and prefill-tail-shaped), and
# either save the outputs (--save) or compare against the saved file (--check). Work
# partitioning changes must reproduce the outputs exactly.
import sys, time, torch
sys.path.insert(0, "C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3")
from exllamav3.ext import exllamav3_ext as ext
from exllamav3.loader.safetensors import SafetensorsCollection
from exllamav3.model.moe_cpu_host import _SharedArena as _HugeArena

MODEL = "D:/personal/models/elx3/td_flash-next_4.05bpw_h6_ng6"
LAYER = 7
E = 128            # first E experts of the layer
mode, out_path = sys.argv[1], sys.argv[2]
threads = int(sys.argv[3]) if len(sys.argv) > 3 else 12

stc = SafetensorsCollection(MODEL)
cpu = torch.device("cpu")
arena = _HugeArena()
swz = ext.exl3_moe_cpu_has_avx512_vbmi()
def fetch(proj):
    out = []
    for e in range(E):
        k = f"model.language_model.layers.{LAYER}.mlp.experts.{e}.{proj}_proj"
        tr = stc.get_tensor(k + ".trellis", cpu)
        tr = arena.rehome(tr, band_swizzle = swz and tr.shape[2] // 16 != 8)
        out.append((tr, arena.rehome(stc.get_tensor(k + ".suh", cpu, float2half = True)),
                    arena.rehome(stc.get_tensor(k + ".svh", cpu, float2half = True))))
    return out
g, u, d = fetch("gate"), fetch("up"), fetch("down")
h = ext.exl3_moe_cpu_make_layer([t[0] for t in g], [t[1] for t in g], [t[2] for t in g],
                                [t[0] for t in u], [t[1] for t in u], [t[2] for t in u],
                                [t[0] for t in d], [t[1] for t in d], [t[2] for t in d],
                                [], [], [], 0, 0.0, 1 if swz else 0)
H = 2560
gen = torch.Generator().manual_seed(1234)
cases = []
for rows, topk in ((1, 10), (3, 10), (64, 10), (17, 4)):
    x = (torch.randn(rows, H, generator = gen) * 0.5).half()
    sel = torch.stack([torch.randperm(E, generator = gen)[:topk] for _ in range(rows)]).to(torch.int32)
    w = torch.rand(rows, topk, generator = gen).half()
    cases.append((x, sel, w))
outs = []
for x, sel, w in cases:
    out = torch.empty(x.shape[0], H, dtype = torch.float)
    ext.exl3_moe_cpu_forward(h, x, sel, w, out, threads)
    outs.append(out.clone())
# timing on the decode shape
x, sel, w = cases[0]
out = torch.empty(1, H, dtype = torch.float)
for _ in range(20): ext.exl3_moe_cpu_forward(h, x, sel, w, out, threads)
t0 = time.perf_counter()
for _ in range(200): ext.exl3_moe_cpu_forward(h, x, sel, w, out, threads)
dt = (time.perf_counter() - t0) / 200
print(f"decode-shape forward: {dt*1e6:.0f} us/job ({topk} experts, {threads} threads)")
if mode == "--save":
    torch.save(outs, out_path); print("saved", out_path)
else:
    ref = torch.load(out_path)
    ok = all(torch.equal(a, b) for a, b in zip(ref, outs))
    print("bit-exact match:", ok)
    if not ok:
        for i, (a, b) in enumerate(zip(ref, outs)):
            print(i, "max abs diff", (a - b).abs().max().item())
        sys.exit(1)
