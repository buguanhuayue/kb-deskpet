from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://kb:kb@localhost:5433/kb"

    # 生成
    llm_base: str = "https://apihub.agnes-ai.com/v1"
    llm_model: str = "agnes-3.0-flash"
    llm_api_key: str = ""

    # 向量化
    embed_base: str = "https://api.siliconflow.cn/v1"
    embed_model: str = "BAAI/bge-m3"
    embed_api_key: str = ""
    embed_dim: int = 1024

    # 重排
    rerank_base: str = "https://api.siliconflow.cn/v1"
    rerank_model: str = "BAAI/bge-reranker-v2-m3"
    rerank_api_key: str = ""

    # 检索
    top_k: int = 5
    candidates: int = 40
    rrf_k: int = 60
    not_found_threshold: float = 0.35

    # 存储
    storage_dir: str = "/data/files"
    max_upload_mb: int = 200

    app_port: int = 8088
    log_level: str = "INFO"

    @property
    def embed_enabled(self) -> bool:
        return bool(self.embed_api_key)

    @property
    def rerank_enabled(self) -> bool:
        return bool(self.rerank_api_key or self.embed_api_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
