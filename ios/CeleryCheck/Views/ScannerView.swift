import SwiftUI
import AVFoundation
import UIKit

/// 掃描電腦上的 QR code
struct ScannerSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ZStack(alignment: .bottom) {
                QRScannerView { text in
                    if model.handle(text: text) {
                        dismiss()
                    } else {
                        message = model.lastError
                    }
                }
                .ignoresSafeArea()

                VStack(spacing: 8) {
                    Text(message ?? "對準電腦上芹查「即時畫面」頁的 QR code")
                        .font(.callout)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
                .padding(.bottom, 40)
                .padding(.horizontal, 24)
            }
            .navigationTitle("掃描 QR code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }
}

struct QRScannerView: UIViewControllerRepresentable {
    var onFound: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let c = ScannerController()
        c.onFound = onFound
        return c
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onFound = onFound
    }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onFound: ((String) -> Void)?
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var lastValue: String?
    private var lastTime = Date.distantPast
    private let sessionQueue = DispatchQueue(label: "org.domyweb.celerycheck.scanner")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            setupSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    granted ? self.setupSession() : self.showMessage("需要相機權限才能掃描。\n請到「設定 → 芹查」打開相機。")
                }
            }
        default:
            showMessage("需要相機權限才能掃描。\n請到「設定 → 芹查」打開相機。")
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let s = session
        sessionQueue.async { if s.isRunning { s.stopRunning() } }
    }

    private func setupSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            showMessage("這支手機的相機無法使用。可以改用「手動輸入」。")
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            showMessage("無法啟動掃描。可以改用「手動輸入」。")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer

        let s = session
        sessionQueue.async { s.startRunning() }
    }

    private func showMessage(_ text: String) {
        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .body)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
        ])
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = code.stringValue else { return }
        // 同一個碼一直被讀到，不要連續觸發
        if value == lastValue, Date().timeIntervalSince(lastTime) < 2 { return }
        lastValue = value
        lastTime = Date()
        let ok = PairInfo.parse(value) != nil
        UINotificationFeedbackGenerator().notificationOccurred(ok ? .success : .error)
        onFound?(value)
    }
}

/// 掃描不方便時，手動輸入電腦位址和配對碼
struct ManualPairSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var host = ""
    @State private var port = "7790"
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("例如 192.168.1.20", text: $host)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("埠號", text: $port)
                        .keyboardType(.numberPad)
                } header: {
                    Text("電腦位址")
                } footer: {
                    Text("電腦上芹查的命令列視窗會顯示「手機連線位址」。")
                }
                Section {
                    TextField("配對碼", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("配對碼")
                } footer: {
                    Text("在電腦的 desktop/data/config.json 裡的 token。用掃的比較快。")
                }
            }
            .navigationTitle("手動輸入")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("儲存") {
                        model.pair = PairInfo(
                            host: host.trimmingCharacters(in: .whitespaces),
                            port: Int(port) ?? 7790,
                            token: token.trimmingCharacters(in: .whitespaces),
                            name: host.trimmingCharacters(in: .whitespaces)
                        )
                        dismiss()
                    }
                    .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty || token.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
