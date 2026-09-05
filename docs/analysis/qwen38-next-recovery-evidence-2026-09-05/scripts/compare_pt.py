# usage: compare_pt.py a.pt b.pt  -- token agreement and first-step logit diff between two saved runs
import sys, torch
a, b = torch.load(sys.argv[1]), torch.load(sys.argv[2])
same = sum(x == y for x, y in zip(a["toks"], b["toks"]))
first_div = next((i for i, (x, y) in enumerate(zip(a["toks"], b["toks"])) if x != y), None)
d = a["logits"] - b["logits"]
print(f"token agreement {same}/{len(a['toks'])} (first divergence at {first_div}); first-step logits: "
      f"max|diff| {d.abs().max():.4f}, mean|diff| {d.abs().mean():.5f}, ref max|logit| {a['logits'].abs().max():.2f}, "
      f"argmax equal {int(a['logits'].argmax()) == int(b['logits'].argmax())}")
