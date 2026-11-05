"""
Tests for the Python side: Houdini/Blender exporters (pure functions),
tools/pbridge.py, and the firmware compiled for the PC.

    python3 -m unittest discover -s tests -v
"""

import importlib.util
import io
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import select

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


hx = load("kinetic_export", "houdini/scripts/python/kinetic_export.py")
bx = load("export_heights_blender", "blender/export_heights_blender.py")
pb = load("pbridge", "tools/pbridge.py")


def grid_xz(rows, cols, spacing=0.1, jitter=0.0, shuffle=True, seed=1):
    rnd = random.Random(seed)
    pts = [((c - 3.5) * spacing + rnd.uniform(-jitter, jitter), (r - 3.5) * spacing + rnd.uniform(-jitter, jitter), r, c)
           for r in range(rows) for c in range(cols)]
    if shuffle:
        rnd.shuffle(pts)
    return pts


class ExporterTests(unittest.TestCase):
    def test_grid_from_positions_any_order(self):
        for mod in (hx, bx):
            pts = grid_xz(8, 8, jitter=0.004)
            rows, cols, rc, spacing = mod.assign_grid([(p[0], p[1]) for p in pts])
            self.assertEqual((rows, cols), (8, 8))
            self.assertEqual(rc, [(p[2], p[3]) for p in pts])
            self.assertAlmostEqual(spacing, 0.1, delta=0.01)

    def test_non_square_grid(self):
        pts = grid_xz(3, 5, shuffle=True)
        rows, cols, rc, _ = hx.assign_grid([(p[0], p[1]) for p in pts])
        self.assertEqual((rows, cols), (3, 5))

    def test_row_col_attributes_win(self):
        xz = [(0, 0), (1, 0), (0, 1), (1, 1)]
        rows, cols, rc, _ = hx.assign_grid(xz, [1, 1, 0, 0], [0, 1, 0, 1])
        self.assertEqual(rc, [(1, 0), (1, 1), (0, 0), (0, 1)])

    def test_irregular_layout_falls_back(self):
        rnd = random.Random(3)
        xz = [(rnd.random(), rnd.random()) for _ in range(12)]
        rows, cols, rc, _ = hx.assign_grid(xz)
        self.assertEqual(rows * cols, 12)
        self.assertEqual(len(set(rc)), 12)

    def _doc(self, mod):
        pts = grid_xz(2, 3, shuffle=True)
        rows, cols, rc, _ = mod.assign_grid([(p[0], p[1]) for p in pts])
        frames = [[400 + 10 * f + p[2] * 3 + p[3] for p in pts] for f in range(5)]
        if mod is hx:
            return hx.build_export(frames, rc, rows, cols, 24, frame_start=1, spacing_mm=100, range_mm=(0, 800))
        return bx.build_export(frames, rc, rows, cols, 24, 1, 100, "blender:test", (0, 800))

    def test_writers_reorder_row_major_and_parse_back(self):
        for mod in (hx, bx):
            doc = self._doc(mod)
            self.assertEqual([(b["row"], b["col"]) for b in doc["balls"]],
                             [(r, c) for r in range(2) for c in range(3)])
            self.assertEqual(doc["frames"][2][4], 400 + 20 + 3 + 1)    # row 1 col 1
            with tempfile.TemporaryDirectory() as d:
                for ext, dump in (("json", mod.dumps_json), ("csv", mod.dumps_csv)):
                    path = os.path.join(d, "h." + ext)
                    with open(path, "w", newline="") as f:
                        f.write(dump(doc))
                    h = pb.load_heights(path)
                    self.assertEqual((h.rows, h.cols, h.fps, h.frame_count), (2, 3, 24.0, 5))
                    self.assertEqual(h.frames, doc["frames"])
                    self.assertEqual(h.range_mm, [0.0, 800.0])

    def test_houdini_check_matches_pbridge_check(self):
        h = pb.load_heights(os.path.join(ROOT, "examples/too_fast_8x8.json"))
        with open(os.path.join(ROOT, "examples/too_fast_8x8.json")) as f:
            doc = json.load(f)
        a = hx.check_limits(doc)
        b = pb.check(h, dict(pb.DEFAULT_LIMITS))
        self.assertFalse(a["ok"])
        self.assertEqual(a["bad_frames"], b["bad_frames"])
        self.assertAlmostEqual(a["peak_speed"], b["peak_speed"], places=6)
        self.assertIn("frame(s) break a limit", hx.format_report(a))

    def test_blender_quick_check(self):
        with open(os.path.join(ROOT, "examples/ripple_8x8.json")) as f:
            doc = json.load(f)
        self.assertTrue(bx.quick_check(doc, 200, 600, 0, 800)["ok"])
        self.assertFalse(bx.quick_check(doc, 50, 600, 0, 800)["ok"])


