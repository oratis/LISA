//
//  main.swift
//  Lisa — native Mac client for the LISA chat GUI.
//
//  Boots a regular NSApplication (regular activation policy, Dock icon
//  visible) and hands off to AppDelegate which owns the MainWindow.
//
//  Sibling to LisaIsland.app (the passive observer pill). Both apps wrap
//  the same LISA web server at localhost:5757; this one points at `/`
//  for the full chat experience, LisaIsland points at `/island`.
//

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
