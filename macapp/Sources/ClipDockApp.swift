import Cocoa
import WebKit
import Foundation
import Darwin

final class ManagedProcess {
    let process: Process
    private let logHandle: FileHandle?

    init(process: Process, logHandle: FileHandle?) {
        self.process = process
        self.logHandle = logHandle
    }

    func stop() {
        guard process.isRunning else {
            try? logHandle?.close()
            return
        }
        let pid = process.processIdentifier
        Darwin.kill(pid, SIGTERM)
        let deadline = Date().addingTimeInterval(1.5)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if process.isRunning {
            Darwin.kill(pid, SIGKILL)
        }
        try? logHandle?.close()
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var managedProcesses: [ManagedProcess] = []
    private var downloadDestinations: [ObjectIdentifier: URL] = [:]
    private var shuttingDown = false
    private var keyMonitor: Any?
    private let fileManager = FileManager.default

    private var supportDirectory: URL {
        fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/ClipDock", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        configureWindow()
        prepareRuntime { [weak self] in
            self?.ensureServicesAndLoadUI()
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !shuttingDown else { return .terminateNow }
        shuttingDown = true
        managedProcesses.reversed().forEach { $0.stop() }
        managedProcesses.removeAll()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard !shuttingDown else { return }
        shuttingDown = true
        managedProcesses.reversed().forEach { $0.stop() }
        managedProcesses.removeAll()
        if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        keyMonitor = nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let response = navigationResponse.response as? HTTPURLResponse,
           response.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedFileTypes = ["mp4", "mov", "webm"]
        panel.message = "选择用于视频对比的文件"
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, url.scheme == "clipdock" else {
            decisionHandler(.allow)
            return
        }
        if url.host == "open-downloads" {
            openDownloadsDirectory()
        } else if url.host == "reveal-download" {
            let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "name" })?.value
            if let name, name == URL(fileURLWithPath: name).lastPathComponent, !name.isEmpty {
                let destination = downloadsDirectory.appendingPathComponent(name)
                if fileManager.fileExists(atPath: destination.path) {
                    NSWorkspace.shared.activateFileViewerSelecting([destination])
                } else {
                    openDownloadsDirectory()
                }
            } else {
                openDownloadsDirectory()
            }
        }
        decisionHandler(.cancel)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let downloadsDirectory = fileManager.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? supportDirectory.appendingPathComponent("Downloads", isDirectory: true)
        try? fileManager.createDirectory(at: downloadsDirectory, withIntermediateDirectories: true)
        let sanitized = suggestedFilename.replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
        let baseName = sanitized.isEmpty ? "clipdock-video.mp4" : sanitized
        var destination = downloadsDirectory.appendingPathComponent(baseName)
        var suffix = 1
        while fileManager.fileExists(atPath: destination.path) {
            let url = downloadsDirectory.appendingPathComponent(baseName)
            let extensionPart = url.pathExtension.isEmpty ? "mp4" : url.pathExtension
            destination = downloadsDirectory.appendingPathComponent("\(url.deletingPathExtension().lastPathComponent)-\(suffix).\(extensionPart)")
            suffix += 1
        }
        downloadDestinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        NSLog("ClipDock download finished")
        guard let destination = downloadDestinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        DispatchQueue.main.async {
            NSWorkspace.shared.activateFileViewerSelecting([destination])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadDestinations.removeValue(forKey: ObjectIdentifier(download))
        DispatchQueue.main.async { [weak self] in
            self?.showError("下载失败：\n\(error.localizedDescription)")
        }
    }

    private func configureWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        webView.autoresizingMask = [.width, .height]

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "ClipDock"
        window.minSize = NSSize(width: 900, height: 620)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("ClipDockMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            self?.handleClipboardShortcut(event) ?? event
        }
    }

