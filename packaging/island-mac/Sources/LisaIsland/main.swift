//
//  main.swift
//  LisaIsland — Phase 2.1 of MAC_ISLAND_PLAN.md
//
//  Boots an accessory-policy NSApplication (no Dock icon, no menu bar app
//  name) and hands off to AppDelegate which owns the IslandWindow lifecycle.
//
//  Why a top-level script entry rather than @main: we explicitly call
//  setActivationPolicy(.accessory) BEFORE app.run() so the Dock icon never
//  even appears momentarily. @main attribute would activate the regular
//  policy briefly.
//

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
