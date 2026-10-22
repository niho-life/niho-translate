#!/bin/sh
set -eu

SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
MODULE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/niho-translate-ios.XXXXXX")"
MODULE_CACHE="$(mktemp -d "${TMPDIR:-/tmp}/niho-translate-module-cache.XXXXXX")"

cleanup() {
  rm -rf "$MODULE_DIR" "$MODULE_CACHE"
}
trap cleanup EXIT

xcrun swiftc \
  -emit-module \
  -parse-as-library \
  -module-name NIHOTranslateCore \
  -target arm64-apple-ios15.5-simulator \
  -sdk "$SDK_PATH" \
  -module-cache-path "$MODULE_CACHE" \
  ios/Sources/NIHOTranslateCore/*.swift \
  -emit-module-path "$MODULE_DIR/NIHOTranslateCore.swiftmodule"

xcrun swiftc \
  -emit-module \
  -parse-as-library \
  -module-name NIHOTranslate \
  -target arm64-apple-ios15.5-simulator \
  -sdk "$SDK_PATH" \
  -module-cache-path "$MODULE_CACHE" \
  -I "$MODULE_DIR" \
  ios/Sources/NIHOTranslate/*.swift \
  -emit-module-path "$MODULE_DIR/NIHOTranslate.swiftmodule"

xcrun swiftc \
  -typecheck \
  -parse-as-library \
  -target arm64-apple-ios15.5-simulator \
  -sdk "$SDK_PATH" \
  -module-cache-path "$MODULE_CACHE" \
  -I "$MODULE_DIR" \
  examples/ios/TranslateView.swift
