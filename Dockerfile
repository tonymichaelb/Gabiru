FROM python:3.11-slim

WORKDIR /app

# Instalar dependências do sistema (incluindo gcc para build do RPi.GPIO)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    curl \
    unzip \
    rsync \
    fswebcam \
    gcc \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Copiar requirements
COPY backend/requirements.txt .

# Instalar dependências Python
RUN pip install --no-cache-dir -r requirements.txt

# Remover gcc após a instalação para reduzir tamanho da imagem
RUN apt-get purge -y gcc python3-dev && apt-get autoremove -y

# Copiar aplicação
COPY backend/app ./app

# Criar diretório de dados
RUN mkdir -p /app/data /app/data/uploads /app/data/timelapse

# Expor porta
EXPOSE 8080

# Executar aplicação
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
