# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Compressor macOS app."""

import os

VERSION = open("VERSION").read().strip()

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=[
        ("templates", "templates"),
        ("static", "static"),
        ("VERSION", "."),
    ],
    hiddenimports=[
        "webview",
        "webview.platforms",
        "webview.platforms.cocoa",
        "PIL",
        "PIL.Image",
        "PIL.JpegImagePlugin",
        "PIL.PngImagePlugin",
        "PIL.WebPImagePlugin",
        "fitz",
        "fitz.fitz",
        "certifi",
        "bottle",
        "AppKit",
        "Foundation",
        "WebKit",
        "objc",
        "Quartz",
        "Security",
        "UniformTypeIdentifiers",
        "werkzeug",
        "werkzeug.security",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "scipy", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Compressor",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon="static/icon.icns",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="Compressor",
)

app = BUNDLE(
    coll,
    name="Compressor.app",
    icon="static/icon.icns",
    bundle_identifier="com.ipln.compressor",
    info_plist={
        "CFBundleName": "Compressor",
        "CFBundleDisplayName": "Compressor",
        "CFBundleVersion": VERSION,
        "CFBundleShortVersionString": VERSION,
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "12.0",
        "NSAppleEventsUsageDescription": "Compressor needs access to compress your files.",
    },
)
