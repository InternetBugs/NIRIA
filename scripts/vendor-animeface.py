"""Convert the fixed MIT animeface LBP classifier; no network access."""
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
source = root / "artifacts/lbpcascade-animeface-4433ab1.xml"
expected = "9376d30ac38db6bda2a68b88b3b76bbd7e6aa33af47f7f5c76bc88ca75f1ce30"
raw = source.read_bytes()
assert hashlib.sha256(raw).hexdigest() == expected, "Unexpected classifier bytes"
cascade = ET.fromstring(raw).find("cascade")
assert cascade.findtext("featureType") == "LBP"
assert cascade.findtext("width") == cascade.findtext("height") == "24"
features = [[int(n) for n in feature.findtext("rect").split()]
            for feature in cascade.find("features")]
assert all(len(f) == 4 and min(f) >= 0 and f[2] > 0 and f[3] > 0
           and f[0] + f[2] * 3 <= 24 and f[1] + f[3] * 3 <= 24 for f in features)
stages = []
for stage in cascade.find("stages"):
    trees = []
    for tree in stage.find("weakClassifiers"):
        nodes = [int(n) for n in tree.findtext("internalNodes").split()]
        leaves = [float(n) for n in tree.findtext("leafValues").split()]
        assert len(nodes) == 11 and nodes[:2] == [0, -1] and len(leaves) == 2
        trees.append([nodes[2], nodes[3:], leaves])
    stages.append([float(stage.findtext("stageThreshold")), trees])
output = root / "prototype/public/vendor/animeface"
output.mkdir(parents=True, exist_ok=True)
license_text = re.search(r"<!--(.*?)-->", raw.decode(), re.S).group(1).strip()
(output / "LICENSE.txt").write_text(license_text + "\n", encoding="utf-8")
data = {
    "format": "niria-animeface-lbp", "version": 1, "size": 24,
    "source": "https://github.com/nagadomi/lbpcascade_animeface",
    "commit": "4433ab1ae1166ea75acfe99eb0f18709dac329a0",
    "sourceSha256": expected, "features": features, "stages": stages
}
(output / "model.json").write_text(json.dumps(data, separators=(",", ":")) + "\n",
                                  encoding="utf-8")
print(json.dumps({"stages": len(stages), "features": len(features),
                  "weakClassifiers": sum(len(stage[1]) for stage in stages)}))
