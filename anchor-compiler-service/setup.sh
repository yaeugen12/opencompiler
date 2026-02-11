#!/bin/bash
set -e

echo "🔧 Setting up Anchor Compiler Service"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install Docker first."
    exit 1
fi
echo "✅ Docker installed"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js v18+ first."
    exit 1
fi
echo "✅ Node.js $(node -v)"

echo ""
echo "🐳 Building Anchor builder Docker image..."
echo "   This will take 10-15 minutes (compiling Anchor CLI)..."

docker build -f Dockerfile.anchor-builder -t anchor-builder:latest .

echo ""
echo "✅ Docker image built successfully!"

echo ""
echo "📦 Installing npm dependencies..."
npm install

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Start the service: npm start"
echo "  2. Test with: curl http://localhost:3000/health"
echo ""
