"""Persistent, stdin-only full connectome worker. No wallets or network clients."""
import json
import os
from pathlib import Path
import sys
import time
import hashlib
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'vendor/stonkfly'))
os.environ.setdefault('STONKFLY_DATA', str(ROOT / 'data/full-brain'))
os.environ['OPENBLAS_NUM_THREADS'] = '1'
import psutil
from stonkfly.config import Settings
from stonkfly.data import verify
from stonkfly.display import market_frame
from stonkfly.neural.controller import FlyController
from PIL import Image

def reply(value):
    print(json.dumps(value, allow_nan=False), flush=True)

controller = None
identity = None
saved = 0
checkpoint = Path(os.environ.get('FULL_BRAIN_CHECKPOINT', ROOT / 'data/full-brain/service.npz'))
meta = Path(os.environ.get('FULL_BRAIN_META', checkpoint.with_suffix('.json')))
latest_input = Path(os.environ.get('FULL_BRAIN_LATEST_INPUT', ROOT / 'data/full-brain/latest-input.png'))
graph = verify()
point_file = ROOT / 'public/malecns-points.json'
sample_file = ROOT / 'server/full-brain/point-sample.json'
sample = json.loads(sample_file.read_text())
if hashlib.sha256(point_file.read_bytes()).hexdigest() != sample['pointsSha256']:
    raise RuntimeError('MaleCNS point sample does not match the displayed point cloud')
sample_ids = np.asarray([int(value) for value in sample['ids']], dtype=np.int64)
sample_indices = None
reply({'ready': True, 'graph': graph})

def visible_activity(counts, limit=900):
    """Return actual spikes for displayed neurons, capped without inventing activity."""
    values = counts[sample_indices]
    active = np.flatnonzero(values > 0)
    if len(active) > limit:
        # Preserve the strongest cells and spread the remaining slots across
        # the complete point ordering so equal one-spike cells do not cluster.
        strong_count = min(limit // 3, len(active))
        strongest = active[np.argsort(values[active], kind='stable')[-strong_count:]]
        remaining = np.setdiff1d(active, strongest, assume_unique=True)
        spread_count = min(limit - len(strongest), len(remaining))
        spread = remaining[np.linspace(0, len(remaining) - 1, spread_count, dtype=int)] if spread_count else np.empty(0, dtype=np.int64)
        active = np.unique(np.concatenate([strongest, spread]))
    encoded = []
    for point_index in active:
        encoded.extend((int(point_index), int(values[point_index])))
    return {
        'sample_activity': encoded,
        'sample_active_count': int(np.count_nonzero(values)),
        'sampled_neurons': int(len(values)),
        'sampled_spikes': int(values.sum()),
        'sampled_peak': int(values.max(initial=0)),
    }

def save_checkpoint():
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    controller.save(checkpoint)
    temporary = meta.with_suffix('.partial')
    temporary.write_text(json.dumps({'tokenAddress': identity, 'savedAt': time.time()}))
    temporary.replace(meta)

for line in sys.stdin:
    request = json.loads(line)
    try:
        if request['method'] == 'observe':
            key = request['tokenAddress'].lower()
            restored = False
            restored_sha = None
            restored_ms = None
            if controller is None or key != identity:
                controller = FlyController(Settings())
                identity = key
                saved = 0
                index_by_id = {int(value): index for index, value in enumerate(controller.brain.ids)}
                try:
                    sample_indices = np.asarray([index_by_id[int(value)] for value in sample_ids], dtype=np.int32)
                except KeyError as error:
                    raise RuntimeError(f'Displayed MaleCNS neuron is absent from the connectome: {error.args[0]}') from error
                if meta.exists() and checkpoint.exists() and json.loads(meta.read_text()).get('tokenAddress') == key:
                    try:
                        controller.restore(checkpoint)
                    except Exception:
                        controller = None
                        identity = None
                        raise
                    restored = True
                    restored_sha = controller.brain.memory()['sha256']
                    restored_ms = controller.brain.sim_ms
            controller.s = Settings(learning=request['learning'], neural_ms=request['neuralMs'], decoder_threshold_hz=request['thresholdHz'])
            controller.brain.weights_frozen = not request['learning']
            controller.decoder.threshold = request['thresholdHz']
            frame = market_frame(request['symbol'] + '/USDT', request['history'], request['price'], request['price'])
            started = time.perf_counter()
            result = controller.observe(frame, request['pulse'], request.get('pulseStrength', 1.0))
            result.update(visible_activity(controller.brain.counts))
            result.update(wallSeconds=round(time.perf_counter()-started, 3), rssMb=round(psutil.Process().memory_info().rss/1048576, 1), restored=restored, restoredMemorySha256=restored_sha, restoredBrainMs=restored_ms, graph=graph)
            latest_input.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(frame).save(latest_input)
            if time.monotonic() - saved >= 60:
                save_checkpoint()
                saved = time.monotonic()
            reply({'id': request['id'], 'result': result})
        elif request['method'] == 'save':
            if controller is not None:
                save_checkpoint()
            reply({'id': request['id'], 'result': {'saved': controller is not None}})
        else:
            raise ValueError('Unknown worker method')
    except Exception as error:
        reply({'id': request['id'], 'error': str(error)})
