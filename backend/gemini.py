"""Server-side Gemini API proxy helpers so the key never leaves the backend."""
from __future__ import annotations

import os
import re
from typing import Any, Optional

import httpx

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
SKIP_MODEL = re.compile(
    r"(image|tts|audio|live|embed|vision|robot|computer|learnlm|aqa|imagen|veo|gemma|native|nano|transcribe|customtools|argon|carbon|omni)",
    re.I,
)
ALLOWED_MIME = re.compile(r"^(image/(png|jpeg|webp|gif)|application/pdf)$", re.I)
SAFE_MODEL = re.compile(r"^[A-Za-z0-9._-]+$")


class ProxyRequestError(ValueError):
    """Validated client or upstream configuration error with an HTTP status code."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def get_api_key() -> str:
    return os.environ.get("GEMINI_API_KEY", "").strip()


def sanitize_error(msg: Any, api_key: str) -> str:
    text = str(msg or "Noma'lum xatolik")
    return text.replace(api_key, "***") if api_key else text


def _version(name: str) -> float:
    m = re.search(r"gemini-(\d+(?:\.\d+)?)", name)
    return float(m.group(1)) if m else 0.0


def rank_models(models: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Filter and rank Gemini models suitable for multimodal JSON generation."""
    usable = [
        m for m in (models or [])
        if re.search(r"gemini", m.get("name", ""), re.I)
        and re.search(r"(flash|lite|pro)", m.get("name", ""), re.I)
        and not SKIP_MODEL.search(m.get("name", ""))
        and "generateContent" in (m.get("supportedGenerationMethods") or [])
    ]

    def score(m: dict[str, Any]) -> float:
        n = m.get("name", "").lower()
        s = _version(n) * 100.0
        if "flash" in n and "lite" not in n:
            s += 30
        elif "lite" in n:
            s += 10
        elif "pro" in n:
            s += 5
        if re.search(r"preview|exp", n):
            s -= 15
        if "latest" in n:
            s += 1
        return s

    usable.sort(key=score, reverse=True)
    return [
        {"id": re.sub(r"^models/", "", m["name"]), "label": m.get("displayName") or m["name"]}
        for m in usable
    ]


def thinking_config_for(model: str, fast: bool) -> Optional[dict[str, Any]]:
    if not fast:
        return None
    v = _version(model)
    if v >= 3:
        return {"thinkingLevel": "low"}
    if v >= 2.5:
        return {"thinkingBudget": 1024 if re.search(r"pro", model, re.I) else 512}
    return None


async def list_models(
    api_key: str,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> list[dict[str, str]]:
    all_models: list[dict[str, Any]] = []
    token = ""
    async with httpx.AsyncClient(timeout=30.0, transport=transport) as client:
        for _ in range(5):
            url = f"{GEMINI_BASE}/models?pageSize=200" + (f"&pageToken={token}" if token else "")
            res = await client.get(url, headers={"x-goog-api-key": api_key})
            data = res.json() if res.content else {}
            if not res.is_success:
                msg = (data.get("error") or {}).get("message") or res.reason_phrase or f"HTTP {res.status_code}"
                raise ProxyRequestError(res.status_code, sanitize_error(msg, api_key))
            all_models.extend(data.get("models") or [])
            token = data.get("nextPageToken") or ""
            if not token:
                break
    ranked = rank_models(all_models)
    if not ranked:
        raise ProxyRequestError(502, "Chizma o'qiy oladigan Gemini modeli topilmadi")
    return ranked


def _build_body(mime_type: str, base64_data: str, prompt: str, thinking: Optional[dict[str, Any]]) -> dict[str, Any]:
    gen_cfg: dict[str, Any] = {"responseMimeType": "application/json"}
    if thinking:
        gen_cfg["thinkingConfig"] = thinking
    return {
        "contents": [{
            "role": "user",
            "parts": [
                {"inline_data": {"mime_type": mime_type, "data": base64_data}},
                {"text": prompt + "\n\nReturn ONLY the JSON object (no prose, no code fence): a program parses your answer."},
            ],
        }],
        "generationConfig": gen_cfg,
    }


async def generate(
    api_key: str,
    payload: dict[str, Any],
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> tuple[int, dict[str, Any], dict[str, str]]:
    file = payload.get("file") if isinstance(payload, dict) else None
    prompt = payload.get("prompt") if isinstance(payload, dict) else None
    if (
        not isinstance(file, dict)
        or not isinstance(file.get("mimeType"), str)
        or not ALLOWED_MIME.match(file["mimeType"])
        or not isinstance(file.get("base64"), str)
        or not file["base64"]
    ):
        raise ProxyRequestError(400, "Yaroqli chizma fayli (PNG, JPEG, WEBP, GIF yoki PDF) yuborilishi shart")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 50000:
        raise ProxyRequestError(400, "Prompt matni bo'sh yoki juda uzun")

    model = str(payload.get("model") or "").strip()
    if model and not SAFE_MODEL.match(model):
        raise ProxyRequestError(400, "Model nomi noto'g'ri")
    if not model:
        models = await list_models(api_key, transport=transport)
        model = models[0]["id"]

    url = f"{GEMINI_BASE}/models/{model}:generateContent"
    tc = thinking_config_for(model, bool(payload.get("fast")))
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}

    async with httpx.AsyncClient(timeout=22.0, transport=transport) as client:
        try:
            up = await client.post(url, headers=headers, json=_build_body(file["mimeType"], file["base64"], prompt, tc))
            data = up.json() if up.content else {"error": {"message": up.reason_phrase or f"HTTP {up.status_code}"}}
            if not up.is_success and up.status_code == 400 and tc:
                err_msg = str((data.get("error") or {}).get("message") or "")
                if re.search(r"thinking", err_msg, re.I):
                    up = await client.post(url, headers=headers, json=_build_body(file["mimeType"], file["base64"], prompt, None))
                    data = up.json() if up.content else {"error": {"message": up.reason_phrase or f"HTTP {up.status_code}"}}
        except httpx.TimeoutException:
            return 504, {"error": {"message": "Model javobi kechikdi — boshqa modelga o'tilmoqda"}}, {
                "Cache-Control": "no-store",
                "X-Gemini-Model": model,
            }

    if isinstance(data, dict) and isinstance(data.get("error"), dict) and "message" in data["error"]:
        data["error"]["message"] = sanitize_error(data["error"]["message"], api_key)

    resp_headers = {"Cache-Control": "no-store", "X-Gemini-Model": model}
    retry_after = up.headers.get("retry-after")
    if retry_after:
        resp_headers["Retry-After"] = retry_after
    return up.status_code, data, resp_headers
