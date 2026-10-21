import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--runtime", type=Path, required=True)
parser.add_argument("--engine", type=Path)
parser.add_argument("--fonts", type=Path)
args = parser.parse_args()
runtime = args.runtime.resolve()
fork = (root / "plugins/kindlespouse.koplugin").is_dir()
build = root / ("kindlespouse/build" if fork else ".test-data")
build.mkdir(parents=True, exist_ok=True)
output = root / ("kindlespouse/build/artifacts" if fork else "artifacts")
output.mkdir(parents=True, exist_ok=True)
engine = args.engine.resolve() if args.engine else build / "notebook-engine/lua"
if not args.engine:
    manifest = json.loads((root / "experiments/notebook/engine.json").read_text())
    request = urllib.request.Request(manifest["url"], headers={"User-Agent": "KindleSpouse-Notebook-Simulation"})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(32 * 1024 * 1024)
    assert hashlib.sha256(data).hexdigest() == manifest["sha256"], "Notebook engine fingerprint mismatch"
    engine.parent.mkdir(parents=True, exist_ok=True)
    (engine.parent / "upstream-source.zip").write_bytes(data)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for info in archive.infolist():
            parts = Path(info.filename).parts[1:]
            if info.is_dir() or not parts or any(part in (".", "..") for part in parts):
                continue
            if parts[0] != "lua" and parts != ("LICENSE",):
                continue
            target = engine.parent.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(info))
test = Path(tempfile.mkdtemp(prefix="notebook-embedded-", dir=build))
(test / "patches").mkdir()
(test / "books").mkdir()
(test / "fonts").mkdir()
fonts = args.fonts.resolve() if args.fonts else root / ("kindlespouse/build/cache" if fork else "native/tools/reader-fonts")
for name in ("NotoSerifCJKsc-Regular.otf", "NotoSansCJKsc-Regular.otf"):
    shutil.copyfile(fonts / name, test / "fonts" / name)
shutil.copytree(engine / "icons", test / "icons")
titles = ["阅读的四季", "山间来信", "一日三餐", "慢慢走", "生活的形状", "一间自己的书房", "寻常故事", "昨日书简", "漫长的旅途", "春日来信", "理想的下午", "此时此地"]
for index, title in enumerate(titles):
    with zipfile.ZipFile(test / "books" / (title + ".epub"), "w") as archive:
        archive.writestr("mimetype", "application/epub+zip")
        archive.writestr("META-INF/container.xml", '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        archive.writestr("book.opf", f'<package version="2.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">notebook-fixture-{index}</dc:identifier><dc:title>{title}</dc:title><dc:creator>KindleSpouse</dc:creator><meta name="cover" content="cover"/></metadata><manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="cover.svg" media-type="image/svg+xml"/></manifest><spine><itemref idref="text"/></spine></package>')
        archive.writestr("text.xhtml", f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title></head><body><h1>{title}</h1></body></html>')
        shade = [235, 85, 195, 150, 215, 110][index % 6]
        ink = "white" if shade < 150 else "black"
        archive.writestr("cover.svg", f'<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="rgb({shade},{shade},{shade})"/><rect x="25" y="25" width="350" height="550" stroke="{ink}" stroke-width="2" fill="none"/><text x="200" y="210" font-size="30" text-anchor="middle" fill="{ink}">READING</text><text x="200" y="320" font-size="82" text-anchor="middle" fill="{ink}">{index + 1:02}</text></svg>')
disabled = ",".join("[" + json.dumps(item.name.removesuffix(".koplugin")) + "]=true" for item in (runtime / "plugins").iterdir() if item.name.endswith(".koplugin") and item.name != "coverbrowser.koplugin")
(test / "settings.reader.lua").write_text('return {language="zh_CN",last_migration_date=20260701,quickstart_shown_version=99999999,home_dir=' + json.dumps(str(test / "books")) + ',start_with="filemanager",disable_network_connection=true,auto_suspend_timeout_seconds=0,notebook_draw_with_finger=true,plugins_disabled={' + disabled + '}}', encoding="utf-8")
patch = root / ("kindlespouse/test_notebook.lua" if fork else "tests/notebook-embedded.lua")
shutil.copyfile(patch, test / "patches/2-notebook-test.lua")
points = [{"x": 1000, "y": 1000, "width": 30}, {"x": 2000, "y": 2000, "width": 40}, {"x": 3000, "y": 1000, "width": 20}]
strokes = [{"brushType": 0, "opacity": 1, "points": points}, {"brushType": 0, "opacity": 1, "points": [dict(point, y=point["y"] + 3000) for point in points]}]
(test / "native-vectors.json").write_text(json.dumps({"version": 1, "source": {"format": "synthetic-native-vector-fixture"}, "pages": [{"width": 18600, "height": 24800, "strokes": strokes}, {"width": 18600, "height": 24800, "strokes": []}]}), encoding="utf-8")
plugin = root / ("plugins/kindlespouse.koplugin" if fork else "native/companion/plugin")
environment = dict(os.environ, SDL_VIDEODRIVER="dummy", SDL_AUDIODRIVER="dummy", XDG_DATA_HOME=str(test), KO_HOME=str(test), KINDLESPOUSE_TEST_ROOT=str(root), KINDLESPOUSE_NOTEBOOK_TEST_ROOT=str(test), KINDLESPOUSE_TEST_PLUGIN=str(plugin), KINDLESPOUSE_NOTEBOOK_ENGINE=str(engine), KINDLESPOUSE_NOTEBOOK_EXPERIMENT=str(root / "experiments/notebook"), KINDLESPOUSE_TEST_OUTPUT=str(output), EMULATE_READER_W="1860", EMULATE_READER_H="2480", EMULATE_READER_DPI="300", LD_LIBRARY_PATH="libs")
result = subprocess.run([str(runtime / "luajit"), "reader.lua", str(test / "books")], cwd=runtime, env=environment, capture_output=True, text=True, timeout=180)
(test / "runtime.log").write_text(result.stdout + result.stderr, encoding="utf-8")
shutil.copyfile(test / "runtime.log", output / "notebook-runtime.log")
assert result.returncode == 0 and "Embedded Notebook acceptance passed" in result.stdout, (result.stdout + result.stderr)[-6000:]
for name in ("library", "profile", "profile-day", "profile-syncing", "gallery", "scrolled", "editor", "saved", "landscape"):
    assert (output / ("notebook-embedded-" + name + ".png")).stat().st_size > 1000
print("Passed in real KOReader: cover tap, search, touch ink, eraser, undo/redo, pages, folders, save/reopen, Library return, editable imported vector fixture, portrait/landscape. No device access.")
