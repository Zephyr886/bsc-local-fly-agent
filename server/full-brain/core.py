"""Replay validation and paper accounting. No signing or network operations."""
import json
import math
from decimal import Decimal
from pathlib import Path

def load_replay(path):
    rows = []
    identity = None
    previous = None
    for number, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        row = json.loads(line)
        key = (row["tokenAddress"].lower(), row["quoteAsset"])
        if identity is not None and key != identity:
            raise ValueError(f"Mixed token or quote asset at line {number}")
        identity = key
        for field in ["at", "price", "quotePrice"]:
            if isinstance(row[field], bool) or not math.isfinite(float(row[field])) or float(row[field]) <= 0:
                raise ValueError(f"Invalid {field} at line {number}")
        row["at"] = int(row["at"])
        if previous is not None and row["at"] <= previous:
            raise ValueError(f"Replay timestamps must increase at line {number}")
        previous = row["at"]
        rows.append(row)
    if not rows:
        raise ValueError("Replay is empty")
    return rows

class PaperBook:
    def __init__(self, quote="10", token="1000000", percent="10", buy_fee="0.01"):
        self.quote = Decimal(quote)
        self.token = Decimal(token)
        self.rate = Decimal(percent) / 100
        self.fee = Decimal(buy_fee)
        if not 0 < self.rate <= 1 or not 0 <= self.fee < 1 or min(self.quote, self.token) < 0:
            raise ValueError("Invalid paper balances, percent or fee")
        self.burned = Decimal(0)
        self.spent = Decimal(0)
        self.last_action_at = None

    def apply(self, side, row, interval_ms):
        if side == "HOLD":
            return {"status": "hold"}
        if self.last_action_at is not None and row["at"] - self.last_action_at < interval_ms:
            return {"status": "blocked", "reason": "interval"}
        if side == "BUY":
            amount = self.quote * self.rate
            if amount <= 0:
                return {"status": "blocked", "reason": "no-quote"}
            received = amount * (1 - self.fee) / Decimal(str(row["quotePrice"]))
            self.quote -= amount
            self.token += received
            self.spent += amount
            result = {"status": "simulated", "action": "buy", "quoteSpent": str(amount), "tokenReceived": str(received)}
        elif side == "SELL":
            amount = self.token * self.rate
            if amount <= 0:
                return {"status": "blocked", "reason": "no-token"}
            self.token -= amount
            self.burned += amount
            result = {"status": "simulated", "action": "burn", "tokenBurned": str(amount)}
        else:
            raise ValueError("Unknown neural proposal")
        self.last_action_at = row["at"]
        return result

    def snapshot(self):
        return {"quote": str(self.quote), "token": str(self.token), "quoteSpent": str(self.spent), "tokenBurned": str(self.burned)}

class OutcomeFeedback:
    """Experimental transfer of our 180s MFE reward to binary DAN pulses."""
    def __init__(self):
        self.pending = []
        self.settled = []

    def register(self, action, row):
        self.pending.append({"action": action, "at": row["at"], "price": float(row["price"]), "mfe": 0.0})

    def observe(self, row):
        keep, ready = [], []
        for item in self.pending:
            favorable = float(row["price"]) / item["price"] - 1 if item["action"] == "buy" else 1 - float(row["price"]) / item["price"]
            # Do not use a post-window price to improve an expired outcome.
            age = row["at"] - item["at"]
            if 0 <= age <= 180000:
                item["mfe"] = max(item["mfe"], favorable)
            if age >= 180000:
                reward = min(1.0, max(0.0, (item["mfe"] * 100 - 10) / 40))
                ready.append({**item, "reward": reward})
            else:
                keep.append(item)
        self.pending = keep
        self.settled.extend(ready)
        pulse = feedback_pulse(ready)
        return pulse, ready

def feedback_pulse(settled):
    return "none" if not settled else "reward" if sum(x["reward"] for x in settled) / len(settled) > 0 else "aversive"

def advance_feedback(feedback, rows, cursor, at):
    """Consume every past price, even between neural observations; never future prices."""
    settled = []
    while cursor < len(rows) and rows[cursor]["at"] <= at:
        _, ready = feedback.observe(rows[cursor])
        settled.extend(ready)
        cursor += 1
    return feedback_pulse(settled), settled, cursor
