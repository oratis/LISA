import SwiftUI
import AVFoundation

/// A full-screen camera viewfinder that reports the first QR code it sees. Used by
/// Settings to scan the `lisa-pair://…` code the Mac shows, instead of pasting it
/// (docs/IOS_COMPANION_PLAN.md §5.3). Needs `NSCameraUsageDescription` (set in
/// project.yml). Degrades honestly: no camera (e.g. the Simulator) or a denied
/// permission surfaces via `onError` rather than a black screen.
struct QRScannerView: UIViewControllerRepresentable {
    /// Called once, on the main actor, with the decoded string of the first QR seen.
    var onScan: (String) -> Void
    /// Called with a human-readable reason when scanning can't start.
    var onError: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.onScan = onScan
        vc.onError = onError
        return vc
    }

    func updateUIViewController(_ vc: ScannerViewController, context: Context) {}
}

/// AVFoundation plumbing for `QRScannerView`. A `UIViewController` (not a bare view)
/// so it owns the capture session lifecycle and lays out the preview layer.
final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var didScan = false  // single-shot: ignore everything after the first hit

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        requestAccessThenConfigure()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.layer.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stop()
    }

    /// Camera access is async on first launch; gate configuration on the grant so a
    /// denied user gets a message instead of a dead viewfinder.
    private func requestAccessThenConfigure() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    granted ? self?.configure() : self?.onError?("Camera access was denied.")
                }
            }
        default:
            onError?("Camera access is off — enable it in Settings to scan.")
        }
    }

    private func configure() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            onError?("No camera available — paste the pairing string instead.")
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            onError?("Can't scan QR codes on this device.")
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.layer.bounds
        view.layer.addSublayer(preview)
        self.preview = preview

        // startRunning() blocks; keep it off the main thread.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    private func stop() {
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard !didScan,
              let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              code.type == .qr,
              let value = code.stringValue else { return }
        didScan = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        stop()
        onScan?(value)
    }
}
