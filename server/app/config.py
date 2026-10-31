from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql://kb:kb@localhost:5433/kb"

    # 生成
    llm_base: str = "https://apihub.agnes-ai.com/v1"
    llm_model: str = "agnes-3.0-flash"
    llm_api_key: str = ""

    # 向量化（默认指向本仓库自带的 embed 服务，见 docker-compose.yml）
    embed_base: str = "http://embed:8088/v1"
    embed_model: str = "jinaai/jina-embeddings-v3"
    embed_api_key: str = ""
    embed_dim: int = 1024
    # 向量化不可用（余额不足 / 服务挂了）时怎么办：
    #   true （默认）→ 整篇置 failed，宁可失败也不写不可检索的数据
    #   false        → 落 embedding=NULL、embed_model='none'，仅关键词可检索
    embed_required: bool = True

    # 重排（同上，本地服务；置空 RERANK_API_KEY 则不出重排，退回余弦阈值）
    rerank_base: str = "http://embed:8088/v1"
    rerank_model: str = "jinaai/jina-reranker-v2-base-multilingual"
    rerank_api_key: str = ""

    # 检索
    top_k: int = 5
    candidates: int = 40
    rrf_k: int = 60
    not_found_threshold: float = 0.35

    # 存储
    storage_dir: str = "/data/files"
    max_upload_mb: int = 200

    app_port: int = 9527
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
