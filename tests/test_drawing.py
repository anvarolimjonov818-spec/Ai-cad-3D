"""Drawing analysis tests with a fake Anthropic client (no network, no API key)."""
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import cad  # noqa: E402
import drawing  # noqa: E402

PLATE = {
    "part_name": "Plastina",
    "kind": "extrude",
    "profile": [],
    # clockwise on purpose: to_spec must reorient it
    "outline": [{"a": -40, "b": -30}, {"a": -40, "b": 30}, {"a": 40, "b": 30}, {"a": 40, "b": -30}],
    "holes": [{"x": 0, "y": 0, "diameter": 20}, {"x": 30, "y": 20, "diameter": 0}],
    "thickness": 8,
    "dimensions": [{"label": "Uzunlik", "value_mm": 80}],
    "assumptions": ["Faskalar e'tiborga olinmadi"],
    "confidence": "high",
}

SHAFT = {
    "part_name": "Val", "kind": "revolve",
    "profile": [{"a": 0, "b": 0}, {"a": 10, "b": 0}, {"a": 10, "b": 40}, {"a": 6, "b": 40}, {"a": 6, "b": 70}, {"a": 0, "b": 70}],
    "outline": [], "holes": [], "thickness": 0, "dimensions": [], "assumptions": [], "confidence": "medium",
}


class FakeClient:
    def __init__(self, payload, stop_reason="end_turn"):
        self.calls = []
        msg = SimpleNamespace(stop_reason=stop_reason, model=drawing.MODEL,
                              content=[SimpleNamespace(type="thinking", thinking=""),
                                       SimpleNamespace(type="text", text=json.dumps(payload))])
        client = self

        class Stream:
            def __enter__(self):
                return SimpleNamespace(get_final_message=lambda: msg)

            def __exit__(self, *a):
                return False

        def stream(**kwargs):
            client.calls.append(kwargs)
            return Stream()

        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=stream))


class DrawingTests(unittest.TestCase):
    def test_plate_spec(self):
        client = FakeClient(PLATE)
        out = drawing.analyze(b"%PDF-1.4 fake", "application/pdf", note="qalinligi 8", client=client)
        spec = out["spec"]
        self.assertEqual(spec["kind"], "extrude")
        self.assertEqual(spec["depth"], 8)
        self.assertEqual(spec["holes"], [{"x": 0.0, "y": 0.0, "r": 10.0}])  # zero-diameter hole dropped
        xs = [p for p in spec["outline"]]
        area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(xs, xs[1:] + xs[:1]))
        self.assertGreater(area, 0, "outline is counter-clockwise")
        self.assertEqual(out["analysis"]["assumptions"], ["Faskalar e'tiborga olinmadi"])

        call = client.calls[0]
        self.assertEqual(call["model"], "claude-opus-5-5")
        self.assertEqual(call["fallbacks"], "default")
        self.assertIn("server-side-fallback-2026-07-01", call["betas"])
        self.assertEqual(call["output_config"]["format"]["type"], "json_schema")
        content = call["messages"][0]["content"]
        self.assertEqual(content[0]["type"], "document")
        self.assertIn("qalinligi 8", content[1]["text"])

    def test_image_block_and_revolve(self):
        client = FakeClient(SHAFT)
        out = drawing.analyze(b"\x89PNG fake", "image/png", client=client)
        self.assertEqual(client.calls[0]["messages"][0]["content"][0]["type"], "image")
        self.assertEqual(out["spec"]["profile"][2], [10.0, 40.0])

    @unittest.skipUnless(cad.available(), "cadquery not installed")
    def test_specs_build_as_solids(self):
        import math
        plate = drawing.to_spec(PLATE)
        self.assertAlmostEqual(cad.volume_mm3(plate), 80 * 60 * 8 - math.pi * 100 * 8, places=2)
        shaft = drawing.to_spec(SHAFT)
        self.assertAlmostEqual(cad.volume_mm3(shaft), math.pi * (100 * 40 + 36 * 30), delta=1)

    def test_rejections(self):
        with self.assertRaises(drawing.DrawingError):
            drawing.analyze(b"x", "text/plain", client=FakeClient(PLATE))
        with self.assertRaises(drawing.DrawingError):
            drawing.analyze(b"x", "image/png", client=FakeClient(PLATE, stop_reason="refusal"))
        with self.assertRaises(drawing.DrawingError):
            drawing.to_spec(dict(PLATE, thickness=0))
        with self.assertRaises(drawing.DrawingError):
            drawing.to_spec(dict(SHAFT, profile=[{"a": 0, "b": 0}]))

    def test_schema_is_strict(self):
        def walk(node):
            if node.get("type") == "object":
                self.assertFalse(node["additionalProperties"])
                self.assertEqual(set(node["required"]), set(node["properties"]))
                for child in node["properties"].values():
                    walk(child)
            if node.get("type") == "array":
                walk(node["items"])
        walk(drawing.SCHEMA)


