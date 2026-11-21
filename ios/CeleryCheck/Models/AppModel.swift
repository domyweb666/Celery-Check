import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum Reachability: Equatable {
        case unknown
        case checking
        case ok
        case failed(String)
    }

    @Published var pair: PairInfo? {
        didSet {
            SharedStore.pair = pair
            // 只有換了電腦才重新檢查；單純更新電腦名稱不用
            if oldValue?.host != pair?.host || oldValue?.port != pair?.port || oldValue?.token != pair?.token {
                reachability = .unknown
                if pair != nil { checkNow() }
            }
        }
    }

    @Published var settings: StreamSettings {
        didSet { SharedStore.settings = settings }
    }

    @Published private(set) var reachability: Reachability = .unknown
    @Published private(set) var broadcast: BroadcastStatus?
    @Published var lastError: String?

    private var timer: Timer?
    private var pingTask: Task<Void, Never>?

    init() {
        pair = SharedStore.pair
        settings = SharedStore.settings
        broadcast = SharedStore.status
    }

    /// 擴充正在投影（而且最近幾秒還有回報狀態）
    var isStreaming: Bool {
        guard let b = broadcast, b.isFresh else { return false }
        return b.state == .connected || b.state == .connecting || b.state == .retrying
    }

    func startPolling() {
        stopPolling()
        refreshStatus()
        checkNow()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    private var tickCount = 0
    private func tick() {
        tickCount += 1
        refreshStatus()
        // 沒在投影時每 4 秒確認一次電腦連不連得到
        if !isStreaming && tickCount % 4 == 0 { checkNow() }
    }

    private func refreshStatus() {
        let s = SharedStore.status
        if s != broadcast { broadcast = s }
    }

    /// 掃到 QR code 或從相機 app 點進來
    @discardableResult
    func handle(text: String) -> Bool {
        guard let info = PairInfo.parse(text) else {
            lastError = "這不是芹查的 QR code。請掃描電腦上芹查「即時畫面」頁的 QR code。"
            return false
        }
        lastError = nil
        pair = info
        return true
    }

    func forget() {
        pair = nil
    }

    func checkNow() {
        guard let url = pair?.pingURL() else { return }
        pingTask?.cancel()
        if reachability != .ok { reachability = .checking }
        pingTask = Task { [weak self] in
            var request = URLRequest(url: url)
            request.timeoutInterval = 4
            request.cachePolicy = .reloadIgnoringLocalCacheData
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                await MainActor.run {
                    guard let self, !Task.isCancelled else { return }
                    if code == 200 {
                        self.reachability = .ok
                        // 電腦改了名字就順便更新
                        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let name = json["name"] as? String, !name.isEmpty, self.pair?.name != name {
                            self.pair?.name = name
                        }
                    } else if code == 403 {
                        self.reachability = .failed("配對碼不對（電腦可能換過配對碼），請重新掃描 QR code")
                    } else {
                        self.reachability = .failed("電腦回應異常（\(code)）")
                    }
                }
            } catch {
                await MainActor.run {
                    guard let self, !Task.isCancelled else { return }
                    let ns = error as NSError
                    if ns.code == NSURLErrorCancelled { return }
                    self.reachability = .failed("連不到電腦。請確認電腦上的芹查有開著，而且手機和電腦連同一個 Wi-Fi。")
                }
            }
        }
    }
}
