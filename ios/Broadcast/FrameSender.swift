import Foundation

/// 用 WebSocket 把畫面推給電腦上的芹查。
/// 每一則訊息：前 8 個位元組是毫秒時間戳（big-endian），後面接 JPEG。
final class FrameSender: NSObject, URLSessionWebSocketDelegate {
    enum Event {
        case connecting(String)
        case connected(String)
        case retrying(String)
        /// 不會自己好的錯誤（例如配對碼不對），擴充應該直接結束廣播
        case fatal(String)
    }

    var onEvent: ((Event) -> Void)?

    private let pair: PairInfo
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "org.domyweb.celerycheck.sender")
    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var connected = false
    private var stopped = false
    private var inFlight = 0
    private var retryCount = 0
    private var pingTimer: DispatchSourceTimer?
    private(set) var framesSent = 0

    /// 同時最多幾格還在傳；網路慢時直接跳格，不讓記憶體越積越多（擴充只有約 50MB 可用）
    private let maxInFlight = 2

    init(pair: PairInfo) {
        self.pair = pair
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 8
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    }

    // MARK: - 對外

    func start() {
        queue.async { self.connect() }
    }

    func stop() {
        lock.lock()
        stopped = true
        connected = false
        let t = task
        task = nil
        lock.unlock()
        pingTimer?.cancel()
        pingTimer = nil
        t?.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
    }

    /// 現在能不能送下一格
    var canSend: Bool {
        lock.lock()
        defer { lock.unlock() }
        return connected && !stopped && inFlight < maxInFlight
    }

    var sentCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return framesSent
    }

    func send(jpeg: Data, at date: Date) {
        lock.lock()
        guard connected, !stopped, let t = task, inFlight < maxInFlight else {
            lock.unlock()
            return
        }
        inFlight += 1
        lock.unlock()

        var ms = UInt64(max(0, date.timeIntervalSince1970 * 1000)).bigEndian
        var payload = Data(bytes: &ms, count: 8)
        payload.append(jpeg)

        t.send(.data(payload)) { [weak self] error in
            guard let self else { return }
            self.lock.lock()
            self.inFlight = max(0, self.inFlight - 1)
            if error == nil { self.framesSent += 1 }
            self.lock.unlock()
            if error != nil { self.handleDrop(of: t, reason: "傳送中斷") }
        }
    }

    // MARK: - 連線

    private func connect() {
        lock.lock()
        let isStopped = stopped
        lock.unlock()
        guard !isStopped else { return }

        guard let url = pair.ingestURL(device: "iPhone", model: DeviceInfo.modelIdentifier) else {
            onEvent?(.fatal("電腦位址不正確，請重新掃描 QR code"))
            return
        }
        onEvent?(.connecting("正在連線到「\(pair.name)」…"))
        let t = session.webSocketTask(with: url)
        t.maximumMessageSize = 16 * 1024 * 1024
        lock.lock()
        task = t
        connected = false
        inFlight = 0
        lock.unlock()
        t.resume()
        receive(on: t)
    }

    /// 電腦不會傳東西來，但要一直收，才知道連線什麼時候斷
    private func receive(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.receive(on: t)
            case .failure:
                self.handleDrop(of: t, reason: "連線中斷")
            }
        }
    }

    private func isCurrent(_ t: URLSessionTask) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return task === t && !stopped
    }

    private func handleDrop(of t: URLSessionTask, reason: String) {
        queue.async {
            guard self.isCurrent(t) else { return }
            self.lock.lock()
            self.task = nil
            self.connected = false
            self.inFlight = 0
            self.retryCount += 1
            let delay = min(5.0, 1.0 + Double(self.retryCount))
            self.lock.unlock()
            self.pingTimer?.cancel()
            self.pingTimer = nil
            t.cancel()
            self.onEvent?(.retrying("\(reason)，\(Int(delay)) 秒後重新連線。請確認電腦上的芹查有開著，手機和電腦在同一個 Wi-Fi。"))
            self.queue.asyncAfter(deadline: .now() + delay) { self.connect() }
        }
    }

    private func fatal(_ t: URLSessionTask, _ message: String) {
        guard isCurrent(t) else { return }
        lock.lock()
        stopped = true
        connected = false
        lock.unlock()
        onEvent?(.fatal(message))
    }

    private func startPing(_ t: URLSessionWebSocketTask) {
        pingTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self, self.isCurrent(t) else { return }
            t.sendPing { error in
                if error != nil { self.handleDrop(of: t, reason: "電腦沒有回應") }
            }
        }
        timer.resume()
        pingTimer = timer
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard isCurrent(webSocketTask) else { return }
        lock.lock()
        connected = true
        retryCount = 0
        lock.unlock()
        let hello = #"{"type":"hello","device":"iPhone","model":"\#(DeviceInfo.modelIdentifier)"}"#
        webSocketTask.send(.string(hello)) { _ in }
        queue.async { self.startPing(webSocketTask) }
        onEvent?(.connected("已連上「\(pair.name)」"))
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        switch closeCode.rawValue {
        case 4000:
            fatal(webSocketTask, "另一支手機連上了電腦，這支已停止投影")
        case 4001:
            fatal(webSocketTask, "電腦上的配對碼已更換，請在芹查 app 重新掃描 QR code")
        default:
            handleDrop(of: webSocketTask, reason: "電腦中斷了連線")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }
        if let http = task.response as? HTTPURLResponse, http.statusCode == 403 {
            fatal(task, "配對碼不對，請在芹查 app 重新掃描電腦上的 QR code")
            return
        }
        let ns = error as NSError
        let reason: String
        switch ns.code {
        case NSURLErrorCannotConnectToHost, NSURLErrorTimedOut, NSURLErrorCannotFindHost:
            reason = "連不到電腦"
        case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
            reason = "網路中斷"
        case NSURLErrorCancelled:
            return
        default:
            reason = "連線失敗（\(ns.code)）"
        }
        handleDrop(of: task, reason: reason)
    }
}
