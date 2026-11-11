import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import gemini as geminilib  # noqa: E402
import main as backend_main  # noqa: E402


class TestGeminiProxy(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = TestClient(backend_main.app)

    def test_get_without_key(self):
        with patch.dict("os.environ", {"GEMINI_API_KEY": ""}, clear=False):
            r = self.client.get("/api/gemini")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"configured": False, "models": []})

    def test_post_without_key_returns_503_missing_key(self):
        with patch.dict("os.environ", {"GEMINI_API_KEY": ""}, clear=False):
            r = self.client.post("/api/gemini", json={"file": {"mimeType": "image/png", "base64": "QUJD"}, "prompt": "p"})
        self.assertEqual(r.status_code, 503)
        self.assertTrue(r.json().get("missingKey"))

    async def test_proxy_list_and_generate_sanitizes_errors_and_forwards_retry_after(self):
        seen_headers = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen_headers.append(request.headers.get("x-goog-api-key"))
            if request.url.path.endswith("/models"):
                return httpx.Response(200, json={
                    "models": [
                        {"name": "models/gemini-3.5-flash", "displayName": "Flash", "supportedGenerationMethods": ["generateContent"]},
                        {"name": "models/gemini-3.5-flash-tts", "displayName": "TTS", "supportedGenerationMethods": ["generateContent"]},
                    ]
                })
            return httpx.Response(
                429,
                headers={"Retry-After": "23"},
                json={"error": {"message": "Rate limit with SECRET_KEY_999"}},
            )

        transport = httpx.MockTransport(handler)
        models = await geminilib.list_models("SECRET_KEY_999", transport=transport)
        self.assertEqual(models, [{"id": "gemini-3.5-flash", "label": "Flash"}])

        status, data, headers = await geminilib.generate(
            "SECRET_KEY_999",
            {"model": "", "file": {"mimeType": "image/png", "base64": "QUJD"}, "prompt": "Test"},
            transport=transport,
        )
        self.assertEqual(status, 429)
        self.assertEqual(headers.get("Retry-After"), "23")
        self.assertEqual(headers.get("X-Gemini-Model"), "gemini-3.5-flash")
        self.assertNotIn("SECRET_KEY_999", data["error"]["message"])
        self.assertTrue(all(h == "SECRET_KEY_999" for h in seen_headers))

    async def test_generate_validates_payload(self):
        with self.assertRaises(geminilib.ProxyRequestError) as ctx:
            await geminilib.generate("k", {"file": {"mimeType": "text/plain", "base64": "x"}, "prompt": "p"})
        self.assertEqual(ctx.exception.status, 400)


if __name__ == "__main__":
    unittest.main()