class PBridgeTests(unittest.TestCase):
    def run_cli(self, *args):
        out = io.StringIO()
        old = sys.stdout
        sys.stdout = out
        try:
            code = pb.main(list(args))
        finally:
            sys.stdout = old
        return code, out.getvalue()

    def test_check_exit_codes(self):
        self.assertEqual(self.run_cli("check", os.path.join(ROOT, "examples/ripple_8x8.json"))[0], 0)
        code, text = self.run_cli("check", os.path.join(ROOT, "examples/too_fast_8x8.json"))
        self.assertEqual(code, 1)
        self.assertIn("speed", text)

    def test_convert_matches_the_web_app_byte_for_byte(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "show.pbridge.json")
            code, _ = self.run_cli("convert", os.path.join(ROOT, "examples/ripple_8x8.json"), "-o", out)
            self.assertEqual(code, 0)
            with open(out) as f:
                mine = json.load(f)
            with open(os.path.join(ROOT, "examples/ripple_8x8.pbridge.json")) as f:
                web = json.load(f)
            self.assertEqual(mine, web)

    def test_convert_refuses_broken_animation(self):
        with tempfile.TemporaryDirectory() as d:
            err = io.StringIO()
            old = sys.stderr
            sys.stderr = err
            try:
                code = pb.main(["convert", os.path.join(ROOT, "examples/too_fast_8x8.json"), "-o", os.path.join(d, "x.json")])
            finally:
                sys.stderr = old
            self.assertEqual(code, 1)
            self.assertFalse(os.path.exists(os.path.join(d, "x.json")))

    def test_steps(self):
        m = dict(pb.DEFAULT_MACHINE)
        spm = pb.steps_per_mm(m)
        self.assertEqual(pb.height_to_steps(800, m, spm), 0)
        self.assertEqual(pb.height_to_steps(0, m, spm), round(800 * spm))
        self.assertEqual(pb.height_to_steps(-5, m, spm), round(800 * spm))   # clamped

    def test_simulated_show(self):
        doc = pb.load_bridge(os.path.join(ROOT, "examples/ripple_8x8.pbridge.json"))
        doc["frames"] = doc["frames"][:60]
        doc["frame_count"] = 60
        doc["fps"] = 120
        boards = [pb.SimBoard(motors=8, capacity=5, board_id=i) for i in range(8)]
        links = [pb.Link(b, "sim%d" % i, lambda *_: None) for i, b in enumerate(boards)]
        pb.play(doc, links, log=lambda *_: None)
        for l in links:
            l.close()
        for i, b in enumerate(boards):
            self.assertEqual(b.received, pb.board_frames(doc, i))


# ---------------------------------------------------------------- firmware on the PC

ACCEL_URL = "https://raw.githubusercontent.com/waspinator/AccelStepper/master/src/"


def accelstepper_dir():
    """AccelStepper sources: $ACCELSTEPPER_SRC, a cached copy, or a download."""
    env = os.environ.get("ACCELSTEPPER_SRC")
    if env and os.path.exists(os.path.join(env, "AccelStepper.cpp")):
        return env
    cache = os.path.join(os.path.expanduser("~"), ".cache", "kinetic-sculpture", "AccelStepper")
    if not os.path.exists(os.path.join(cache, "AccelStepper.cpp")):
        os.makedirs(cache, exist_ok=True)
        for name in ("AccelStepper.cpp", "AccelStepper.h"):
            urllib.request.urlretrieve(ACCEL_URL + name, os.path.join(cache, name))
    return cache


