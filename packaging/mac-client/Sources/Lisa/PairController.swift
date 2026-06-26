//
//  PairController.swift
//  Lisa
//
//  "Pair iPhone…" — the GUI counterpart to `lisa pair` (src/cli/pair.ts), so a
//  non-terminal user can pair Lisa Pocket without opening a shell. It mirrors the
//  CLI exactly: POST the loopback-only /api/pair/start to mint a per-device token,
//  detect the Mac's LAN IP, build the same `lisa-pair://v1?host=&port=&token=&name=`
//  deep-link, render it as a QR, and show it in a window to scan.
//
//  Pairs with decision ② (the menu-bar app binds the backend to 0.0.0.0): the
//  phone reaches the Mac at the LAN IP in the QR and authenticates with the minted
//  device token. The mint call is loopback, so it needs no token itself.
//

import AppKit
import CoreImage.CIFilterBuiltins
import Darwin
import Foundation

@MainActor
final class PairController {
    static let shared = PairController()
    private init() {}

    private var window: NSWindow?
    private var lastURL = ""
    private let port = 5757

    /// Mint a device token and show a scannable QR (or an error alert).
    func showPairing() {
        Task { @MainActor in
            do { present(try await mint()) }
            catch { presentError(error) }
        }
    }

    // MARK: - Mint (mirrors pair.ts runPairCommand)

    struct Pairing { let url: String; let host: String; let port: Int }

    private func mint() async throws -> Pairing {
        guard let host = Self.detectLanHost() else { throw PairError.noLan }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/pair/start")!, timeoutInterval: 8)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["name": "iPhone", "platform": "ios"])

        let data: Data, resp: URLResponse
        do { (data, resp) = try await URLSession.shared.data(for: req) }
        catch { throw PairError.unreachable }

        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 403 { throw PairError.notLocalhost }
        guard (200..<300).contains(code) else { throw PairError.http(code) }

        struct R: Decodable { var token: String?; var id: String?; var port: Int? }
        let body = (try? JSONDecoder().decode(R.self, from: data)) ?? R()
        guard let token = body.token, !token.isEmpty else { throw PairError.noToken }
        let effPort = body.port ?? port
        return Pairing(url: Self.buildPairUrl(host: host, port: effPort, token: token, name: "iPhone"),
                       host: host, port: effPort)
    }

    enum PairError: LocalizedError {
        case noLan, notLocalhost, http(Int), noToken, unreachable
        var errorDescription: String? {
            switch self {
            case .noLan:        return "Couldn't find your Mac's Wi-Fi address. Connect to Wi-Fi and try again."
            case .notLocalhost: return "Pairing can only be started on the Mac itself."
            case .http(let c):  return "The Lisa backend returned an error (HTTP \(c))."
            case .noToken:      return "The Lisa backend didn't return a pairing token."
            case .unreachable:  return "Lisa's backend isn't running. Start it, then try Pair iPhone again."
            }
        }
    }

    // MARK: - LAN IP (mirrors pair.ts detectLanHost: first non-internal IPv4)

    static func detectLanHost() -> String? {
        var result: String?
        var ifaddrPtr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddrPtr) == 0, let first = ifaddrPtr else { return nil }
        defer { freeifaddrs(ifaddrPtr) }
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = ptr.pointee.ifa_flags
            guard (flags & UInt32(IFF_UP)) != 0, (flags & UInt32(IFF_LOOPBACK)) == 0 else { continue }
            guard let addr = ptr.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let ip = String(cString: host)
            if !ip.isEmpty && !ip.hasPrefix("169.254") { result = ip; break }   // skip link-local
        }
        return result
    }

    // MARK: - Pair URL (mirrors pair.ts buildPairUrl) + QR

    static func buildPairUrl(host: String, port: Int, token: String, name: String) -> String {
        var comps = URLComponents()
        comps.scheme = "lisa-pair"
        comps.host = "v1"
        comps.queryItems = [
            .init(name: "host", value: host),
            .init(name: "port", value: String(port)),
            .init(name: "token", value: token),
            .init(name: "name", value: name),
        ]
        return comps.url?.absoluteString ?? "lisa-pair://v1?host=\(host)&port=\(port)&token=\(token)&name=\(name)"
    }

    static func qrImage(_ string: String, side: CGFloat) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: side / output.extent.width,
                                                              y: side / output.extent.height))
        let rep = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }

    // MARK: - Window

    private func present(_ pairing: Pairing) {
        window?.close()
        lastURL = pairing.url

        let pad: CGFloat = 24
        let width: CGFloat = 320
        let qrSide: CGFloat = 240

        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.edgeInsets = NSEdgeInsets(top: pad, left: pad, bottom: pad, right: pad)

        let title = NSTextField(labelWithString: "Pair your iPhone")
        title.font = .systemFont(ofSize: 17, weight: .bold)
        stack.addArrangedSubview(title)

        let sub = NSTextField(wrappingLabelWithString:
            "Open Lisa Pocket on your iPhone and scan this during setup — or in Settings → Scan QR code.")
        sub.font = .systemFont(ofSize: 12)
        sub.textColor = .secondaryLabelColor
        sub.alignment = .center
        sub.preferredMaxLayoutWidth = width - pad * 2
        stack.addArrangedSubview(sub)

        let qr = NSImageView()
        qr.image = Self.qrImage(pairing.url, side: qrSide * 2)   // 2× pixels → crisp on retina
        qr.imageScaling = .scaleProportionallyUpOrDown
        qr.wantsLayer = true
        qr.layer?.backgroundColor = NSColor.white.cgColor
        qr.layer?.cornerRadius = 10
        qr.layer?.masksToBounds = true
        qr.translatesAutoresizingMaskIntoConstraints = false
        qr.widthAnchor.constraint(equalToConstant: qrSide).isActive = true
        qr.heightAnchor.constraint(equalToConstant: qrSide).isActive = true
        stack.addArrangedSubview(qr)

        let net = NSTextField(labelWithString: "Same Wi-Fi · \(pairing.host):\(pairing.port)")
        net.font = .systemFont(ofSize: 11)
        net.textColor = .tertiaryLabelColor
        stack.addArrangedSubview(net)

        let copy = NSButton(title: "Copy pairing link", target: self, action: #selector(copyLink))
        copy.bezelStyle = .rounded
        stack.addArrangedSubview(copy)

        let done = NSButton(title: "Done", target: self, action: #selector(closeWindow))
        done.bezelStyle = .rounded
        done.keyEquivalent = "\r"
        stack.addArrangedSubview(done)

        let container = NSView()
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            container.widthAnchor.constraint(equalToConstant: width),
        ])

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 480),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "Pair iPhone"
        w.contentView = container
        w.setContentSize(container.fittingSize)
        w.isReleasedWhenClosed = false
        w.center()
        window = w
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    @objc private func copyLink() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(lastURL, forType: .string)
    }

    @objc private func closeWindow() { window?.close() }

    private func presentError(_ error: Error) {
        let alert = NSAlert()
        alert.messageText = "Couldn't start pairing"
        alert.informativeText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        alert.runModal()
    }
}
