//go:build !darwin

package keychain

// Keychain is macOS-only; other platforms resolve credentials from the
// on-disk files the tools themselves write.
func Read(service, account string) string { return "" }
