"""Only RGB and engineered reinforcement enter the network. No market policy."""

import hashlib

import numpy as np

from .common import annotations
from .visual import VisualMemoryBrain


class Decoder:
    def __init__(self, ids, annotation, threshold):
        types = annotation.type.fillna("")
        sides = annotation.somaSide.fillna("")
        self.left = np.flatnonzero(types.eq("DNp20") & sides.eq("L"))
        self.right = np.flatnonzero(types.eq("DNp20") & sides.eq("R"))
        self.gate = np.flatnonzero(types.eq("DNpe017"))
        if not len(self.left) or not len(self.right) or not len(self.gate):
            raise RuntimeError("Missing annotated BCI outputs")
        self.threshold = threshold
        self.identities = {
            k: [str(ids[i]) for i in getattr(self, k)]
            for k in ["left", "right", "gate"]
        }

    def decode(self, counts, seconds):
        # Mean rates prevent side population size from creating a built-in bias.
        left = float(np.mean(counts[self.left]) / seconds)
        right = float(np.mean(counts[self.right]) / seconds)
        difference = right - left
        gate = int(counts[self.gate].sum())
        side = (
            "HOLD"
            if not gate or abs(difference) < self.threshold
            else "BUY"
            if difference > 0
            else "SELL"
        )
        return {
            "side": side,
            "left_hz": left,
            "right_hz": right,
            "difference_hz": difference,
            "gate_spikes": gate,
            "cell_ids": self.identities,
        }


class FlyController:
    def __init__(self, settings):
        self.s = settings
        self.brain = VisualMemoryBrain()
        self.brain.weights_frozen = not settings.learning
        self.decoder = Decoder(
            self.brain.ids, annotations(self.brain.ids), settings.decoder_threshold_hz
        )

    def observe(self, rgb, reinforcement, reinforcement_strength=1.0):
        if reinforcement not in ("none", "reward", "aversive"):
            raise ValueError("Unknown reinforcement")
        reinforcement_strength = float(reinforcement_strength)
        if not 0 <= reinforcement_strength <= 1:
            raise ValueError("Reinforcement strength must be between 0 and 1")
        b = self.brain
        counts = np.zeros(b.n, dtype=np.int32)
        wall = 0.0
        remaining = round(self.s.neural_ms / b.dt)
        pulse = round(self.s.pulse_ms / b.dt) if reinforcement != "none" else 0
        delivered = 0
        while remaining:
            n = min(remaining, round(self.s.neural_bin_ms / b.dt))
            if pulse:
                n = min(n, pulse)
            stimulus = (
                (b.circuit[reinforcement], self.s.pulse_current * reinforcement_strength) if pulse else None
            )
            c, elapsed = b.rgb_step(
                rgb, n * b.dt, learning=self.s.learning, stimulation=stimulus
            )
            counts += c
            wall += elapsed
            remaining -= n
            if pulse:
                delivered += n
                pulse -= n
        b.counts[:] = counts
        return {
            **self.decoder.decode(counts, self.s.neural_ms / 1000),
            "brain_ms": b.sim_ms,
            "compute_seconds": wall,
            "stimulus": reinforcement,
            "stimulus_strength": reinforcement_strength if reinforcement != "none" else 0.0,
            "stimulus_ms": delivered * b.dt,
            "reward_spikes": int(counts[b.circuit["reward"]].sum()),
            "aversive_spikes": int(counts[b.circuit["aversive"]].sum()),
            "KC_spikes": int(counts[b.circuit["kc"]].sum()),
            "total_spikes": int(counts.sum()),
            "spike_sha256": hashlib.sha256(counts.tobytes()).hexdigest(),
            "input_sha256": hashlib.sha256(np.asarray(rgb).tobytes()).hexdigest(),
            "memory": b.memory(),
        }

    def save(self, path):
        self.brain.checkpoint(path)

    def restore(self, path):
        self.brain.restore(path)
