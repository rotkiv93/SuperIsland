# DevWidget (native macOS widget, Liquid Glass)

WidgetKit widget: VPN connect/disconnect (interactive App Intent buttons), service health,
GitLab review requests. Reads from `Extensions/dev-bridge` (127.0.0.1:7831).

## Requirements
- Full **Xcode 26+** from the App Store (only Command Line Tools installed now)
- `brew install xcodegen`
- A free Apple ID added to Xcode (personal team) for signing

## Build
    cd DevWidget && xcodegen && open DevWidget.xcodeproj
Set the team on both targets, Run `DevWidgetHost`, then right-click desktop → Edit Widgets → Dev Widget.

## TODO
- Bridge: add `/gitlab/summary` (token via env/Keychain file) and `/cornercase/notifications`
- Small/large layouts, per-MR Orca/cornercase buttons (App Intents → `/mr/orca`, `/mr/cornercase`)
