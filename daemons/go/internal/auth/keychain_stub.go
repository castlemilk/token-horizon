//go:build !darwin

package auth

// Keychain is macOS-only; other platforms resolve credentials from the
// on-disk files the tools themselves write.
func keychainRead(service, account string) string { return "" }
