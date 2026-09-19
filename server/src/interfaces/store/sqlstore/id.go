package sqlstore

import (
	"strconv"
	"strings"
)

func itoa(i int) string { return strconv.Itoa(i) }

func joinAnd(parts []string) string { return strings.Join(parts, " AND ") }
