#!/bin/bash
# Build AppImage for Linux distribution

set -e

APP_NAME="Lattice"
APP_VERSION="0.1.0"
ARCH="x86_64"

echo "Building AppImage..."

# Install appimagetool if not available
if ! command -v appimagetool &> /dev/null; then
    echo "Installing appimagetool..."
    wget "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x appimagetool-x86_64.AppImage
    APPIMAGETOOL="./appimagetool-x86_64.AppImage"
else
    APPIMAGETOOL="appimagetool"
fi

# Create AppDir structure
APP_DIR="dist/AppDir"
mkdir -p "$APP_DIR"

# Create directory structure
mkdir -p "$APP_DIR/usr/bin"
mkdir -p "$APP_DIR/usr/lib"
mkdir -p "$APP_DIR/usr/share/applications"
mkdir -p "$APP_DIR/usr/share/icons/hicolor/128x128/apps"
mkdir -p "$APP_DIR/usr/share/icons/hicolor/256x256/apps"

# Copy binary
echo "Copying binary..."
cp target/release/lattice "$APP_DIR/usr/bin/"

# Copy libraries (webkit2gtk dependencies)
echo "Copying dependencies..."
ldd target/release/lattice | grep "=> /" | awk '{print $3}' | xargs -I '{}' cp -v '{}' "$APP_DIR/usr/lib/" || true

# Create desktop file
cat > "$APP_DIR/usr/share/applications/lattice.desktop" << EOF
[Desktop Entry]
Name=Lattice
Comment=Personal Knowledge Management
Exec=lattice
Icon=lattice
Type=Application
Categories=Utility;Office;
Terminal=false
StartupWMClass=lattice
EOF

# Copy icon
cp public/icons/128x128.png "$APP_DIR/usr/share/icons/hicolor/128x128/apps/lattice.png"
cp public/icons/icon.png "$APP_DIR/usr/share/icons/hicolor/256x256/apps/lattice.png"

# Create AppRun script
cat > "$APP_DIR/AppRun" << 'EOF'
#!/bin/bash
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
export PATH="${HERE}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${LD_LIBRARY_PATH}"
exec "${HERE}/usr/bin/lattice" "$@"
EOF

chmod +x "$APP_DIR/AppRun"

# Create desktop entry in root
cp "$APP_DIR/usr/share/applications/lattice.desktop" "$APP_DIR/lattice.desktop"
cp "$APP_DIR/usr/share/icons/hicolor/128x128/apps/lattice.png" "$APP_DIR/lattice.png"

# Build AppImage
echo "Building AppImage..."
$APPIMAGETOOL "$APP_DIR" "dist/Lattice-${APP_VERSION}-${ARCH}.AppImage"

echo "✓ AppImage created: dist/Lattice-${APP_VERSION}-${ARCH}.AppImage"
echo ""
echo "To distribute:"
echo "1. Upload to GitHub releases"
echo "2. Users can chmod +x and run directly"
echo "3. Optional: Submit to AppImageHub"
