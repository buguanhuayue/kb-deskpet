.PHONY: help up down logs migrate seed check eval sh

help:
	@echo "make up       起 postgres/api/worker（首次会 build）"
	@echo "make check    M0 自检：db / embedding / rerank / llm"
	@echo "make seed     造演示账号并打印 token"
	@echo "make logs     跟踪 api+worker 日志"
	@echo "make migrate  只跑迁移"
	@echo "make down     停容器（保留数据卷）"

up:
	docker compose up -d --build
	@echo "验收台: http://localhost:$${APP_PORT:-8088}"

sync:
	@rsync -a --exclude='.git' --exclude='.env' --exclude='.venv' --exclude='server/data' --exclude='dist' ./ kbvm:~/kb-deskpet/
	@echo "已同步到 kbvm（.env 不动）；改 Python 需 docker compose up -d --build api worker"

down:
	docker compose down

logs:
	docker compose logs -f api worker

migrate:
	docker compose exec api python scripts/migrate.py

seed:
	docker compose exec api python scripts/seed.py

check:
	docker compose exec api python scripts/check_keys.py

eval:
	docker compose exec api python scripts/eval_retrieval.py

sh:
	docker compose exec api bash
