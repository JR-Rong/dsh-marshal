import Foundation
import Capacitor

/**
 * 原生 SSE 通道（iOS 侧）。
 *
 * 用 URLSession 的流式回调逐块读取 text/event-stream，按 SSE 规范切事件，
 * 通过 notifyListeners 回传 JS。WebView 本身受同源策略限制，做不到这件事。
 */
@objc(MarshalStreamPlugin)
public class MarshalStreamPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MarshalStreamPlugin"
    public let jsName = "MarshalStream"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var buffer = ""
    private var eventName = "message"
    private var dataLines: [String] = []
    private let delegate = MarshalStreamDelegate()

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("url required")
            return
        }
        closeStream()

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token = call.getString("token"), !token.isEmpty {
            request.setValue(token, forHTTPHeaderField: "x-marshal-token")
        }

        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60 * 60
        configuration.timeoutIntervalForResource = 60 * 60
        let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        self.session = session

        delegate.onData = { [weak self] text in
            self?.consume(text)
        }
        delegate.onEnd = { [weak self] message in
            guard let self = self else { return }
            if let message = message {
                self.emit(event: "error", data: message)
            }
            self.closeStream()
        }
        delegate.onResponse = { status in
            if status != 200 {
                self.emit(event: "error", data: "HTTP \(status)")
            }
        }

        task = session.dataTask(with: request)
        task?.resume()
        call.resolve()
    }

    @objc func close(_ call: CAPPluginCall) {
        closeStream()
        call.resolve()
    }

    private func closeStream() {
        task?.cancel()
        task = nil
        session?.invalidateAndCancel()
        session = nil
        buffer = ""
        dataLines = []
        eventName = "message"
    }

    private func emit(event: String, data: String) {
        notifyListeners("message", data: ["event": event, "data": data])
    }

    private func consume(_ text: String) {
        buffer += text
        while let newline = buffer.firstIndex(of: "\n") {
            let rawLine = String(buffer[buffer.startIndex..<newline])
            buffer = String(buffer[buffer.index(after: newline)...])
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
            if line.isEmpty {
                if !dataLines.isEmpty {
                    emit(event: eventName, data: dataLines.joined(separator: "\n"))
                }
                eventName = "message"
                dataLines.removeAll()
                continue
            }
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("event:") {
                eventName = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
            }
        }
    }
}

/// URLSession 的流式代理：只关心收到多少字节、何时结束。
final class MarshalStreamDelegate: NSObject, URLSessionDataDelegate {
    var onData: ((String) -> Void)?
    var onEnd: ((String?) -> Void)?
    var onResponse: ((Int) -> Void)?

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        if let http = response as? HTTPURLResponse {
            onResponse?(http.statusCode)
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
        onData?(text)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        onEnd?(error.map { $0.localizedDescription })
    }
}
