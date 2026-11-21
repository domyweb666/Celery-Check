import SwiftUI
import ReplayKit
import UIKit

/// iOS 只允許透過系統的「螢幕廣播」選擇器開始投影。
/// 這裡把系統選擇器藏起來，用我們自己的大按鈕去觸發它。
final class BroadcastPickerHolder {
    let picker: RPSystemBroadcastPickerView = {
        let p = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        p.preferredExtension = SharedStore.broadcastExtensionID
        p.showsMicrophoneButton = false
        return p
    }()

    /// 叫出系統的「開始廣播／停止廣播」面板
    func present() {
        for view in picker.subviews {
            if let button = view as? UIButton {
                button.sendActions(for: .allTouchEvents)
                return
            }
        }
    }
}

struct HiddenBroadcastPicker: UIViewRepresentable {
    let holder: BroadcastPickerHolder

    func makeUIView(context: Context) -> UIView {
        let container = UIView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        container.isUserInteractionEnabled = false
        container.alpha = 0.02
        container.addSubview(holder.picker)
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}

/// 看得到的系統廣播按鈕（備用：萬一大按鈕叫不出面板，直接按這個）
struct SystemBroadcastButton: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let p = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        p.preferredExtension = SharedStore.broadcastExtensionID
        p.showsMicrophoneButton = false
        return p
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
