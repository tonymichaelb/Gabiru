FROM python:3.11-slim

WORKDIR /app

# Instalar dependências do sistema
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    curl \
    unzip \
    rsync \
    libcamera-apps \
    fswebcam \
    && rm -rf /var/lib/apt/lists/*

# Copiar requirements
COPY backend/requirements.txt .

# Instalar dependências Python
RUN pip install --no-cache-dir -r requirements.txt

# Copiar aplicação
COPY backend/app ./app

# Criar diretório de dados
RUN mkdir -p /app/data /app/data/uploads /app/data/timelapse

# Expor porta
EXPOSE 8080

# Executar aplicação
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
