import json
import pathlib
import sys
import time


def load_request():
    request = json.load(sys.stdin)
    tabby_root = pathlib.Path(request["tabbyRoot"])
    sys.path.insert(0, str(tabby_root))
    return request


def accepts(grammar_class, schema, tokenizer, text):
    handler = grammar_class()
    handler.add_json_schema_filter(json.loads(json.dumps(schema)), tokenizer)
    formatter = handler.filters[0]._formatter
    try:
        formatter.accept_bytes(text.encode("utf-8"))
    except ValueError:
        return False
    return True


def main():
    request = load_request()

    from exllamav3 import Config, Tokenizer
    from backends.exllamav3.grammar import ExLlamaV3Grammar, schema_filter_cache

    config = Config.from_directory(str(pathlib.Path(request["modelDir"]).resolve()))
    tokenizer = Tokenizer.from_config(config)
    schema_filter_cache.clear()

    started = time.perf_counter()
    first = ExLlamaV3Grammar()
    first.add_json_schema_filter(json.loads(json.dumps(request["schema"])), tokenizer)
    compile_ms = (time.perf_counter() - started) * 1000

    results = {
        entry["name"]: accepts(
            ExLlamaV3Grammar,
            request["schema"],
            tokenizer,
            entry["text"],
        )
        for entry in request["corpus"]
    }
    schema_filter_cache.clear()
    print(json.dumps({"compileMs": compile_ms, "results": results}))


if __name__ == "__main__":
    main()
