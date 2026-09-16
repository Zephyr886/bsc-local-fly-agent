"""Local full-connectome tests and paper replay; never imports a live executor."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "vendor/stonkfly"))
os.environ["STONKFLY_DATA"] = str(ROOT / "data/full-brain")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
from core import load_replay, PaperBook, OutcomeFeedback, advance_feedback

def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")

class MemoryMeter:
    def __init__(self):
        import psutil
        self.process = psutil.Process()
        self.peak = 0
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
    def run(self):
        while not self.stop.is_set():
            self.peak = max(self.peak, self.process.memory_info().rss)
            self.stop.wait(0.05)
    def finish(self):
        self.stop.set()
        self.thread.join()
        info = self.process.memory_info()
        return round(max(self.peak, info.rss, getattr(info, "peak_wset", 0)) / 1048576, 1)

def self_test(args):
    import numpy as np
    from stonkfly.data import verify
    from stonkfly.config import Settings
    from stonkfly.neural.controller import FlyController
    meter = MemoryMeter()
    started = time.perf_counter()
    graph = verify()
    emit({"phase": "loading_full_connectome", **graph})
    c = FlyController(Settings())
    assert len(c.brain.post) == 25582938 and len(c.brain.circuit["edges"]) == 7835
    assert len(c.brain.retina) == 3335 and len(c.brain.r8) == 811
    out = ROOT / args.out
    white = np.full((180, 320, 3), 255, np.uint8)
    timings = []
    def observe(kind):
        before = time.perf_counter()
        result = c.observe(white, kind)
        result["observation_wall_seconds"] = round(time.perf_counter() - before, 3)
        timings.append(result["observation_wall_seconds"])
        emit({"phase": "neural_observation", "stimulus": kind, "seconds": timings[-1], "kc_spikes": result["KC_spikes"], "side": result["side"]})
        return result
    for _ in range(3):
        observe("none")
    checkpoint = out / "before.npz"
    c.save(checkpoint)
    before = c.brain.weight[c.brain.circuit["edges"]].copy()
    reward = observe("reward")
    assert reward["reward_spikes"] > 0 and reward["stimulus_ms"] == 200
    assert reward["KC_spikes"] > 0 and reward["memory"]["changed_edges"] > 0
    rewarded = c.brain.weight[c.brain.circuit["edges"]].copy()
    c.restore(checkpoint)
    assert np.array_equal(before, c.brain.weight[c.brain.circuit["edges"]])
    control = observe("none")
    assert not np.array_equal(rewarded, c.brain.weight[c.brain.circuit["edges"]])
    c.restore(checkpoint)
    c.brain.weights_frozen = True
    observe("reward")
    assert np.array_equal(before, c.brain.weight[c.brain.circuit["edges"]])
    c.restore(checkpoint)
    loss = observe("aversive")
    assert loss["aversive_spikes"] > 0 and loss["stimulus_ms"] == 200
    assert np.isfinite(c.brain.weight).all()
    result = {"passed": True, "mode": "local-neural-test", "graph": graph, "checks": ["full graph and checksum locks", "retinal mapping", "KC and reward/aversive DAN spikes", "reward versus same-checkpoint control", "frozen weights", "checkpoint restoration", "finite weights"], "observation_seconds": timings, "peak_rss_mb": meter.finish(), "elapsed_seconds": round(time.perf_counter()-started, 2), "reward": reward, "control": control, "loss": loss, "upstream": json.loads((ROOT/'vendor/stonkfly/UPSTREAM.json').read_text()), "limitations": "White-field mechanism test; does not establish market signal quality or profitable learning."}
    save(out / "summary.json", result)
    emit({"phase": "complete", "passed": True, "report": str(out / "summary.json"), "peak_rss_mb": result["peak_rss_mb"], "observation_seconds": timings})

def replay(args):
    from stonkfly.data import verify
    from stonkfly.config import Settings
    from stonkfly.neural.controller import FlyController
    from stonkfly.display import market_frame
    from PIL import Image
    rows = load_replay(ROOT / args.input)
    selected, last = [], None
    for row in rows:
        if last is None or row["at"] - last >= args.sample_seconds * 1000:
            selected.append(row)
            last = row["at"]
    if args.steps:
        selected = selected[:args.steps]
    meter = MemoryMeter()
    graph = verify()
    c = FlyController(Settings(learning=not args.frozen))
    book = PaperBook(args.quote, args.token, buy_fee=args.buy_fee)
    feedback = OutcomeFeedback()
    history, records = [], []
    cursor = 0
    out = ROOT / args.out
    out.mkdir(parents=True, exist_ok=True)
    # Fresh replay runs overwrite outputs; they never resume or touch live state.
    with (out / "events.jsonl").open("w", encoding="utf-8") as handle:
        for index, row in enumerate(selected):
            pulse, settled, cursor = advance_feedback(feedback, rows, cursor, row["at"])
            if args.no_feedback:
                pulse = "none"
            history.append(float(row["price"]))
            frame = market_frame(row.get("symbol", "FLAP") + "/USDT", history, row["price"], row["price"])
            started = time.perf_counter()
            neural = c.observe(frame, pulse)
            seconds = time.perf_counter() - started
            execution = book.apply(neural["side"], row, args.interval_seconds * 1000)
            if execution["status"] == "simulated":
                feedback.register(execution["action"], row)
            event = {"index": index, "at": row["at"], "price": row["price"], "quotePrice": row["quotePrice"], "pulse": pulse, "settled": settled, "neural": neural, "execution": execution, "balances": book.snapshot(), "wall_seconds": round(seconds, 3)}
            records.append(event)
            handle.write(json.dumps(event, allow_nan=False) + "\n")
            handle.flush()
            emit({"index": index, "proposal": neural["side"], "execution": execution, "seconds": round(seconds, 3), "kc_spikes": neural["KC_spikes"]})
            Image.fromarray(frame).save(out / "latest-input.png")
    c.save(out / "final.npz")
    summary = {"mode": "paper-replay", "graph": graph, "input_sha256": hashlib.sha256((ROOT / args.input).read_bytes()).hexdigest(), "observations": len(records), "learning": not args.frozen, "external_feedback": not args.no_feedback, "neural_time_ms": c.brain.sim_ms, "sample_seconds": args.sample_seconds, "minimum_action_interval_seconds": args.interval_seconds, "buy_fee_fraction": args.buy_fee, "proposals": {side: sum(r["neural"]["side"] == side for r in records) for side in ['BUY','SELL','HOLD']}, "balances": book.snapshot(), "unsettled_outcomes": len(feedback.pending), "peak_rss_mb": meter.finish(), "mean_observation_seconds": sum(r["wall_seconds"] for r in records) / len(records), "limitations": ["SELL is experimentally mapped to burn, not sale", "Binary MFE-to-DAN pulse is a new unvalidated adapter", "Paper buy fee is assumed, not measured; gas, depth and impact are not modeled", "Image contains sampled past prices only; bid equals ask", "Not connected to the mainnet executor"]}
    summary.update(input_rows=len(rows), feedback_price_rows_processed=cursor, feedback_uses_all_past_rows=True)
    save(out / "summary.json", summary)
    emit({"phase": "complete", "report": str(out / 'summary.json'), **summary})

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("prepare")
    sub.add_parser("verify")
    sub.add_parser("build")
    test = sub.add_parser("self-test")
    test.add_argument("--out", default="work/full-brain/self-test")
    run = sub.add_parser("replay")
    run.add_argument("--input", required=True)
    run.add_argument("--out", default="work/full-brain/replay")
    run.add_argument("--steps", type=int, default=0)
    run.add_argument("--sample-seconds", type=int, default=60)
    run.add_argument("--interval-seconds", type=int, default=60)
    run.add_argument("--quote", default="10")
    run.add_argument("--token", default="1000000")
    run.add_argument("--buy-fee", default="0.01")
    run.add_argument("--frozen", action="store_true")
    run.add_argument("--no-feedback", action="store_true")
    args = parser.parse_args()
    if args.command == "prepare":
        from stonkfly.data import prepare
        prepare()
    elif args.command == "verify":
        from stonkfly.data import verify
        emit(verify())
    elif args.command == "build":
        from stonkfly.neural.brain import build
        emit(build())
    elif args.command == "self-test":
        self_test(args)
    else:
        if args.sample_seconds <= 0 or args.interval_seconds < 0 or args.steps < 0:
            parser.error("Invalid sample interval, action interval or steps")
        replay(args)

if __name__ == "__main__":
    main()