    private func handleClipboardShortcut(_ event: NSEvent) -> NSEvent? {
        guard window?.isKeyWindow == true else { return event }
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard modifiers.contains(.command) || modifiers.contains(.control) else { return event }
        guard let key = event.charactersIgnoringModifiers?.lowercased(), key == "v" || key == "c" || key == "q" else { return event }
        if key == "q" {
            NSApp.terminate(nil)
            return nil
        }
        if key == "v" {
            guard let text = NSPasteboard.general.string(forType: .string), !text.isEmpty else { return nil }
            let encoded = (try? JSONEncoder().encode(text)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
            webView.evaluateJavaScript("""
            (() => { const input = document.getElementById('urlInput'); if (!input) return; input.focus(); const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? input.value.length; input.value = input.value.slice(0, start) + \(encoded) + input.value.slice(end); input.selectionStart = input.selectionEnd = start + \(encoded).length; input.dispatchEvent(new Event('input', { bubbles: true })); })();
            """)
            return nil
        }
        webView.evaluateJavaScript("""
        (() => { const input = document.getElementById('urlInput'); if (!input || document.activeElement !== input || input.selectionStart === input.selectionEnd) return ''; return input.value.slice(input.selectionStart, input.selectionEnd); })();
        """) { result, _ in
            guard let text = result as? String, !text.isEmpty else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        return nil
    }

    private var downloadsDirectory: URL {
        fileManager.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? supportDirectory.appendingPathComponent("Downloads", isDirectory: true)
    }

    private func openDownloadsDirectory() {
        NSWorkspace.shared.open(downloadsDirectory)
    }

    private func prepareRuntime(completion: @escaping () -> Void) {
        do {
            try fileManager.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
            let sourceConfig = Bundle.main.resourceURL!.appendingPathComponent("bin/config.yaml")
            let targetConfig = supportDirectory.appendingPathComponent("config.yaml")
            if !fileManager.fileExists(atPath: targetConfig.path) {
                try fileManager.copyItem(at: sourceConfig, to: targetConfig)
            }
            completion()
        } catch {
            showError("无法准备 ClipDock 运行目录：\n\(error.localizedDescription)")
        }
    }

    private func ensureServicesAndLoadUI() {
        probe(url: URL(string: "http://127.0.0.1:2022/api/scraper/platform/status")!) { [weak self] agentAvailable in
            guard let self else { return }
            if !agentAvailable {
                self.launchAgent()
            }
            self.probe(url: URL(string: "http://127.0.0.1:3457/")!) { [weak self] serverAvailable in
                guard let self else { return }
                if !serverAvailable {
                    self.launchClipDockServer()
                }
                self.waitForServerAndLoad()
            }
        }
    }

    private func launchAgent() {
        let executable = Bundle.main.resourceURL!.appendingPathComponent("bin/wx_video_download")
        let config = supportDirectory.appendingPathComponent("config.yaml")
        launch(
            executable: executable,
            arguments: ["--config", config.path, "--workdir", supportDirectory.path],
            workingDirectory: supportDirectory,
            environment: ProcessInfo.processInfo.environment,
            logName: "wx-video-download.log"
        )
    }

    private func launchClipDockServer() {
        guard let node = findNode() else {
            showError("找不到 Node.js。请先安装 Node.js（推荐 v20 或更高版本），然后重新打开 ClipDock。")
            return
        }
        let server = Bundle.main.resourceURL!.appendingPathComponent("server.js")
        var environment = ProcessInfo.processInfo.environment
        environment["PORT"] = "3457"
        environment["WX_CHANNELS_AGENT_ORIGIN"] = "http://127.0.0.1:2022"
        environment["NODE_NO_WARNINGS"] = "1"
        launch(
            executable: node,
            arguments: [server.path],
            workingDirectory: Bundle.main.resourceURL!,
            environment: environment,
            logName: "clipdock-server.log"
        )
    }

    private func launch(executable: URL, arguments: [String], workingDirectory: URL, environment: [String: String], logName: String) {
        guard fileManager.isExecutableFile(atPath: executable.path) else {
            showError("应用资源不可执行：\(executable.lastPathComponent)")
            return
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = workingDirectory
        process.environment = environment
        let logURL = supportDirectory.appendingPathComponent(logName)
        fileManager.createFile(atPath: logURL.path, contents: nil)
        let logHandle = try? FileHandle(forWritingTo: logURL)
        _ = try? logHandle?.seekToEnd()
        process.standardOutput = logHandle
        process.standardError = logHandle
        do {
            try process.run()
            managedProcesses.append(ManagedProcess(process: process, logHandle: logHandle))
        } catch {
            try? logHandle?.close()
            showError("启动 \(executable.lastPathComponent) 失败：\n\(error.localizedDescription)")
        }
    }

    private func findNode() -> URL? {
        var candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        let nvmRoot = fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".nvm/versions/node")
        if let versions = try? fileManager.contentsOfDirectory(at: nvmRoot, includingPropertiesForKeys: nil) {
            candidates.insert(contentsOf: versions.sorted { $0.lastPathComponent > $1.lastPathComponent }.map {
                $0.appendingPathComponent("bin/node").path
            }, at: 0)
        }
        return candidates.map(URL.init(fileURLWithPath:)).first { fileManager.isExecutableFile(atPath: $0.path) }
    }

    private func probe(url: URL, completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.2
        URLSession.shared.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async { completion((response as? HTTPURLResponse)?.statusCode == 200) }
        }.resume()
    }

    private func waitForServerAndLoad(attempt: Int = 0) {
        probe(url: URL(string: "http://127.0.0.1:3457/")!) { [weak self] available in
            guard let self else { return }
            if available {
                self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:3457/")!))
            } else if attempt < 80 && !self.shuttingDown {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self.waitForServerAndLoad(attempt: attempt + 1)
                }
            } else {
                self.showError("ClipDock 服务启动超时。\n请查看 ~/Library/Application Support/ClipDock/clipdock-server.log。")
            }
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "ClipDock 启动失败"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "好")
        alert.runModal()
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
