# End-to-end equivalence check for the CPU-offload engine changes: load the model exactly as the
# benchmarks do, prefill a fixed 2048-token chunk (exercises the streamed-prefill path), run 24
# greedy decode steps (exercises the decode handoff), and save/compare the last-position logits
# and the sampled tokens. usage: logits_check.py --save|--check <file> [model_init args...]
import sys, argparse, importlib.util, torch
from exllamav3 import model_init

def main():
    mode, path = sys.argv[1], sys.argv[2]
    parser = argparse.ArgumentParser()
    model_init.add_args(parser)
    args = parser.parse_args(sys.argv[3:])

    spec = importlib.util.spec_from_file_location(
        "perf", "C:/Users/denys/Documents/GitHub/SiftKit/pristine_exle/exllamav3/eval/perf.py")
    perf = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(perf)

    CHUNK, STEPS = 2048, 24
    model, config, cache, tokenizer = model_init.init(args, max_chunk_size = CHUNK)
    perf.load_workload_ids(tokenizer, CHUNK + STEPS + 512)
    is_recurrent = model.caps.get("recurrent_states", False)

    with torch.inference_mode():
        recurrent = [cache.get_test_state(0)] if is_recurrent else None
        params = {"attn_mode": "flash_attn", "cache": cache, "past_len": 0,
                  "batch_shape": (1, CHUNK + 512), "recurrent_states": recurrent}
        model.prefill(perf.workload_ids(0, CHUNK), params)
        ids = perf.workload_ids(CHUNK, 1)
        toks, logits_first = [], None
        for i in range(STEPS):
            params = {"attn_mode": "flash_attn", "cache": cache, "past_len": CHUNK + i,
                      "batch_shape": (1, CHUNK + 512), "recurrent_states": recurrent}
            logits = model.forward(ids, params).float()
            if logits_first is None:
                logits_first = logits[0, -1].cpu().clone()
            nxt = torch.argmax(logits[0, -1]).view(1, 1).cpu()
            toks.append(int(nxt))
            ids = nxt
        torch.cuda.synchronize()

    print("tokens:", toks)
    print("text:", repr(tokenizer.decode(torch.tensor([toks]))[0] if hasattr(tokenizer, "decode") else ""))
    if mode == "--save":
        torch.save({"toks": toks, "logits": logits_first}, path)
        print("saved", path)
    else:
        ref = torch.load(path)
        same = sum(a == b for a, b in zip(ref["toks"], toks))
        d = (ref["logits"] - logits_first)
        print(f"token agreement {same}/{STEPS}; first-step logits: max|diff| {d.abs().max():.4f}, "
              f"ref max|logit| {ref['logits'].abs().max():.2f}, argmax equal {int(ref['logits'].argmax()) == int(logits_first.argmax())}")


if __name__ == "__main__":
    main()
