//
//  HotkeyManager.swift
//  Lisa
//
//  System-wide global hotkey (default ⌃⌥S) that triggers "screenshot for
//  Lisa": brings the chat window forward and runs the page's capture bridge,
//  which shells out to macOS `screencapture` (the familiar crosshair) and
//  drops the result into the composer for the user to talk about.
//
//  Uses Carbon's RegisterEventHotKey — the standard, dependency-free way to
//  register a process-wide hotkey from a regular .app. It works whether or
//  not Lisa is frontmost. (Unlike NSEvent.addGlobalMonitor it captures the
//  key combo rather than just observing it, so it won't double-fire into
//  whatever app is in front.)
//

import AppKit
import Carbon.HIToolbox

final class HotkeyManager {
    static let shared = HotkeyManager()

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private var onFire: (() -> Void)?

    /// Register the global hotkey. Default: Control+Option+S.
    /// Safe to call once at launch; no-ops if already registered.
    func register(onFire: @escaping () -> Void) {
        guard hotKeyRef == nil else { return }
        self.onFire = onFire

        // Install one application-level handler for hotkey-pressed events.
        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed),
        )
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let callback: EventHandlerUPP = { (_, event, userData) -> OSStatus in
            guard let userData = userData, let event = event else { return noErr }
            let manager = Unmanaged<HotkeyManager>.fromOpaque(userData).takeUnretainedValue()
            var hkID = EventHotKeyID()
            GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hkID,
            )
            if hkID.id == HotkeyManager.hotKeyIDValue {
                DispatchQueue.main.async { manager.onFire?() }
            }
            return noErr
        }
        InstallEventHandler(
            GetApplicationEventTarget(),
            callback,
            1,
            &spec,
            selfPtr,
            &eventHandler,
        )

        // Register ⌃⌥S. keyCode 1 = 's' on the ANSI layout.
        var hotKeyID = EventHotKeyID(signature: Self.signature, id: Self.hotKeyIDValue)
        let modifiers = UInt32(controlKey | optionKey)
        RegisterEventHotKey(
            UInt32(kVK_ANSI_S),
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef,
        )
        FileHandle.standardError.write(Data("[lisa] global hotkey ⌃⌥S registered\n".utf8))
        _ = hotKeyID // silence unused-mutation warning
    }

    func unregister() {
        if let ref = hotKeyRef { UnregisterEventHotKey(ref); hotKeyRef = nil }
        if let handler = eventHandler { RemoveEventHandler(handler); eventHandler = nil }
    }

    // "LISA" as an OSType signature, and a stable hotkey id.
    private static let signature: OSType = {
        let chars = Array("LISA".utf8)
        return chars.reduce(OSType(0)) { ($0 << 8) + OSType($1) }
    }()
    private static let hotKeyIDValue: UInt32 = 1
}
