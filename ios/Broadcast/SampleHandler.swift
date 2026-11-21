import ReplayKit
import CoreMedia
import QuartzCore
import CoreImage
import ImageIO
import UIKit

/// 螢幕廣播擴充：iOS 把整個螢幕的畫面交給這裡，我們壓成 JPEG 推給電腦。
/// 切到別的 app 也會繼續推，所以能拿來測任何 app。
final class SampleHandler: RPBroadcastSampleHandler {
    private var sender: FrameSender?
    private var settings = StreamSettings()
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private var lastFrameTime: CFTimeInterval = 0
    private var statusTimer: DispatchSourceTimer?
    private let statusQueue = DispatchQueue(label: "org.domyweb.celerycheck.status")
    private var currentState: BroadcastStatus.State = .connecting
    private var currentDetail = ""

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        guard let pair = SharedStore.pair else {
            finish(with: "還沒配對電腦。請先打開芹查 app，掃描電腦上的 QR code。")
            return
        }
        settings = SharedStore.settings
        let s = FrameSender(pair: pair)
        s.onEvent = { [weak self] event in self?.handle(event) }
        sender = s
        updateStatus(.connecting, "正在連線到「\(pair.name)」…")
        s.start()
        startStatusTimer()
    }

    override func broadcastPaused() {
        updateStatus(currentState, "已暫停")
    }

    override func broadcastResumed() {
        updateStatus(currentState, "投影中")
    }

    override func broadcastFinished() {
        statusTimer?.cancel()
        statusTimer = nil
        sender?.stop()
        sender = nil
        writeStatus(.stopped, "已停止投影")
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, let sender, sender.canSend else { return }

        // iOS 只在畫面有變動時才給新格；這裡再限制最高每秒幾格
        let now = CACurrentMediaTime()
        let minInterval = 1.0 / Double(max(1, settings.fps))
        if now - lastFrameTime < minInterval * 0.9 { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastFrameTime = now

        var orientation = CGImagePropertyOrientation.up
        if let raw = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
           let o = CGImagePropertyOrientation(rawValue: raw.uint32Value) {
            orientation = o
        }

        autoreleasepool {
            var image = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
            let scale = settings.quality.scale
            if scale < 0.999 {
                image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            }
            let extent = image.extent.integral
            image = image.cropped(to: extent)
            let options: [CIImageRepresentationOption: Any] = [
                CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): settings.quality.jpegQuality,
            ]
            guard let jpeg = ciContext.jpegRepresentation(of: image, colorSpace: colorSpace, options: options) else { return }
            sender.send(jpeg: jpeg, at: Date())
        }
    }

    // MARK: - 狀態

    private func handle(_ event: FrameSender.Event) {
        switch event {
        case .connecting(let text):
            updateStatus(.connecting, text)
        case .connected(let text):
            updateStatus(.connected, text)
        case .retrying(let text):
            updateStatus(.retrying, text)
        case .fatal(let text):
            finish(with: text)
        }
    }

    private func finish(with message: String) {
        statusTimer?.cancel()
        statusTimer = nil
        sender?.stop()
        sender = nil
        writeStatus(.failed, message)
        let error = NSError(domain: "org.domyweb.celerycheck", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        finishBroadcastWithError(error)
    }

    private func updateStatus(_ state: BroadcastStatus.State, _ detail: String) {
        statusQueue.async {
            self.currentState = state
            self.currentDetail = detail
            self.writeStatusLocked()
        }
    }

    private func writeStatus(_ state: BroadcastStatus.State, _ detail: String) {
        statusQueue.sync {
            self.currentState = state
            self.currentDetail = detail
            self.writeStatusLocked()
        }
    }

    private func writeStatusLocked() {
        SharedStore.status = BroadcastStatus(
            state: currentState,
            detail: currentDetail,
            framesSent: sender?.sentCount ?? 0,
            updatedAt: Date()
        )
    }

    /// 每秒更新一次狀態，app 看時間戳就知道擴充還活著
    private func startStatusTimer() {
        let timer = DispatchSource.makeTimerSource(queue: statusQueue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.writeStatusLocked() }
        timer.resume()
        statusTimer = timer
    }
}
