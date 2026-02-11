#!/bin/bash

# ===== Anchor Compiler Service - Production Deployment Script =====
# This script automates the deployment process for production

set -e  # Exit on error

echo "🚀 Anchor Compiler Service - Production Deployment"
echo "=================================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

success() {
    echo -e "${GREEN}✓${NC} $1"
}

warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

error() {
    echo -e "${RED}✗${NC} $1"
}

# Check prerequisites
check_prerequisites() {
    info "Checking prerequisites..."
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        error "Docker not found. Please install Docker first."
        exit 1
    fi
    success "Docker found: $(docker --version)"
    
    # Check Docker Compose
    if ! command -v docker-compose &> /dev/null; then
        error "Docker Compose not found. Please install Docker Compose first."
        exit 1
    fi
    success "Docker Compose found: $(docker-compose --version)"
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        error "Node.js not found. Please install Node.js v18+ first."
        exit 1
    fi
    success "Node.js found: $(node --version)"
    
    echo ""
}

# Setup environment
setup_environment() {
    info "Setting up environment..."
    
    if [ ! -f .env ]; then
        warning ".env file not found. Creating from .env.production.example..."
        cp .env.production.example .env
        warning "⚠️  IMPORTANT: Edit .env and add your ANTHROPIC_API_KEY!"
        read -p "Press Enter after editing .env (Ctrl+C to cancel)..."
    else
        success ".env file exists"
    fi
    
    # Check if ANTHROPIC_API_KEY is set
    if grep -q "your-actual-api-key-here" .env; then
        error "Please set ANTHROPIC_API_KEY in .env file!"
        exit 1
    fi
    
    success "Environment configured"
    echo ""
}

# Build Docker image
build_docker_image() {
    info "Building Anchor Builder Docker image (this may take 10-15 minutes)..."
    
    if docker images | grep -q "anchor-builder.*latest"; then
        warning "anchor-builder:latest already exists"
        read -p "Rebuild? (y/N) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            success "Using existing anchor-builder:latest"
            return
        fi
    fi
    
    docker build -f Dockerfile.anchor-builder -t anchor-builder:latest .
    
    if [ $? -eq 0 ]; then
        success "Docker image built successfully"
        docker images | grep anchor-builder
    else
        error "Docker image build failed"
        exit 1
    fi
    
    echo ""
}

# Install Node.js dependencies
install_dependencies() {
    info "Installing Node.js dependencies..."
    
    npm install
    
    success "Dependencies installed"
    echo ""
}

# Create necessary directories
create_directories() {
    info "Creating necessary directories..."
    
    mkdir -p uploads builds logs
    chmod 755 uploads builds logs
    
    success "Directories created"
    echo ""
}

# Start services
start_services() {
    info "Starting services with Docker Compose..."
    
    docker-compose -f docker-compose.production.yml up -d
    
    if [ $? -eq 0 ]; then
        success "Services started"
    else
        error "Failed to start services"
        exit 1
    fi
    
    echo ""
}

# Wait for service to be ready
wait_for_service() {
    info "Waiting for service to be ready..."
    
    MAX_ATTEMPTS=30
    ATTEMPT=0
    
    while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
        if curl -s http://localhost:5000/health > /dev/null; then
            success "Service is ready!"
            break
        fi
        
        ATTEMPT=$((ATTEMPT + 1))
        echo -n "."
        sleep 1
    done
    
    if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
        error "Service failed to start within 30 seconds"
        error "Check logs: docker-compose logs api"
        exit 1
    fi
    
    echo ""
}

# Display service info
display_info() {
    echo ""
    echo "=================================================="
    success "Deployment completed successfully!"
    echo "=================================================="
    echo ""
    echo "📊 Service Information:"
    echo "  - API:       http://localhost:5000"
    echo "  - Frontend:  http://localhost:8080"
    echo "  - Health:    http://localhost:5000/health"
    echo "  - WebSocket: ws://localhost:5000/ws"
    echo ""
    echo "📝 Useful Commands:"
    echo "  - View logs:     docker-compose -f docker-compose.production.yml logs -f api"
    echo "  - Stop services: docker-compose -f docker-compose.production.yml down"
    echo "  - Restart:       docker-compose -f docker-compose.production.yml restart"
    echo "  - Health check:  curl http://localhost:5000/health"
    echo ""
    echo "📚 Documentation:"
    echo "  - Production Guide: README-PRODUCTION.md"
    echo "  - API Docs:         http://localhost:5000/health (for now)"
    echo ""
    echo "🔒 Security Reminders:"
    echo "  - API Key: $(grep -q 'API_KEY=.*[^=]$' .env && echo '✓ Enabled' || echo '✗ Not set (optional)')"
    echo "  - CORS:    $(grep 'CORS_ORIGIN' .env | cut -d= -f2)"
    echo ""
}

# Main deployment flow
main() {
    check_prerequisites
    setup_environment
    install_dependencies
    create_directories
    build_docker_image
    start_services
    wait_for_service
    display_info
}

# Run deployment
main
