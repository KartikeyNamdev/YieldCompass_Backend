# Build context = repo root:  docker build -f infra/analytics.Dockerfile .
FROM python:3.11-slim
WORKDIR /app
COPY services/analytics/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/analytics/app ./app
COPY data/seed ./data/seed
ENV SEED_DIR=/app/data/seed
EXPOSE 8000
# hosts such as Render inject PORT
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
