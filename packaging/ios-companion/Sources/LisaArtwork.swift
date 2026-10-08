import UIKit

/// The same versioned atlas/cell map as Web and Island. The source image is
/// cached, so mood changes do not redownload a sheet or flash a placeholder.
@MainActor
enum LisaArtwork {
    private static let cache = NSCache<NSURL, UIImage>()

    static func load(client: LisaClient, path: String) async throws -> UIImage? {
        let slug = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
        if path.hasPrefix("/assets/lisa/"), let index = LisaArtCatalog.moods[slug],
           let atlasRequest = try? client.makeRequest(LisaArtCatalog.atlasPath, timeout: 15),
           let url = atlasRequest.url {
            var atlas = cache.object(forKey: url as NSURL)
            if atlas == nil {
                // Older servers do not carry this atlas. Fall back to their
                // original portrait endpoint, still using authentication headers.
                if let (data, response) = try? await URLSession.shared.data(for: atlasRequest),
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
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { return nil }
        try Task.checkCancellation()
        return UIImage(data: data)
    }
}

