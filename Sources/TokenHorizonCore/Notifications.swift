import Foundation

/// Shared notification names posted by core engines; UIs observe these.
extension Notification.Name {
    public static let refreshTrends = Notification.Name("refreshTrends")
    public static let refreshModelExtras = Notification.Name("refreshModelExtras")
    public static let ollamaTelemetryUpdated = Notification.Name("ollamaTelemetryUpdated")
    public static let openDashboard = Notification.Name("openDashboard")
}
