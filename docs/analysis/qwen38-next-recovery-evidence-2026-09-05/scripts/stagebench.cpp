#include <cstring>
#include <cstdint>
#include <thread>
#include <vector>
#include <chrono>
// Replicates stage_copy_trellis: for `experts` experts, copy 3 matrices of `mat_bytes` from
// random offsets in `src` (arena) into `dst` sequentially, in `chunk`-byte memcpys, over `threads`.
extern "C" __declspec(dllexport) double stage_bench(const uint8_t* src, size_t src_bytes, uint8_t* dst,
    int experts, size_t mat_bytes, size_t chunk, int threads, int reps)
{
    const int units = experts * 3;
    std::vector<size_t> offs(units);
    uint64_t r = 88172645463325252ull;
    for (int u = 0; u < units; ++u) { r ^= r << 13; r ^= r >> 7; r ^= r << 17; offs[u] = (r % (src_bytes / mat_bytes - 1)) * mat_bytes; }
    auto t0 = std::chrono::steady_clock::now();
    for (int rep = 0; rep < reps; ++rep)
    {
        std::vector<std::thread> ts;
        for (int t = 0; t < threads; ++t)
            ts.emplace_back([&, t]() {
                for (int u = t; u < units; u += threads)
                    for (size_t o = 0; o < mat_bytes; o += chunk)
                        std::memcpy(dst + size_t(u) * mat_bytes + o, src + offs[u] + o, chunk);
            });
        for (auto& th : ts) th.join();
    }
    double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    return double(units) * mat_bytes * reps / s / 1e9;
}
