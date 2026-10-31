import SwiftUI

// Minimal host app: WidgetKit extensions must ship inside an app.
@main
struct DevWidgetHost: App {
    var body: some Scene {
        MenuBarExtra("Dev Widget", systemImage: "square.grid.2x2") {
            Text("Add the widget: right-click desktop → Edit Widgets → Dev Widget")
            Divider()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
    }
}
