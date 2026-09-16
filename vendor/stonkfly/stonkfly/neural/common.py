"""Local verified dataset and build cache; never a dependency on another repo."""

import hashlib
import json
import os
from pathlib import Path

DATA = Path(os.environ.get("STONKFLY_DATA", "data")).resolve()
GRAPH = DATA / "graph.npz"
OUT = DATA / "cache"


def digest(array):
    return hashlib.sha256(array.tobytes()).hexdigest()


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".partial")
    tmp.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    tmp.replace(path)


def annotations(ids):
    import pyarrow.feather as f

    return (
        f.read_table(DATA / "annotations.feather")
        .to_pandas()
        .set_index("bodyId")
        .loc[ids]
    )
