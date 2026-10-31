import WidgetKit
import SwiftUI
import AppIntents

struct Intent_VPN: AppIntent {
    static var title: LocalizedStringResource = "Toggle VPN"
    @Parameter(title: "Connect") var connect: Bool
    init() {}
    init(connect: Bool) { self.connect = connect }
    func perform() async throws -> some IntentResult {
        await Bridge.post(connect ? "/vpn/connect" : "/vpn/disconnect")
        return .result()
    }
}

struct Entry: TimelineEntry {
    let date: Date
    let vpn: VPN?
    let services: [ServiceItem]
    let gitlab: GitLabSummary?
}

struct Provider: TimelineProvider {
    func placeholder(in: Context) -> Entry { Entry(date: .now, vpn: nil, services: [], gitlab: nil) }
    func getSnapshot(in: Context, completion: @escaping (Entry) -> Void) { Task { completion(await load()) } }
    func getTimeline(in: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        Task { completion(Timeline(entries: [await load()], policy: .after(.now.addingTimeInterval(120)))) }
    }
    func load() async -> Entry {
        async let v = Bridge.get("/vpn", as: VPN.self)
        async let s = Bridge.get("/services", as: ServicesResponse.self)
        async let g = Bridge.get("/gitlab/summary", as: GitLabSummary.self)   // TODO: add to bridge.py
        return Entry(date: .now, vpn: await v, services: await s?.items ?? [], gitlab: await g)
    }
}

struct DevWidgetView: View {
    let e: Entry
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: e.vpn?.connected == true ? "lock.shield.fill" : "lock.open")
                    .foregroundStyle(e.vpn?.connected == true ? .green : .red)
                Text(e.vpn?.connected == true ? "VPN on" : "VPN off").font(.headline)
                Spacer()
                Button(intent: Intent_VPN(connect: e.vpn?.connected != true)) {
                    Text(e.vpn?.connected == true ? "Disconnect" : "Connect")
                }.buttonStyle(.glass)
            }
            HStack(spacing: 6) {
                ForEach(e.services) { s in
                    Label(s.name, systemImage: "circle.fill")
                        .labelStyle(.titleAndIcon).font(.caption2)
                        .foregroundStyle(s.up ? .green : .red)
                }
            }
            Divider()
            if let g = e.gitlab {
                Text("Review requested · \(g.review.count)   Todos · \(g.todos)").font(.caption).foregroundStyle(.secondary)
                ForEach(g.review.prefix(4)) { mr in
                    Link(destination: URL(string: mr.url)!) {
                        HStack { Text(mr.title).lineLimit(1); Spacer(); Text(mr.project).foregroundStyle(.secondary) }
                            .font(.caption)
                    }
                }
            } else {
                Text("GitLab: bridge unavailable").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        // Liquid Glass: the system renders the widget background as glass on macOS 26+.
        .containerBackground(.clear, for: .widget)
    }
}

@main
struct DevWidgetBundle: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "DevWidget", provider: Provider()) { DevWidgetView(e: $0) }
            .configurationDisplayName("Dev Status")
            .description("VPN, services, GitLab MRs.")
            .supportedFamilies([.systemMedium, .systemLarge])
    }
}
