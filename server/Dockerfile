FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e . || pip install --no-cache-dir \
      "fastapi>=0.115" "uvicorn[standard]>=0.30" "psycopg[binary,pool]>=3.2" \
      "pydantic-settings>=2.4" "httpx>=0.27" "jieba>=0.42" "pypdfium2>=4.30" \
      "python-multipart>=0.0.9" "pgvector>=0.3"

COPY . .
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8088"]
