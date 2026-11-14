// Explicit opt-in only. Never prompts for Accessibility access and never logs UI text.
import AppKit
import ApplicationServices

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func text(_ element: AXUIElement, _ name: String, _ limit: Int = 400) -> String {
    String(((attribute(element, name) as? String) ?? "").prefix(limit))
}
func rect(_ element: AXUIElement) -> CGRect? {
    guard let p = attribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
          let s = attribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
          [point.x, point.y, size.width, size.height].allSatisfy({ $0.isFinite && abs($0) <= 100000 }),
          size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: point, size: size)
}
func bounds(_ r: CGRect) -> [String: Double] {
    ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
}
func capture() -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["status": "permission_required"] }
    guard let app = NSWorkspace.shared.frontmostApplication else { return ["status": "unavailable"] }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.2)
    guard let raw = attribute(root, kAXFocusedWindowAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        return ["status": "unavailable"]
    }
    let window = raw as! AXUIElement
    guard let frame = rect(window) else { return ["status": "unavailable"] }
    var rows: [[String: Any]] = [], seen = Set<CFHashCode>(), visits = 0, remaining = 8000
    var truncated = false
    func walk(_ element: AXUIElement, _ depth: Int) {
        guard depth <= 10, visits < 250, rows.count < 100, remaining > 0 else { truncated = true; return }
        guard seen.insert(CFHash(element)).inserted else { return }
        visits += 1
        let role = text(element, kAXRoleAttribute, 60), subrole = text(element, kAXSubroleAttribute, 60)
        // Do not read or traverse secure-entry controls, even their labels.
        guard role != "AXSecureTextField", subrole != "AXSecureTextField" else { return }
        if (attribute(element, "AXHidden") as? Bool) == true { return }
        if let r = rect(element) {
            guard r.intersects(frame) else { return }
            let title = text(element, kAXTitleAttribute), value = text(element, kAXValueAttribute)
            let parts = [title, value].filter { !$0.isEmpty }
            let combined = String(Array(NSOrderedSet(array: parts)).compactMap { $0 as? String }.joined(separator: " · ").prefix(min(remaining, 800)))
            if !combined.isEmpty && element != window {
                rows.append(["role": role, "text": combined, "bounds": bounds(r)])
                remaining -= combined.count
            }
        }
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success, count > 0 else { return }
        if count > 50 { truncated = true }
        var rawChildren: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, 50), &rawChildren) == .success,
              let children = rawChildren as? [AXUIElement] else { return }
        for child in children { walk(child, depth + 1) }
    }
    walk(window, 0)
    return ["status": "ready", "app": String((app.localizedName ?? "").prefix(200)),
            "window": text(window, kAXTitleAttribute), "bounds": bounds(frame), "elements": rows,
            "truncated": truncated]
}
let result = capture()
if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
}
