import XCTest
@testable import TokenHorizonCore
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Cancelling a request mid-stream must never kill the daemon.
/// Root cause of the crash: nothing ignored SIGPIPE, so the meter's next
/// relay send() to the dead peer terminated the whole process.
final class MeterCancelTests: XCTestCase {

    /// Sending to a peer-closed socket surfaces EPIPE instead of
    /// terminating the process — the contract ignoreSIGPIPE() establishes.
    /// (Without the fix, this test binary dies with SIGPIPE.)
    func testPeerClosedSendReturnsEPIPE() {
        ignoreSIGPIPE()
        var pair = [Int32](repeating: -1, count: 2)
        XCTAssertEqual(socketpair(AF_UNIX, Int32(SOCK_STREAM.rawValue), 0, &pair), 0)
        defer { close(pair[0]) }
        close(pair[1])
        pair[1] = -1
        let payload = Data(repeating: 0xAB, count: 64 * 1024)
        let n = payload.withUnsafeBytes { ptr in
            send(pair[0], ptr.baseAddress!, payload.count, 0)
        }
        XCTAssertEqual(n, -1, "closed peer must fail the send")
        XCTAssertEqual(errno, EPIPE, "failure must be EPIPE, not a crash")
    }

    /// End-to-end: a client that disconnects mid-stream is handled
    /// gracefully (upstream cancelled, fd released) and the meter keeps
    /// serving the next request.
    func testClientCancelMidStreamThenServesAgain() throws {
        // Same startup contract as every host: without this the runner
        // itself dies of SIGPIPE (signal 13) — the reported crash.
        ignoreSIGPIPE()
        // Env grant (no disk write — grant() would persist real consents).
        setenv("TH_CONSENT", "metering", 1)
        defer { unsetenv("TH_CONSENT") }
        let upstreamPort: UInt16 = 18731
        let meterPort: UInt16 = 18732
        let chunks = 30
        let server = SlowUpstream(port: upstreamPort, chunks: chunks)
        server.start()
        defer { server.stop() }
        let meter = RequestMeter(vendor: "testcancel", listenPort: meterPort,
                                 targetBase: URL(string: "http://127.0.0.1:\(upstreamPort)")!,
                                 store: nil, sourceKind: .external)
        meter.start()
        defer { meter.stop() }
        XCTAssertTrue(waitForPort(meterPort), "meter must listen")

        // Request 1: read the response head + one chunk, then vanish.
        let victim = connect127(port: meterPort)
        XCTAssertGreaterThanOrEqual(victim, 0, "client must connect")
        let req = "POST /v1/chat HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
        XCTAssertTrue(sendAll(victim, Data(req.utf8)))
        let head = readUntilDoubleCRLF(victim)
        XCTAssertNotNil(head, "must receive relayed response head before cancelling")
        _ = readSome(victim) // at most one body chunk
        close(victim) // cancel mid-stream

        // Request 2 (after the cancel has propagated): must be served whole.
        var full: Data?
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            full = roundTrip(port: meterPort, request: req)
            if let full, full.count >= chunks { break }
            Thread.sleep(forTimeInterval: 0.2)
            full = nil
        }
        guard let body = full else {
            return XCTFail("meter did not recover after client cancel")
        }
        XCTAssertEqual(body.count, chunks, "second response must be complete, got \(body.count) bytes")
    }

    // MARK: - Socket helpers

    private func listen127(port: UInt16) -> Int32 {
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else { return -1 }
        var one: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 && listen(fd, 8) == 0
            }
        }
        guard ok else { close(fd); return -1 }
        return fd
    }

    private func connect127(port: UInt16) -> Int32 {
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else { return -1 }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0
            }
        }
        guard ok else { close(fd); return -1 }
        return fd
    }

    private func sendAll(_ fd: Int32, _ data: Data) -> Bool {
        var sent = 0
        return data.withUnsafeBytes { ptr -> Bool in
            guard let base = ptr.baseAddress else { return true }
            while sent < data.count {
                let n = send(fd, base + sent, data.count - sent, 0)
                if n <= 0 { return false }
                sent += n
            }
            return true
        }
    }

    private func readUntilDoubleCRLF(_ fd: Int32) -> Data? {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        let end = Date().addingTimeInterval(10)
        while Date() < end {
            let n = recv(fd, &buf, buf.count, 0)
            if n > 0 {
                data.append(contentsOf: buf[..<n])
                if data.range(of: Data([13, 10, 13, 10])) != nil { return data }
            } else if n == 0 {
                return nil
            }
        }
        return nil
    }

    private func readSome(_ fd: Int32) -> Data {
        var buf = [UInt8](repeating: 0, count: 4096)
        var tv = timeval(tv_sec: 2, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let n = recv(fd, &buf, buf.count, 0)
        guard n > 0 else { return Data() }
        return Data(buf[..<n])
    }

    /// Full POST round-trip through the meter; returns the response BODY.
    private func roundTrip(port: UInt16, request: String) -> Data? {
        let fd = connect127(port: port)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        guard sendAll(fd, Data(request.utf8)) else { return nil }
        guard let head = readUntilDoubleCRLF(fd) else { return nil }
        var body = Data()
        if let range = head.range(of: Data([13, 10, 13, 10])) {
            body.append(contentsOf: head[range.upperBound...])
        }
        let end = Date().addingTimeInterval(10)
        var buf = [UInt8](repeating: 0, count: 16 * 1024)
        while Date() < end {
            let n = recv(fd, &buf, buf.count, 0)
            if n > 0 { body.append(contentsOf: buf[..<n]) }
            else { break } // close-delimited end (or peer gone)
        }
        return body
    }

    private func waitForPort(_ port: UInt16) -> Bool {
        let end = Date().addingTimeInterval(5)
        while Date() < end {
            let fd = connect127(port: port)
            if fd >= 0 { close(fd); return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    /// Upstream that streams N one-byte chunks with pauses — slow enough
    /// for a client to cancel mid-stream, then serves the next connection.
    private final class SlowUpstream {
        let port: UInt16
        let chunks: Int
        private var fd: Int32 = -1
        init(port: UInt16, chunks: Int) { self.port = port; self.chunks = chunks }
        func start() {
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = port.bigEndian
            addr.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)
            fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
            withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    _ = bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                    _ = listen(fd, 8)
                }
            }
            DispatchQueue(label: "test.slowupstream", qos: .utility).async { [weak self] in
                while let self, self.fd >= 0 {
                    let conn = accept(self.fd, nil, nil)
                    guard conn >= 0 else { continue }
                    DispatchQueue(label: "test.slowupstream.conn", qos: .utility).async {
                        self.serve(conn)
                    }
                }
            }
        }
        private func serve(_ conn: Int32) {
            defer { close(conn) }
            // Drain request head (client may vanish; ignore errors).
            var data = Data()
            var buf = [UInt8](repeating: 0, count: 4096)
            while data.range(of: Data([13, 10, 13, 10])) == nil {
                let n = recv(conn, &buf, buf.count, 0)
                guard n > 0 else { return }
                data.append(contentsOf: buf[..<n])
            }
            let head = "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n"
            _ = head.withCString { send(conn, $0, strlen($0), 0) }
            for _ in 0..<chunks {
                Thread.sleep(forTimeInterval: 0.05)
                var b: UInt8 = 0x58
                if send(conn, &b, 1, 0) <= 0 { return } // peer gone — stop
            }
        }
        func stop() {
            let fd = self.fd
            self.fd = -1
            if fd >= 0 { close(fd) }
        }
    }
}
