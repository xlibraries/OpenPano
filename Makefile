.PHONY: build install dev help

help:
	@echo "OpenPano - Video to Panorama"
	@echo ""
	@echo "  make build     Build the C++ stitcher engine"
	@echo "  make install   Install all dependencies"
	@echo "  make dev       Show how to run in development"
	@echo ""

build:
	cd engine && ./generate.sh build

install:
	cd engine && ./generate.sh build
	cd backend && pip install -r requirements.txt
	cd frontend && npm install

dev:
	@echo "Run in separate terminals:"
	@echo ""
	@echo "  Backend:"
	@echo "    cd backend && ENGINE_SCRIPT=../engine/video2pano.py ENGINE_ROOT=../engine python3 server.py"
	@echo ""
	@echo "  Frontend:"
	@echo "    cd frontend && npm run dev"
	@echo ""
	@echo "  Then open http://localhost:3000"
