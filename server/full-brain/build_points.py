"""Render metadata from retained MaleCNS neurons; visualization sampling only."""
import json
import os
from pathlib import Path
import sys
import hashlib
import numpy as np
import pyarrow.feather as f
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'vendor/stonkfly'))
os.environ['STONKFLY_DATA'] = str(ROOT/'data/full-brain')
from stonkfly.data import verify
verify()
ids = np.load(ROOT/'data/full-brain/graph.npz')['ids']
annotation = f.read_table(ROOT/'data/full-brain/annotations.feather', columns=['bodyId', 'somaLocation', 'superclass']).to_pandas().set_index('bodyId').loc[ids]
classes = sorted(annotation.superclass.fillna('unassigned').astype(str).unique().tolist())
raw = []
body_ids = []
for body_id, cell in annotation.iterrows():
    coordinates = cell.somaLocation
    if isinstance(coordinates, (list, tuple, np.ndarray)) and len(coordinates) == 3 and np.isfinite(coordinates).all():
        raw.append([*coordinates, classes.index(cell.superclass if isinstance(cell.superclass, str) else 'unassigned')])
        body_ids.append(str(body_id))
values = np.array(raw)
low, high = values[:, :3].min(axis=0), values[:, :3].max(axis=0)
values[:, :3] = np.round((values[:, :3]-(high+low)/2)*1023/max(high-low))
voxel = 4
while True:
    cells = {}
    for point, body_id in zip(values.astype(int).tolist(), body_ids):
        cells.setdefault(tuple(x//voxel for x in point[:3]), (point, body_id))
    if len(cells) <= 14000:
        break
    voxel += 1
lock = json.loads((ROOT/'vendor/stonkfly/stonkfly/neural/sources.lock.json').read_text())
output = {'meta': {'dataset': 'MaleCNS v1.0', 'source': lock['annotations.feather']['url'], 'citation': 'MaleCNS v1.0; see vendor/stonkfly/THIRD_PARTY.md', 'licence': 'CC BY 4.0', 'neuronsInSource': len(raw), 'pointsInFile': len(cells), 'gridVoxel': voxel, 'classes': classes, 'axisOrder': ['x','y','z'], 'spansNm': (high-low).astype(int).tolist(), 'coordinateUnits': 'released annotation units'}, 'stride': 4, 'points': [x for point, _ in cells.values() for x in point]}
point_bytes = json.dumps(output, separators=(',', ':')).encode()
(ROOT/'public/malecns-points.json').write_bytes(point_bytes)
sample = {
    'dataset': 'MaleCNS v1.0',
    'pointsSha256': hashlib.sha256(point_bytes).hexdigest(),
    'ids': [body_id for _, body_id in cells.values()],
}
(ROOT/'server/full-brain/point-sample.json').write_text(json.dumps(sample, separators=(',', ':')))
print(json.dumps(output['meta']))
