#!/usr/bin/env bash
# Install Púca from GitHub Releases (root tarball + host ABI). No npm registry.
set -euo pipefail

VERSION="${PUCA_VERSION:-0.3.0}"
REPO="${PUCA_REPO:-RexySaragih/puca}"
TAG="v${VERSION}"

detect_abi() {
  local sys
  local machine
  sys="$(uname -s)"
  machine="$(uname -m)"
  case "${sys}-${machine}" in
    Darwin-arm64) echo "darwin-arm64" ;;
    Darwin-x86_64) echo "darwin-x64" ;;
    Linux-x86_64) echo "linux-x64-gnu" ;;
    MINGW64*-x86_64 | MSYS*-x86_64 | CYGWIN*-x86_64) echo "win32-x64-msvc" ;;
    *)
      echo "Unsupported host ${sys}-${machine}. Supported ABIs: darwin-arm64, darwin-x64, linux-x64-gnu, win32-x64-msvc." >&2
      exit 2
      ;;
  esac
}

ABI="$(detect_abi)"
ROOT_TGZ="puca-${VERSION}.tgz"
ABI_TGZ="puca-${ABI}-${VERSION}.tgz"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

curl -fsSL -o "${ROOT_TGZ}" "${BASE}/${ROOT_TGZ}"
curl -fsSL -o "${ABI_TGZ}" "${BASE}/${ABI_TGZ}"
npm install "./${ROOT_TGZ}" "./${ABI_TGZ}" --no-fund --no-audit
echo "Installed puca ${VERSION} (${ABI}). Run: ./node_modules/.bin/puca --help"
