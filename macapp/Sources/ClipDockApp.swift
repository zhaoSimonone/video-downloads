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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var managedProcesses: [ManagedProcess] = []
    private var shuttingDown = false
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
        return .terminateNow
    }

    func applicationWillTerminate(_ notification: Notification) {
        guard !shuttingDown else { return }
        shuttingDown = true
        managedProcesses.reversed().forEach { $0.stop() }
        managedProcesses.removeAll()
    }

    private func configureWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
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
