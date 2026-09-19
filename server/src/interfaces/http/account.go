package api

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/castlemilk/token-horizon/server/src/models/identity"
)

// Account handlers: profile read/edit and avatar storage.

// toPublicUser strips provider subs before a user crosses the wire.
func toPublicUser(u identity.User) identity.User {
	u.GoogleSub, u.MSSub = "", ""
	return u
}

func (a *Auth) me(w http.ResponseWriter, r *http.Request, userID string) {
	u, err := a.Use.Store.UserByID(r.Context(), userID)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "account missing"})
		return
	}
	writeJSON(w, http.StatusOK, toPublicUser(u))
}

func (a *Auth) update(w http.ResponseWriter, r *http.Request, userID string) {
	var body struct {
		DisplayName string `json:"display_name"`
		Handle      string `json:"handle"`
		Bio         string `json:"bio"`
	}
	if !decodeJSON(w, r, 1<<16, &body) {
		return
	}
	u, err := a.Acct.Update(r.Context(), userID, body.DisplayName, body.Handle, "", body.Bio)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "taken") {
			status = http.StatusConflict
		} else if strings.Contains(err.Error(), "handle") {
			status = http.StatusBadRequest
		}
		writeJSON(w, status, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, toPublicUser(u))
}

// uploadAvatar accepts a webp/png/jpeg image (the client downscales to
// ~256px webp first), stores it, and points the profile at it.
func (a *Auth) uploadAvatar(w http.ResponseWriter, r *http.Request, userID string) {
	if err := r.ParseMultipartForm(2<<20 + 1<<16); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "multipart parse failed"})
		return
	}
	f, _, err := r.FormFile("avatar")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "avatar file required"})
		return
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 2<<20+1))
	if err != nil || len(raw) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "empty file"})
		return
	}
	ext, ctype, ok := sniffImage(raw)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "avatar must be webp, png, or jpeg"})
		return
	}
	_ = ctype
	if err := os.MkdirAll(a.AvatarDir, 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "storage unavailable"})
		return
	}
	name := userID + ext
	if err := os.WriteFile(filepath.Join(a.AvatarDir, name), raw, 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "storage unavailable"})
		return
	}
	url := strings.TrimSuffix(a.AvatarURLBase, "/") + "/" + userID
	u, err := a.Acct.Update(r.Context(), userID, "", "", url, "")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, toPublicUser(u))
}

// serveAvatar serves stored avatars (public — <img> tags carry no auth).
func (a *Auth) serveAvatar(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || strings.ContainsAny(id, "/\\") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bad id"})
		return
	}
	for _, ext := range []string{".webp", ".png", ".jpg", ".jpeg"} {
		path := filepath.Join(a.AvatarDir, id+ext)
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		_, ctype, ok := sniffImage(raw)
		if !ok {
			continue
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(raw)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "no avatar"})
}

// sniffImage allows webp/png/jpeg by magic bytes.
func sniffImage(b []byte) (ext, ctype string, ok bool) {
	if len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP" {
		return ".webp", "image/webp", true
	}
	if len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n" {
		return ".png", "image/png", true
	}
	if len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF {
		return ".jpg", "image/jpeg", true
	}
	return "", "", false
}
