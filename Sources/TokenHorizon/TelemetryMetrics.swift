import Foundation
import OpenTelemetryApi
import OpenTelemetryProtocolExporterHttp
import OpenTelemetrySdk
import PrometheusExporter

final class TokenHorizonTelemetry {
    static let shared = TokenHorizonTelemetry()

    private let meterProvider: MeterProviderSdk
    private let prometheusExporter: PrometheusExporter
    private let metricLock = NSLock()
    private let modelLabelLock = NSLock()
    private var modelLabels: Set<String> = []
    private let maxModelLabels = 32

    private lazy var requests = meter.counterBuilder(name: "token_horizon_ollama_requests_total").build()
    private lazy var completedRequests = meter.counterBuilder(name: "token_horizon_ollama_completed_requests_total").build()
    private lazy var generatedTokens = meter.counterBuilder(name: "token_horizon_ollama_generated_tokens_total").build()
    private lazy var promptTokens = meter.counterBuilder(name: "token_horizon_ollama_prompt_tokens_total").build()
    private lazy var generationDuration = meter.histogramBuilder(name: "token_horizon_ollama_generation_duration_seconds")
        .setExplicitBucketBoundariesAdvice([0.01, 0.1, 0.5, 1, 2, 5, 15, 60, 300])
        .build()
    private lazy var tokPerSecond = meter.histogramBuilder(name: "token_horizon_ollama_tokens_per_second")
        .setExplicitBucketBoundariesAdvice([1, 5, 10, 20, 30, 50, 75, 100, 150, 250])
        .build()
    private lazy var mlxActive = meter.gaugeBuilder(name: "token_horizon_mlx_active_runners").build()
    private lazy var mlxCPU = meter.gaugeBuilder(name: "token_horizon_mlx_cpu_percent").build()
    private lazy var mlxMemory = meter.gaugeBuilder(name: "token_horizon_mlx_memory_bytes").build()
    private lazy var mlxDiskRead = meter.gaugeBuilder(name: "token_horizon_mlx_disk_read_bytes_per_second").build()
    private lazy var mlxDiskWrite = meter.gaugeBuilder(name: "token_horizon_mlx_disk_write_bytes_per_second").build()

    private let meter: MeterSdk

    private init() {
        let prometheus = PrometheusExporter(
            options: PrometheusExporterOptions(url: "http://127.0.0.1:8765/metrics")
        )
        var builder = MeterProviderSdk.builder()
            .registerView(selector: InstrumentSelectorBuilder().build(), view: View.builder().build())
            .registerMetricReader(
                reader: PeriodicMetricReaderBuilder(exporter: prometheus)
                    .setInterval(timeInterval: 5)
                    .build()
            )

        var otlp: OtlpHttpMetricExporter?
        if let endpoint = Self.otlpEndpoint() {
            let exporter = OtlpHttpMetricExporter(endpoint: endpoint)
            otlp = exporter
            builder = builder.registerMetricReader(
                reader: PeriodicMetricReaderBuilder(exporter: exporter)
                    .setInterval(timeInterval: 60)
                    .build()
            )
        } else {
            otlp = nil
        }

        let provider = builder.build()
        prometheusExporter = prometheus
        meterProvider = provider
        meter = provider.get(name: "token-horizon")
        _ = otlp // Keep the exporter alive through the metric reader.
        OpenTelemetry.registerMeterProvider(meterProvider: provider)
        recordMLX(MLXSnapshot())
    }

    func recordOllama(_ sample: OllamaTelemetrySample) {
        let attributes = attributes(model: sample.model)
        metricLock.lock()
        completedRequests.add(value: 1, attributes: attributes)
        if sample.evalCount > 0 {
            generatedTokens.add(value: sample.evalCount, attributes: attributes)
        }
        if let promptCount = sample.promptEvalCount, promptCount > 0 {
            promptTokens.add(value: promptCount, attributes: attributes)
        }
        if let duration = Double(exactly: sample.evalDurationNs) {
            generationDuration.record(value: duration / 1_000_000_000, attributes: attributes)
        }
        if let rate = sample.tokPerSec {
            tokPerSecond.record(value: rate, attributes: attributes)
        }
        metricLock.unlock()
    }

    func recordOllamaRequest(model: String?) {
        let attributes = attributes(model: model ?? "unknown")
        metricLock.lock()
        requests.add(value: 1, attributes: attributes)
        metricLock.unlock()
    }

    func recordMLX(_ snapshot: MLXSnapshot) {
        let attributes = ["backend": AttributeValue.string("mlx")]
        metricLock.lock()
        mlxActive.record(value: Double(snapshot.processes.isEmpty ? 0 : 1), attributes: attributes)
        mlxCPU.record(value: snapshot.cpuPercent, attributes: attributes)
        mlxMemory.record(value: snapshot.memoryMB * 1_048_576, attributes: attributes)
        mlxDiskRead.record(value: snapshot.diskReadMBps * 1_048_576, attributes: attributes)
        mlxDiskWrite.record(value: snapshot.diskWriteMBps * 1_048_576, attributes: attributes)
        metricLock.unlock()
    }

    func prometheusText() -> String {
        _ = meterProvider.forceFlush()
        return PrometheusExporterExtensions.writeMetricsCollection(exporter: prometheusExporter)
    }

    func shutdown() {
        _ = meterProvider.shutdown()
    }

    private func attributes(model: String) -> [String: AttributeValue] {
        let normalized = model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let candidate = normalized.isEmpty ? "unknown" : String(normalized.prefix(96))
        modelLabelLock.lock()
        let label: String
        if modelLabels.contains(candidate) || modelLabels.count < maxModelLabels {
            modelLabels.insert(candidate)
            label = candidate
        } else {
            label = "other"
        }
        modelLabelLock.unlock()
        let backend = label.contains("mlx") ? "mlx" : "ollama"
        return [
            "model": AttributeValue.string(label),
            "backend": AttributeValue.string(backend)
        ]
    }

    private static func otlpEndpoint() -> URL? {
        let environment = ProcessInfo.processInfo.environment
        if let value = environment["OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"],
           let url = URL(string: value), url.scheme != nil, url.host != nil {
            return url
        }
        if let base = environment["OTEL_EXPORTER_OTLP_ENDPOINT"],
           var url = URL(string: base), url.scheme != nil, url.host != nil {
            if !url.path.hasSuffix("/v1/metrics") {
                url.appendPathComponent("v1/metrics")
            }
            return url
        }
        return nil
    }
}
