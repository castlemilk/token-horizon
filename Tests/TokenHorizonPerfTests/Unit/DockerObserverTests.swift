import XCTest
@testable import TokenHorizon

final class DockerObserverTests: XCTestCase {
    func testParsePercent() {
        XCTAssertEqual(DockerObserver.parsePercent("0.28%"), 0.28, accuracy: 0.001)
        XCTAssertEqual(DockerObserver.parsePercent("100%"), 100.0, accuracy: 0.001)
        XCTAssertEqual(DockerObserver.parsePercent("0%"), 0.0, accuracy: 0.001)
        XCTAssertEqual(DockerObserver.parsePercent(""), 0.0, accuracy: 0.001)
    }

    func testParseBytesMB() {
        XCTAssertEqual(DockerObserver.parseBytesMB("0B"), 0.0, accuracy: 0.001)
        XCTAssertEqual(DockerObserver.parseBytesMB("1024B"), 0.000976, accuracy: 0.001)
        XCTAssertEqual(DockerObserver.parseBytesMB("388kB"), 0.3789, accuracy: 0.01)
        XCTAssertEqual(DockerObserver.parseBytesMB("47.07MiB"), 47.07, accuracy: 0.01)
        XCTAssertEqual(DockerObserver.parseBytesMB("205MB"), 205.0, accuracy: 0.01)
        XCTAssertEqual(DockerObserver.parseBytesMB("63.17GiB"), 63.17 * 1024, accuracy: 0.1)
        XCTAssertEqual(DockerObserver.parseBytesMB("1.83TB"), 1.83 * 1024 * 1024, accuracy: 1.0)
    }

    func testParseSlashPairMB() {
        let (used, limit) = DockerObserver.parseSlashPairMB("47.07MiB / 63.17GiB")
        XCTAssertEqual(used, 47.07, accuracy: 0.01)
        XCTAssertEqual(limit, 63.17 * 1024, accuracy: 0.1)

        let (netIn, netOut) = DockerObserver.parseSlashPairMB("205MB / 274MB")
        XCTAssertEqual(netIn, 205.0, accuracy: 0.01)
        XCTAssertEqual(netOut, 274.0, accuracy: 0.01)
    }

    func testParseStatsOutput_multiContainers() {
        let jsonLines = """
        {"BlockIO":"0B / 4.1kB","CPUPerc":"0.35%","Container":"dd7397b17b9c56ff5bb263e080420cfb2e0232a13cd19479bb90013a76091449","ID":"dd7397b17b9c","MemPerc":"0.07%","MemUsage":"47.32MiB / 63.17GiB","Name":"sfh-e2e-backend-1","NetIO":"205MB / 274MB","PIDs":"14"}
        {"BlockIO":"0B / 26.4MB","CPUPerc":"0.43%","Container":"60c6420031f6e5c9948c993cbbca78cbd4fbe5f69eb04a906d23a5d31a9638d6","ID":"60c6420031f6","MemPerc":"0.21%","MemUsage":"138.1MiB / 63.17GiB","Name":"sfh-e2e-db-1","NetIO":"282MB / 211MB","PIDs":"31"}
        """
        guard let data = jsonLines.data(using: .utf8) else {
            XCTFail("Failed to encode jsonLines")
            return
        }

        let metadata = [
            "dd7397b17b9c": (image: "sfh-e2e-backend", status: "Up 15 hours", ports: "8480->8080"),
            "60c6420031f6": (image: "sfh-postgres:local", status: "Up 15 hours (healthy)", ports: "54329->5432")
        ]

        let samples = DockerObserver.parseStatsOutput(data, metadata: metadata)
        XCTAssertEqual(samples.count, 2)

        let first = samples[0]
        XCTAssertEqual(first.id, "dd7397b17b9c")
        XCTAssertEqual(first.name, "sfh-e2e-backend-1")
        XCTAssertEqual(first.image, "sfh-e2e-backend")
        XCTAssertEqual(first.cpu, 0.35, accuracy: 0.001)
        XCTAssertEqual(first.memMB, 47.32, accuracy: 0.01)
        XCTAssertEqual(first.memPercent, 0.07, accuracy: 0.001)
        XCTAssertEqual(first.pids, 14)
        XCTAssertEqual(first.status, "Up 15 hours")
        XCTAssertEqual(first.ports, "8480->8080")

        let second = samples[1]
        XCTAssertEqual(second.id, "60c6420031f6")
        XCTAssertEqual(second.name, "sfh-e2e-db-1")
        XCTAssertEqual(second.pids, 31)
    }

