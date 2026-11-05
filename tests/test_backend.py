import json
import math
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import cad  # noqa: E402
import mesh as meshlib  # noqa: E402

RECT = [[-30, -25], [30, -25], [30, 25], [-30, 25]]


@unittest.skipUnless(cad.available(), "cadquery not installed")
class CadTests(unittest.TestCase):
    def test_box_volume_exact(self):
        spec = {"kind": "extrude", "axis": "y", "depth": 180, "outline": RECT, "holes": []}
        self.assertAlmostEqual(cad.volume_mm3(spec), 60 * 50 * 180, places=3)

    def test_flange_hole_subtracted(self):
        spec = {"kind": "extrude", "axis": "y", "depth": 10, "outline": RECT, "holes": [{"x": 0, "y": 0, "r": 10}]}
        self.assertAlmostEqual(cad.volume_mm3(spec), 60 * 50 * 10 - math.pi * 100 * 10, places=2)

    def test_extrude_axis_y_grows_up(self):
        spec = {"kind": "extrude", "axis": "y", "depth": 180, "outline": RECT, "holes": []}
        bb = cad.build_solid(spec).val().BoundingBox()
        self.assertAlmostEqual(bb.ymin, 0, places=4)
        self.assertAlmostEqual(bb.ymax, 180, places=4)
        self.assertAlmostEqual(bb.zlen, 50, places=4)

    def test_revolve_cylinder(self):
        spec = {"kind": "revolve", "profile": [[0, 0], [30, 0], [30, 100], [0, 100]]}
        self.assertAlmostEqual(cad.volume_mm3(spec), math.pi * 900 * 100, delta=1)

    def test_revolve_tube_off_axis(self):
        spec = {"kind": "revolve", "profile": [[20, 0], [30, 0], [30, 100], [20, 100]]}
        self.assertAlmostEqual(cad.volume_mm3(spec), math.pi * (900 - 400) * 100, delta=1)

    def test_step_file(self):
        data = cad.to_step({"kind": "revolve", "profile": [[0, 0], [30, 0], [30, 100], [0, 100]]})
        self.assertTrue(data.startswith(b"ISO-10303-21"))
        self.assertIn(b"MANIFOLD_SOLID_BREP", data)

    @unittest.skipUnless(shutil.which("node") and (ROOT / "node_modules" / "three").exists(), "node + three needed")
    def test_presets_match_browser_mesh(self):
        """The CadQuery solid and the browser mesh describe the same part."""
        out = subprocess.run(["node", str(ROOT / "tests" / "js" / "dump_presets.js")],
                             capture_output=True, text=True, check=True)
        for item in json.loads(out.stdout):
            with self.subTest(preset=item["preset"]):
                solid = cad.build_solid(item["spec"]).val()
                bb = solid.BoundingBox()
                # tessellation makes the mesh slightly smaller than the exact solid
                self.assertAlmostEqual(solid.Volume(), item["meshVolume"], delta=solid.Volume() * 0.01)
                for got, want in zip((bb.xlen, bb.ylen, bb.zlen), item["meshSize"]):
                    self.assertAlmostEqual(got, want, delta=0.05)


class MeshTests(unittest.TestCase):
    def test_box_report(self):
        r = meshlib.report(meshlib.load_stl(meshlib.box_stl(60, 50, 180)))
        self.assertTrue(r["watertight"])
        self.assertAlmostEqual(r["volume_cm3"], 540, places=3)

    def test_repair_fills_hole(self):
        m = meshlib.load_stl(meshlib.box_stl(10, 10, 10))
        m.update_faces(list(range(1, len(m.faces))))  # punch a hole
        self.assertFalse(m.is_watertight)
        fixed, log = meshlib.repair(m)
        self.assertTrue(fixed.is_watertight)
        self.assertAlmostEqual(fixed.volume, 1000, places=3)

    def test_invalid_stl(self):
        with self.assertRaises(Exception):
            meshlib.load_stl(b"not an stl")


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        import main
        cls.client = TestClient(main.app)

    def test_health(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["step"], cad.available())

    def test_serves_app_but_not_repo(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/js/geometry.js").status_code, 200)
        self.assertEqual(self.client.get("/backend/main.py").status_code, 404)
        self.assertEqual(self.client.get("/.git/config").status_code, 404)

    def test_mesh_check(self):
        r = self.client.post("/api/mesh/check", content=meshlib.box_stl(60, 50, 180))
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["watertight"])

    def test_bad_spec_rejected(self):
        r = self.client.post("/api/export/step", json={"kind": "revolve", "profile": [[0, 0], [1, 1]]})
        self.assertEqual(r.status_code, 422)
        r = self.client.post("/api/export/step", json={"kind": "extrude", "outline": RECT})
        self.assertEqual(r.status_code, 422)

    @unittest.skipUnless(cad.available(), "cadquery not installed")
    def test_step_export(self):
        r = self.client.post("/api/export/step", json={"kind": "extrude", "depth": 5, "outline": RECT, "name": "plate 1"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b"ISO-10303-21"))
        self.assertIn('filename="plate_1.step"', r.headers["content-disposition"])


if __name__ == "__main__":
    unittest.main()
