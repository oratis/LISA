import UIKit
import ImageIO

/// The same versioned atlas/cell map as Web and Island. The source image is
/// cached, so mood changes do not redownload a sheet or flash a placeholder.
@MainActor
enum LisaArtwork {
    private static let cache = NSCache<NSURL, UIImage>()

    private static let motionCache: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.totalCostLimit = 8 * 1024 * 1024
        cache.countLimit = 4
        return cache
    }()

    static func motion(client: LisaClient, path: String) async throws -> UIImage? {
        let slug = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        guard path.hasPrefix("/assets/lisa/"), let index = LisaArtCatalog.moods[slug],
              let asset = LisaArtCatalog.motion[index] else { return nil }
        return try await animation(client: client, path: asset)
    }

    static func animation(client: LisaClient, path: String) async throws -> UIImage? {
        guard path.hasPrefix("/assets/visuals/soft-ink-motion-v1/"), !path.contains(".."), path.hasSuffix(".gif") else { return nil }
        let request = try client.makeRequest(path, timeout: 15)
        guard let url = request.url else { return nil }
        if let cached = motionCache.object(forKey: url as NSURL) { return cached }
        let (data, response) = try await client.data(for: request, path: path)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let decoded = decodeMotion(data) else { return nil }
        motionCache.setObject(decoded.image, forKey: url as NSURL, cost: decoded.cost)
        return decoded.image
    }

    private static let posterCache: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>(); cache.totalCostLimit = 4 * 1024 * 1024; cache.countLimit = 16; return cache
    }()
    static func expressionPoster(client: LisaClient, path: String) async throws -> UIImage? {
        guard path.hasPrefix("/assets/visuals/soft-ink-motion-v1/"), !path.contains(".."), path.hasSuffix("-static.webp") else { return nil }
        let request = try client.makeRequest(path, timeout: 15)
        guard let url = request.url else { return nil }
        if let image = posterCache.object(forKey: url as NSURL) { return image }
        let (data, response) = try await client.data(for: request, path: path)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), data.count <= 256 * 1024,
              let image = UIImage(data: data), let cg = image.cgImage, cg.width <= 256, cg.height <= 256 else { return nil }
        posterCache.setObject(image, forKey: url as NSURL, cost: cg.width * cg.height * 4)
        return image
    }

    static func decodeMotion(_ data: Data) -> (image: UIImage, cost: Int)? {
        guard data.count <= 256 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let count = CGImageSourceGetCount(source)
        guard (2...16).contains(count) else { return nil }
        var frames: [UIImage] = []
        var ticks: [Int] = []
        var cost = 0
        for i in 0..<count {
            let props = CGImageSourceCopyPropertiesAtIndex(source, i, nil) as? [CFString: Any]
            guard let width = props?[kCGImagePropertyPixelWidth] as? Int,
                  let height = props?[kCGImagePropertyPixelHeight] as? Int,
                  width > 0, height > 0, width <= 256, height <= 256,
                  let cg = CGImageSourceCreateImageAtIndex(source, i, nil) else { return nil }
            let gif = props?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let delay = (gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double)
                ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
            guard delay.isFinite, delay > 0, delay <= 5 else { return nil }
            frames.append(UIImage(cgImage: cg))
            ticks.append(max(2, Int((delay * 100).rounded())))
            cost += width * height * 4
        }
        // Repeated references preserve each GIF frame's delay without duplicating pixels.
        func gcd(_ a: Int, _ b: Int) -> Int { b == 0 ? a : gcd(b, a % b) }
        let quantum = ticks.reduce(ticks[0], gcd)
        let sequence = zip(frames, ticks).flatMap { frame, ticks in Array(repeating: frame, count: ticks / quantum) }
        guard let image = UIImage.animatedImage(with: sequence, duration: Double(ticks.reduce(0, +)) / 100) else { return nil }
        return (image, cost)
    }

    static func load(client: LisaClient, path: String) async throws -> UIImage? {
        let slug = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        if path.hasPrefix("/assets/lisa/"), let index = LisaArtCatalog.moods[slug],
           let atlasRequest = try? client.makeRequest(LisaArtCatalog.atlasPath, timeout: 15),
           let url = atlasRequest.url {
            var atlas = cache.object(forKey: url as NSURL)
            if atlas == nil {
                // Older servers do not carry this atlas. Fall back to their
                // original portrait endpoint, still using authentication headers.
                if let (data, response) = try? await client.data(for: atlasRequest, path: LisaArtCatalog.atlasPath),
                   let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                   let decoded = UIImage(data: data) {
                    atlas = decoded
                    cache.setObject(decoded, forKey: url as NSURL)
                }
            }
            try Task.checkCancellation()
            if let cg = atlas?.cgImage {
                let width = CGFloat(cg.width) / CGFloat(LisaArtCatalog.columns)
                let height = CGFloat(cg.height) / CGFloat(LisaArtCatalog.rows)
                let rect = CGRect(x: CGFloat(index % LisaArtCatalog.columns) * width,
                                  y: CGFloat(index / LisaArtCatalog.columns) * height,
                                  width: width, height: height)
                if let frame = cg.cropping(to: rect.integral) { return UIImage(cgImage: frame) }
            }
        }
        let request = try client.makeRequest(path, timeout: 15)
        let (data, response) = try await client.data(for: request, path: path)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        try Task.checkCancellation()
        return UIImage(data: data)
    }
}