    func testParsePsOutput() {
        let psJson = """
        {"Command":"\\"/sfh-backend\\"","CreatedAt":"2026-09-01 23:34:52 +1000 AEST","HealthStatus":"none","ID":"dd7397b17b9c","Image":"sfh-e2e-backend","Names":"sfh-e2e-backend-1","Ports":"0.0.0.0:8480->8080/tcp","Status":"Up 15 hours"}
        """
        guard let data = psJson.data(using: .utf8) else {
            XCTFail("Failed to encode psJson")
            return
        }

        let meta = DockerObserver.parsePsOutput(data)
        XCTAssertNotNil(meta["dd7397b17b9c"])
        XCTAssertEqual(meta["dd7397b17b9c"]?.image, "sfh-e2e-backend")
        XCTAssertEqual(meta["dd7397b17b9c"]?.status, "Up 15 hours")
        XCTAssertEqual(meta["dd7397b17b9c"]?.ports, "0.0.0.0:8480->8080/tcp")
    }

    func testIsDockerProcess() {
        XCTAssertTrue(DockerObserver.isDockerProcess(name: "com.apple.Virtualization.VirtualMachine", command: "/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine"))
        XCTAssertTrue(DockerObserver.isDockerProcess(name: "com.docker.backend", command: "/Applications/Docker.app/Contents/MacOS/com.docker.backend"))
        XCTAssertTrue(DockerObserver.isDockerProcess(name: "dockerd", command: "/usr/local/bin/dockerd"))
        XCTAssertTrue(DockerObserver.isDockerProcess(name: "docker", command: "/opt/homebrew/bin/docker"))
        XCTAssertTrue(DockerObserver.isDockerProcess(name: "orbctl", command: "/Applications/OrbStack.app/Contents/MacOS/orbctl"))
        XCTAssertFalse(DockerObserver.isDockerProcess(name: "Finder", command: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"))
    }

    func testDockerRoles() {
        XCTAssertEqual(DockerObserver.dockerRole(name: "com.apple.Virtualization.VirtualMachine", command: "com.apple.Virtualization.VirtualMachine"), .primaryVM)
        XCTAssertEqual(DockerObserver.dockerRole(name: "com.docker.virtualization", command: "com.docker.virtualization"), .primaryVM)
        XCTAssertEqual(DockerObserver.dockerRole(name: "dockerd", command: "/usr/local/bin/dockerd"), .primaryVM)
        XCTAssertEqual(DockerObserver.dockerRole(name: "com.docker.backend", command: "com.docker.backend"), .backendDaemon)
        XCTAssertEqual(DockerObserver.dockerRole(name: "Docker Desktop", command: "Docker Desktop"), .desktopHelper)
        XCTAssertEqual(DockerObserver.dockerRole(name: "com.docker.build", command: "com.docker.build"), .desktopHelper)
        XCTAssertEqual(DockerObserver.dockerRole(name: "docker", command: "docker stats"), .cli)
        XCTAssertEqual(DockerObserver.dockerRole(name: "Finder", command: "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"), .none)
    }

    func testFindPrimaryDockerPid() {
        let sampleDate = Date()
        let p1 = ProcSample(pid: 72637, ppid: 1, name: "com.docker.backend", command: "com.docker.backend", user: "user", threads: 8, cpu: 1.0, memMB: 35.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)
        let p2 = ProcSample(pid: 72781, ppid: 72637, name: "com.docker.virtualization", command: "com.docker.virtualization", user: "user", threads: 6, cpu: 2.0, memMB: 20.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)
        let p3 = ProcSample(pid: 72784, ppid: 1, name: "com.apple.Virtualization.VirtualMachine", command: "com.apple.Virtualization.VirtualMachine", user: "user", threads: 30, cpu: 40.0, memMB: 6500.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)
        let p4 = ProcSample(pid: 100, ppid: 1, name: "bash", command: "/bin/bash", user: "user", threads: 1, cpu: 0.1, memMB: 5.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)

        let primaryPid = DockerObserver.findPrimaryDockerPid(in: [p1, p2, p3, p4])
        XCTAssertEqual(primaryPid, 72784, "Primary Docker PID should be the VM engine with 6.5 GB RAM")
    }

    func testEffectiveParentPid_linksVirtualMachineUnderDocker() {
        let sampleDate = Date()
        let p1 = ProcSample(pid: 72637, ppid: 1, name: "com.docker.backend", command: "com.docker.backend", user: "user", threads: 8, cpu: 1.0, memMB: 35.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)
        let p2 = ProcSample(pid: 72781, ppid: 72637, name: "com.docker.virtualization", command: "com.docker.virtualization", user: "user", threads: 6, cpu: 2.0, memMB: 20.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)
        let p3 = ProcSample(pid: 72784, ppid: 1, name: "com.apple.Virtualization.VirtualMachine", command: "com.apple.Virtualization.VirtualMachine", user: "user", threads: 30, cpu: 40.0, memMB: 6500.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)

        let effectiveParent = DockerObserver.effectiveParentPid(for: p3, in: [p1, p2, p3])
        XCTAssertEqual(effectiveParent, 72781, "VirtualMachine should be linked to com.docker.virtualization")
    }

    func testDockerRoles_windows() {
        XCTAssertEqual(DockerObserver.dockerRole(name: "vmmemWSL", command: "C:\\Windows\\System32\\vmmemWSL.exe"), .primaryVM)
        XCTAssertEqual(DockerObserver.dockerRole(name: "vmmem", command: "vmmem"), .primaryVM)
        XCTAssertEqual(DockerObserver.dockerRole(name: "dockerd.exe", command: "C:\\Program Files\\Docker\\Docker\\resources\\dockerd.exe"), .primaryVM)
        XCTAssertEqual(DockerObserver.dockerRole(name: "com.docker.backend.exe", command: "com.docker.backend.exe"), .backendDaemon)
        XCTAssertEqual(DockerObserver.dockerRole(name: "Docker Desktop.exe", command: "Docker Desktop.exe"), .desktopHelper)
        XCTAssertEqual(DockerObserver.dockerRole(name: "docker.exe", command: "docker.exe stats"), .cli)
        XCTAssertEqual(DockerObserver.dockerRole(name: "wsl.exe", command: "wsl.exe --exec docker stats"), .cli)
    }

    func testFindPrimaryDockerPid_windowsWSL() {
        let sampleDate = Date()
        let p1 = ProcSample(pid: 1010, ppid: 1, name: "Docker Desktop.exe", command: "Docker Desktop.exe", user: "User", threads: 12, cpu: 0.5, memMB: 120.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)
        let p2 = ProcSample(pid: 1020, ppid: 1010, name: "com.docker.backend.exe", command: "com.docker.backend.exe", user: "User", threads: 8, cpu: 1.0, memMB: 60.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)
        let p3 = ProcSample(pid: 2048, ppid: 1, name: "vmmemWSL", command: "vmmemWSL", user: "SYSTEM", threads: 45, cpu: 25.0, memMB: 8192.0, diskReadMBps: 0, diskWriteMBps: 0, netInKBps: 0, netOutKBps: 0, startTime: sampleDate)

        let primaryPid = DockerObserver.findPrimaryDockerPid(in: [p1, p2, p3])
        XCTAssertEqual(primaryPid, 2048, "Primary Docker PID should be vmmemWSL with 8 GB RAM")

        let effectiveParent = DockerObserver.effectiveParentPid(for: p3, in: [p1, p2, p3])
        XCTAssertEqual(effectiveParent, 1010, "vmmemWSL should be linked under Docker Desktop")
    }
}
