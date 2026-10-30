"""Agnes（OpenAI 兼容）对话客户端，流式。"""
import json
import logging
from typing import AsyncIterator

import httpx

from app.config import settings

log = logging.getLogger(__name__)


async def stream_chat(messages: list[dict], *, temperature: float = 0.2) -> AsyncIterator[str]:
    if not settings.llm_api_key:
        yield "（未配置 LLM_API_KEY，无法生成回答）"
        return

    payload = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            f"{settings.llm_base.rstrip('/')}/chat/completions",
            headers={"Authorization": f"Bearer {settings.llm_api_key}"},
            json=payload,
        ) as r:
            if r.status_code >= 400:
                body = (await r.aread()).decode("utf-8", "ignore")[:300]
                raise RuntimeError(f"LLM {r.status_code}: {body}")
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                chunk = line[5:].strip()
                if chunk == "[DONE]":
                    break
                try:
                    delta = json.loads(chunk)["choices"][0]["delta"].get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if delta:
                    yield delta


async def chat_once(messages: list[dict], *, temperature: float = 0.2) -> str:
    return "".join([t async for t in stream_chat(messages, temperature=temperature)])
