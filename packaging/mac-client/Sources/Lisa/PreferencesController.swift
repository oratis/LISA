//
//  PreferencesController.swift
//  Lisa
//
//  The Settings window (⌘,). A small native panel for app-level toggles —
//  the Lisa Island switch, and the (opt-in) Screen Advisor. The Screen Advisor
//  state lives server-side (~/.lisa/screen-advisor.json via the backend), so
//  this panel GETs it to populate the controls and POSTs on change.
//

import AppKit
import Foundation

final class PreferencesController: NSObject, NSWindowDelegate {
    static let shared = PreferencesController()
    private override init() { super.init() }

    private var window: NSWindow?
    private var islandCheckbox: NSButton?
    private var resetButton: NSButton?
    private var screenCheckbox: NSButton?
    private var intervalField: NSTextField?
    private var intervalStepper: NSStepper?
    private var screenCaption: NSTextField?

    /// The local backend the Mac app talks to (same port used elsewhere).
    private let baseURL = "http://localhost:5757"

    func show() {
        if window == nil { build() }
        syncControls()
        fetchScreenAdvisorConfig()   // pull server truth into the controls
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Build

    private func build() {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 340),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        win.title = "Lisa Settings"
        win.isReleasedWhenClosed = false
        win.delegate = self

        let content = NSView(frame: win.contentLayoutRect)
        content.autoresizingMask = [.width, .height]

        // ── Lisa Island ────────────────────────────────────────────────
        let header = label("Lisa Island", size: 13, bold: true)
        header.frame = NSRect(x: 24, y: 300, width: 392, height: 20)
        content.addSubview(header)

        let checkbox = NSButton(checkboxWithTitle: "Show Lisa Island (notch pill)",
                                target: self, action: #selector(toggleIsland(_:)))
        checkbox.frame = NSRect(x: 22, y: 272, width: 392, height: 22)
        content.addSubview(checkbox)
        islandCheckbox = checkbox

        let caption = label("A small floating pill by the menu bar / notch that shows Lisa's mood and your agents' activity.",
                            size: 11, bold: false)
        caption.textColor = .secondaryLabelColor
        caption.frame = NSRect(x: 42, y: 236, width: 374, height: 32)
        wrap(caption)
        content.addSubview(caption)

        let reset = NSButton(title: "Reset Island Position",
                             target: self, action: #selector(resetPosition(_:)))
        reset.bezelStyle = .rounded
        reset.frame = NSRect(x: 22, y: 204, width: 200, height: 28)
        content.addSubview(reset)
        resetButton = reset

        // divider
        let line = NSBox(frame: NSRect(x: 22, y: 188, width: 396, height: 1))
        line.boxType = .separator
        content.addSubview(line)

        // ── Screen Advisor ─────────────────────────────────────────────
        let saHeader = label("Screen Advisor", size: 13, bold: true)
        saHeader.frame = NSRect(x: 24, y: 158, width: 392, height: 20)
        content.addSubview(saHeader)

        let saCheck = NSButton(checkboxWithTitle: "Suggest next steps from my screen",
                               target: self, action: #selector(screenAdvisorChanged(_:)))
        saCheck.frame = NSRect(x: 22, y: 130, width: 392, height: 22)
        content.addSubview(saCheck)
        screenCheckbox = saCheck

        // interval row: "Every [ 10 ]⇅ minutes"
        let everyLbl = label("Every", size: 12, bold: false)
        everyLbl.frame = NSRect(x: 42, y: 102, width: 44, height: 20)
        content.addSubview(everyLbl)

        let field = NSTextField(frame: NSRect(x: 88, y: 100, width: 48, height: 22))
        field.alignment = .right
        field.integerValue = 10
        field.target = self
        field.action = #selector(screenAdvisorChanged(_:))
        content.addSubview(field)
        intervalField = field

        let stepper = NSStepper(frame: NSRect(x: 138, y: 99, width: 19, height: 25))
        stepper.minValue = 2
        stepper.maxValue = 240
        stepper.increment = 1
        stepper.integerValue = 10
        stepper.valueWraps = false
        stepper.target = self
        stepper.action = #selector(stepperChanged(_:))
        content.addSubview(stepper)
        intervalStepper = stepper

        let minsLbl = label("minutes", size: 12, bold: false)
        minsLbl.frame = NSRect(x: 162, y: 102, width: 80, height: 20)
        content.addSubview(minsLbl)

        let saCaption = label("Lisa periodically screenshots your screen and suggests one next coding step in the island. Privacy: off by default; the image is used only for that suggestion and never stored. Requires the Lisa backend running (macOS only).",
                              size: 11, bold: false)
        saCaption.textColor = .secondaryLabelColor
        saCaption.frame = NSRect(x: 42, y: 18, width: 380, height: 72)
        wrap(saCaption)
        content.addSubview(saCaption)
        screenCaption = saCaption

        win.contentView = content
        window = win
    }

    private func label(_ text: String, size: CGFloat, bold: Bool) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        return l
    }

    private func wrap(_ field: NSTextField) {
        (field.cell as? NSTextFieldCell)?.wraps = true
        field.lineBreakMode = .byWordWrapping
    }

    // MARK: - State

    private func syncControls() {
        let on = IslandController.shared.isEnabled
        islandCheckbox?.state = on ? .on : .off
        resetButton?.isEnabled = on
    }

    /// Reflect server config into the Screen Advisor controls.
    private func applyScreenConfig(enabled: Bool, interval: Int, supported: Bool) {
        screenCheckbox?.state = enabled ? .on : .off
        screenCheckbox?.isEnabled = supported
        intervalField?.integerValue = interval
        intervalStepper?.integerValue = interval
        let editable = supported && enabled
        intervalField?.isEnabled = editable
        intervalStepper?.isEnabled = editable
        if !supported {
            screenCaption?.stringValue = "Screen Advisor is macOS-only and needs the Lisa backend running."
        }
    }

    // MARK: - Actions

    @objc private func toggleIsland(_ sender: NSButton) {
        IslandController.shared.setEnabled(sender.state == .on)
        syncControls()
    }

    @objc private func resetPosition(_ sender: Any?) {
        IslandController.shared.resetPosition()
    }

    @objc private func stepperChanged(_ sender: NSStepper) {
        intervalField?.integerValue = sender.integerValue
        postScreenAdvisorConfig()
    }

    @objc private func screenAdvisorChanged(_ sender: Any?) {
        // keep stepper + field in sync, clamp, then persist to the server
        var minutes = intervalField?.integerValue ?? 10
        if minutes < 2 { minutes = 2 }
        if minutes > 240 { minutes = 240 }
        intervalField?.integerValue = minutes
        intervalStepper?.integerValue = minutes
        let enabled = screenCheckbox?.state == .on
        intervalField?.isEnabled = enabled
        intervalStepper?.isEnabled = enabled
        postScreenAdvisorConfig()
    }

    // MARK: - Server sync

    private func fetchScreenAdvisorConfig() {
        guard let url = URL(string: "\(baseURL)/api/screen-advisor/config") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            let enabled = obj["enabled"] as? Bool ?? false
            let interval = obj["intervalMinutes"] as? Int ?? 10
            let supported = obj["supported"] as? Bool ?? true
            DispatchQueue.main.async {
                self.applyScreenConfig(enabled: enabled, interval: interval, supported: supported)
            }
        }.resume()
    }

    private func postScreenAdvisorConfig() {
        guard let url = URL(string: "\(baseURL)/api/screen-advisor/config") else { return }
        let enabled = screenCheckbox?.state == .on
        let interval = intervalField?.integerValue ?? 10
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["enabled": enabled, "intervalMinutes": interval]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            // Echo back the normalized config so a clamped interval shows up.
            guard let self = self, let data = data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            let en = obj["enabled"] as? Bool ?? enabled
            let iv = obj["intervalMinutes"] as? Int ?? interval
            let supported = obj["supported"] as? Bool ?? true
            DispatchQueue.main.async {
                self.applyScreenConfig(enabled: en, interval: iv, supported: supported)
            }
        }.resume()
    }
}
