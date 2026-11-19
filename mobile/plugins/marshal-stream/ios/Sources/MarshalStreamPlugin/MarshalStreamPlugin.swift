import Foundation
import Capacitor

/**
 * 原生 SSE 通道（iOS 侧）。
 *
 * 多路流各自持有 URLSession。UTF-8 按字节拼接，避免汉字被拆到两个 TCP 块时整块丢弃。
 * 干净结束同样通知 JS，并带回最近的事件 id，供 Last-Event-ID 续传。
 */
@objc(MarshalStreamPlugin)
public class MarshalStreamPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MarshalStreamPlugin"
    public let jsName = "MarshalStream"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var streams: [String: StreamBox] = [:]

    @objc func open(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("url required")
            return
        }
        let id = call.getString("id").flatMap { $0.isEmpty ? nil : $0 } ?? "default"
        lock.lock()
        let previous = streams.removeValue(forKey: id)
        lock.unlock()
        previous?.cancel()

        let box = StreamBox(id: id, plugin: self)
        lock.lock()
        streams[id] = box
        lock.unlock()
        box.start(url: url, token: call.getString("token"), lastEventId: call.getString("lastEventId"))
        call.resolve()
    }

    @objc func close(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        lock.lock()
        let closing: [StreamBox]
        if id.isEmpty {
            closing = Array(streams.values)
            streams.removeAll()
        } else {
            closing = streams.removeValue(forKey: id).map { [$0] } ?? []
        }
        lock.unlock()
        closing.forEach { $0.cancel() }
        call.resolve()
    }

    func emit(streamId: String, event: String, data: String, id: String?) {
        var payload: [String: Any] = ["streamId": streamId, "event": event, "data": data]
        if let id, !id.isEmpty { payload["id"] = id }
        notifyListeners("message", data: payload)
    }
}

final class StreamBox: NSObject, URLSessionDataDelegate {
    let id: String
    weak var plugin: MarshalStreamPlugin?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var pending = Data()
    private var lineBuffer = ""
    private var eventName = "message"
    private var dataLines: [String] = []
    private var eventId = ""
    private var intentional = false
    private var opened = false
    private var terminal = false

    init(id: String, plugin: MarshalStreamPlugin) {
        self.id = id
        self.plugin = plugin
    }

    func start(url: URL, token: String?, lastEventId: String?) {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let token, !token.isEmpty {
            if token.hasPrefix("mph1.") || token.hasPrefix("mnd1.") {
                request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            } else {
                request.setValue(token, forHTTPHeaderField: "x-marshal-token")
            }
        }
        if let lastEventId, !lastEventId.isEmpty {
            request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
        }
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 60 * 60
        configuration.timeoutIntervalForResource = 60 * 60
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        task = session.dataTask(with: request)
        task?.resume()
    }

    func cancel() {
        intentional = true
        task?.cancel()
        session?.invalidateAndCancel()
        task = nil
        session = nil
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status != 200 {
            terminal = true
            plugin?.emit(streamId: id, event: "error", data: "HTTP \(status)", id: nil)
            completionHandler(.cancel)
            return
        }
        opened = true
        plugin?.emit(streamId: id, event: "open", data: "", id: nil)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let text = takeText(data)
        if !text.isEmpty { consume(text) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if intentional || terminal { return }
        if let error = error as NSError?, error.code == NSURLErrorCancelled { return }
        terminal = true
        if let error {
            plugin?.emit(streamId: id, event: "error", data: error.localizedDescription, id: eventId.isEmpty ? nil : eventId)
        } else {
            plugin?.emit(streamId: id, event: "end", data: "closed", id: eventId.isEmpty ? nil : eventId)
        }
    }

    /// 保留末尾不完整的 UTF-8 序列，下一块再拼。规则与 mobile/src/lib/utf8.ts 相同。
    private func takeText(_ chunk: Data) -> String {
        pending.append(chunk)
        if let whole = String(data: pending, encoding: .utf8) {
            pending.removeAll(keepingCapacity: true)
            return whole
        }
        let bytes = [UInt8](pending)
        guard !bytes.isEmpty else { return "" }
        var index = bytes.count - 1
        var continuations = 0
        while index >= 0 && continuations < 3 && (bytes[index] & 0xC0) == 0x80 {
            continuations += 1
            index -= 1
        }
        if index >= 0 {
            let lead = bytes[index]
            let need: Int
            if lead & 0x80 == 0 { need = 1 }
            else if lead & 0xE0 == 0xC0 { need = 2 }
            else if lead & 0xF0 == 0xE0 { need = 3 }
            else if lead & 0xF8 == 0xF0 { need = 4 }
            else { need = 0 }
            let have = bytes.count - index
            if need > 1 && have < need {
                let prefix = pending.prefix(index)
                pending = Data(pending.suffix(from: index))
                return String(data: prefix, encoding: .utf8) ?? ""
            }
        }
        pending = Data(pending.dropFirst())
        return takeText(Data())
    }

    private func consume(_ text: String) {
        lineBuffer += text
        while let newline = lineBuffer.firstIndex(of: "\n") {
            let rawLine = String(lineBuffer[lineBuffer.startIndex..<newline])
            lineBuffer = String(lineBuffer[lineBuffer.index(after: newline)...])
            let line = rawLine.hasSuffix("\r") ? String(rawLine.dropLast()) : rawLine
            if line.isEmpty {
                if !dataLines.isEmpty {
                    plugin?.emit(streamId: id, event: eventName, data: dataLines.joined(separator: "\n"), id: eventId.isEmpty ? nil : eventId)
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
            } else if line.hasPrefix("id:") {
                let value = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                if !value.contains("\0") { eventId = value }
            }
        }
    }
}
