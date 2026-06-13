#!/bin/bash
# Build script for Arch Linux AUR package (PKGBUILD)

set -e

APP_NAME="lattice"
APP_VERSION="0.1.0"
MAINTAINER="vijaygatla <your@email.com>"

echo "Building Lattice AUR package..."

# Create PKGBUILD directory
mkdir -p dist/aur
cd dist/aur

cat > PKGBUILD << 'EOF'
# Maintainer: vijaygatla <your@email.com>
pkgname=lattice-bin
pkgver=0.1.0
pkgrel=1
pkgdesc="A Git-native personal knowledge management system with Canvas, Academic papers, and BYOC sync"
arch=('x86_64')
url="https://github.com/vijaygatla/lattice"
license=('MIT')
depends=('webkit2gtk' 'gtk3' 'libayatana-appindicator' 'git')
optdepends=(
    'ripgrep: Fast search backend'
    'fzf: Alternative search backend'
)
provides=('lattice')
conflicts=('lattice')
source=("${pkgname}-${pkgver}.tar.gz::https://github.com/vijaygatla/lattice/releases/download/v${pkgver}/lattice_${pkgver}_amd64.tar.gz")
sha256sums=('SKIP')

package() {
    cd "$srcdir"
    
    # Install binary
    install -Dm755 lattice "$pkgdir/usr/bin/lattice"
    
    # Install desktop file
    install -Dm644 lattice.desktop "$pkgdir/usr/share/applications/lattice.desktop"
    
    # Install icon
    install -Dm644 icons/128x128.png "$pkgdir/usr/share/pixmaps/lattice.png"
    
    # Install CLI
    install -Dm755 cli/lattice.js "$pkgdir/usr/bin/lattice-cli"
}
EOF

cat > .SRCINFO << 'EOF'
pkgbase = lattice-bin
	pkgdesc = A Git-native personal knowledge management system
	pkgver = 0.1.0
	pkgrel = 1
	url = https://github.com/vijaygatla/lattice
	arch = x86_64
	license = MIT
	depends = webkit2gtk
	depends = gtk3
	depends = libayatana-appindicator
	depends = git
	optdepends = ripgrep: Fast search backend
	optdepends = fzf: Alternative search backend
	provides = lattice
	conflicts = lattice
	source = lattice-bin-0.1.0.tar.gz::https://github.com/vijaygatla/lattice/releases/download/v0.1.0/lattice_0.1.0_amd64.tar.gz
	sha256sums = SKIP

pkgname = lattice-bin
EOF

echo "✓ Created PKGBUILD and .SRCINFO"
echo ""
echo "To publish to AUR:"
echo "1. Create AUR account at https://aur.archlinux.org/"
echo "2. git clone ssh://aur@aur.archlinux.org/lattice-bin.git"
echo "3. Copy PKGBUILD and .SRCINFO to lattice-bin/"
echo "4. makepkg --printsrcinfo > .SRCINFO"
echo "5. git add PKGBUILD .SRCINFO && git commit -m 'Initial release'"
echo "6. git push"