FIXTURES = json.loads((ROOT / "tests" / "fixtures" / "drawings.json").read_text(encoding="utf-8"))
REAL = {k: v for k, v in FIXTURES.items() if not k.startswith("_")}


def api_answer(answer):
    """Pad a free-mode answer with the fields the strict API schema always sends."""
    blank = {"axis": "z", "from": 0, "to": 0, "outline": [], "profile": [], "center": [0, 0], "diameter": 0,
             "sides": 0, "rotation_deg": 0, "circles": [], "label": ""}
    return dict(answer, features=[{**blank, **f} for f in answer["features"]])


class CsgTests(unittest.TestCase):
    def test_prompt_shared_with_browser(self):
        self.assertIn('"kind": "csg"', drawing.SYSTEM)
        self.assertIn("```json", drawing.SYSTEM)
        self.assertNotIn("\\`", drawing.SYSTEM)

    def test_api_answer_to_spec_drops_unused_fields(self):
        spec = drawing.to_spec(api_answer(REAL["kalit"]["answer"]))
        self.assertEqual(spec["kind"], "csg")
        hull, ring, hexagon = spec["features"]
        self.assertEqual(set(hull), {"op", "shape", "label", "axis", "from", "to", "circles"})
        self.assertEqual(hexagon["sides"], 6)

    @unittest.skipUnless(cad.available(), "cadquery not installed")
    def test_real_drawings_build_exact_solids(self):
        for name, fx in REAL.items():
            with self.subTest(drawing=name):
                spec = drawing.to_spec(api_answer(fx["answer"]))
                solid = cad.build_solid(spec).val()
                self.assertTrue(solid.isValid())
                self.assertAlmostEqual(solid.Volume(), fx["expected_volume"], delta=0.5)


class DrawingApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        import main
        cls.client = TestClient(main.app)

    def test_unavailable_without_key(self):
        with mock.patch.object(drawing, "available", return_value=False):
            r = self.client.post("/api/drawing/analyze", content=b"x", headers={"Content-Type": "image/png"})
        self.assertEqual(r.status_code, 503)

    def test_endpoint(self):
        fake = FakeClient(PLATE)
        real = drawing.analyze
        with mock.patch.object(drawing, "available", return_value=True), \
             mock.patch.object(drawing, "analyze", side_effect=lambda d, t, n: real(d, t, n, client=fake)):
            r = self.client.post("/api/drawing/analyze?note=test", content=b"\x89PNG", headers={"Content-Type": "image/png"})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["spec"]["kind"], "extrude")
        if cad.available():
            self.assertGreater(body["analysis"]["volume_cm3"], 0)

    @unittest.skipUnless(cad.available(), "cadquery not installed")
    def test_csg_step_export(self):
        spec = dict(REAL["vtulkali_asos"]["answer"], name="Vtulkali asos")
        r = self.client.post("/api/export/step", json={"kind": "csg", "name": spec["name"], "features": spec["features"]})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.content.startswith(b"ISO-10303-21"))

    def test_csg_spec_validation(self):
        bad = {"kind": "csg", "features": [{"op": "cut", "shape": "cylinder", "from": 0, "to": 5, "diameter": 3}]}
        self.assertEqual(self.client.post("/api/export/step", json=bad).status_code, 422)
        bad = {"kind": "csg", "features": [{"op": "add", "shape": "cylinder", "from": 5, "to": 5, "diameter": 3}]}
        self.assertEqual(self.client.post("/api/export/step", json=bad).status_code, 422)


if __name__ == "__main__":
    unittest.main()
