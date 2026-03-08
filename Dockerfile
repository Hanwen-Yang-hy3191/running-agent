# ── Stage 1: Install Node.js dependencies ────────────────────────────────────
FROM node:20-slim AS node-deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM python:3.12-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install opencode-ai globally
RUN npm install -g opencode-ai tsx

# Set up Python dependencies
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy Node.js dependencies from stage 1
COPY --from=node-deps /app/node_modules ./node_modules

# Copy application code
COPY package.json ./
COPY tsconfig.json* ./
COPY opencode.json ./
COPY api.py shared.py models.py scheduler.py ./
COPY src/ ./src/

# Create directories for data and workspaces
RUN mkdir -p /data /workspaces

# Environment defaults
ENV PYTHONPATH=/app
ENV APP_DIR=/app
ENV DATA_DIR=/data
ENV WORKSPACES_DIR=/workspaces
ENV PORT=8000

EXPOSE 8000

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
