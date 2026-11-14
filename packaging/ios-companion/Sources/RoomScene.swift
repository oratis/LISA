import SwiftUI

/// The desktop Room assets are packaged into Pocket by XcodeGen. Positions are
/// fractions of the square artwork, including when the preview crops the scene.
enum RoomInterior: String, CaseIterable {
    case sunroom, studio
    var title: LocalizedStringKey { self == .sunroom ? "Sunroom" : "Studio" }
    var background: String { self == .sunroom ? "sunroom" : "room" }
    var seat: CGPoint { self == .sunroom ? CGPoint(x: 0.797, y: 0.682) : CGPoint(x: 0.713, y: 0.618) }
    var furniture: [CGPoint] {
        let coordinates: [(CGFloat, CGFloat)] = self == .sunroom
            ? [(0.868,0.484),(0.89,0.57),(0.888,0.658),(0.858,0.747),(0.838,0.792),(0.829,0.783),(0.86,0.66),(0.87,0.574)]
            : [(0.696,0.64),(0.707,0.619),(0.765,0.594),(0.802,0.598),(0.827,0.625),(0.819,0.698),(0.797,0.723),(0.72,0.73),(0.696,0.683)]
        return coordinates.map { CGPoint(x: $0.0, y: $0.1) }
    }
}

enum RoomPose: String {
    case idle, read, work, tea, sleep
    init(mood: String) {
        let text = mood.lowercased()
        if text.contains("sleep") || text.contains("nap") { self = .sleep }
        else if text.contains("reading") { self = .read }
        else if ["working","studying","research","writing","typing","gaming","watching"].contains(where: text.contains) { self = .work }
        else if ["tea","coffee","drinking"].contains(where: text.contains) { self = .tea }
        else { self = .idle }
    }

    var activity: String {
        switch self {
        case .idle: return String(localized: "Lisa is at home")
        case .read: return String(localized: "Lisa is reading")
        case .work: return String(localized: "Lisa is working")
        case .tea: return String(localized: "Lisa is having tea")
        case .sleep: return String(localized: "Lisa is resting")
        }
    }

    var sizeAndContact: (width: CGFloat, x: CGFloat, y: CGFloat) {
        switch self {
        case .idle: return (0.387, 0.5, 0.98)
        case .read: return (0.195 * 0.86, 0.69, 0.68)
        case .work: return (0.215 * 0.86, 0.78, 0.67)
        case .tea: return (0.185 * 0.86, 0.68, 0.69)
        case .sleep: return (0.24 * 0.86, 0.79, 0.82)
        }
    }
}

private enum RoomArtwork {
    static let images: [String: UIImage] = {
        var result: [String: UIImage] = [:]
        for name in ["room", "sunroom", "read", "work", "tea", "sleep", "poses"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "webp"),
                  let image = UIImage(contentsOfFile: url.path) else { continue }
            if name == "poses", let cg = image.cgImage {
                let rect = CGRect(x: 0, y: 0, width: cg.width / 4, height: cg.height / 3)
                if let cell = cg.cropping(to: rect) { result["idle"] = UIImage(cgImage: cell) }
            } else { result[name] = image }
        }
        return result
    }()
}

struct RoomScene: View {
    let interior: RoomInterior
    let mood: String?

    // Leave the chair and the standing character's feet in the wide crop.
    static func imageTop(for size: CGSize) -> CGFloat {
        (size.height - max(size.width, size.height)) * 0.74
    }

    var body: some View {
        GeometryReader { geo in
            let side = max(geo.size.width, geo.size.height)
            ZStack(alignment: .topLeading) {
                if let bg = RoomArtwork.images[interior.background] {
                    Image(uiImage: bg).resizable().frame(width: side, height: side)
                    if let mood { character(RoomPose(mood: mood), side: side) }
                    Image(uiImage: bg).resizable().frame(width: side, height: side)
                        .mask {
                            Path { path in
                                for (i, point) in interior.furniture.enumerated() {
                                    let p = CGPoint(x: point.x * side, y: point.y * side)
                                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                                }
                                path.closeSubpath()
                            }.fill()
                        }
                }
            }
            .frame(width: side, height: side)
            .overlay(Color.indigo.opacity(lightTint))
            .position(x: geo.size.width / 2, y: side / 2 + Self.imageTop(for: geo.size))
        }
        .clipped()
        .accessibilityHidden(true)
    }

    private var lightTint: Double {
        switch Calendar.current.component(.hour, from: Date()) {
        case 0..<6, 21..<24: return 0.25
        case 17..<21: return 0.10
        default: return 0
        }
    }

    @ViewBuilder private func character(_ pose: RoomPose, side: CGFloat) -> some View {
        if let image = RoomArtwork.images[pose.rawValue] {
            let spec = pose.sizeAndContact
            let width = side * spec.width
            let height = width * image.size.height / image.size.width
            let anchor = pose == .idle ? CGPoint(x: 0.495, y: 0.87) : interior.seat
            Image(uiImage: image).resizable().frame(width: width, height: height)
                .offset(x: anchor.x * side - width * spec.x, y: anchor.y * side - height * spec.y)
        }
    }
}
