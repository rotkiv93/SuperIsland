# Dev Bridge
Local helper (127.0.0.1:7831) used by `dev-status` and `clipboard-shelf`, because extensions cannot run shell commands.
Install: `./install.sh`. Env: `DEV_BRIDGE_CORNERCASE_REMOTE` (default `vps`), `DEV_BRIDGE_GITLAB_HOST`.
VPN connect/disconnect clicks the GlobalProtect menu-bar UI via AppleScript, so the process running the bridge needs Accessibility permission.
Clipboard entries marked concealed/transient (password managers) are never stored; pins persist in `~/Library/Application Support/SuperIsland/dev-bridge/pins.json`.
