import XCTest
import UIKit
import ImageIO
import UniformTypeIdentifiers
@testable import LisaPocket

@MainActor
final class MotionArtworkTests: XCTestCase {
    private func gif(size: Int = 8, delays: [Double] = [0.1, 0.3]) throws -> Data {
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, delays.count, nil))
        for (index, delay) in delays.enumerated() {
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            let image = UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: format).image { context in
                (index == 0 ? UIColor.systemTeal : UIColor.systemBlue).setFill()
                context.fill(CGRect(x: 0, y: 0, width: size, height: size))
            }
            CGImageDestinationAddImage(destination, try XCTUnwrap(image.cgImage), [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay]] as CFDictionary)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    func testPreservesVariableFrameDurationsWithoutDuplicatingPixels() throws {
        let result = try XCTUnwrap(LisaArtwork.decodeMotion(gif()))
        XCTAssertEqual(result.image.duration, 0.4, accuracy: 0.001)
        XCTAssertEqual(result.image.images?.count, 4)
        XCTAssertEqual(result.cost, 2 * 8 * 8 * 4)
        let view = UIImageView(image: result.image)
        view.startAnimating()
        view.stopAnimating()
        view.image = nil
        view.image = result.image.images?.first
        XCTAssertFalse(view.isAnimating)
        XCTAssertNil(view.image?.images)
    }

    func testRejectsMalformedOversizedOrStaticAnimations() throws {
        XCTAssertNil(LisaArtwork.decodeMotion(Data("invalid".utf8)))
        XCTAssertNil(LisaArtwork.decodeMotion(Data(count: 256 * 1024 + 1)))
        XCTAssertNil(LisaArtwork.decodeMotion(try gif(size: 300)))
        XCTAssertNil(LisaArtwork.decodeMotion(try gif(delays: [0.1])))
    }

    func testEveryCorePortraitHasANativeAnimation() {
        XCTAssertEqual(LisaArtCatalog.motion.count, 24)
        for index in LisaArtCatalog.moods.values { XCTAssertNotNil(LisaArtCatalog.motion[index]) }
    }
}
