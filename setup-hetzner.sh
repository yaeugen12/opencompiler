#!/bin/bash
set -e

# ==========================================
# OpenCompiler - Hetzner CX42 Setup
# Run this on a fresh Ubuntu 24.04 server
# ==========================================

DOMAIN="${1:-api.opencompiler.io}"
EMAIL="${2:-}"
GITHUB_REPO="https://github.com/yaeugen12/opencompiler.git"

echo "=========================================="
echo "  OpenCompiler API - Hetzner Setup"
echo "=========================================="
echo "  Domain: $DOMAIN"
echo "=========================================="

if [ -z "$EMAIL" ]; then
    echo ""
    echo "Usage: ./setup-hetzner.sh <domain> <email>"
    echo "  domain: your API domain (default: api.opencompiler.io)"
    echo "  email:  email for Let's Encrypt SSL"
    echo ""
    echo "Example: ./setup-hetzner.sh api.opencompiler.io admin@opencompiler.io"
    echo ""
    echo "Running without SSL (HTTP only)..."
    echo ""
fi

# ===== 1. System Update =====
echo "[1/8] Updating system..."
apt-get update && apt-get upgrade -y

# ===== 2. Add Swap (needed for Rust compilation) =====
echo "[2/8] Setting up swap space..."
if [ ! -f /swapfile ]; then
    fallocate -l 4G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo "4GB swap created"
else
    echo "Swap already exists"
fi

# ===== 3. Install Docker =====
echo "[3/8] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
    echo "Docker installed successfully"
else
    echo "Docker already installed"
fi

# Install Docker Compose plugin
if ! docker compose version &> /dev/null; then
    apt-get install -y docker-compose-plugin
fi

# ===== 4. Install useful tools =====
echo "[4/8] Installing tools..."
apt-get install -y git curl htop ufw

# ===== 5. Configure Firewall =====
echo "[5/8] Configuring firewall..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP
ufw allow 443/tcp   # HTTPS
ufw --force enable
echo "Firewall configured (SSH + HTTP + HTTPS)"

# ===== 6. Clone and Setup Project =====
echo "[6/8] Setting up project..."
PROJECT_DIR="/opt/opencompiler/anchor-compiler-service"
mkdir -p /opt/opencompiler

# Clone repo if not already present
if [ ! -f "docker-compose.production.yml" ]; then
    echo "Cloning repository..."
    cd /opt
    rm -rf opencompiler
    git clone "$GITHUB_REPO" opencompiler
    PROJECT_DIR="/opt/opencompiler/anchor-compiler-service"
    cd "$PROJECT_DIR"
fi

# ===== 7. Build Anchor Builder Image =====
echo "[7/8] Building anchor-builder Docker image (this takes 10-15 min)..."
if [ -f "Dockerfile.anchor-builder" ]; then
    docker build -f Dockerfile.anchor-builder -t anchor-builder:latest . || {
        echo "WARNING: anchor-builder image build failed."
        echo "You can build it later with:"
        echo "  docker build -f Dockerfile.anchor-builder -t anchor-builder:latest ."
    }
else
    echo "Dockerfile.anchor-builder not found, skipping image build."
fi

# ===== 8. SSL Setup =====
echo "[8/8] Setting up SSL..."
mkdir -p nginx/ssl

if [ -n "$EMAIL" ]; then
    echo "Setting up Let's Encrypt for $DOMAIN..."

    # Generate temporary self-signed cert for nginx to start
    openssl req -x509 -nodes -days 1 -newkey rsa:2048 \
        -keyout nginx/ssl/privkey.pem \
        -out nginx/ssl/fullchain.pem \
        -subj "/CN=$DOMAIN"

    # Create .env.production if not exists
    if [ ! -f ".env.production" ]; then
        cp .env.production.example .env.production 2>/dev/null || true
    fi

    # Start nginx first (needed for ACME challenge)
    docker compose -f docker-compose.production.yml up -d nginx

    # Get real SSL certificate
    docker run --rm \
        -v "$(pwd)/certbot_data:/var/www/certbot" \
        -v "$(pwd)/certbot_certs:/etc/letsencrypt" \
        certbot/certbot certonly \
        --webroot --webroot-path=/var/www/certbot \
        --email "$EMAIL" --agree-tos --no-eff-email \
        -d "$DOMAIN"

    # Link real certs
    ln -sf "/opt/opencompiler/anchor-compiler-service/certbot_certs/live/$DOMAIN/fullchain.pem" nginx/ssl/fullchain.pem
    ln -sf "/opt/opencompiler/anchor-compiler-service/certbot_certs/live/$DOMAIN/privkey.pem" nginx/ssl/privkey.pem

    echo "SSL certificate obtained for $DOMAIN"
else
    echo "No email specified. Generating self-signed certificate..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout nginx/ssl/privkey.pem \
        -out nginx/ssl/fullchain.pem \
        -subj "/CN=$DOMAIN"
    echo "Self-signed certificate generated (browser will show warning)"
fi

# ===== Done =====
echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Create .env.production:"
echo "   cp .env.production.example .env.production"
echo "   nano .env.production"
echo ""
echo "2. Start everything:"
echo "   docker compose -f docker-compose.production.yml up -d"
echo ""
echo "3. Check status:"
echo "   docker compose -f docker-compose.production.yml ps"
echo "   curl https://$DOMAIN/health"
echo ""
echo "Your API will be available at: https://$DOMAIN"
echo ""
