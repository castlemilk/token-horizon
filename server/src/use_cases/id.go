package usecases

import (
	"crypto/rand"
	"encoding/hex"
)

// newID mints a random 128-bit hex id (no external deps for identity).
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("usecases: no entropy: " + err.Error())
	}
	// UUIDv4 shape: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx.
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	hexed := hex.EncodeToString(b[:])
	return hexed[:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:]
}
