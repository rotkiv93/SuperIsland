import Foundation

// Talks to Extensions/dev-bridge (127.0.0.1:7831).
struct VPN: Decodable { var connected: Bool; var ip: String?; var gitlabReachable: Bool? }
struct ServiceItem: Decodable, Identifiable { var name: String; var up: Bool; var id: String { name } }
struct ServicesResponse: Decodable { var items: [ServiceItem] }
struct MR: Decodable, Identifiable { var id: Int; var title: String; var project: String; var url: String; var pipeline: String? }
struct GitLabSummary: Decodable { var review: [MR]; var mine: [MR]; var todos: Int; var issues: Int }

enum Bridge {
    static let base = URL(string: "http://127.0.0.1:7831")!

    static func get<T: Decodable>(_ path: String, as: T.Type) async -> T? {
        var req = URLRequest(url: base.appending(path: path)); req.timeoutInterval = 4
        guard let (data, _) = try? await URLSession.shared.data(for: req) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    @discardableResult
    static func post(_ path: String) async -> Bool {
        var req = URLRequest(url: base.appending(path: path)); req.httpMethod = "POST"; req.timeoutInterval = 30
        return (try? await URLSession.shared.data(for: req)) != nil
    }
}
