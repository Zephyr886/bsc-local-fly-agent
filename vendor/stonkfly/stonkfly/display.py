"""Render observations into an RGB chart; never reads future prices or P&L."""

import numpy as np
from PIL import Image, ImageDraw


def market_frame(product, history, bid, ask):
    im = Image.new("RGB", (320, 180), (235, 240, 249))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, 319, 27), fill=(19, 36, 71))
    d.text((9, 8), product, fill=(219, 229, 249))
    for x in range(12, 310, 30):
        d.line((x, 34, x, 160), fill=(200, 212, 233))
    for y in range(38, 162, 24):
        d.line((10, y, 308, y), fill=(200, 212, 233))
    values = np.asarray(history[-100:], dtype=float)
    if len(values):
        span = max(float(np.ptp(values)), float(np.mean(values)) * 0.002)
        lo = float(values.min()) - span * 0.12
        span *= 1.24
        points = [
            (12 + i * 294 / max(1, len(values) - 1), 153 - (v - lo) / span * 109)
            for i, v in enumerate(values)
        ]
        if len(points) > 1:
            for a, b in zip(points, points[1:]):
                d.line(
                    (*a, *b),
                    fill=(0, 101, 183) if b[1] <= a[1] else (197, 37, 78),
                    width=3,
                )
        for x, y in points:
            d.rectangle((x - 1, y - 1, x + 1, y + 1), fill=(27, 39, 81))
    d.text((9, 165), f"BID {bid}  ASK {ask}"[:50], fill=(28, 46, 82))
    return np.asarray(im, dtype=np.uint8)
