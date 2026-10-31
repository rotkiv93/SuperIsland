#!/bin/bash
# Installs the dev bridge as a LaunchAgent (starts at login, restarts on crash).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.victor.superisland.dev-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$(command -v /opt/homebrew/bin/python3 || command -v python3)"
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PY</string><string>$DIR/bridge.py</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/dev-bridge.log</string>
</dict></plist>
P
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1; curl -s http://127.0.0.1:7831/health && echo " <- bridge up"
echo "Uninstall: launchctl bootout gui/\$(id -u)/$LABEL && rm $PLIST"