class PipePort:
    """pyserial-like wrapper around a subprocess' stdin/stdout."""

    def __init__(self, proc):
        self.proc = proc

    def write(self, data):
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def read(self, size=1):
        r, _, _ = select.select([self.proc.stdout], [], [], 0.05)
        return os.read(self.proc.stdout.fileno(), size) if r else b""


@unittest.skipIf(shutil.which("g++") is None, "g++ not available")
class FirmwareTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.accel = accelstepper_dir()
        except Exception as e:  # offline
            raise unittest.SkipTest("AccelStepper sources unavailable: %s" % e)
        cls.tmp = tempfile.mkdtemp()

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def build(self, board, *defines):
        exe = os.path.join(self.tmp, "fw_" + board)
        cmd = ["g++", "-std=c++17", "-O2", "-Wall", "-DARDUINO=100", "-D" + board, "-DHOMING_SPEED=20000",
               "-DMOVE_SPEED=20000", "-DMOVE_ACCEL=200000"] + ["-D" + d for d in defines] + [
            "-I", os.path.join(ROOT, "firmware/test"), "-I", self.accel,
            os.path.join(ROOT, "firmware/test/harness.cpp"), os.path.join(self.accel, "AccelStepper.cpp"), "-o", exe]
        subprocess.run(cmd, check=True, capture_output=True)
        return exe

    def show(self, frames=90, fps=60):
        doc = pb.load_bridge(os.path.join(ROOT, "examples/ripple_8x8.pbridge.json"))
        doc["frames"] = doc["frames"][:frames]
        doc["frame_count"] = frames
        doc["fps"] = fps
        doc["boards"] = doc["boards"][:1]
        return doc

    def play_on(self, exe, doc, motors):
        proc = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        link = pb.Link(PipePort(proc), "fw", lambda *_: None)
        try:
            t0 = time.time()
            pb.play(doc, [link], home=True, log=lambda *_: None)
            elapsed = time.time() - t0
            status = link.command("?", "S", 5).split()
            time.sleep(0.2)   # let the last segment finish
            status2 = link.command("?", "S", 5).split()
        finally:
            link.close()
            proc.stdin.write(b"#QUIT\n")
            proc.stdin.flush()
            _, err = proc.communicate(timeout=10)
        phys = [int(v) for v in err.decode().split("PHYS", 1)[1].split()]
        return status, status2, phys, elapsed

    def test_mega_plays_show_exactly(self):
        doc = self.show()
        status, status2, phys, elapsed = self.play_on(self.build("ARDUINO_AVR_MEGA2560"), doc, 8)
        last = doc["frames"][-1][:8]
        self.assertEqual(status2[1], "IDLE")
        self.assertEqual([int(v) for v in status2[4:]], last)
        # Physical position = logical + HOMING_BACKOFF (home is that far below the switch).
        self.assertEqual(phys, [v + 160 for v in last])
        # Played on the board's own clock: 90 frames at 60 fps take ~1.5 s.
        self.assertGreater(elapsed, 1.4)

    def test_esp32_shared_switch_homing_and_play(self):
        doc = self.show(frames=40)
        _, status2, phys, _ = self.play_on(self.build("ESP32"), doc, 8)
        last = doc["frames"][-1][:8]
        self.assertEqual([int(v) for v in status2[4:]], last)
        self.assertEqual(phys, [v + 160 for v in last])

    def test_uno_four_motors(self):
        doc = self.show(frames=30)
        doc["boards"] = [{"board": 0, "motors": [0, 1, 2, 3]}]
        _, status2, phys, _ = self.play_on(self.build("UNO"), doc, 4)
        last = [doc["frames"][-1][i] for i in range(4)]
        self.assertEqual(phys, [v + 160 for v in last])

    def test_protocol_errors(self):
        exe = self.build("ARDUINO_AVR_MEGA2560")
        out = subprocess.run([exe], input=b"F 1 2 3\nNOPE\nFPS 0\nGOTO 1\nHELLO\n", capture_output=True, timeout=10).stdout.decode()
        self.assertIn("E BAD_FRAME", out)
        self.assertIn("E UNKNOWN", out)
        self.assertIn("E BAD_FPS", out)
        self.assertIn("PB1 0 8 48", out)


if __name__ == "__main__":
    unittest.main()
