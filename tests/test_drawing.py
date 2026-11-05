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


if __name__ == "__main__":
    unittest.main()
