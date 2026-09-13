package store

import (
	"crypto/rand"
	"encoding/hex"
	"strconv"
	"strings"
)

func itoa(i int) string { return strconv.Itoa(i) }

func joinAnd(parts []string) string { return strings.Join(parts, " AND ") }

// newID mints a random UUIDv4-shaped hex id.
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("store: no entropy: " + err.Error())
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	hexed := hex.EncodeToString(b[:])
	return hexed[:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:]
}
