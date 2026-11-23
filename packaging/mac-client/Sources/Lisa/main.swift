//
//  main.swift
//  Lisa — native Mac client for the LISA chat GUI.
//
//  Boots a regular NSApplication (regular activation policy, Dock icon
//  visible) and hands off to AppDelegate which owns the MainWindow.
//
//  Sibling to LisaIsland.app (the passive observer pill). Both apps wrap
//  the local LISA web server in My Mac mode; this one can also open LISA Cloud
//  for the full chat experience, LisaIsland points at `/island`.
//

import AppKit

let app = NSApplication.shared
#if DEBUG
if MainActor.assumeIsolated({ CloudPreview.launchIfRequested() }) {
    app.setActivationPolicy(.regular)
    app.run()
    exit(0)
}
#endif
let delegate = MainActor.assumeIsolated { AppDelegate() }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
