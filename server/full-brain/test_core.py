import json
from decimal import Decimal
import pytest
from core import load_replay, PaperBook, OutcomeFeedback, advance_feedback

def row(at=1000, price=1, quote_price=1, token="0xabc"):
    return {"at": at, "price": price, "quotePrice": quote_price, "tokenAddress": token, "quoteAsset": "GOOGLB"}

@pytest.mark.parametrize("rows", [[row(), row()], [row(), row(2000, token="0xdef")], [row(price=float('nan'))], [row(price=True)]])
def test_invalid_replay_is_rejected(tmp_path, rows):
    path = tmp_path / "input.jsonl"
    path.write_text("\n".join(json.dumps(x) for x in rows))
    with pytest.raises(ValueError):
        load_replay(path)

def test_buy_and_burn_do_not_create_quote_funding():
    book = PaperBook("10", "100", buy_fee="0.01")
    book.apply("BUY", row(1000, quote_price=2), 0)
    assert book.quote == Decimal("9")
    assert book.token == Decimal("100.495")
    before_quote, before_token = book.quote, book.token
    result = book.apply("SELL", row(2000), 0)
    assert result["action"] == "burn"
    assert book.quote == before_quote
    assert book.token + book.burned == before_token

def test_interval_applies_across_both_directions():
    book = PaperBook()
    book.apply("BUY", row(1000), 60000)
    before = book.snapshot()
    assert book.apply("SELL", row(2000), 60000)["status"] == "blocked"
    assert book.snapshot() == before

def test_feedback_does_not_settle_early_or_use_future_peak():
    feedback = OutcomeFeedback()
    feedback.register("buy", row(1000))
    pulse, ready = feedback.observe(row(100000, price=1.05))
    assert pulse == "none" and ready == []
    pulse, ready = feedback.observe(row(200000, price=2))
    assert pulse == "aversive" and ready[0]["reward"] == 0

def test_burn_reward_uses_price_decline():
    feedback = OutcomeFeedback()
    feedback.register("burn", row(1000))
    assert feedback.observe(row(181000, price=0.7))[0] == "reward"

def test_feedback_keeps_between_observation_peak_without_reading_future():
    rows = [row(1000), row(20000, price=1.3), row(181000), row(240000, price=2)]
    feedback = OutcomeFeedback()
    _, _, cursor = advance_feedback(feedback, rows, 0, 1000)
    feedback.register("buy", rows[0])
    pulse, settled, cursor = advance_feedback(feedback, rows, cursor, 61000)
    assert pulse == "none" and settled == [] and cursor == 2
    pulse, settled, cursor = advance_feedback(feedback, rows, cursor, 181000)
    assert pulse == "reward" and len(settled) == 1 and cursor == 3
    assert settled[0]["mfe"] == pytest.approx(0.3)
    assert settled[0]["reward"] == pytest.approx(0.5)
    assert advance_feedback(feedback, rows, cursor, 241000)[:2] == ("none", [])
