#!/usr/bin/env bash
# Rebuild vendor/scrcpy-server-v4.1-agent-eye.jar: scrcpy's server, tag v4.1, plus
# vendor/scrcpy-camera-controls.patch (manual focus, exposure / white balance locks, 3A reports).
#
# Needs git, a JDK 17 (JAVA_HOME) and the Android SDK (ANDROID_HOME: platform 36, build-tools 36.0.0).
# Usage: scripts/build-server.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SDK=${ANDROID_HOME:-$HOME/Library/Android/sdk}
PLAT=$SDK/platforms/android-36
BT=$SDK/build-tools/36.0.0
JAVAC=${JAVA_HOME:+$JAVA_HOME/bin/}javac
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

git clone -q --depth 1 -b v4.1 https://github.com/Genymobile/scrcpy.git "$W/scrcpy"
git -C "$W/scrcpy" apply "$ROOT/vendor/scrcpy-camera-controls.patch"
SRC=$W/scrcpy/server/src/main
mkdir -p "$W/classes" "$W/gen/com/genymobile/scrcpy"
printf 'package com.genymobile.scrcpy;\npublic final class BuildConfig {\n  public static final boolean DEBUG = false;\n  public static final String VERSION_NAME = "4.1";\n}\n' \
  > "$W/gen/com/genymobile/scrcpy/BuildConfig.java"
(cd "$SRC/aidl" && "$BT/aidl" -o"$W/gen" -I. android/content/IOnPrimaryClipChangedListener.aidl \
  && "$BT/aidl" -o"$W/gen" -I. -p "$PLAT/framework.aidl" android/view/IDisplayWindowListener.aidl)
(cd "$SRC/java" && "$JAVAC" -nowarn -encoding UTF-8 -bootclasspath "$PLAT/android.jar" -cp "$BT/core-lambda-stubs.jar:$W/gen" \
  -d "$W/classes" -source 1.8 -target 1.8 \
  android/content/*.java com/genymobile/scrcpy/*.java \
  com/genymobile/scrcpy/{audio,control,device,display,model,opengl,util,video,wrappers}/*.java \
  $(find "$W/gen" -name '*.java'))
(cd "$W/classes" && "$BT/d8" --classpath "$PLAT/android.jar" --output "$W/server.zip" $(find . -name '*.class' | sed 's|^\./||'))
mv "$W/server.zip" "$ROOT/vendor/scrcpy-server-v4.1-agent-eye.jar"
echo "built vendor/scrcpy-server-v4.1-agent-eye.jar"
