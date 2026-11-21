import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var showScanner = false
    @State private var showManual = false
    @State private var confirmForget = false
    @State private var picker = BroadcastPickerHolder()

    var body: some View {
        NavigationStack {
            Form {
                header

                if let pair = model.pair {
                    computerSection(pair)
                    streamSection
                    settingsSection
                    tipsSection
                } else {
                    pairSection
                    howSection
                }
            }
            .navigationTitle("芹查")
            .toolbar {
                if model.pair != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Menu {
                            Button {
                                showScanner = true
                            } label: {
                                Label("重新掃描 QR code", systemImage: "qrcode.viewfinder")
                            }
                            Button {
                                showManual = true
                            } label: {
                                Label("手動輸入電腦位址", systemImage: "keyboard")
                            }
                            Button(role: .destructive) {
                                confirmForget = true
                            } label: {
                                Label("忘記這台電腦", systemImage: "trash")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
            }
            .background(HiddenBroadcastPicker(holder: picker).frame(width: 1, height: 1))
            .sheet(isPresented: $showScanner) {
                ScannerSheet().environmentObject(model)
            }
            .sheet(isPresented: $showManual) {
                ManualPairSheet().environmentObject(model)
            }
            .confirmationDialog("忘記這台電腦？", isPresented: $confirmForget, titleVisibility: .visible) {
                Button("忘記", role: .destructive) { model.forget() }
            } message: {
                Text("之後要再掃一次電腦上的 QR code 才能投影。")
            }
            .alert("無法配對", isPresented: Binding(
                get: { model.lastError != nil && !showScanner },
                set: { if !$0 { model.lastError = nil } }
            )) {
                Button("好") { model.lastError = nil }
            } message: {
                Text(model.lastError ?? "")
            }
        }
        .onOpenURL { url in
            model.handle(text: url.absoluteString)
        }
        .onAppear { model.startPolling() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.startPolling() } else { model.stopPolling() }
        }
    }

    // MARK: - 區塊

    private var header: some View {
        Section {
            HStack(spacing: 14) {
                Image(systemName: "rectangle.on.rectangle.angled")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundStyle(.tint)
                    .frame(width: 44)
                Text("把手機畫面投到電腦，遇到問題在電腦上框選、寫說明，直接交給 Claude Code 修。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private var pairSection: some View {
        Section {
            Button {
                showScanner = true
            } label: {
                Label("掃描電腦上的 QR code", systemImage: "qrcode.viewfinder")
                    .font(.headline)
                    .frame(maxWidth: .infinity, minHeight: 50)
            }
            .buttonStyle(.borderedProminent)
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))

            Button("手動輸入電腦位址") { showManual = true }
                .frame(maxWidth: .infinity)
        } header: {
            Text("第一步：配對電腦")
        } footer: {
            Text("在電腦上打開芹查，「即時畫面」頁會顯示 QR code。用內建相機 app 掃也可以，會自動打開這裡。")
        }
    }

    private var howSection: some View {
        Section("怎麼用") {
            step(1, "電腦上執行芹查，打開 http://localhost:7790")
            step(2, "手機掃 QR code 配對，按「開始投影」")
            step(3, "照平常那樣操作你要測的 app，畫面會出現在電腦上")
            step(4, "遇到問題在電腦上按「標記問題」（F8 或踏板），框選、寫說明、送給 Claude")
        }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(n)")
                .font(.footnote.bold())
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(Circle().fill(Color.accentColor))
            Text(text).font(.subheadline)
        }
    }

    private func computerSection(_ pair: PairInfo) -> some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: "desktopcomputer")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                    .frame(width: 36)
                VStack(alignment: .leading, spacing: 3) {
                    Text(pair.name).font(.headline)
                    Text(pair.addressText).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                Spacer()
                reachabilityBadge
            }
            if case .failed(let message) = model.reachability, !model.isStreaming {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button("再試一次") { model.checkNow() }
            }
        } header: {
            Text("電腦")
        }
    }

    @ViewBuilder
    private var reachabilityBadge: some View {
        switch model.reachability {
        case .ok:
            Label("連得到", systemImage: "checkmark.circle.fill")
                .labelStyle(.titleAndIcon)
                .font(.caption.bold())
                .foregroundStyle(.green)
        case .checking, .unknown:
            ProgressView().controlSize(.small)
        case .failed:
            Label("連不到", systemImage: "exclamationmark.triangle.fill")
                .font(.caption.bold())
                .foregroundStyle(.red)
        }
    }

    private var streamSection: some View {
        Section {
            Button {
                picker.present()
            } label: {
                VStack(spacing: 4) {
                    Label(model.isStreaming ? "停止投影" : "開始投影",
                          systemImage: model.isStreaming ? "stop.circle.fill" : "play.circle.fill")
                        .font(.title3.bold())
                    Text(model.isStreaming ? "會跳出系統面板，按「停止廣播」" : "會跳出系統面板，按「開始廣播」")
                        .font(.caption)
                        .opacity(0.85)
                }
                .frame(maxWidth: .infinity, minHeight: 64)
            }
            .buttonStyle(.borderedProminent)
            .tint(model.isStreaming ? Color.red : Color.accentColor)
            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))

            if let b = model.broadcast, b.isFresh || b.state == .failed {
                HStack(alignment: .top, spacing: 10) {
                    Circle()
                        .fill(color(for: b.state))
                        .frame(width: 10, height: 10)
                        .padding(.top, 5)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(b.detail).font(.subheadline)
                        if b.state == .connected {
                            Text("已傳送 \(b.framesSent) 格").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } header: {
            Text("投影")
        } footer: {
            Text("開始後可以切到任何 app，畫面會一直傳到電腦。iOS 會在狀態列顯示紅色的錄影標記，這是正常的。畫面不會存在手機上。")
        }
    }

    private func color(for state: BroadcastStatus.State) -> Color {
        switch state {
        case .connected: return .green
        case .connecting, .retrying: return .orange
        case .failed: return .red
        case .stopped: return .gray
        }
    }

    private var settingsSection: some View {
        Section {
            Picker("每秒最多幾格", selection: $model.settings.fps) {
                ForEach(StreamSettings.fpsOptions, id: \.self) { Text("\($0)").tag($0) }
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)
            Text("每秒最多幾格").font(.caption).foregroundStyle(.secondary)

            Picker("畫質", selection: $model.settings.quality) {
                ForEach(StreamSettings.Quality.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .listRowSeparator(.hidden)
            Text("畫質").font(.caption).foregroundStyle(.secondary)
        } header: {
            Text("投影設定")
        } footer: {
            Text("要看動畫順不順就調高格數。Wi-Fi 慢或手機發燙就調回 15 格、標準畫質。改了設定要停止再重新開始投影才會生效。")
        }
    }

    private var tipsSection: some View {
        Section("小技巧") {
            VStack(alignment: .leading, spacing: 6) {
                Text("從控制中心開關").font(.subheadline.bold())
                Text("到「設定 → 控制中心」加入「螢幕錄製」。之後長按控制中心的錄影按鈕，選「芹查」，就能不打開這個 app 直接開始或停止投影。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                SystemBroadcastButton()
                    .frame(width: 44, height: 44)
                Text("如果上面的「開始投影」按了沒反應，改按左邊這個系統按鈕。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
