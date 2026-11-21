import Foundation
import CoreGraphics

/// App 和螢幕廣播擴充共用的資料。兩邊是不同的程式，只能透過 App Group 的 UserDefaults 交換。
enum SharedStore {
    static let appGroup = "group.org.domyweb.celerycheck"
    static let broadcastExtensionID = "org.domyweb.celerycheck.broadcast"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    private static func read<T: Decodable>(_ key: String, as type: T.Type) -> T? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    private static func write<T: Encodable>(_ key: String, _ value: T?) {
        if let value, let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    static var pair: PairInfo? {
        get { read("pair", as: PairInfo.self) }
        set { write("pair", newValue) }
    }

    static var settings: StreamSettings {
        get { read("settings", as: StreamSettings.self) ?? StreamSettings() }
        set { write("settings", newValue) }
    }

    static var status: BroadcastStatus? {
        get { read("status", as: BroadcastStatus.self) }
        set { write("status", newValue) }
    }
}

/// 掃 QR code 得到的電腦資訊
struct PairInfo: Codable, Equatable {
    var host: String
    var port: Int
    var token: String
    var name: String

    /// QR code 內容：celerycheck://pair?h=192.168.1.5&p=7790&t=配對碼&n=電腦名稱
    static func parse(_ text: String) -> PairInfo? {
        guard let comps = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              comps.scheme?.lowercased() == "celerycheck",
              comps.host?.lowercased() == "pair" else { return nil }
        var values: [String: String] = [:]
        for item in comps.queryItems ?? [] { values[item.name] = item.value ?? "" }
        guard let host = values["h"], !host.isEmpty,
              let token = values["t"], !token.isEmpty else { return nil }
        let port = Int(values["p"] ?? "") ?? 7790
        let name = values["n"].flatMap { $0.isEmpty ? nil : $0 } ?? host
        return PairInfo(host: host, port: port, token: token, name: name)
    }

    private var urlHost: String {
        host.contains(":") ? "[\(host)]" : host
    }

    func pingURL() -> URL? {
        var c = URLComponents()
        c.scheme = "http"
        c.host = host
        c.port = port
        c.path = "/api/ping"
        c.queryItems = [URLQueryItem(name: "t", value: token)]
        return c.url
    }

    func ingestURL(device: String, model: String) -> URL? {
        var c = URLComponents()
        c.scheme = "ws"
        c.host = host
        c.port = port
        c.path = "/ingest"
        c.queryItems = [
            URLQueryItem(name: "t", value: token),
            URLQueryItem(name: "d", value: device),
            URLQueryItem(name: "m", value: model),
        ]
        return c.url
    }

    var addressText: String { "\(urlHost):\(port)" }
}

/// 投影設定
struct StreamSettings: Codable, Equatable {
    enum Quality: String, Codable, CaseIterable, Identifiable {
        case standard, sharp, full
        var id: String { rawValue }
        var label: String {
            switch self {
            case .standard: return "標準"
            case .sharp: return "清晰"
            case .full: return "原始"
            }
        }
        /// 相對手機螢幕原始解析度的縮放
        var scale: CGFloat {
            switch self {
            case .standard: return 0.5
            case .sharp: return 0.75
            case .full: return 1.0
            }
        }
        var jpegQuality: CGFloat {
            switch self {
            case .standard: return 0.6
            case .sharp: return 0.65
            case .full: return 0.7
            }
        }
    }

    var fps: Int = 15
    var quality: Quality = .standard

    static let fpsOptions = [10, 15, 24, 30]
}

/// 擴充回報給 app 的狀態
struct BroadcastStatus: Codable, Equatable {
    enum State: String, Codable {
        case connecting, connected, retrying, failed, stopped
    }

    var state: State
    var detail: String
    var framesSent: Int
    var updatedAt: Date

    /// 擴充每秒更新一次；超過幾秒沒更新就當作已經停了
    var isFresh: Bool { Date().timeIntervalSince(updatedAt) < 4 }
}

enum DeviceInfo {
    /// 例如 iPhone16,1
    static var modelIdentifier: String {
        var info = utsname()
        uname(&info)
        let mirror = Mirror(reflecting: info.machine)
        let id = mirror.children.reduce(into: "") { result, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            result.append(Character(UnicodeScalar(UInt8(value))))
        }
        return id.isEmpty ? "iPhone" : id
    }
}
